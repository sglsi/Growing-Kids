import { Injectable, BadRequestException } from '@nestjs/common'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import {
  Document, Packer, Paragraph, TextRun, ImageRun,
  AlignmentType, HeadingLevel,
} from 'docx'
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

// Word 版面：docx 的 page.size / margin 单位是 twips（1pt = 20twips），
// ImageRun 的 transformation 单位是像素（docx 内部按 96dpi 换算）。
const A4_TWIP = { width: 11906, height: 16838 }
const DOCX_MARGIN_TWIP = PAGE_MARGIN * 20
/** 正文可用区（px @96dpi）：A4 扣掉四周页边距 */
const DOCX_MAX_W = Math.round(((A4_TWIP.width - DOCX_MARGIN_TWIP * 2) / 20) * (96 / 72))
const DOCX_MAX_H = Math.round(((A4_TWIP.height - DOCX_MARGIN_TWIP * 2) / 20) * (96 / 72))

/** 合成目标格式：pdf（图片拼页）与 docx（图片顺排入 Word） */
export type CombineFormat = 'pdf' | 'docx'

export interface CombineResult {
  url: string
  key: string
  doc_id: string
  /** PDF：实际页数；DOCX：按图高估算的页数 */
  pages: number
  /** PDF：版面填充率；DOCX 恒为 0（不适用） */
  fillRatio: number
  /** 参与合成的图片张数 */
  images: number
}

/**
 * 从 PNG/JPEG 二进制头部解析像素尺寸。
 * 仅作 sharp 不可用时的兜底（readImageSize 零依赖，永远不抛错）。
 */
function readImageSize(buffer: Buffer): { width: number; height: number } {
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

  /** 素材 id → 已下载的图片（含二进制、格式与像素尺寸） */
  private async fetchImages(userId: string, ids: string[]): Promise<
    { id: string; buffer: Buffer; isPng: boolean; width: number; height: number }[]
  > {
    if (!ids || !ids.length) throw new BadRequestException('请选择要合成的素材')
    const items: (TimelineItem & { url?: string })[] = await this.timelineService.listByIdsWithUrls(userId, ids)
    if (!items.length) throw new BadRequestException('未找到所选素材')

    const out: { id: string; buffer: Buffer; isPng: boolean; width: number; height: number }[] = []
    for (const it of items) {
      if (it.kind !== 'image' || !it.url) continue
      let buffer: Buffer
      try {
        buffer = await this.download(it.url)
      } catch (e) {
        console.error('[combine] 素材下载失败，跳过', it.id, e)
        continue
      }

      // 格式归一：pdf-lib 与 docx 都只吃 PNG/JPEG，而素材里存在 WebP/HEIC 等格式
      // （微信侧产出、以及图片管线中间产物）。不归一的话会出现「PDF 报没有可合成的
      // 图片」「Word 里图片损坏打不开」——两处症状不同，根因同一个。
      let isPng = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
      let width = 0
      let height = 0
      try {
        const meta = await sharp(buffer).metadata()
        width = meta.width || 0
        height = meta.height || 0
        const supported = meta.format === 'png' || meta.format === 'jpeg'
        if (!supported) {
          // 有透明通道 → 转 PNG 保住透明度；否则转 JPEG，避免 PNG 体积暴涨
          buffer = meta.hasAlpha
            ? await sharp(buffer).png({ compressionLevel: 6 }).toBuffer()
            : await sharp(buffer).jpeg({ quality: 92, mozjpeg: true }).toBuffer()
          isPng = !!meta.hasAlpha
          console.log(`[combine] 素材 ${it.id} 原格式 ${meta.format} 不支持，已转为 ${isPng ? 'png' : 'jpeg'}`)
        }
      } catch (e) {
        // sharp 不可用/解码失败 → 回退头部解析，行为与改造前一致
        console.warn('[combine] sharp 解析失败，回退头部解析', it.id, (e as Error)?.message)
      }
      if (!width || !height) {
        const size = readImageSize(buffer)
        width = size.width || it.width || 0
        height = size.height || it.height || 0
      }
      if (!width || !height) {
        console.error('[combine] 无法解析图片尺寸，跳过', it.id)
        continue
      }
      out.push({ id: it.id, buffer, isPng, width, height })
    }
    return out
  }

  /**
   * 合成入口：按目标格式分发。
   *
   * - `pdf`：Guillotine-BSSF 智能拼页，多图共用一页，省纸少留白；
   * - `docx`：图片按选择顺序顺排进 Word，家长可继续编辑、加批注后再打印。
   */
  async combine(userId: string, ids: string[], format: CombineFormat = 'pdf'): Promise<CombineResult> {
    return format === 'docx' ? this.combineIntoDocx(userId, ids) : this.combineIntoPdf(userId, ids)
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
  async combineIntoPdf(userId: string, ids: string[]): Promise<CombineResult> {
    const sources = await this.fetchImages(userId, ids)
    if (!sources.length) throw new BadRequestException('所选素材中没有可合成的图片')

    const pdf = await PDFDocument.create()

    // 1) 解码，收集「可排版」的图片及其原始尺寸
    const decoded: { key: string; image: any; width: number; height: number }[] = []
    for (const s of sources) {
      let image: any
      try {
        try {
          image = s.isPng ? await pdf.embedPng(s.buffer) : await pdf.embedJpg(s.buffer)
        } catch {
          image = s.isPng ? await pdf.embedJpg(s.buffer) : await pdf.embedPng(s.buffer)
        }
      } catch (e) {
        console.error('[pdf] 图片解码失败，跳过', s.id, e)
        continue
      }
      decoded.push({ key: s.id, image, width: image.width || s.width, height: image.height || s.height })
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
    const day = new Date().toLocaleDateString('zh-CN')
    const title = `复习资料-${day}.pdf`
    // ⚠️ 对象存储的 key 只接受 ASCII（Supabase 会拒「Invalid key」），中文只能出现在
    //    documents.title（展示名）里——此前用中文 key 上传，切到 supabase 驱动后必然失败。
    const key = await this.storageService.uploadBuffer(pdfBuffer, `review-pack-${Date.now()}.pdf`, 'application/pdf')
    const url = await this.storageService.getPublicUrl(key)
    const docId = await this.archive(userId, {
      title,
      type: 'pdf',
      file_key: key,
      mime_type: 'application/pdf',
      size_bytes: pdfBuffer.length,
      meta: { source_ids: ids },
    })

    const fillRatio = areaTotal > 0 ? areaSum / areaTotal : 0
    console.log(`[pdf] 合成完成：${decoded.length} 张图 → ${pages} 页，平均填充率 ${(fillRatio * 100).toFixed(1)}%`)
    return { url, key, doc_id: docId, pages, fillRatio, images: decoded.length }
  }

  /**
   * 把选中的图片合成 Word（.docx），供家长二次编辑、加批注后再打印。
   *
   * 与 PDF 的差异：PDF 走「多图拼页省纸」，Word 走「一图一段顺排」——
   * docx 的排版引擎无法像 pdf-lib 那样精确控制多图同页布局，
   * 强行拼版会导致图片错位/被切断页，因此这里以「可编辑性」为第一目标：
   *   · 单图宽度不超过正文可用宽，高度不超过可用高（保证一图不跨页）；
   *   · 原图小于可用宽时不放大（避免插值糊图）；
   *   · 标题 + 生成信息置顶，图片居中顺排。
   */
  async combineIntoDocx(userId: string, ids: string[]): Promise<CombineResult> {
    const sources = await this.fetchImages(userId, ids)
    if (!sources.length) throw new BadRequestException('所选素材中没有可合成的图片')

    const day = new Date().toLocaleDateString('zh-CN')
    const children: Paragraph[] = [
      new Paragraph({
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [new TextRun({ text: `复习资料 ${day}`, bold: true, size: 36, font: '黑体' })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
        children: [
          new TextRun({ text: `共 ${sources.length} 张图片 · 生成于 ${day}`, size: 20, color: '6B655D', font: '宋体' }),
        ],
      }),
    ]

    let heightSum = 0
    for (const s of sources) {
      // 等比缩放到正文可用区内；原图更小则保持原始尺寸（不放大）
      const scale = Math.min(1, DOCX_MAX_W / s.width, DOCX_MAX_H / s.height)
      const width = Math.max(1, Math.round(s.width * scale))
      const height = Math.max(1, Math.round(s.height * scale))
      heightSum += height
      try {
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 120, after: 120 },
            children: [
              new ImageRun({
                type: s.isPng ? 'png' : 'jpg',
                data: s.buffer,
                transformation: { width, height },
              }),
            ],
          }),
        )
      } catch (e) {
        console.error('[docx] 图片写入失败，跳过', s.id, e)
      }
    }

    const doc = new Document({
      sections: [
        {
          properties: {
            page: {
              size: { width: A4_TWIP.width, height: A4_TWIP.height },
              margin: {
                top: DOCX_MARGIN_TWIP,
                right: DOCX_MARGIN_TWIP,
                bottom: DOCX_MARGIN_TWIP,
                left: DOCX_MARGIN_TWIP,
              },
            },
          },
          children,
        },
      ],
    })

    const docxBuffer = Buffer.from(await Packer.toBuffer(doc))
    const title = `复习资料-${day}.docx`
    const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    const key = await this.storageService.uploadBuffer(docxBuffer, `review-pack-${Date.now()}.docx`, mime)
    const url = await this.storageService.getPublicUrl(key)
    const docId = await this.archive(userId, {
      title,
      type: 'docx',
      file_key: key,
      mime_type: mime,
      size_bytes: docxBuffer.length,
      meta: { source_ids: ids },
    })

    // docx 由 Word 排版引擎分页，这里只能按累计图高估算，仅用于前端提示文案
    const pages = Math.max(1, Math.ceil(heightSum / DOCX_MAX_H))
    console.log(`[docx] 合成完成：${sources.length} 张图，估算 ${pages} 页`)
    return { url, key, doc_id: docId, pages, fillRatio: 0, images: sources.length }
  }

  /** 归档进文档页。入库失败不影响合成结果返回，但必须打全错（best-effort catch 铁律） */
  private async archive(
    userId: string,
    input: { title: string; type: string; file_key: string; mime_type: string; size_bytes: number; meta?: Record<string, unknown> },
  ): Promise<string> {
    try {
      const doc = await this.documentsService.create(userId, input)
      return doc.id
    } catch (e) {
      console.error('[combine] 文档记录入库失败（不影响返回）', input.title, e)
      return ''
    }
  }
}
