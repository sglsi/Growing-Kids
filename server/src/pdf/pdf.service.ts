import { Injectable, BadRequestException } from '@nestjs/common'
import { PDFDocument } from 'pdf-lib'
import * as http from 'http'
import * as https from 'https'
import { StorageService } from '../storage/storage.service'
import { TimelineService } from '../timeline/timeline.service'
import { DocumentsService } from '../documents/documents.service'
import type { TimelineItem } from '../timeline/timeline.types'
import { packPages, type PackInput } from './pdf-layout'

const A4_PT = { width: 595.28, height: 841.89 }
// 版面留白（用户选择「宽松易读」）：页边距加大到 34pt(≈12mm)，
// 图与图之间保留 12pt 空隙，便于剪裁/批注，观感更舒展。
const PAGE_MARGIN = 34
const IMAGE_GAP = 12

@Injectable()
export class PdfService {
  constructor(
    private readonly storageService: StorageService,
    private readonly timelineService: TimelineService,
    private readonly documentsService: DocumentsService,
  ) {}

  private download(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https:') ? https : http
      const req = mod.get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          this.download(res.headers.location).then(resolve, reject)
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`下载素材失败(status ${res.statusCode})`))
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      })
      req.setTimeout(60000, () => req.destroy(new Error('下载素材超时')))
      req.on('error', reject)
    })
  }

  /**
   * 把选中的图片（timeline_items kind=image）合成标准 A4 PDF。
   *
   * 排版策略（Guillotine-BSSF 智能拼页，替代原「每图一页」）：
   *  1. 逐张下载并解码，拿到各自宽高比例；
   *  2. 用 packPages 把「等比缩放后的矩形」装箱到 A4 可用区，得到「每页放哪些图、各在哪」；
   *  3. 按页绘制：小图与别的图共享一页，大图自然独占一页，尽量减少留白。
   *
   * 结果转存 TOS 并归档进 documents（文档页）。
   */
  async combineIntoPdf(
    userId: string,
    ids: string[],
  ): Promise<{ url: string; key: string; doc_id: string; pages: number; fillRatio: number }> {
    if (!ids || !ids.length) throw new BadRequestException('请选择要合成的素材')
    const items: (TimelineItem & { url?: string })[] = await this.timelineService.listByIdsWithUrls(userId, ids)
    if (!items.length) throw new BadRequestException('未找到所选素材')

    const pdf = await PDFDocument.create()

    // 1) 下载 + 解码，收集「可排版」的图片及其原始尺寸
    const decoded: { key: string; image: any; width: number; height: number }[] = []
    for (const it of items) {
      if (it.kind !== 'image' || !it.url) continue
      let buffer: Buffer
      try {
        buffer = await this.download(it.url)
      } catch (e) {
        console.error('[pdf] 素材下载失败，跳过', it.id, e)
        continue
      }
      let image: any
      try {
        const isPng =
          buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
        try {
          image = isPng ? await pdf.embedPng(buffer) : await pdf.embedJpg(buffer)
        } catch {
          image = isPng ? await pdf.embedJpg(buffer) : await pdf.embedPng(buffer)
        }
      } catch (e) {
        console.error('[pdf] 图片解码失败，跳过', it.id, e)
        continue
      }
      const w = image.width || it.width || 1
      const h = image.height || it.height || 1
      decoded.push({ key: it.id, image, width: w, height: h })
    }

    if (!decoded.length) throw new BadRequestException('所选素材中没有可合成的图片')

    // 2) 装箱：页面可用净区域（扣页边距）。packPages 会以「图高」为基准归一化，
    //    使同页各图字大接近；再用 Guillotine-BSSF 拼页，尽量少页、少留白。
    const bin = {
      width: A4_PT.width - PAGE_MARGIN * 2,
      height: A4_PT.height - PAGE_MARGIN * 2,
    }
    const inputs: PackInput[] = decoded.map((d) => ({ key: d.key, width: d.width, height: d.height }))
    const packed = packPages(inputs, bin, { allowRotate: false })

    const imageByKey = new Map(decoded.map((d) => [d.key, d.image]))

    // 3) 按页绘制。packPages 坐标为「y 向下」，pdf-lib 为「y 向上」，需翻转；
    //    每张图按 IMAGE_GAP/2 内缩形成间距；并把**整页内容居中**：
    //      · 横向：用内容实际宽度居中，消除右侧大片留白；
    //      · 纵向：用内容实际高度居中，消除"全堆在页顶、页脚空一大片"的观感。
    //    注意：挪动的是整块内容的原点，不改变图与图的相对位置，因此不会引入重叠。
    let areaSum = 0
    let areaTotal = 0
    for (const pg of packed) {
      const page = pdf.addPage([A4_PT.width, A4_PT.height])
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (const pl of pg.placements) {
        minX = Math.min(minX, pl.x)
        maxX = Math.max(maxX, pl.x + pl.width)
        minY = Math.min(minY, pl.y)
        maxY = Math.max(maxY, pl.y + pl.height)
      }
      const hasContent = isFinite(minX) && isFinite(minY)
      const contentW = hasContent && maxX > minX ? maxX - minX : 0
      const contentH = hasContent && maxY > minY ? maxY - minY : 0
      const centerShiftX = (bin.width - contentW) / 2 - (hasContent ? minX : 0)
      const centerShiftY = (bin.height - contentH) / 2 - (hasContent ? minY : 0)

      for (const pl of pg.placements) {
        const img = imageByKey.get(pl.key)
        if (!img) continue
        const inset = IMAGE_GAP / 2
        const drawW = Math.max(1, pl.width - IMAGE_GAP)
        const drawH = Math.max(1, pl.height - IMAGE_GAP)
        const drawX = PAGE_MARGIN + pl.x + centerShiftX + inset
        const drawY = A4_PT.height - PAGE_MARGIN - (pl.y + centerShiftY + pl.height) + inset
        page.drawImage(img, { x: drawX, y: drawY, width: drawW, height: drawH })
        areaSum += drawW * drawH
      }
      areaTotal += bin.width * bin.height
    }

    const pages = pdf.getPageCount()
    if (!pages) throw new BadRequestException('所选素材中没有可合成的图片')

    const pdfBuffer = Buffer.from(await pdf.save())
    const title = `复习资料-${new Date().toLocaleDateString('zh-CN')}.pdf`
    const key = await this.storageService.uploadBuffer(pdfBuffer, `复习资料-${Date.now()}.pdf`, 'application/pdf')
    const url = await this.storageService.getPublicUrl(key)

    // 归档进文档页
    let docId = ''
    try {
      const doc = await this.documentsService.create(userId, {
        title,
        type: 'pdf',
        file_key: key,
        mime_type: 'application/pdf',
        size_bytes: pdfBuffer.length,
        meta: { source_ids: ids },
      })
      docId = doc.id
    } catch (e) {
      console.error('[pdf] 文档记录入库失败（不影响返回）', e)
    }

    const fillRatio = areaTotal > 0 ? areaSum / areaTotal : 0
    console.log(`[pdf] 合成完成：${decoded.length} 张图 → ${pages} 页，平均填充率 ${(fillRatio * 100).toFixed(1)}%`)
    return { url, key, doc_id: docId, pages, fillRatio }
  }
}
