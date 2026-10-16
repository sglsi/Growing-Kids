import sharp from 'sharp'
import { getPpsv3Client, getPpsv3Supervisor } from '../ocr/ppsv3.client'

/**
 * 图片自动调正 · UVDoc 矫正（3.x 侧车 /ppsv3/rectify）
 *
 * 定位（溯源文档《侧车3.x-A_B试点与摆正估计器假峰溯源.md》§四决策 1）：
 *   **摆正链路（straightenImage）的首选矫正路径**，投影估计器（image-deskew，
 *   #135 已修复）降级为兜底。理由：UVDoc 是透视/曲面模型（治本），投影估计器
 *   只是旋转模型且已被证明在真实密页不可靠（治标）。
 *
 * 与 OCR 实例的关系（坐标保真）：
 *   生产 OCR 实例 PPSV3_UNWARP=0（box 必须留在输入图坐标系与笔迹掩膜匹配）。
 *   /ppsv3/rectify 端点用**独立 UVDoc 轻量单例**（TextImageUnwarping），同进程
 *   共存、与该开关无关——矫正端点恒定真正 unwarp，OCR 产物坐标不受影响。
 *
 * 可用性设计（与朝向 OCR 细化同构的「最佳努力」模式）：
 *   - 侧车不可达 / 超时 / 推理失败 → 返回 null，straightenImage 静默回落
 *     投影估计器兜底（#135 修复后保守拒动），主链路绝不抛错；
 *   - `OCR_RECTIFY=0` 一键关闭；超时 `OCR_RECTIFY_TIMEOUT_MS` 默认 90s
 *     （UVDoc CPU 实测 ~4.4s/页，留足大图与冷启动余量）。
 */

export interface RectifyResult {
  buffer: Buffer
  width: number
  height: number
  elapsed_ms: number
}

/** rectify 调用超时（ms）：UVDoc CPU ~4.4s/页，留足大图与冷启动余量 */
const RECTIFY_TIMEOUT_MS = Number(process.env.OCR_RECTIFY_TIMEOUT_MS ?? 90000)

/**
 * 调 3.x 侧车做 UVDoc 矫正。任何失败返回 null（调用方降级，不阻断主链路）。
 */
export async function rectifyBySidecar(buf: Buffer): Promise<RectifyResult | null> {
  if (process.env.OCR_RECTIFY === '0') return null
  try {
    const client = getPpsv3Client()
    const r = await getPpsv3Supervisor().withSidecar(async () => {
      return await Promise.race([
        client.rectify({ image_base64: buf.toString('base64') }),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error(`UVDoc 矫正超时（>${RECTIFY_TIMEOUT_MS}ms）`)), RECTIFY_TIMEOUT_MS),
        ),
      ])
    })
    if (!r?.rectified_image_base64) return null
    const out = Buffer.from(r.rectified_image_base64, 'base64')
    const meta = await sharp(out).metadata()
    return {
      buffer: out,
      width: meta.width || r.width,
      height: meta.height || r.height,
      elapsed_ms: r.elapsed_ms,
    }
  } catch (e) {
    console.warn('[image-rectify] UVDoc 矫正失败（回落投影估计器）：', (e as Error).message)
    return null
  }
}
