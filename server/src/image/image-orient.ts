/**
 * 图片自动摆正 · 朝向估计（orientation）
 *
 * 目标：把"横拍 / 颠倒 / 侧翻"的试卷图转正，使文字呈水平可读。
 * 覆盖 0° / 90° / 180° / 270° 四种朝向。
 *
 * 设计原则（不依赖大模型 / VLM）：
 *   - 核心判定 **纯几何、零外部依赖、常驻生效**：用「投影轮廓峰数」判断文字是横排还是竖排。
 *     横排图 → 行投影（每行墨迹和）呈强周期性峰谷；竖排图 → 列投影峰更显著。
 *     该信号能**确定性修掉 90°/270° 侧翻**（把图转为横排），且无需任何模型。
 *   - 0° vs 180°、90° vs 270° 属「同一轴内的镜像」，纯几何无法区分（投影对称）。
 *     此时用 **OCR 侧车（CV 模型，非大模型）做最佳努力细化**：比较两候选朝向的 OCR 文本量，取多者。
 *     侧车不可达时回落纯几何结果（侧车自带每行 0/180 角度分类，识别仍正确）。
 *
 * 为什么不直接用大模型：朝向是「结构几何问题」，投影法在 CPU 上毫秒级、离线可用、
 * 不引入外部调用与费用；大模型属杀鸡用牛刀且带来可用性/隐私耦合。
 */

import sharp from 'sharp'
import { estimateSkew } from './image-deskew'

export type OrientationAngle = 0 | 90 | 180 | 270
export type OrientMethod = 'projection' | 'ocr' | 'none'

export interface OrientationResult {
  /** 需对「输入图」施加的旋转角（度），使其转正 */
  angle: OrientationAngle
  method: OrientMethod
  /** 几何判定出的文字主轴 */
  axis: 'horizontal' | 'vertical'
  /** 四个候选朝向的几何分（仅调试用） */
  scores?: Record<OrientationAngle, number>
  /** 是否启用了 OCR 细化 */
  ocrRefined?: boolean
}

const CANDIDATES: OrientationAngle[] = [0, 90, 180, 270]

/** 注入式 OCR 文本量估计（生产用侧车，测试可替换）。返回该图能读出的"文本体量"代理值。 */
export type OcrVolumeFn = (buf: Buffer) => Promise<number>

function localOtsu(hist: Int32Array, total: number): number {
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0
  let wB = 0
  let maxVar = -1
  let threshold = 127
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > maxVar) {
      maxVar = between
      threshold = t
    }
  }
  return threshold
}

/** 投影轮廓的「峰数」：高于均值且为局部极大的采样点个数，表征"文字行/列"的结构强度 */
function peakCount(p: Int32Array): number {
  const n = p.length
  let sum = 0
  for (let i = 0; i < n; i++) sum += p[i]
  if (sum === 0) return 0
  const mean = sum / n
  let cnt = 0
  for (let i = 1; i < n - 1; i++) {
    if (p[i] > mean && p[i] >= p[i - 1] && p[i] >= p[i + 1]) cnt++
  }
  if (p[0] > mean && p[0] >= p[1]) cnt++
  if (p[n - 1] > mean && p[n - 1] >= p[n - 2]) cnt++
  return cnt
}

/** 纯几何朝向分：仅需一次二值化，四个候选由行列投影推导（无需 4 次旋转） */
export function scoreOrientation(ink: Uint8Array, w: number, h: number): {
  scores: Record<OrientationAngle, number>
  axis: 'horizontal' | 'vertical'
} {
  const horiz = new Int32Array(h)
  const vert = new Int32Array(w)
  for (let y = 0; y < h; y++) {
    const base = y * w
    let c = 0
    for (let x = 0; x < w; x++) c += ink[base + x]
    horiz[y] = c
  }
  for (let x = 0; x < w; x++) {
    let c = 0
    for (let y = 0; y < h; y++) c += ink[y * w + x]
    vert[x] = c
  }
  const hp = peakCount(horiz)
  const vp = peakCount(vert)
  // 0/180：横排 → 行峰 - 列峰；90/270：竖排 → 列峰 - 行峰（投影关于镜像对称，无法区分 0 vs 180 / 90 vs 270）
  const scores: Record<OrientationAngle, number> = {
    0: hp - vp,
    90: vp - hp,
    180: hp - vp,
    270: vp - hp,
  }
  return { scores, axis: hp >= vp ? 'horizontal' : 'vertical' }
}

/** 对输入图做二值墨迹（缩小到 ≤800px 以提速，朝向估计对分辨率不敏感） */
async function binarize(buf: Buffer): Promise<{ ink: Uint8Array; w: number; h: number }> {
  const { data, info } = await sharp(buf)
    .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const w = info.width
  const h = info.height
  const hist = new Int32Array(256)
  for (let i = 0; i < data.length; i++) hist[data[i]]++
  const t = localOtsu(hist, data.length)
  const ink = new Uint8Array(w * h)
  for (let i = 0; i < data.length; i++) ink[i] = data[i] < t ? 1 : 0
  return { ink, w, h }
}

/** 旋转缓冲区（sharp 对 90/180/270 走无损路径） */
export async function rotateBuffer(buf: Buffer, angle: OrientationAngle): Promise<Buffer> {
  if (angle === 0) return buf
  return sharp(buf).rotate(angle).toBuffer()
}

/**
 * 估计输入图应旋转的角度（度）以转正。
 * @param ocrVolume 可选 OCR 文本量函数（侧车），用于 0/180 与 90/270 的镜像消歧；缺失则纯几何。
 */
export async function estimateOrientation(
  buf: Buffer,
  ocrVolume?: OcrVolumeFn,
): Promise<OrientationResult> {
  const { ink, w, h } = await binarize(buf)
  const { scores, axis } = scoreOrientation(ink, w, h)

  // 纯几何初判：横排取 0、竖排取 90（侧车 cls 会兜 0/180；OCR 细化会纠正 90/270 选择）
  let angle: OrientationAngle = axis === 'horizontal' ? 0 : 90

  // 镜像消歧：0 vs 180、90 vs 270
  if (ocrVolume) {
    try {
      const a0 = axis === 'horizontal' ? 0 : 90
      const a1 = ((a0 + 180) % 360) as OrientationAngle
      const [v0, v1] = await Promise.all([
        rotateBuffer(buf, a0).then(ocrVolume),
        rotateBuffer(buf, a1).then(ocrVolume),
      ])
      angle = v1 > v0 ? a1 : a0
      return { angle, method: 'ocr', axis, scores, ocrRefined: true }
    } catch {
      /* 侧车失败 → 回落纯几何 */
    }
  }
  return { angle, method: 'projection', axis, scores }
}

/** 便捷封装：直接返回转正后的图与朝向信息 */
export async function autoOrient(
  buf: Buffer,
  ocrVolume?: OcrVolumeFn,
): Promise<{ buffer: Buffer; angle: OrientationAngle; method: OrientMethod; axis: 'horizontal' | 'vertical' }> {
  const r = await estimateOrientation(buf, ocrVolume)
  const buffer = await rotateBuffer(buf, r.angle)
  return { buffer, angle: r.angle, method: r.method, axis: r.axis }
}

/**
 * 工厂：用 OCR 侧车（CV 模型，非大模型）估计某图的 OCR 文本体量，作为朝向镜像消歧依据。
 * - 侧车是 DRY_RUN（假数据）→ 主动抛错，由调用方回落纯几何结果（避免假数据污染朝向）。
 * - 侧车不可达 / 超时 → 抛错，回落纯几何。
 * 注意：90° vs 270°、0° vs 180° 的「正立与否」纯几何无法判定（投影关于 180° 镜像对称），
 * 必须靠「读出文字」来确定——这正是 OCR 侧车的价值，且它属 CV 模型、非大模型。
 * 返回的文本体量以「去空白字符数」为代理：正立文本通常更连贯、字符更多，倒立则被切碎。
 */
export function ocrVolumeFromSidecar(baseUrl?: string): OcrVolumeFn {
  const url = baseUrl ?? process.env.OCR_ORIENT_URL ?? process.env.OCR_ENGINE_URL ?? 'http://127.0.0.1:9000'
  let checked = false
  let usable = true
  return async (buf: Buffer): Promise<number> => {
    if (!usable) throw new Error('ocr sidecar unusable (dry_run or unreachable)')
    // 首次调用先自检：DRY_RUN 侧车返回的是假数据，不能用它做朝向消歧
    if (!checked) {
      checked = true
      try {
        const h = await fetch(url + '/healthz', { signal: AbortSignal.timeout(5000) })
        const hj = (await h.json().catch(() => ({}))) as { dry_run?: boolean }
        if (hj.dry_run === true) {
          usable = false
          throw new Error('ocr sidecar is DRY_RUN')
        }
      } catch (e) {
        if (!usable) throw e
        // 无 /healthz 也不影响：照常尝试 /recognize，失败再由上层回落
      }
    }
    const b64 = buf.toString('base64')
    const r = await fetch(url + '/recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: 'data:image/jpeg;base64,' + b64, mode: 'rapid' }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!r.ok) throw new Error('ocr sidecar ' + r.status)
    const j = (await r.json()) as unknown
    let vol = 0
    const walk = (o: unknown) => {
      if (typeof o === 'string') vol += o.replace(/\s/g, '').length
      else if (Array.isArray(o)) o.forEach(walk)
      else if (o && typeof o === 'object') Object.values(o as Record<string, unknown>).forEach(walk)
    }
    walk(j)
    return vol
  }
}

export { estimateSkew }
