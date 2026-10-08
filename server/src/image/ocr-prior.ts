/**
 * OCR 框先验（去手写集成实验）
 * ------------------------------------------------------------------
 * 思路：先调本地 OCR 侧车拿到"文字检测框"坐标（不画框、不改原图），
 * 再把"落在 OCR 文字框内且本身是深色墨迹"的像素抬为去手写候选。
 *
 * 为什么有效：纯像素下"黑笔手写 ≡ 手写体印刷"无法区分（T7 死结），
 * 但 OCR 框把"哪里有文字"在**区域级**标了出来——框内的深色墨迹
 * 几乎必然是手写或印刷文字（而非纸张/阴影/笔迹外的噪点），
 * 于是把判别器的候选集从"全图深墨"收敛到"文字框内深墨"，
 * 既提升手写召回，又自然降低对框外印刷/背景的误伤。
 *
 * 与 v20.8 manualRects 的区别：manualRects 是整矩形并入（会连同框内印刷体一起擦）；
 * 这里只取"框内深墨"像素，更外科，避免误伤框内印刷结构。
 */
import sharp from 'sharp'

export interface OcrBox {
  box: [number, number, number, number] // [x0, y0, x1, y1] 像素
  text: string
  score: number
}

export interface OcrPriorResult {
  boxes: OcrBox[]
  /** 候选先验 mask：Uint8Array，0 或 255，长度 = W*H */
  prior: Uint8Array
  width: number
  height: number
}

function pctl(arr: Float64Array, q: number): number {
  const s = Float64Array.from(arr).sort()
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))
  return s[idx]
}

/** 调本地 OCR 侧车拿文字框坐标 */
export async function callOcrSidecar(imageBuffer: Buffer): Promise<OcrBox[] | null> {
  const url = process.env.OCR_ENGINE_URL || 'http://127.0.0.1:9000'
  const timeoutMs = Number(process.env.OCR_TIMEOUT_MS || 60000)
  const b64 = imageBuffer.toString('base64')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${url}/recognize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: b64, mode: 'rapid' }),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      console.warn(`[ocr-prior] 侧车返回 ${res.status}，跳过 OCR 先验`)
      return null
    }
    const json = (await res.json()) as {
      text_regions?: Array<{ box: [number, number, number, number]; text?: string; score?: number }>
    }
    const regions = json.text_regions || []
    return regions
      .filter((r) => Array.isArray(r.box) && r.box.length === 4)
      .map((r) => ({ box: r.box, text: r.text ?? '', score: r.score ?? 0 }))
  } catch (e) {
    console.warn(`[ocr-prior] 调侧车失败（${e instanceof Error ? e.message : e}），跳过 OCR 先验`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 把文字框 dilated 后填充成 ROI mask */
function boxesToRoi(W: number, H: number, boxes: OcrBox[], dilate: number): Uint8Array {
  const roi = new Uint8Array(W * H)
  for (const { box } of boxes) {
    const [x0, y0, x1, y1] = box
    const xr0 = Math.max(0, Math.floor(x0 - dilate))
    const yr0 = Math.max(0, Math.floor(y0 - dilate))
    const xr1 = Math.min(W - 1, Math.ceil(x1 + dilate))
    const yr1 = Math.min(H - 1, Math.ceil(y1 + dilate))
    for (let y = yr0; y <= yr1; y++) {
      const row = y * W
      for (let x = xr0; x <= xr1; x++) roi[row + x] = 255
    }
  }
  return roi
}

/** 自适应深墨阈值：纸面亮度 90 分位的 0.6 倍以下视为深墨 */
async function darkInkMask(imageBuffer: Buffer, W: number, H: number): Promise<Uint8Array> {
  const raw = await sharp(imageBuffer).removeAlpha().raw().toBuffer()
  const n = W * H
  const luma = new Float64Array(n)
  let max = 0
  for (let i = 0; i < n; i++) {
    const p = i * 3
    const l = 0.299 * raw[p] + 0.587 * raw[p + 1] + 0.114 * raw[p + 2]
    luma[i] = l
    if (l > max) max = l
  }
  const paper = pctl(luma, 0.9)
  const th = Math.max(40, paper * 0.6)
  const dark = new Uint8Array(n)
  for (let i = 0; i < n; i++) dark[i] = luma[i] < th ? 255 : 0
  return dark
}

/**
 * 构建 OCR 框先验候选 mask。
 * 合并规则：ROI（ dilated 文字框） ∩ 深墨 = 候选；再对未检出深墨但被 OCR 框覆盖的
 * 行级空白作答区做一次轻量外扩（dilate），以容纳压在框边缘的手写。
 * 返回 null 表示侧车不可用 / 无框 → 调用方应走原链路。
 */
export async function buildOcrPriorMask(imageBuffer: Buffer): Promise<OcrPriorResult | null> {
  const meta = await sharp(imageBuffer).metadata()
  const W = meta.width!, H = meta.height!
  const boxes = await callOcrSidecar(imageBuffer)
  if (!boxes || boxes.length === 0) return null

  const dilate = Math.round(Math.min(W, H) * 0.02) // ~29px @1440
  const roi = boxesToRoi(W, H, boxes, dilate)
  const dark = await darkInkMask(imageBuffer, W, H)

  const prior = new Uint8Array(W * H)
  let cnt = 0
  for (let i = 0; i < W * H; i++) {
    const v = roi[i] & dark[i]
    prior[i] = v
    if (v > 0) cnt++
  }
  console.log(`[ocr-prior] 文字框 ${boxes.length} 个 → 候选像素 ${(cnt / (W * H) * 100).toFixed(2)}%`)
  return { boxes, prior, width: W, height: H }
}
