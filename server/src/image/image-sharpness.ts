/**
 * 拍摄清晰度门禁（P1-8 · 图像预处理前置）
 * ------------------------------------------------------------------
 * 技术文档 §2.7 局限 ⑥：是否纠偏/增强仍靠用户手动点，歪斜与模糊直接喂给切块/OCR。
 *
 * 本模块补齐其中的**清晰度**一环（透视纠偏其实已经在跑了：`buildLayoutContext`
 * 第①步就调 `straightenImage({auto:true})`，所以不必重复做）：
 *
 *   拉普拉斯方差法 —— 经典无参考清晰度度量。原理是二阶导数对高频边缘敏感：
 *   清晰图像的灰度突变多 → 拉普拉斯响应分布宽（方差大）；运动模糊/失焦图像边缘被
 *   抹平 → 响应集中在 0 附近（方差小）。无需参考图、纯 CPU、毫秒级。
 *
 * 用法：入口处只跑一次；低于阈值时**不阻断**流程，只把 `sharp: false` 带回前端让
 * 用户决定要不要重拍 —— 门禁是提示不是拦截，因为"我知道它糊、但我就要这张"真实存在。
 */
import sharp from 'sharp'

export interface SharpnessResult {
  /** 拉普拉斯响应标准差（越大越清晰） */
  score: number
  /** 是否通过清晰度门禁 */
  sharp: boolean
  /** 采样尺寸（降采样到该边长以内再算，避免大图无谓耗时） */
  sampleSize: number
}

/**
 * 默认通过阈值。
 *
 * ⚠️ 这个数是**经验初值而非标定金标准**：同一份内容，纸张纹理重、笔墨重、压缩噪声大
 * 都会抬高拉普拉斯方差。目前取 6 的目的是"拦住明显失焦的运动模糊照片，放过正常文档图"，
 * 宁可漏报也不误报（误报会让用户对着一张好图反复重拍）。
 * 上线前建议用真实拍摄样本标定一次，或通过环境变量 IMG_MIN_SHARPNESS 覆盖。
 */
export const DEFAULT_MIN_SHARPNESS = 6

/**
 * 估算一张图的清晰度。
 *
 * ⚠️ 实现细节：sharp 的 `convolve` 输出会被截断到 uint8，负向响应会被削到 0，
 *    所以必须加 `offset: 127` 把零响应抬到中灰，否则负响应全变 0，方差反而失真。
 *    scale 必须显式给 1 —— 拉普拉斯核各元素之和为 0，sharp 用核和作除数会得到除零。
 */
export async function estimateSharpness(
  buf: Buffer,
  opts: { minScore?: number; maxSample?: number } = {},
): Promise<SharpnessResult> {
  const maxSample = opts.maxSample ?? 1200
  const minScore = Number.isFinite(opts.minScore)
    ? opts.minScore!
    : Number(process.env.IMG_MIN_SHARPNESS ?? DEFAULT_MIN_SHARPNESS)
  try {
    const { data, info } = await sharp(buf)
      .removeAlpha()
      .greyscale()
      .resize({ width: maxSample, height: maxSample, fit: 'inside' })
      .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0], scale: 1, offset: 127 })
      .raw()
      .toBuffer({ resolveWithObject: true })

    const n = info.width * info.height * info.channels
    let sum = 0
    for (let i = 0; i < n; i++) sum += data[i]
    const mean = n ? sum / n : 0
    let varSum = 0
    for (let i = 0; i < n; i++) {
      const d = data[i] - mean
      varSum += d * d
    }
    const score = n ? Math.sqrt(varSum / n) : 0
    return {
      score: +score.toFixed(2),
      sharp: score >= minScore,
      sampleSize: Math.max(info.width, info.height),
    }
  } catch (e) {
    // 门禁绝不能成为主链路的单点故障：算不出来就放行
    console.warn('[sharpness] 清晰度估算失败，放行：', (e as Error)?.message ?? e)
    return { score: 0, sharp: true, sampleSize: 0 }
  }
}

/** 给前端的可读提示语（要不要重拍由用户决定） */
export function sharpnessHint(r: SharpnessResult): string | null {
  if (r.sharp) return null
  return `照片偏模糊（清晰度 ${r.score}，建议 ≥ ${DEFAULT_MIN_SHARPNESS}），识别准确率会下降，建议重新拍摄或先做「智能高清」处理`
}
