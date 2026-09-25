import { Injectable, BadRequestException } from '@nestjs/common'
import { PDFDocument } from 'pdf-lib'
import * as http from 'http'
import * as https from 'https'
import { StorageService } from '../storage/storage.service'
import { TimelineService } from '../timeline/timeline.service'
import { DocumentsService } from '../documents/documents.service'
import type { TimelineItem } from '../timeline/timeline.types'

const A4_PT = { width: 595.28, height: 841.89 }

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
   * 把选中的图片（timeline_items kind=image）合成标准 A4 PDF，每图一页，等比留白居中。
   * 结果转存 TOS 并归档进 documents（文档页）。
   */
  async combineIntoPdf(
    userId: string,
    ids: string[],
  ): Promise<{ url: string; key: string; doc_id: string; pages: number }> {
    if (!ids || !ids.length) throw new BadRequestException('请选择要合成的素材')
    const items: (TimelineItem & { url?: string })[] = await this.timelineService.listByIdsWithUrls(userId, ids)
    if (!items.length) throw new BadRequestException('未找到所选素材')

    const pdf = await PDFDocument.create()

    for (const it of items) {
      if (it.kind !== 'image' || !it.url) continue
      let buffer: Buffer
      try {
        buffer = await this.download(it.url)
      } catch (e) {
        console.error('[pdf] 素材下载失败，跳过', it.id, e)
        continue
      }
      let image
      try {
        const isPng = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
        try {
          image = isPng ? await pdf.embedPng(buffer) : await pdf.embedJpg(buffer)
        } catch (embedErr) {
          image = isPng ? await pdf.embedJpg(buffer) : await pdf.embedPng(buffer)
        }
      } catch (e) {
        console.error('[pdf] 图片解码失败，跳过', it.id, e)
        continue
      }

      const page = pdf.addPage([A4_PT.width, A4_PT.height])
      const margin = 24
      const maxW = A4_PT.width - margin * 2
      const maxH = A4_PT.height - margin * 2
      const w = image.width
      const h = image.height
      const scale = Math.min(maxW / w, maxH / h, 1)
      const drawW = w * scale
      const drawH = h * scale
      const x = (A4_PT.width - drawW) / 2
      const y = (A4_PT.height - drawH) / 2
      page.drawImage(image, { x, y, width: drawW, height: drawH })
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

    return { url, key, doc_id: docId, pages }
  }
}
