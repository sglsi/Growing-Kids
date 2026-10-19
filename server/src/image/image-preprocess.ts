import sharp from 'sharp'

/**
 * 图像预处理/后处理工具（阶段一：保比例 + 色调一致性 + 结果校验）
 *
 * 背景：当前「去手写」走的是图生图（整图重绘），会导致两个问题：
 *  1. 输出尺寸档位（'2K'）改变长宽比 → 左右两侧内容被裁掉；
 *  2. 生成模型重绘后整体色调/对比度漂移 → 观感与原图不一致。
 *
 * 本模块做三件事：
 *  - fitSizeToRatio：按**原图长宽比**算出满足模型像素约束的合法尺寸；
 *  - measureTone / matchTone：统计原图色调，把 AI 结果**拉回**原图色调（色调一致性）；
 *  - verifyResult：对 AI 结果做**比例偏差 / 尺寸**校验，不合格直接判失败。
 *
 * 全部基于 sharp 的真实像素运算，非静态占位。
 */

// —— 来自 coze-coding-dev-sdk 的 ImageConfig（已实测）——
/** 最小总像素 */
export const MIN_TOTAL_PIXELS = 3_686_400
/** 最大总像素 */
export const MAX_TOTAL_PIXELS = 16_777_216
/** 最小宽高比 */
export const MIN_ASPECT_RATIO = 0.0625
/** 最大宽高比 */
export const MAX_ASPECT_RATIO = 16

/** 比例偏差容忍阈值：0.5% */
export const RATIO_TOLERANCE = 0.005

export interface SizeSpec {
  width: number
  height: number
  /** 形如 "1663x2217" */
  size: string
  /** 实际长宽比 */
  ratio: number
  /** 实际总像素 */
  pixels: number
}

export interface ImageMeta {
  width: number
  height: number
  format?: string
  channels?: number
}

/** 读取图片元信息（宽高），失败抛错 */
export async function readMeta(buf: Buffer): Promise<ImageMeta> {
  const m = await sharp(buf).metadata()
  if (!m.width || !m.height) throw new Error('无法读取图片尺寸')
  return { width: m.width, height: m.height, format: m.format, channels: m.channels }
}

/**
 * 按原图长宽比，计算一个满足模型像素约束的合法尺寸。
 *
 * 做法：以 minimum 像素为基准，按比例反解宽高，再夹到 [MIN, MAX] 区间内；
 * 夹取后做一次微调，确保总像素严格落在合法区间。
 *
 * 这样传给模型的尺寸与**原图同比例**，模型就不会为了适配 '2K' 而裁掉左右内容。
 */
export function fitSizeToRatio(srcW: number, srcH: number): SizeSpec {
  if (!srcW || !srcH) throw new Error('原图尺寸无效')

  const ratio = srcW / srcH
  const clamped = Math.min(Math.max(ratio, MIN_ASPECT_RATIO), MAX_ASPECT_RATIO)

  // 以 MIN_TOTAL_PIXELS 为基准反解
  let w = Math.round(Math.sqrt(MIN_TOTAL_PIXELS * clamped))
  let h = Math.round(Math.sqrt(MIN_TOTAL_PIXELS / clamped))

  // 兜底：总像素低于下限则等比放大一点点；高于上限则等比缩小一点点
  let pixels = w * h
  if (pixels < MIN_TOTAL_PIXELS) {
    const k = Math.sqrt(MIN_TOTAL_PIXELS / pixels) * 1.001
    w = Math.round(w * k)
    h = Math.round(h * k)
    pixels = w * h
  }
  if (pixels > MAX_TOTAL_PIXELS) {
    const k = Math.sqrt(MAX_TOTAL_PIXELS / pixels) * 0.999
    w = Math.round(w * k)
    h = Math.round(h * k)
    pixels = w * h
  }
  // 极端情况再夹一次（理论上不会触发）
  if (pixels < MIN_TOTAL_PIXELS && w * h < MIN_TOTAL_PIXELS) {
    w += 1
    h = Math.max(h, Math.ceil(MIN_TOTAL_PIXELS / w))
    pixels = w * h
  }

  return { width: w, height: h, size: `${w}x${h}`, ratio: w / h, pixels: w * h }
}

/** 校验某个尺寸是否被模型接受（复刻 SDK validateImageSize 的规则） */
export function isSizeValid(w: number, h: number): { ok: boolean; reason?: string } {
  const pixels = w * h
  if (pixels < MIN_TOTAL_PIXELS || pixels > MAX_TOTAL_PIXELS) {
    return { ok: false, reason: `总像素需在 ${MIN_TOTAL_PIXELS}~${MAX_TOTAL_PIXELS}，实际 ${pixels}` }
  }
  const ratio = w / h
  if (ratio < MIN_ASPECT_RATIO || ratio > MAX_ASPECT_RATIO) {
    return { ok: false, reason: `宽高比需在 ${MIN_ASPECT_RATIO}~${MAX_ASPECT_RATIO}，实际 ${ratio}` }
  }
  return { ok: true }
}

// ============================================================
// 色调一致性（Tone Consistency）
// ============================================================

export interface ToneStats {
  /** 每通道均值（0~255） */
  means: number[]
  /** 每通道标准差（0~255） */
  stds: number[]
  /** 整图平均亮度（0~255） */
  brightness: number
}

/**
 * 统计图像色调（逐通道均值 + 标准差）。
 *
 * 这是"色调一致性"的度量基础：原图与 AI 结果各算一份，
 * 用差值决定要不要做色调匹配、以及匹配多少。
 */
export async function measureTone(buf: Buffer): Promise<ToneStats> {
  const { channels } = await sharp(buf).stats()
  const means = channels.map((c) => c.mean)
  const stds = channels.map((c) => c.stdev)
  const brightness = means.reduce((a, b) => a + b, 0) / (means.length || 1)
  return { means, stds, brightness }
}

/** 色调偏差（各通道均值差的最大绝对值） */
export function toneDelta(a: ToneStats, b: ToneStats): number {
  const n = Math.min(a.means.length, b.means.length)
  let max = 0
  for (let i = 0; i < n; i++) max = Math.max(max, Math.abs(a.means[i] - b.means[i]))
  return max
}

/**
 * 把 `target` 的色调**拉回**到 `reference`（原图）的色调。
 *
 * 原理（业界通行的 color transfer 简化版）：
 *  - 逐通道线性变换：dst = (src - mean_src) * (std_ref / std_src) + mean_ref
 *    即"先把 src 摊平，再按 ref 的均值和标准差重建"，从而对齐均值（色偏）与标准差（对比度）。
 *  - 用 `strength`(0~1) 在"原样"和"完全匹配"之间做插值，避免过度校正。
 *  - 只对**亮度/饱和度**做整体校正，不改变像素位置 → **不会重排、不会改版式**。
 *
 * 这正是我们需要的：AI 重绘导致色调漂移时，用原图色调把它拉回来，
 * 保证整幅图的"纸张底色 / 墨色 / 对比度"一致。
 */
export async function matchTone(
  target: Buffer,
  referenceTone: ToneStats,
  opts: { strength?: number; maxDeltaRatio?: number } = {},
): Promise<{ buffer: Buffer; applied: boolean; deltaBefore: number; deltaAfter: number }> {
  const strength = opts.strength ?? 0.85
  const targetTone = await measureTone(target)
  const deltaBefore = toneDelta(referenceTone, targetTone)

  // 偏差本身就很小 → 不动它，避免引入无谓的处理痕迹
  if (deltaBefore < 1.5) {
    return { buffer: target, applied: false, deltaBefore, deltaAfter: deltaBefore }
  }

  // 逐通道增益与偏移
  const n = Math.min(referenceTone.means.length, targetTone.means.length)
  if (n < 3) {
    // 灰度图等通道不足的情况：不做色调匹配，保持原样
    return { buffer: target, applied: false, deltaBefore, deltaAfter: deltaBefore }
  }
  const gain: number[] = []
  const offset: number[] = []
  for (let i = 0; i < n; i++) {
    const sStd = targetTone.stds[i] || 1
    const rStd = referenceTone.stds[i] || sStd
    // 标准差比夹到 [0.5, 2]，防止极端放大噪声
    const g = Math.min(Math.max(rStd / sStd, 0.5), 2)
    const gEff = 1 + (g - 1) * strength
    // dst = src * gEff + oEff；用 strength 对"完全匹配"做插值
    const oEff = (referenceTone.means[i] - targetTone.means[i] * gEff) * strength
    gain.push(gEff)
    offset.push(oEff)
  }

  // sharp.linear(a, b)：逐通道线性变换 dst = a[i] * src[i] + b[i]
  // 只改像素的**颜色映射**，不改位置 → 不会重排、不会改版式
  const buf = await sharp(target)
    .linear(gain, offset)
    .png()
    .toBuffer()

  const after = await measureTone(buf)
  return { buffer: buf, applied: true, deltaBefore, deltaAfter: toneDelta(referenceTone, after) }
}

// ============================================================
// 结果校验
// ============================================================

export interface VerifyResult {
  ok: boolean
  reason?: string
  /** 实测比例偏差（相对值） */
  ratioDeviation: number
  srcRatio: number
  outRatio: number
  srcSize: string
  outSize: string
}

/**
 * 校验 AI 结果是否"可用"，不合格就判失败（避免把坏图静默存下来）。
 *
 * 检查项：
 *  1. **长宽比偏差**必须 < RATIO_TOLERANCE（默认 0.5%）—— 直接对应"左右吞字"；
 *  2. 尺寸必须有效（非 0）。
 *
 * ⚠️ 注意：**不要**在这里校验 MIN/MAX_TOTAL_PIXELS。
 * 那是**对模型输入尺寸的约束**（见 isSizeValid / fitSizeToRatio），
 * 而模型返回的是一张已经生成好的图，其分辨率不受该区间限制。
 * 把输入的像素区间套到输出上会误杀正常结果（曾因此误判 1200x1601 为失败）。
 */
export function verifyResult(
  src: ImageMeta,
  out: ImageMeta,
  opts: { tolerance?: number } = {},
): VerifyResult {
  const tolerance = opts.tolerance ?? RATIO_TOLERANCE
  const srcRatio = src.width / src.height
  const outRatio = out.width / out.height
  const ratioDeviation = Math.abs(outRatio - srcRatio) / srcRatio

  const base = {
    ratioDeviation,
    srcRatio,
    outRatio,
    srcSize: `${src.width}x${src.height}`,
    outSize: `${out.width}x${out.height}`,
  }

  if (!out.width || !out.height) {
    return { ok: false, reason: '结果图片尺寸无效', ...base }
  }
  if (ratioDeviation > tolerance) {
    return {
      ok: false,
      reason: `结果长宽比偏差 ${(ratioDeviation * 100).toFixed(2)}%（上限 ${(tolerance * 100).toFixed(2)}%），疑似裁切或拉伸`,
      ...base,
    }
  }
  return { ok: true, ...base }
}

/**
 * 把结果**等比缩放**到与原图完全一致的尺寸（在原比例已通过校验的前提下）。
 * 用于消除模型输出尺寸与原图不一致带来的观感差异。
 */
export async function conformSize(buf: Buffer, src: ImageMeta): Promise<Buffer> {
  const m = await readMeta(buf)
  if (m.width === src.width && m.height === src.height) return buf
  return sharp(buf).resize(src.width, src.height, { fit: 'fill' }).png().toBuffer()
}
