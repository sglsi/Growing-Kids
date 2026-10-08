import type { LocalOcrResult } from './ocr.types'

export type LocalOcrMode = 'both' | 'rapid' | 'paddle'

export interface LocalOcrClientOptions {
  baseUrl?: string
  timeoutMs?: number
  mode?: LocalOcrMode
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

  constructor(opts: LocalOcrClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? process.env.OCR_ENGINE_URL ?? 'http://127.0.0.1:9000'
    // 本地 OCR 在 CPU 上首帧/大图可能需数十秒（模型推理），默认放宽到 60s，
    // 并允许通过 OCR_TIMEOUT_MS 覆盖。超时即视为失败 → 降级 VLM。
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.OCR_TIMEOUT_MS ?? 60_000)
    this.mode = opts.mode ?? 'both'
  }

  async recognizeByUrl(imageUrl: string, mode: LocalOcrMode = this.mode): Promise<LocalOcrResult | null> {
    return this.post({ image_url: imageUrl, mode })
  }

  async recognizeByBase64(b64: string, mode: LocalOcrMode = this.mode): Promise<LocalOcrResult | null> {
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
        return null
      }
      return (await res.json()) as LocalOcrResult
    } catch (e) {
      console.warn(`[local-ocr] 调用失败，降级 VLM: ${String((e as Error)?.message ?? e)}`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}
