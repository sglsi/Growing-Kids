import { PDFDocument } from 'pdf-lib'
import type { NormalizedImage } from './image-normalize'

/** A4（pt）与页边距：与 `PdfService` 智能拼页共用同一套版面常量 */
export const A4_PT = { width: 595.28, height: 841.89 }
export const PAGE_MARGIN = 34

/**
 * 一图一页：每张图独占一页 A4，等比缩放居中，**严格按入参数组的先后排页**。
 *
 * D-063（思傅 2026-11-15 改判）：资料库「多图导入」要的是按页序还原原件，
 * 不能用 `PdfService.combineIntoPdf()` 的 Guillotine-BSSF 智能拼页——多图挤一页
 * 会让「自动排序 / 手动调序」的结果看不出来，也不像试卷原件。
 *
 * 这里刻意做成零 Nest 依赖的纯函数：复习本智能拼页与资料库一图一页是**两种版式**，
 * 彼此不复用拼版算法，但共用图片归一（`normalizeImageSource`）与版面常量，
 * 且可以被离线实证脚本直接 require 编译产物验证「页数 == 图片数、页序 == 入参序」。
 */
export async function buildOneImagePerPagePdf(images: NormalizedImage[]): Promise<Buffer> {
  if (!images.length) throw new Error('没有可合成的图片')
  const pdf = await PDFDocument.create()
  const availW = A4_PT.width - PAGE_MARGIN * 2
  const availH = A4_PT.height - PAGE_MARGIN * 2

  for (const s of images) {
    let image: any
    try {
      // 少数图片被错误标了 isPng（如微信转码后扩展名与内容不一致），双向兜底
      try {
        image = s.isPng ? await pdf.embedPng(s.buffer) : await pdf.embedJpg(s.buffer)
      } catch {
        image = s.isPng ? await pdf.embedJpg(s.buffer) : await pdf.embedPng(s.buffer)
      }
    } catch (e) {
      console.error('[one-image-per-page] 图片解码失败，跳过', e)
      continue
    }
    const iw = image.width || s.width
    const ih = image.height || s.height
    if (!iw || !ih) continue
    const scale = Math.min(availW / iw, availH / ih)
    const w = iw * scale
    const h = ih * scale
    // 🔴 一图一页的硬约束：循环一次只 addPage 一次，绝不装箱合并
    const page = pdf.addPage([A4_PT.width, A4_PT.height])
    page.drawImage(image, {
      x: (A4_PT.width - w) / 2,
      y: (A4_PT.height - h) / 2,
      width: w,
      height: h,
    })
  }

  if (!pdf.getPageCount()) throw new Error('没有可合成的图片')
  return Buffer.from(await pdf.save())
}
