import { Injectable, BadRequestException } from '@nestjs/common'
import { PDFDocument } from 'pdf-lib'
import * as http from 'http'
import * as https from 'https'
import { StorageService } from '../storage/storage.service'
import { MaterialsService } from '../materials/materials.service'
import { DocumentsService } from '../documents/documents.service'
import type { Material } from '../materials/materials.types'

const A4_PT = { width: 595.28, height: 841.89 }

@Injectable()
export class PdfService {
  constructor(
    private readonly storageService: StorageService,
    private readonly materialsService: MaterialsService,
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
   * 把选中的素材（图片为主，文档则合并其已归档图片等）合成标准 A4 PDF，
   * 每个素材一页，图片等比缩放留白居中放置。结果转存 TOS 并归档为文档素材。
   */
  async combineIntoPdf(ids: string[]): Promise<{ url: string; key: string; material_id: string; pages: number }> {
    if (!ids || !ids.length) throw new BadRequestException('请选择要合成的素材')
    const materials: Material[] = await this.materialsService.listByIds(ids)
    if (!materials.length) throw new BadRequestException('未找到所选素材')

    const pdf = await PDFDocument.create()

    for (const m of materials) {
      if (m.type !== 'image' || !m.url) continue
      let buffer: Buffer
      try {
        buffer = await this.download(m.url)
      } catch (e) {
        console.error('[pdf] 素材下载失败，跳过', m.id, e)
        continue
      }
      let image
      try {
        // 用魔数自动探测真实图片格式，兼容 mime_type 标注不准确的情况
        const isPng = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
        try {
          image = isPng ? await pdf.embedPng(buffer) : await pdf.embedJpg(buffer)
        } catch (embedErr) {
          image = isPng ? await pdf.embedJpg(buffer) : await pdf.embedPng(buffer)
        }
      } catch (e) {
        console.error('[pdf] 图片解码失败，跳过', m.id, e)
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

    const key = await this.storageService.uploadBuffer(pdfBuffer, `复习资料-${Date.now()}.pdf`, 'application/pdf')
    const url = await this.storageService.getPublicUrl(key)

    let materialId = ''
    try {
      const material = await this.materialsService.createMaterial({
        name: `复习资料-${new Date().toLocaleDateString('zh-CN')}.pdf`,
        type: 'document',
        file_key: key,
        url,
        mime_type: 'application/pdf',
        size_bytes: pdfBuffer.length,
      })
      materialId = material.id
    } catch (e) {
      console.error('[pdf] 生成素材归档失败（不影响返回）', e)
    }

    try {
      await this.documentsService.create({
        title: `复习资料-${new Date().toLocaleDateString('zh-CN')}.pdf`,
        type: 'pdf',
        file_key: key,
        url,
        mime_type: 'application/pdf',
        size_bytes: pdfBuffer.length,
      })
    } catch (e) {
      console.error('[pdf] 文档记录入库失败（不影响返回）', e)
    }

    return { url, key, material_id: materialId, pages }
  }
}