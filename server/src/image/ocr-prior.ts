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
import * as fs from 'fs'

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
  // 默认端口 9300（9000 在部分部署环境被平台内部代理占用，见 2ff820a）
  const url = process.env.OCR_ENGINE_URL || 'http://127.0.0.1:9300'
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

/**
 * 读取文字框：优先使用 OCR_BOXES_JSON 指定的预生成结果（沙箱可复现、不依赖侧车进程），
 * 否则回退到本地 OCR 侧车。返回 null 表示无框 / 不可用。
 */
export async function loadOcrBoxes(imageBuffer: Buffer, jsonPath?: string): Promise<OcrBox[] | null> {
  const p = jsonPath || process.env.OCR_BOXES_JSON
  if (p && fs.existsSync(p)) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
      const regions: Array<{ box: [number, number, number, number]; text?: string; score?: number }> =
        raw.text_regions || raw.regions || (Array.isArray(raw) ? raw : [])
      const boxes = regions
        .filter((r) => r && Array.isArray(r.box) && r.box.length === 4)
        .map((r) => ({ box: r.box, text: r.text ?? '', score: r.score ?? 0 }))
      if (boxes.length) {
        console.log(`[ocr-shield] 从 ${p} 读取文字框 ${boxes.length} 个`)
        return boxes
      }
    } catch (e) {
      console.warn(`[ocr-shield] 读 OCR_BOXES_JSON 失败: ${e instanceof Error ? e.message : e}`)
    }
  }
  return callOcrSidecar(imageBuffer)
}

/**
 * 高置信印刷框的 score 阈值（设计常数，非回归棘轮）。
 *
 * 依据：RapidOCR（PP-OCR 系列）以印刷体为主要训练分布，印刷文字框的识别置信度
 * 系统性高于手写框。annot1–4 实测（OCR 框 vs GT 手写框重叠度标注）：
 *   纯印刷框 n=176 → score 中位 0.983，均值 0.956
 *   手写框   n=27  → score 中位 0.725，均值 0.735
 * 阈值扫描的净收益（护住印刷率 − 误护手写率）在 0.90 / 0.95 同为大值 +0.74，
 * 但 0.95 的误护手写率仅 3.7%（0.90 为 18.5%），故取 0.95 为默认。
 */
export const OCR_PRINT_MIN_SCORE = 0.95

export interface OcrShieldResult {
  /** 禁擦区：255 = 禁止擦除（文字框内/附近），擦除 mask 在该区域内一律置 0 */
  shield: Uint8Array
  /** 真正参与构建禁擦区的框（printOnly 模式下为过滤后的高置信印刷框） */
  boxes: OcrBox[]
  /** OCR 原始全部框（未过滤），便于审计与可视化对照 */
  allBoxes: OcrBox[]
  /** printOnly 模式下被 score 阈值剔除的框（疑似手写）数量 */
  dropped: number
  width: number
  height: number
}

/**
 * 构建"印刷体保护盾"：把 OCR 检测到的文字框作为禁擦区。
 * 去手写擦除 mask 在该区域内一律置 0，从机制上杜绝擦到印刷 / 文字内容（别误伤印刷）。
 *
 * 模式（可组合）：
 *  - surgical=false（默认）：整框 + dilate 作为禁擦区（最强保证，文字框内任何像素都不擦）
 *  - surgical=true：仅"框内深墨"作为禁擦区（更外科，空背景不被无谓保护）
 *  - printOnly=true：只护"高置信印刷框"——score < minScore 的框（疑似手写）不设禁擦区，
 *    照常参与擦除。这是把"整框盾牺牲 ~85% 手写擦除"压下来的关键细化方向。
 *
 * 返回 null 表示无框 / 侧车不可用 / 过滤后无高置信框 → 调用方走原链路（不施加盾）。
 */
export async function buildOcrShieldMask(
  imageBuffer: Buffer,
  opts: {
    jsonPath?: string
    dilate?: number
    surgical?: boolean
    /** 只护高置信印刷框，低分（疑似手写）框不护 */
    printOnly?: boolean
    /** 高置信印刷框 score 阈值，默认 OCR_PRINT_MIN_SCORE=0.95 */
    minScore?: number
  } = {},
): Promise<OcrShieldResult | null> {
  const meta = await sharp(imageBuffer).metadata()
  const W = meta.width!, H = meta.height!
  const allBoxes = await loadOcrBoxes(imageBuffer, opts.jsonPath)
  if (!allBoxes || allBoxes.length === 0) return null
  const dilate = opts.dilate ?? Math.max(3, Math.round(Math.min(W, H) * 0.004))

  let boxes = allBoxes
  let dropped = 0
  if (opts.printOnly) {
    const minScore = typeof opts.minScore === 'number' ? opts.minScore : OCR_PRINT_MIN_SCORE
    boxes = allBoxes.filter((b) => b.score >= minScore)
    dropped = allBoxes.length - boxes.length
    console.log(
      `[ocr-shield] printOnly: score>=${minScore} 保留 ${boxes.length}/${allBoxes.length} 框，剔除疑似手写 ${dropped} 框`,
    )
    if (boxes.length === 0) {
      console.log('[ocr-shield] printOnly 过滤后无高置信印刷框，不施加盾，走原链路')
      return null
    }
  }

  const roi = boxesToRoi(W, H, boxes, dilate)
  let shield = roi
  if (opts.surgical) {
    const dark = await darkInkMask(imageBuffer, W, H)
    shield = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) shield[i] = roi[i] & dark[i]
  }
  let cnt = 0
  for (let i = 0; i < W * H; i++) if (shield[i] > 0) cnt++
  console.log(
    `[ocr-shield] 文字框 ${boxes.length} 个 → 禁擦区 ${(cnt / (W * H) * 100).toFixed(2)}% (surgical=${!!opts.surgical}, printOnly=${!!opts.printOnly}, dilate=${dilate})`,
  )
  return { shield, boxes, allBoxes, dropped, width: W, height: H }
}
