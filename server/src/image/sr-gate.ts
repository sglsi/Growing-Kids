/**
 * 【Phase 2 后续】智能高清（SR）服务端限流 + 排队。
 *
 * ── 为什么要做（压测实测，1 核虚拟主机 / 1600×1200）─────────────────────────
 *   | 倍率 | 模式      | p50 单图 | 4 路并发端到端 |
 *   | x2   | classical | 1019ms   | 4162ms         |
 *   | x2   | espcn     | 3322ms   | 13186ms        |
 *   | x3   | classical | 2277ms   | 9141ms         |
 *   | x3   | espcn     | 5434ms   | 21898ms        |
 *
 * 关键事实：`superResolveESPCN` 是**纯 JS 嵌套循环 → 同步阻塞 Node 事件循环**；
 * classical 路径靠 sharp/libvips（异步，但同样把 CPU 吃满）。二者都**独占 CPU**。
 * 1 核机器上 4 路并发 ESPCN → 端到端 22 秒，且会把**整个服务其它请求**一起拖死。
 * ⇒ 光「限频」不够，必须**限制同时在跑的重任务数（并发闸）**。
 *
 * ── 两道防线（用户已确认「两者都做」）─────────────────────────────────────
 *   ① 全局并发闸 `SrGate`：双泳道（light/heavy）+ 权重计费 + FIFO 排队 + 排队超时。
 *      → 防 CPU 雪崩，保护小主机。
 *   ② 用户级配额 `SrUserQuota`：滑动窗口限次 + 同时进行数。
 *      → 防单用户滥用（拖垮所有人的服务）。
 *
 * ── 任务分级（用户已确认口径）─────────────────────────────────────────────
 *   heavy = scale >= 3 || mode === 'espcn'；仅 x2-classical 为 light（宽松）。
 *
 * ── 超限行为（用户已确认）────────────────────────────────────────────────
 *   排队超时/队列满 → 友好降级提示（引导改选 x2），不硬拒、不静默降级。
 *
 * ── 诚实局限 ─────────────────────────────────────────────────────────────
 *   · 闸是**进程内**的：PM2 cluster / 多副本下各进程独立计数 ⇒ 实际全局并发
 *     = 额度 × 进程数。生产多副本需改 Redis 信号量（本期不做）。
 *   · 排队会占着 HTTP 连接（默认最多 20s）；小并发可接受。
 *   · 并发闸限制的是「同时数」，无法消除单次同步阻塞（彻底解法是 worker_threads，后续项）。
 *
 * 本模块**纯逻辑、无 Nest / DB 依赖**，便于单测。
 */

// ============================ 1. 任务分级 ============================

export type SrScale = 2 | 3 | 4
export type SrMode = 'classical' | 'espcn'
export type SrLane = 'light' | 'heavy'

export interface SrClass {
  /** 是否重任务（需限流） */
  heavy: boolean
  /** 所属泳道 */
  lane: SrLane
  /** CPU 占用权重（依据实测延迟比例定档），用于并发计费 */
  cost: 1 | 2 | 3
}

/**
 * 任务分级（纯函数）。
 *
 * cost 依据实测 p50 延迟比例定档（以 x2-classical≈1.0s 为 1 个单位）：
 *   x2-classical ≈ 1.0s → 1
 *   x3-classical ≈ 2.3s → 2
 *   x4-classical ≈ 3.4s → 3
 *   espcn（任意倍率）≈ 3.3~5.4s → 3
 */
export function classifySr(scale: SrScale, mode: SrMode): SrClass {
  const heavy = scale >= 3 || mode === 'espcn'
  if (!heavy) return { heavy: false, lane: 'light', cost: 1 }
  if (mode === 'espcn') return { heavy: true, lane: 'heavy', cost: 3 }
  return { heavy: true, lane: 'heavy', cost: scale === 4 ? 3 : 2 }
}

// ============================ 2. 并发闸 ============================

export type AcquireFail = 'timeout' | 'queue_full' | 'aborted'

export interface AcquireOptions {
  /** 排队等待上限（ms），超过即失败返回 timeout */
  timeoutMs?: number
}

export interface AcquireResult {
  ok: boolean
  /** 失败原因（ok=false 时有值） */
  reason?: AcquireFail
  /** 已等待时长（ms） */
  waitedMs?: number
  /** 获得的额度权重（release 时需原样归还） */
  cost?: number
}

interface Waiter {
  lane: SrLane
  cost: number
  /** 入队时间戳，用于计算等待时长 */
  at: number
  resolve: (r: AcquireResult) => void
  timer?: NodeJS.Timeout
}

export interface GateStats {
  runningLight: number
  runningHeavyCost: number
  queued: number
  /** 累计拒绝（超时 + 队列满） */
  rejected: number
}

const numEnv = (key: string, def: number): number => {
  const v = Number(process.env[key])
  return Number.isFinite(v) && v >= 0 ? v : def
}

/**
 * 全局并发闸（双泳道 + 权重计费 + FIFO 排队）。
 *
 * 泳道额度：
 *   light  = IMG_SR_CONCURRENCY_LIGHT（默认 2）—— 轻任务并发**个数**
 *   heavy  = IMG_SR_CONCURRENCY_HEAVY（默认 1）—— 重任务并发**权重和**（1 核机器跑满即 1）
 *
 * 权重计费让「一个 x4(3) 顶三个 x2(1)」真实反映 CPU 占用，避免把重量级任务当轻量并行。
 */
export class SrGate {
  private runningLight = 0
  private runningHeavyCost = 0
  private readonly queue: Waiter[] = []
  private rejected = 0

  get lightLimit(): number {
    return numEnv('IMG_SR_CONCURRENCY_LIGHT', 2)
  }

  get heavyLimit(): number {
    return numEnv('IMG_SR_CONCURRENCY_HEAVY', 1)
  }

  get queueMax(): number {
    return numEnv('IMG_SR_QUEUE_MAX', 8)
  }

  private laneLimit(lane: SrLane): number {
    return lane === 'light' ? this.lightLimit : this.heavyLimit
  }

  /**
   * 当前可容纳该 cost（不排队、直接进）。
   *
   * ⚠️ 关键：**门槛额度必须能容纳「单个最重任务」**，否则会死锁
   *   —— 若 heavyLimit=1 而某任务 cost=3，则 `0+3<=1` 恒假，该任务永远排不进、
   *   只能等到超时被拒（实测踩过：x3/x4/espcn 全部被误拒）。
   *   故实际额度取 `max(配置额度, 该任务 cost)`，保证「宁可放一个重的，也不要全饿死」。
   */
  private canRunNow(lane: SrLane, cost: number): boolean {
    if (lane === 'light') return this.runningLight + 1 <= this.lightLimit
    const effective = Math.max(this.heavyLimit, cost)
    return this.runningHeavyCost + cost <= effective
  }

  /** 当前泳道已有占用（用于决定是否需要排队，避免插队） */
  private laneBusy(lane: SrLane): boolean {
    return lane === 'light' ? this.runningLight > 0 : this.runningHeavyCost > 0
  }

  /**
   * 申请执行额度。成功返回 `{ ok:true, cost }`，调用方**必须**在 finally 中 `release(cost, lane)`。
   *
   * 规则：
   *   - 队列为空且额度够 → 立即执行；
   *   - 否则入队 FIFO 等待（受 timeoutMs 与 queueMax 约束）；
   *   - 队列满 → 立即 `queue_full`（不无限积压）。
   */
  acquire(cost: number, lane: SrLane, opts: AcquireOptions = {}): Promise<AcquireResult> {
    const timeoutMs = opts.timeoutMs ?? numEnv('IMG_SR_QUEUE_TIMEOUT_MS', 20000)

    // 直接可跑：队列为空（保证 FIFO 公平，不插队）且额度足够
    if (this.queue.length === 0 && this.canRunNow(lane, cost)) {
      this.consume(lane, cost)
      return Promise.resolve({ ok: true, cost, waitedMs: 0 })
    }

    // 队列满 → 立即拒绝
    if (this.queue.length >= this.queueMax) {
      this.rejected += 1
      return Promise.resolve({ ok: false, reason: 'queue_full', waitedMs: 0 })
    }

    // 入队等待
    return new Promise<AcquireResult>((resolve) => {
      const waiter: Waiter = { lane, cost, at: Date.now(), resolve }
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const i = this.queue.indexOf(waiter)
          if (i >= 0) this.queue.splice(i, 1)
          this.rejected += 1
          resolve({ ok: false, reason: 'timeout', waitedMs: Date.now() - waiter.at })
        }, timeoutMs)
      }
      this.queue.push(waiter)
    })
  }

  /** 归还额度并唤醒队首 */
  release(cost: number, lane: SrLane): void {
    if (lane === 'light') this.runningLight = Math.max(0, this.runningLight - 1)
    else this.runningHeavyCost = Math.max(0, this.runningHeavyCost - cost)
    this.pump()
  }

  /** 占住额度（内部） */
  private consume(lane: SrLane, cost: number): void {
    if (lane === 'light') this.runningLight += 1
    else this.runningHeavyCost += cost
  }

  /** 尝试唤醒队首（额度够则出队执行） */
  private pump(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0]
      if (!this.canRunNow(head.lane, head.cost)) break
      this.queue.shift()
      if (head.timer) clearTimeout(head.timer)
      this.consume(head.lane, head.cost)
      head.resolve({ ok: true, cost: head.cost, waitedMs: Date.now() - head.at })
    }
  }

  stats(): GateStats {
    return {
      runningLight: this.runningLight,
      runningHeavyCost: this.runningHeavyCost,
      queued: this.queue.length,
      rejected: this.rejected,
    }
  }

  /** 仅供测试：重置全部状态 */
  reset(): void {
    for (const w of this.queue) if (w.timer) clearTimeout(w.timer)
    this.queue.length = 0
    this.runningLight = 0
    this.runningHeavyCost = 0
    this.rejected = 0
  }
}

// ============================ 3. 用户级配额 ============================

export interface UserQuotaFail {
  ok: false
  code: 'SR_RATE_LIMIT' | 'SR_USER_BUSY'
  retryAfterMs: number
  msg: string
}

export interface UserQuotaOk {
  ok: true
}

export type UserQuotaResult = UserQuotaOk | UserQuotaFail

interface UserState {
  /** 本窗口内已完成/发起的次数 */
  hits: number
  /** 当前同时进行数 */
  running: number
  /** 窗口起点 */
  windowAt: number
}

/**
 * 用户级配额（进程内，滑动窗口 + 同时进行数）。
 *
 *   IMG_SR_USER_RATE（默认 6）      —— 每用户每 60s 内 heavy 次数上限
 *   IMG_SR_USER_CONCURRENT（默认 1）—— 每用户 heavy 同时进行数
 *
 * 说明：限流是**进程内保护**，重启即重置，可接受（无需 DB）。
 */
export class SrUserQuota {
  private readonly map = new Map<string, UserState>()
  private static readonly WINDOW_MS = 60_000

  get rateLimit(): number {
    return numEnv('IMG_SR_USER_RATE', 6)
  }

  get concurrentLimit(): number {
    return numEnv('IMG_SR_USER_CONCURRENT', 1)
  }

  /** 检查并占用（成功返回 ok:true，需在 finally 中 releaseUser） */
  check(userId: string): UserQuotaResult {
    const key = userId || '__anon__'
    const now = Date.now()
    let st = this.map.get(key)
    if (!st || now - st.windowAt >= SrUserQuota.WINDOW_MS) {
      st = { hits: 0, running: 0, windowAt: now }
      this.map.set(key, st)
    }

    if (st.running >= this.concurrentLimit) {
      return {
        ok: false,
        code: 'SR_USER_BUSY',
        retryAfterMs: 2000,
        msg: '你还有一张高清图正在处理，请等它完成后再试',
      }
    }

    if (st.hits + 1 > this.rateLimit) {
      const elapsed = now - st.windowAt
      return {
        ok: false,
        code: 'SR_RATE_LIMIT',
        retryAfterMs: Math.max(1000, SrUserQuota.WINDOW_MS - elapsed),
        msg: `高清处理太频繁（每分钟上限 ${this.rateLimit} 次），请稍后再试`,
      }
    }

    st.hits += 1
    st.running += 1
    return { ok: true }
  }

  /** 释放同时进行数 */
  releaseUser(userId: string): void {
    const st = this.map.get(userId || '__anon__')
    if (st) st.running = Math.max(0, st.running - 1)
  }

  /** 惰性清理过期窗口（避免 Map 无限增长） */
  sweep(now = Date.now()): void {
    for (const [k, st] of this.map) {
      if (now - st.windowAt >= SrUserQuota.WINDOW_MS && st.running === 0) this.map.delete(k)
    }
  }

  /** 仅供测试 */
  reset(): void {
    this.map.clear()
  }
}

// ============================ 4. 全局单例 ============================

/** 全局并发闸（进程内单例） */
export const srGate = new SrGate()
/** 用户级配额（进程内单例） */
export const srUserQuota = new SrUserQuota()

/** 开关：IMG_SR_GATE=off 一键回退旧行为（不设闸、不设用户配额） */
export function srGateEnabled(): boolean {
  return (process.env.IMG_SR_GATE || 'on').toLowerCase() !== 'off'
}
