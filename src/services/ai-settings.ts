// ============================================================
// AI 外发开关的本地视图（OPS-18 R-合规-02）
//
// 口径（思傅 2026-10-27 定）：由用户自己决定是否开放 ima 与 LLM 访问。
//   未开启 ⇒ 仅本地：本机 OCR 侧车 + 本地题库，任何内容不出机器
//   已开启 ⇒ 才允许联网检索 / ima 知识库 / 大模型
//
// 这个模块只做三件事：
//   1. 缓存开关值（避免每个页面各自请求一次）；
//   2. 单飞（并发调用只发一次请求，防止首页同时挂三个卡片就发三次）；
//   3. 给调用点一个**同步**判断 `peekAiEnabled()`，用于"点了才提示"，而不是先请求再拦。
//
// ⚠️ 真正的控制点在服务端 `requireAiEnabled()`。这里是体验层：
//    只靠前端判断等于没有控制（拿到接口就绕过去了）。
// ============================================================
import { getSettings, setAiEnabled } from '@/services/api'

/** null = 还没读到（未知）；true/false = 已知 */
let cached: boolean | null = null
let inflight: Promise<boolean> | null = null

/** 仅本地模式的统一提示语（各处复用，避免同一件事三种说法） */
export const AI_DISABLED_HINT = '未开启 AI 与在线检索（当前仅本地处理），可在「我的 · 隐私与账号」中开启'

/** 同步读缓存：未知时返回 false（宁可少放行，也不要先发出去再道歉） */
export function peekAiEnabled(): boolean {
  return cached === true
}

/** 是否已经读到过开关值 */
export function aiSettingLoaded(): boolean {
  return cached !== null
}

/**
 * 确保开关值已加载；失败按「未开启」处理（fail-closed）。
 * @param force 强制重新拉取（用户刚改完开关、或怀疑缓存过期）
 */
export function ensureAiSetting(force = false): Promise<boolean> {
  if (!force && cached !== null) return Promise.resolve(cached)
  if (inflight) return inflight
  inflight = getSettings()
    .then((s) => {
      cached = s?.ai_enabled === true
      return cached
    })
    .catch((e) => {
      // 读不到就当没开：这只会让用户少一个功能，不会让数据多流出去一次
      console.warn('[ai-settings] 读取开关失败，按「仅本地」处理', e)
      cached = false
      return false
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** 保存开关并同步本地缓存 */
export async function updateAiEnabled(enabled: boolean): Promise<boolean> {
  const r = await setAiEnabled(enabled)
  cached = r?.ai_enabled === true
  return cached
}

/** 登出/切换账号时清空，避免把上一个账号的授权状态带给下一个人 */
export function clearAiSetting(): void {
  cached = null
  inflight = null
}
