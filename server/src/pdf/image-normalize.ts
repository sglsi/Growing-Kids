import sharp from 'sharp'

/**
 * 归一后的位图：`pdf-lib`（PDF）与 `docx` 都只吃 PNG / JPEG。
 * `width/height` 是像素尺寸，供拼页算比例用。
 */
export interface NormalizedImage {
  buffer: Buffer
  isPng: boolean
  width: number
  height: number
}

/** 从 PNG/JPEG 二进制头部解析像素尺寸。sharp 不可用时的兜底，永不抛错。 */
export function readImageSize(buffer: Buffer): { width: number; height: number } {
  // PNG：0~7 签名，16~23 为 IHDR 的 width/height（大端 uint32）
  if (buffer.length > 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  // JPEG：从 SOI(FFD8) 起遍历标记段，找 SOF0~SOF15（C4/D8/D9/DA 除外）
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let i = 2
    while (i + 9 < buffer.length) {
      if (buffer[i] !== 0xff) { i += 1; continue }
      const marker = buffer[i + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      const segLen = buffer.readUInt16BE(i + 2)
      const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSOF) return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5) }
      if (segLen <= 0) break
      i += 2 + segLen
    }
  }
  return { width: 0, height: 0 }
}

/**
 * 把任意上传图（含 WebP/HEIC 等微信常见格式）归一成 PDF/Word 可嵌的 PNG/JPEG，
 * 并给出像素尺寸；无法解码或读不出尺寸返回 null，由调用方跳过并留痕。
 *
 * D-063：这段归一逻辑原先内联在 `PdfService.fetchImages()` 里，复习本合成与
 * 「资料库多图合成」都要用，因此抽成零 Nest 依赖的共用单元——不复制第二份，
 * 也避免两处格式兼容行为漂移（WebP 进 PDF 会报「没有可合成的图片」）。
 */
export async function normalizeImageSource(buffer: Buffer, tag = ''): Promise<NormalizedImage | null> {
  if (!buffer || buffer.length < 12) return null
  let out = buffer
  let isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
  let width = 0
  let height = 0
  try {
    const meta = await sharp(buffer).metadata()
    width = meta.width || 0
    height = meta.height || 0
    const supported = meta.format === 'png' || meta.format === 'jpeg'
    if (!supported) {
      // 有透明通道 → 转 PNG 保住透明度；否则转 JPEG，避免 PNG 体积暴涨
      out = meta.hasAlpha
        ? await sharp(buffer).png({ compressionLevel: 6 }).toBuffer()
        : await sharp(buffer).jpeg({ quality: 92, mozjpeg: true }).toBuffer()
      isPng = !!meta.hasAlpha
      console.log(`[image-normalize] ${tag} 原格式 ${meta.format} 不支持，已转为 ${isPng ? 'png' : 'jpeg'}`)
    }
  } catch (e) {
    // sharp 不可用/解码失败 → 回退头部解析，行为与改造前一致
    console.warn('[image-normalize] sharp 解析失败，回退头部解析', tag, (e as Error)?.message)
  }
  if (!width || !height) {
    const size = readImageSize(out)
    width = size.width || 0
    height = size.height || 0
  }
  if (!width || !height) {
    console.error('[image-normalize] 无法解析图片尺寸', tag)
    return null
  }
  return { buffer: out, isPng, width, height }
}
