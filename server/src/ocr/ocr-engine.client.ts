import type { LocalOcrResult } from './ocr.types'
import {
  type OcrTelemetry,
  type OcrAlertSink,
  OcrHealthProbe,
  getOcrTelemetry,
  getOcrAlertSink,
} from './ocr-health'
import { toolOcr, toolInvokeEnabled } from './ocr-tool'

export type LocalOcrMode = 'both' | 'rapid' | 'paddle'

export interface LocalOcrClientOptions {
  baseUrl?: string
  timeoutMs?: number
  mode?: LocalOcrMode
  /** 埋点（成功率/降级率统计）。默认共享 getOcrTelemetry 单例。 */
  telemetry?: OcrTelemetry
  /** 告警上报。默认共享 getOcrAlertSink 单例。 */
  alertSink?: OcrAlertSink
  /** 是否随客户端自动启动健康探针（定时探活 + 失联告警）。默认 true。 */
  autoProbe?: boolean
  /** 探针周期（ms）。默认 30s，可用 OCR_HEALTH_PROBE_MS 覆盖。 */
  probeIntervalMs?: number
  /** 探针连续失败达此次数才告警（防抖）。默认 3，可用 OCR_HEALTH_FAILS 覆盖。 */
  probeFailThreshold?: number
  /** 「可用率跌阈值自动告警」阈值（0~1）。默认 0.8，可用 OCR_AVAIL_WARN_THRESHOLD 覆盖。 */
  availThreshold?: number
  /** 评估可用率所需的最小窗口样本数，低于则视为无信号不告警。默认 5，可用 OCR_AVAIL_MIN_SAMPLES 覆盖。 */
  availMinSamples?: number
  /** 可用率连续低于阈值的 tick 次数达此值才告警（防抖）。默认 3，可用 OCR_AVAIL_FAILS 覆盖。 */
  availFailThreshold?: number
}

/**
 * 本地 OCR 侧车客户端（PaddleOCR + RapidOCR 融合，平台独立部署）。
 *
 * 设计原则（与 VLM 兜底配合）：
 * - 任何失败（网络/超时/非 200/解析异常）都返回 `null`，**绝不抛错**，
 *   交由上层 OcrService 降级到 VLM 或纯文字退化。
 * - 使用 Node 内置 fetch（无需额外 HTTP 依赖）。
 */
export class LocalOcrClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly mode: LocalOcrMode
  private readonly telemetry: OcrTelemetry
  private readonly alertSink: OcrAlertSink
  private readonly probe: OcrHealthProbe | null
  private probeStop: (() => void) | null = null

  constructor(opts: LocalOcrClientOptions = {}) {
    // 默认端口 9300（沙箱 9000 被 Coze 平台内部 uvicorn 代理占用，/recognize 会 401）
    this.baseUrl = opts.baseUrl ?? process.env.OCR_ENGINE_URL ?? 'http://127.0.0.1:9300'
    // 本地 OCR 在 CPU 上首帧/大图可能需数十秒（模型推理），默认放宽到 60s，
    // 并允许通过 OCR_TIMEOUT_MS 覆盖。超时即视为失败 → 降级 VLM。
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.OCR_TIMEOUT_MS ?? 60_000)
    this.mode = opts.mode ?? 'both'
    this.telemetry = opts.telemetry ?? getOcrTelemetry()
    this.alertSink = opts.alertSink ?? getOcrAlertSink()

    const autoProbe = opts.autoProbe ?? (process.env.OCR_AUTO_PROBE ?? 'true') !== 'false'
    const probeIntervalMs = opts.probeIntervalMs ?? Number(process.env.OCR_HEALTH_PROBE_MS ?? 30_000)
    const probeFailThreshold = opts.probeFailThreshold ?? Number(process.env.OCR_HEALTH_FAILS ?? 3)
    if (autoProbe) {
      this.probe = new OcrHealthProbe({
        probe: () => this.health(),
        intervalMs: probeIntervalMs,
        failThreshold: probeFailThreshold,
        alertSink: this.alertSink,
        telemetry: this.telemetry,
        label: this.baseUrl,
        // 「可用率跌阈值自动告警」：默认 80% 可用率告警、样本≥5、连续 3 次触发
        availThreshold: opts.availThreshold ?? Number(process.env.OCR_AVAIL_WARN_THRESHOLD ?? 0.8),
        availMinSamples: opts.availMinSamples ?? Number(process.env.OCR_AVAIL_MIN_SAMPLES ?? 5),
        availFailThreshold: opts.availFailThreshold ?? Number(process.env.OCR_AVAIL_FAILS ?? 3),
      })
    } else {
      this.probe = null
    }
    // autoProbe 即"自动启动探针"：构造后立即开始定时探活（startProbe 幂等，重复调用安全）
    if (this.probe) this.startProbe()
  }

  async recognizeByUrl(imageUrl: string, mode: LocalOcrMode = this.mode): Promise<LocalOcrResult | null> {
    return this.post({ image_url: imageUrl, mode })
  }

  async recognizeByBase64(b64: string, mode: LocalOcrMode = this.mode): Promise<LocalOcrResult | null> {
    // 工具式调用（默认）：进程隔离 + 硬超时，崩/卡只影响当次、下条自动恢复（见 ocr-tool.ts）。
    if (toolInvokeEnabled()) {
      const raw = b64.includes(',') ? b64.split(',', 1)[1] : b64
      const r = await toolOcr(Buffer.from(raw, 'base64'), { op: 'recognize', mode })
      if (r.ok && r.data) {
        this.telemetry.markSuccess()
        return r.data as unknown as LocalOcrResult
      }
      this.telemetry.markDegrade(`tool_${r.reason ?? 'failed'}`)
      return null
    }
    return this.post({ image_base64: b64, mode })
  }

  async health(): Promise<boolean> {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 3000)
    try {
      const res = await fetch(`${this.baseUrl}/healthz`, { signal: ctrl.signal })
      return res.ok
    } catch {
      return false
    } finally {
      clearTimeout(t)
    }
  }

  private async post(body: Record<string, unknown>): Promise<LocalOcrResult | null> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}/recognize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      if (!res.ok) {
        console.warn(`[local-ocr] 侧车返回 ${res.status}，降级 VLM`)
        this.telemetry.markDegrade(`http_${res.status}`)
        return null
      }
      this.telemetry.markSuccess()
      return (await res.json()) as LocalOcrResult
    } catch (e) {
      console.warn(`[local-ocr] 调用失败，降级 VLM: ${String((e as Error)?.message ?? e)}`)
      this.telemetry.markDegrade('error')
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** 启动主动健康探针（定时探活 + 连续失败告警）。已启动则 no-op。 */
  startProbe(): void {
    this.probe?.start()
  }

  /** 停止健康探针并释放定时器。 */
  stopProbe(): void {
    this.probe?.stop()
  }

  /** 调试/监控用：返回埋点快照与当前 baseUrl。 */
  getDiagnostics() {
    return {
      baseUrl: this.baseUrl,
      telemetry: this.telemetry.snapshot(),
    }
  }
}
