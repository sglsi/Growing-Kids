// ============================================================
// 匿名建号闸门（P-007 / D-010，"A：治 197 空壳"）
// 位置：server/src/shared/anon-bootstrap-guard.ts
//
// 身份契约（P-007 / D-010）：`X-Auth-Token` 唯一信任根 + `openid` 唯一身份
//   + `device_id` 临时锚点。`device_id` 是前端自生成随机串，**不是账号**：
//   只在「登录前 bootstrap 换令牌」与「登录时合并匿名数据」两处用，
//   绝不能拿它当跨设备找回数据的依据（找回靠 openid）。
//
// 治的是什么：现网 197 个 users 行里绝大多数是零数据空壳，根因是
//   `findOrCreateByDeviceId()` 对每个陌生 X-Device-Id 无条件 insert 一行。
//   测试脚本 / 开发者工具重编译 / 反复重扫码不断换新串 ⇒ 空壳持续累积，
//   而「滑动续期」让它们永不过期，maintenance 的 expire_at 清理永远扫不到。
//
// 本闸门只拦「新建」，不拦「找回」：
//   · `findOrCreateByDeviceId()` 的 **find 分支零改动** —— 已存在的
//     device_id 照常查找 / 滑动续期 / 签令牌，现有用户零影响（P-007 ④②）；
//   · 只有走到 insert 前才调 `allow()`；格式非法或窗口内新建过密 ⇒ 拒绝。
//
// ⚠️ 刻意零依赖（不 import Nest / supabase / fs），好让 M28 能单编后直接
//    require 测纯函数。进程内单例仅适用于 L3 单实例；多实例须换共享计数
//    （P-007 ④ 边界，见 GK-QA-16）。
// ============================================================

/** device_id 长度下界：短于 4 字符一律视为垃圾（真实生成式至少 12+） */
export const DEVICE_ID_MIN_LENGTH = 4
/** device_id 长度上界：防超长串把日志与索引撑爆 */
export const DEVICE_ID_MAX_LENGTH = 128
/**
 * 允许的字符：ASCII 字母 / 数字 / `_` `-` `.`。
 * ⚠️ 必须放行**现存格式**：前端 `dev_xxx`、验证套件 `verify-xxx-m27`、
 *   历史 `gk_xxx`、UUID、纯数字串。收紧这个字符集等于把老用户判成非法
 *   ⇒ 换手机后题目不见了（P-007 ⑤ falsifier #2，最坏情况）。
 * 拒绝的是：空串、首尾空白、控制字符、中文 / 引号 / 斜杠等明显构造串。
 */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_.-]+$/

/** 滑动窗口长度（毫秒）：1 分钟 */
export const GATE_WINDOW_MS = 60_000
/**
 * 单个窗口内允许新建的最大匿名行数。
 * 正常量级参考：一次全量 `pnpm verify` 只用 3 个不同 device tag ⇒ 3 行；
 * 一个家庭几台设备一天也只新建个位数行。30 足以挡住「脚本一秒换几百个串」，
 * 又不会误伤真人或验证套件。收紧 / 放宽必须同步改 P-007 ⑤ 与 M28。
 */
export const GATE_MAX_CREATES = 30

export type GateReason = 'INVALID_FORMAT' | 'RATE_LIMITED'

export interface GateDecision {
  allowed: boolean
  reason?: GateReason
}

/**
 * 格式校验：宽松白名单，只挡明显垃圾，不做「是不是真用户」的身份判断。
 * 返回 false 时调用方**不得**新建 users 行（但已有行仍可正常找回）。
 */
export function isValidDeviceId(id: unknown): boolean {
  if (typeof id !== 'string') return false
  if (id.length < DEVICE_ID_MIN_LENGTH || id.length > DEVICE_ID_MAX_LENGTH) return false
  if (id !== id.trim()) return false
  return DEVICE_ID_PATTERN.test(id)
}

/** 闸门拒绝时抛出的专用错误（让 /api/auth/anonymous 能如实回报，而不是伪装成 400 缺参数） */
export class AnonymousCreationRejectedError extends Error {
  readonly reason: GateReason
  constructor(reason: GateReason) {
    super(`匿名建号被闸门拒绝：${reason}`)
    this.name = 'AnonymousCreationRejectedError'
    this.reason = reason
  }
}

/**
 * 进程内滑动窗口计数器。
 * `now` 可注入，便于 M28 用时钟替身测阈值，不依赖真实等待。
 */
export class AnonymousCreationGate {
  private readonly windowMs: number
  private readonly maxCreates: number
  private readonly now: () => number
  private stamps: number[] = []
  private blockedCount = 0

  constructor(opts: { windowMs?: number; maxCreates?: number; now?: () => number } = {}) {
    this.windowMs = opts.windowMs ?? GATE_WINDOW_MS
    this.maxCreates = opts.maxCreates ?? GATE_MAX_CREATES
    this.now = opts.now ?? Date.now
  }

  /**
   * ⚠️ 只允许在「确实要新建匿名行」时调用，find 分支不得调用。
   * 通过时记一次戳；拒绝时不记戳（窗口内持续拒绝，直到旧戳滑出）。
   */
  allow(deviceId: string): GateDecision {
    if (!isValidDeviceId(deviceId)) return { allowed: false, reason: 'INVALID_FORMAT' }
    const t = this.now()
    const cutoff = t - this.windowMs
    this.stamps = this.stamps.filter((s) => s > cutoff)
    if (this.stamps.length >= this.maxCreates) {
      this.blockedCount += 1
      return { allowed: false, reason: 'RATE_LIMITED' }
    }
    this.stamps.push(t)
    return { allowed: true }
  }

  /** 只读统计，供日志 / 验证用 */
  stats(): { inWindow: number; blocked: number; windowMs: number; maxCreates: number } {
    const cutoff = this.now() - this.windowMs
    return {
      inWindow: this.stamps.filter((s) => s > cutoff).length,
      blocked: this.blockedCount,
      windowMs: this.windowMs,
      maxCreates: this.maxCreates,
    }
  }
}

/** 进程内单例：L3 单实例部署下全局共用一份计数 */
export const anonymousCreationGate = new AnonymousCreationGate()
