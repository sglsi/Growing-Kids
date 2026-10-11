/**
 * 本地 OCR 侧车的「埋点 + 健康探针 + 告警」基础设施。
 *
 * 设计动机：侧车是独立进程，宕机时 OcrService 会静默降级到 VLM（见 LocalOcrClient / sidecar.supervisor），
 * 系统从外部看"一切正常"——这会导致"侧车失联无人知晓"的隐患。本模块把"健康态可见化"：
 *  - OcrTelemetry：每次本地 OCR 调用的成功/降级埋点，滑动窗口算"侧车可用率/降级率"。
 *  - OcrHealthProbe：独立于业务调用的主动探活，侧车连续失联触发告警、恢复时通知。
 *  - OcrAlertSink：可插拔告警（默认 console；配 OCR_ALERT_WEBHOOK_URL 走 webhook）。
 *
 * 全部默认 no-op 友好：不传则走内存实现 + console，零外部依赖。
 */

// ----------------------------- 埋点（telemetry） -----------------------------

export interface OcrTelemetry {
  /** 侧车 HTTP 调用成功（200 + 可解析），记一次成功。 */
  markSuccess(): void
  /** 侧车调用失败（非 200 / 超时 / 异常），记一次降级。reason 用于诊断。 */
  markDegrade(reason: string): void
  /** 主动健康探测结果。ok=false 累加连续失败计数（供快照参考）。 */
  markHealthCheck(ok: boolean): void
  /** 最近窗口内成功率（0~1），无样本返回 null。 */
  successRate(): number | null
  /** 最近窗口内降级率（0~1），无样本返回 null。 */
  degradeRatio(): number | null
  /** 当前统计快照。 */
  snapshot(): OcrTelemetrySnapshot
  reset(): void
}

export interface OcrTelemetrySnapshot {
  total: number
  success: number
  degrade: number
  successRate: number | null
  degradeRatio: number | null
  recentHealthFails: number
  windowMs: number
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1000
const DEFAULT_CAP = 2000

export class InMemoryOcrTelemetry implements OcrTelemetry {
  private events: { t: number; kind: 'success' | 'degrade' }[] = []
  private healthFails = 0

  constructor(
    private readonly windowMs: number = DEFAULT_WINDOW_MS,
    private readonly cap: number = DEFAULT_CAP,
  ) {}

  private push(kind: 'success' | 'degrade'): void {
    this.events.push({ t: Date.now(), kind })
    if (this.events.length > this.cap) this.events.shift()
  }

  markSuccess(): void {
    this.push('success')
  }

  markDegrade(reason: string): void {
    this.push('degrade')
    if (reason) {
      // reason 仅用于未来可能的分类统计，这里静默消费，避免无谓日志
    }
  }

  markHealthCheck(ok: boolean): void {
    if (ok) this.healthFails = 0
    else this.healthFails++
  }

  private windowed(): { success: number; degrade: number; total: number } {
    const cut = Date.now() - this.windowMs
    let success = 0
    let degrade = 0
    for (const e of this.events) {
      if (e.t < cut) continue
      if (e.kind === 'success') success++
      else degrade++
    }
    return { success, degrade, total: success + degrade }
  }

  successRate(): number | null {
    const w = this.windowed()
    return w.total ? w.success / w.total : null
  }

  degradeRatio(): number | null {
    const w = this.windowed()
    return w.total ? w.degrade / w.total : null
  }

  snapshot(): OcrTelemetrySnapshot {
    const w = this.windowed()
    return {
      total: w.total,
      success: w.success,
      degrade: w.degrade,
      successRate: w.total ? w.success / w.total : null,
      degradeRatio: w.total ? w.degrade / w.total : null,
      recentHealthFails: this.healthFails,
      windowMs: this.windowMs,
    }
  }

  reset(): void {
    this.events = []
    this.healthFails = 0
  }
}

// ------------------------------- 告警（sink） --------------------------------

export interface OcrAlertSink {
  /** event 形如 'sidecar-unreachable' / 'sidecar-recovered' / 'sidecar-startup-failed' / 'sidecar-unhealthy' */
  alert(event: string, detail?: Record<string, unknown>): void
}

export class ConsoleAlertSink implements OcrAlertSink {
  alert(event: string, detail?: Record<string, unknown>): void {
    const tail = detail && Object.keys(detail).length ? ' ' + JSON.stringify(detail) : ''
    // 用 warn 而非 error：告警不应中断主链路日志流，但要在 stderr 突出
    console.warn(`[ocr-alert] ${event}${tail}`)
  }
}

export type AlertWebhookType = 'generic' | 'wecom' | 'feishu'

/**
 * Webhook 告警出口。按 `type` 组装不同平台要求的消息体：
 * - generic：纯 JSON（`{event,detail,ts}`），兼容自建接收端 / n8n / 任意 webhook；
 * - wecom：企业微信机器人，要求 `{msgtype:"markdown",markdown:{content}}`；
 * - feishu：飞书自定义机器人，要求 `{msg_type:"text",content:{text}}`。
 *
 * 任一格式下都先走 `fallback` 同步打印，确保 webhook 失败时仍有本地留痕。
 */
export class WebhookAlertSink implements OcrAlertSink {
  constructor(
    private readonly url: string,
    private readonly type: AlertWebhookType = 'generic',
    private readonly fallback: OcrAlertSink = new ConsoleAlertSink(),
  ) {}

  alert(event: string, detail?: Record<string, unknown>): void {
    // 兜底同步打印，确保即使 webhook 失败也有留痕
    this.fallback.alert(event, detail)
    const body = this.buildBody(event, detail)
    fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {
      /* webhook 失败不阻断，兜底已打印 */
    })
  }

  private buildBody(event: string, detail?: Record<string, unknown>): unknown {
    const detailStr =
      detail && Object.keys(detail).length ? '\n' + JSON.stringify(detail) : ''
    const text = `[OCR告警] ${event}${detailStr}`
    switch (this.type) {
      case 'wecom':
        return {
          msgtype: 'markdown',
          markdown: { content: `**OCR 告警**\n> ${event}${detailStr}` },
        }
      case 'feishu':
        return { msg_type: 'text', content: { text } }
      case 'generic':
      default:
        return { event, detail: detail ?? {}, ts: Date.now() }
    }
  }
}

// ------------------------------ 健康探针（probe） ----------------------------

export interface OcrHealthProbeOptions {
  /** 返回 true 表示侧车健康（通常封装 LocalOcrClient.health / supervisor.isHealthy） */
  probe: () => Promise<boolean>
  /** 探测周期（ms），默认 30s */
  intervalMs?: number
  /** 连续失败达到该次数才告警，避免抖动误报。默认 3 */
  failThreshold?: number
  alertSink?: OcrAlertSink
  telemetry?: OcrTelemetry
  /** 探针标签（多侧车场景区分），进告警明细 */
  label?: string
  /**
   * 「可用率跌到阈值自动告警」：读取埋点滑动窗口的 successRate()，低于 availThreshold
   * 且窗口样本数 ≥ availMinSamples 时，连续 availFailThreshold 次触发 `sidecar-low-availability`，
   * 恢复到阈值之上（或窗口无样本）时触发 `sidecar-availability-recovered`。
   * 默认启用：threshold=0.8 / minSamples=5 / fails=3。设为 NaN 或 ≤0 关闭本能力。
   */
  availThreshold?: number
  /** 窗口样本数低于此值时不评估可用率（避免空闲期误报）。默认 5 */
  availMinSamples?: number
  /** 连续低于阈值的 tick 次数达此值才告警，默认 3 */
  availFailThreshold?: number
}

/**
 * 主动健康探针：独立于业务调用周期地探活侧车，连续失败超阈值触发 'sidecar-unreachable' 告警，
 * 恢复后触发 'sidecar-recovered'。不依赖"调用失败才降级"的被动路径，让侧车失联成为可知事件。
 */
export class OcrHealthProbe {
  private timer: NodeJS.Timeout | null = null
  private consecutive = 0
  private alerted = false
  private readonly intervalMs: number
  private readonly failThreshold: number
  private readonly alertSink: OcrAlertSink
  private readonly telemetry?: OcrTelemetry
  private readonly label?: string
  private stopped = false

  // 「可用率跌阈值」状态
  private availConsecutive = 0
  private availAlerted = false
  private readonly availThreshold: number
  private readonly availMinSamples: number
  private readonly availFailThreshold: number

  constructor(private readonly opts: OcrHealthProbeOptions) {
    this.intervalMs = opts.intervalMs ?? 30_000
    this.failThreshold = opts.failThreshold ?? 3
    this.alertSink = opts.alertSink ?? new ConsoleAlertSink()
    this.telemetry = opts.telemetry
    this.label = opts.label
    // 可用率告警默认启用（threshold=0.8）；显式 ≤0/NaN 关闭
    const t = opts.availThreshold ?? 0.8
    this.availThreshold = Number.isFinite(t) && t > 0 ? t : NaN
    this.availMinSamples = opts.availMinSamples ?? 5
    this.availFailThreshold = opts.availFailThreshold ?? 3
  }

  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    this.timer.unref?.()
    void this.tick() // 立即探一次
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    let ok = false
    try {
      ok = await this.opts.probe()
    } catch {
      ok = false
    }
    this.telemetry?.markHealthCheck(ok)
    if (!ok) {
      this.consecutive++
      if (!this.alerted && this.consecutive >= this.failThreshold) {
        this.alertSink.alert('sidecar-unreachable', {
          consecutive: this.consecutive,
          label: this.label,
        })
        this.alerted = true
      }
    } else {
      if (this.alerted) {
        this.alertSink.alert('sidecar-recovered', { label: this.label })
        this.alerted = false
      }
      this.consecutive = 0
    }

    this.evaluateAvailability()
  }

  /**
   * 「可用率跌到阈值自动告警」：与失联告警解耦——
   * 侧车可能"活着但大量请求失败"（如模型加载异常、超时雪崩），此时 health() 仍 ok，
   * 单看探针看不到问题；本评估读埋点滑动窗口的 successRate() 捕捉这类"半死"态。
   * 窗口无样本（successRate=null，空闲期）不评估，避免误报。
   */
  private evaluateAvailability(): void {
    if (!this.telemetry || !Number.isFinite(this.availThreshold)) return
    const snap = this.telemetry.snapshot()
    // 无样本（空闲）或样本不足：视为"无信号"，不告警也不计入连续失败
    if (snap.successRate === null || snap.total < this.availMinSamples) {
      this.availConsecutive = 0
      return
    }
    const below = snap.successRate < this.availThreshold
    if (below) {
      this.availConsecutive++
      if (!this.availAlerted && this.availConsecutive >= this.availFailThreshold) {
        this.alertSink.alert('sidecar-low-availability', {
          successRate: snap.successRate,
          threshold: this.availThreshold,
          samples: snap.total,
          label: this.label,
        })
        this.availAlerted = true
      }
    } else {
      if (this.availAlerted) {
        this.alertSink.alert('sidecar-availability-recovered', {
          successRate: snap.successRate,
          label: this.label,
        })
        this.availAlerted = false
      }
      this.availConsecutive = 0
    }
  }
}

// ------------------------------ 单例（共享） --------------------------------

let _telemetry: OcrTelemetry | null = null
let _sink: OcrAlertSink | null = null

export function getOcrTelemetry(): OcrTelemetry {
  if (!_telemetry) _telemetry = new InMemoryOcrTelemetry()
  return _telemetry
}

export function getOcrAlertSink(): OcrAlertSink {
  if (_sink) return _sink
  const url = process.env.OCR_ALERT_WEBHOOK_URL
  if (url) {
    const type = (process.env.OCR_ALERT_WEBHOOK_TYPE as AlertWebhookType) || 'generic'
    _sink = new WebhookAlertSink(url, type)
  } else {
    _sink = new ConsoleAlertSink()
  }
  return _sink
}

/** 测试/诊断用：重置共享单例（不常用，避免跨用例串扰）。 */
export function _resetOcrHealthSingletons(): void {
  _telemetry = null
  _sink = null
}
