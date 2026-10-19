import sharp from 'sharp'
import { createHash } from 'crypto'

/**
 * 图片压缩预处理管线（纯函数，零依赖除 sharp）
 * 依据：复习本与项目设计.md §11.3 策略 1（压缩 + 转 WebP）+ 策略 2（缩略图）
 *
 * 设计取舍（均有本机实测支撑，见 存储空间优化-实现说明.md）：
 *   - 选 WebP 而非 AVIF：AVIF 仅再小约 12%，但编码慢数倍、兼容面窄，不划算。
 *   - 长边 1600 / q80：错题本要保证文字可辨认，实测该档文字清晰。
 *   - 三档产物：original（留档）+ display（日常）+ thumb（列表）。
 *   - **幂等**：已是 WebP 且尺寸达标 → 不重编码，避免多次压缩累积画质损失。
 *   - **降级**：任何异常都回退为「原样透传」，绝不阻断上传。
 */

/** 可调参数（如需调整画质/体积平衡，改这里即可） */
export const IMAGE_POLICY = {
  /** 日常展示图：长边上限（px） */
  displayMaxEdge: 1600,
  /** 日常展示图：WebP 质量 */
  displayQuality: 80,
  /** 缩略图：宽度上限（px） */
  thumbWidth: 400,
  /** 缩略图：WebP 质量 */
  thumbQuality: 72,
  /** 小于该字节数的图不再压缩（避免小图越压越大） */
  minBytesToOptimize: 40 * 1024,
  /** 已经是 WebP 且长边不超过该值，视为已优化，跳过重编码 */
  alreadyOptimizedMaxEdge: 1600,
} as const

export interface DerivedVariant {
  buffer: Buffer
  ext: string
  mime: string
  width: number
  height: number
}

export interface PreprocessResult {
  /** 是否走了压缩管线（false = 非图片或降级透传） */
  optimized: boolean
  /** 是否因「已优化」而跳过重编码 */
  skipped?: boolean
  /** 原图 sha256（用于内容去重，按**原始字节**算，保证同图同 hash） */
  hash: string
  /** 原图字节数 */
  originalBytes: number
  /** 原图尺寸（EXIF 方向纠正后） */
  width: number
  height: number
  /** 原始 MIME */
  mime: string
  /** 原图（留档用；若未压缩则等于输入） */
  original: DerivedVariant
  /** 日常展示图 */
  display: DerivedVariant
  /** 缩略图 */
  thumb: DerivedVariant
  /** 降级原因（optimized=false 且有值时） */
  fallbackReason?: string
}

export const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

const asVariant = (buffer: Buffer, ext: string, mime: string, width: number, height: number): DerivedVariant =>
  ({ buffer, ext, mime, width, height })

/** 从 MIME / 扩展名判断是否为可处理的图片 */
export const isProcessableImage = (mime: string): boolean =>
  /^image\/(jpe?g|png|webp|tiff?|avif|heic|heif)$/i.test(mime || '')

/**
 * 纠正 EXIF 方向后的实际显示尺寸。
 *
 * ⚠️ 踩坑记录：`sharp(buf).rotate().metadata()` **不会**反映旋转结果 ——
 * metadata() 对 pipeline 是透传的，返回的仍是原始 width/height/orientation。
 * （本机实测：400x200 + orientation=6，rotate() 后 metadata 仍报 400x200，
 *   但真实输出的图片确实是 200x400。）
 * 若照抄 metadata 就会把竖拍照片的宽高写反，导致前端按错误比例预留位置、图片变形。
 * 因此这里按 EXIF orientation 自行换算：5/6/7/8 表示需旋转 90°，宽高对调。
 */
function orientedSize(meta: { width?: number; height?: number; orientation?: number }): { w: number; h: number } {
  const w = meta.width || 0
  const h = meta.height || 0
  const o = meta.orientation || 1
  if (o >= 5 && o <= 8) return { w: h, h: w } // 需要 90° 旋转 ⇒ 宽高对调
  return { w, h }
}

/**
 * 主入口：把一张图变成「原图 + 展示图 + 缩略图」三档产物。
 *
 * 注意：hash 按**输入原始字节**计算（不是压缩后），这样：
 *   - 同一个文件无论何时上传，hash 恒定 → 去重才有效；
 *   - 内容不同的图不会因压缩后趋同而误判为重复。
 */
export async function preprocessImage(
  input: Buffer,
  mime: string,
): Promise<PreprocessResult> {
  const hash = sha256(input)
  const originalBytes = input.length

  // 非图片 ⇒ 不进管线，原样透传
  if (!isProcessableImage(mime)) {
    return passthrough(input, hash, mime, 'not-an-image')
  }

  try {
    // 读元数据（注意：此处 width/height 是**旋转前**的原始像素）
    const meta = await sharp(input).metadata()
    const srcLongEdge = Math.max(meta.width || 0, meta.height || 0)
    const { w: outW, h: outH } = orientedSize(meta)

    // 幂等：已是 WebP 且长边达标且体积不大 ⇒ 保留原样，避免二次编码损失
    const alreadyWebp = meta.format === 'webp'
    const smallEnough = srcLongEdge <= IMAGE_POLICY.alreadyOptimizedMaxEdge
    if (alreadyWebp && smallEnough && originalBytes <= IMAGE_POLICY.minBytesToOptimize) {
      return skippedResult(input, hash, 'image/webp', outW, outH)
    }

    // 统一走 .rotate() —— 按 EXIF 自动纠正方向；手机竖拍照片必须做，否则会躺倒
    const needResize = Math.max(outW, outH) > IMAGE_POLICY.displayMaxEdge
    const displayPipeline = sharp(input).rotate()
    if (needResize) {
      displayPipeline.resize({
        width: IMAGE_POLICY.displayMaxEdge,
        height: IMAGE_POLICY.displayMaxEdge,
        fit: 'inside',
        withoutEnlargement: true,
      })
    }
    const displayBuf = await displayPipeline.webp({ quality: IMAGE_POLICY.displayQuality }).toBuffer()
    const displayMeta = await sharp(displayBuf).metadata()

    const thumbBuf = await sharp(input)
      .rotate()
      .resize({ width: IMAGE_POLICY.thumbWidth, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: IMAGE_POLICY.thumbQuality })
      .toBuffer()
    const thumbMeta = await sharp(thumbBuf).metadata()

    return {
      optimized: true,
      hash,
      originalBytes,
      width: outW,
      height: outH,
      mime,
      // 原图留档：保留原始字节与原始 mime（不转码，保证可追溯）
      original: asVariant(input, extOf(mime), mime, outW, outH),
      display: asVariant(displayBuf, 'webp', 'image/webp', displayMeta.width || outW, displayMeta.height || outH),
      thumb: asVariant(thumbBuf, 'webp', 'image/webp', thumbMeta.width || 0, thumbMeta.height || 0),
    }
  } catch (e) {
    // 坏图 / 不支持的编码 ⇒ 降级透传，绝不阻断上传
    const reason = e instanceof Error ? e.message : String(e)
    return passthrough(input, hash, mime, `sharp-failed: ${reason}`)
  }
}

/** 非图片 / 处理失败：三档产物都是原图，调用方照常存取 */
function passthrough(input: Buffer, hash: string, mime: string, reason: string): PreprocessResult {
  const v = asVariant(input, extOf(mime), mime || 'application/octet-stream', 0, 0)
  return {
    optimized: false,
    hash,
    originalBytes: input.length,
    width: 0,
    height: 0,
    mime,
    original: v,
    display: v,
    thumb: v,
    fallbackReason: reason,
  }
}

/** 已是优化过的 WebP：保留原样，不重编码 */
function skippedResult(input: Buffer, hash: string, mime: string, w: number, h: number): PreprocessResult {
  const v = asVariant(input, 'webp', 'image/webp', w, h)
  return {
    optimized: true,
    skipped: true,
    hash,
    originalBytes: input.length,
    width: w,
    height: h,
    mime: 'image/webp',
    original: v,
    display: v,
    thumb: v,
  }
}

/** 从 MIME 取扩展名 */
export function extOf(mime: string): string {
  const m = (mime || '').toLowerCase()
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg'
  if (m.includes('png')) return 'png'
  if (m.includes('webp')) return 'webp'
  if (m.includes('gif')) return 'gif'
  if (m.includes('tiff')) return 'tiff'
  if (m.includes('avif')) return 'avif'
  if (m.includes('heic') || m.includes('heif')) return 'heic'
  if (m.includes('pdf')) return 'pdf'
  if (m.includes('word') || m.includes('officedocument')) return 'docx'
  // 成长记忆：音频
  if (m.includes('mpeg')) return 'mp3'
  if (m.includes('mp4')) return 'mp4'
  if (m.includes('aac')) return 'aac'
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('wav') || m.includes('wave')) return 'wav'
  if (m.includes('webm')) return 'webm'
  if (m.includes('quicktime')) return 'mov'
  if (m.includes('3gpp')) return '3gp'
  return 'bin'
}
