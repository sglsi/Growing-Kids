import { Injectable, BadRequestException, Logger } from '@nestjs/common'
import sharp from 'sharp'
import { StorageService } from '../storage/storage.service'
import { LibraryService } from './library.service'
import { normalizeImageSource, type NormalizedImage } from '../pdf/image-normalize'
import { buildOneImagePerPagePdf } from '../pdf/one-image-per-page'

/**
 * 一次最多合成多少张。
 * 上限的意义不只是省资源：微信 `wx.request` 超时硬顶 60s，本端点是同步合成，
 * 张数不封顶就有「多图 → 超时但服务端其实成功入库」的幽灵数据。
 * 超过上限请分两次导入（资料库里会得到两份独立 PDF）。
 */
export const MAX_COMBINE_IMAGES = 20

/**
 * 只接受本项目上传链路产出的对象 key，挡住 `../`、绝对路径与任意路径读取。
 * 合法形态：`tmp/xx/<hash>.<ext>`（purpose=temp 主路径）、
 * `blobs/xx/<hash>/...`（物理去重命中）、`raw/...`（预处理降级的兜底）。
 */
const OBJECT_KEY_RE = /^(?:tmp|blobs|raw)\/[A-Za-z0-9._/-]+$/

function defaultName(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `图片合成_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.pdf`
}

/**
 * 资料库「多图导入 → 一份 PDF」（D-063）。
 *
 * 与复习本 `PdfService.combine()` 的区别（**刻意不复用它的取数与归档**）：
 *  · 数据源：`combine` 只认 timeline 条目 id；这里直接收**上传返回的 storage key**，
 *    临时图走 `purpose=temp`（ref_count=0，24h 后由既有孤儿 GC 回收），
 *    不会在收件箱 / 资料库多出 N 条原图记录。
 *  · 版式：复习本走智能拼页省纸；这里按思傅 2026-11-15 改判走**一图一页**，
 *    `keys` 的先后就是 PDF 页序，自动/手动排序的结果必须看得见。
 *  · 归档：只 `LibraryService.create()` **一条**成品记录，不写 documents、不写 timeline。
 *
 * 🔴 归属边界：对象 key 是内容寻址的，不含 user_id，`blob_objects` 也没有 owner 列，
 *    因此服务端无法逐 key 证明「这张图属于当前用户」（与项目既有 `/api/storage/files/*`
 *    直读模型一致）。本端点要求登录态 + key 格式白名单，key 是 64 位内容 hash 不可枚举；
 *    若将来要做逐对象强隔离，需独立提案改存储模型，本轮不假装已做到。
 */
@Injectable()
export class LibraryImageCombineService {
  private readonly logger = new Logger(LibraryImageCombineService.name)

  constructor(
    private readonly storage: StorageService,
    private readonly library: LibraryService,
  ) {}

  async combine(userId: string, keys: string[], name?: string, folderId?: string | null): Promise<{
    id: string
    name: string
    url: string
    pages: number
    images: number
  }> {
    if (!Array.isArray(keys) || !keys.length) throw new BadRequestException('请先选择要合成的图片')
    if (keys.length > MAX_COMBINE_IMAGES) {
      throw new BadRequestException(`一次最多合成 ${MAX_COMBINE_IMAGES} 张图片，请分次导入`)
    }
    const bad = keys.filter((k) => typeof k !== 'string' || k.includes('..') || !OBJECT_KEY_RE.test(k))
    if (bad.length) throw new BadRequestException('图片来源无效，请重新选择图片')

    // 🔴 严格按入参数组顺序读图，绝不排序、也绝不并行拉取后丢序：
    //    顺序是用户「自动排序 + 手动调序」的唯一成果，乱一条就等于功能没做。
    const images: NormalizedImage[] = []
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      let buf: Buffer | null = null
      try {
        buf = await this.storage.readObject(key)
      } catch (e) {
        this.logger.warn(`[combine-images] 读取第 ${i + 1} 张失败：${key} ${e instanceof Error ? e.message : e}`)
      }
      if (!buf || !buf.length) {
        this.logger.warn(`[combine-images] 第 ${i + 1} 张为空，跳过：${key}`)
        continue
      }
      const norm = await normalizeImageSource(buf, `第${i + 1}张`)
      if (!norm) {
        this.logger.warn(`[combine-images] 第 ${i + 1} 张无法解码，跳过：${key}`)
        continue
      }
      images.push(norm)
    }
    if (!images.length) throw new BadRequestException('所选图片无法读取，请重新选择')

    const pdfBytes = await buildOneImagePerPagePdf(images)
    const title = ((name || '').trim() || defaultName()).slice(0, 96)
    const safeTitle = /\.pdf$/i.test(title) ? title : `${title}.pdf`
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const fileKey = await this.storage.uploadBuffer(
      pdfBytes,
      `library-combine-${stamp}.pdf`,
      'application/pdf',
    )

    // 封面缩略图：让资料库卡片一眼看出是哪份卷子。失败不影响成品入库。
    let thumbKey: string | undefined
    try {
      const thumb = await sharp(images[0].buffer)
        .resize({ width: 320, height: 320, fit: 'inside' })
        .jpeg({ quality: 80 })
        .toBuffer()
      thumbKey = await this.storage.uploadBuffer(thumb, `library-combine-thumb-${stamp}.jpg`, 'image/jpeg')
    } catch (e) {
      this.logger.warn(`[combine-images] 封面缩略图生成失败（不影响成品）：${e instanceof Error ? e.message : e}`)
    }

    // 🔴 只建这一条：原图不单独建条目（Q4「只存合成文件到资料库」）
    const doc = await this.library.create(userId, {
      name: safeTitle,
      file_key: fileKey,
      thumb_key: thumbKey,
      mime_type: 'application/pdf',
      size_bytes: pdfBytes.length,
      source: 'image-combine',
      tags: ['图片合成'],
      // D-068：成品归档到合成时所在文件夹（归属由 LibraryService.create 统一校验）
      ...(folderId ? { folder_id: folderId } : {}),
    })
    const [withUrl] = await this.library.withUrls([doc])
    this.logger.log(`[combine-images] ${images.length} 张图 → ${images.length} 页 PDF，归档 ${doc.id}`)
    return {
      id: doc.id,
      name: doc.name,
      url: withUrl.url || '',
      pages: images.length,
      images: images.length,
    }
  }
}
