import { Injectable, Logger } from '@nestjs/common'
import { StorageService } from './storage.service'
import { BlobService } from './blob.service'
import { preprocessImage, sha256, type PreprocessResult } from './image-pipeline'

export interface IngestResult {
  /** 日常展示用 key（WebP） */
  key: string
  /** 缩略图 key（WebP）；非图片时与 key 相同 */
  thumbKey: string
  /** 原图留档 key */
  originalKey: string
  /** 内容 sha256（去重标识） */
  hash: string
  sizeBytes: number
  /** 日常展示图尺寸 */
  width: number
  height: number
  mimeType: string
  /** 是否命中已有内容（true = 复用，未重复占用对象存储） */
  deduped: boolean
  /** 是否经过压缩管线 */
  optimized: boolean
}

/**
 * 统一入库服务 —— 压缩 → 去重 → 落对象存储「一条龙」。
 *
 * 依据：复习本与项目设计.md §11.3 策略 1+2+4
 *
 * 为什么单独抽出来：上传链路（upload.controller）和图片处理链路（image.service）
 * 都需要「压缩 + 去重」，若各写一份必然分叉。集中一处，改策略只改这里。
 *
 * 安全契约：
 *   - 任何步骤失败都**不阻断上传** —— sharp 挂了就存原图，去重表挂了就当新文件。
 *   - 先去重后上传：命中即复用 storage_key，**不重复占用** 对象存储。
 */
@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name)

  constructor(
    private readonly storage: StorageService,
    private readonly blobs: BlobService,
  ) {}

  /**
   * 入库一份文件。
   * @param buffer 原始字节
   * @param mimeType MIME（决定是否走图片管线）
   */
  async ingest(buffer: Buffer, mimeType: string): Promise<IngestResult> {
    let pre: PreprocessResult
    try {
      pre = await preprocessImage(buffer, mimeType || 'application/octet-stream')
    } catch (e) {
      // preprocessImage 内部已 try/catch，这里只是双保险
      this.logger.warn(`[ingest] 预处理异常，按原文件处理: ${e}`)
      pre = null as unknown as PreprocessResult
    }

    // 预处理失败（理论不可达）：退回最朴素的单文件上传
    if (!pre) {
      return this.ingestRaw(buffer, mimeType, sha256(buffer))
    }

    const hash = pre.hash

    // ---------- 去重：命中即复用，不再上传 ----------
    try {
      const { existed, record } = await this.blobs.acquire(hash)
      if (existed && record) {
        const variants = (record.variants || {}) as Record<string, string>
        const key = variants.display || record.storage_key
        const thumbKey = variants.thumb || key
        const originalKey = variants.original || record.storage_key
        this.logger.log(`[ingest] 命中去重 ${hash.slice(0, 12)}… ref=${record.ref_count + 1}`)
        return {
          key,
          thumbKey,
          originalKey,
          hash,
          sizeBytes: record.size_bytes ?? pre.display.buffer.length,
          width: record.width ?? pre.width,
          height: record.height ?? pre.height,
          mimeType: 'image/webp',
          deduped: true,
          optimized: pre.optimized,
        }
      }
    } catch (e) {
      // 去重表不可用 ⇒ 退化为「不去重」，仍正常上传，绝不阻断
      this.logger.warn(`[ingest] 去重查询失败，按新文件上传: ${e}`)
    }

    // ---------- 未命中：上传三档产物 ----------
    const isImage = pre.optimized
    const display = isImage ? pre.display : pre.original

    let key: string
    let thumbKey: string
    let originalKey: string
    try {
      if (isImage) {
        originalKey = await this.storage.uploadDerived(
          pre.original.buffer, hash, 'original', pre.original.ext, pre.original.mime,
        )
        key = await this.storage.uploadDerived(
          display.buffer, hash, 'display', display.ext, display.mime,
        )
        thumbKey = pre.skipped
          ? key // 已优化的图：缩略图复用自身，避免无谓再编码
          : await this.storage.uploadDerived(pre.thumb.buffer, hash, 'thumb', pre.thumb.ext, pre.thumb.mime)
      } else {
        // 非图片：单文件，三档指向同一个 key
        key = await this.ingestKeyOnly(buffer, hash, pre.original.ext, mimeType)
        thumbKey = key
        originalKey = key
      }
    } catch (e) {
      this.logger.error(`[ingest] 上传派生图失败，回退原文件: ${e}`)
      return this.ingestRaw(buffer, mimeType, hash)
    }

    // ---------- 登记去重表（失败不影响主流程，由 GC 孤儿核对兜底）----------
    try {
      await this.blobs.register({
        contentHash: hash,
        storageKey: key,
        sizeBytes: display.buffer.length,
        mimeType: isImage ? 'image/webp' : (mimeType || 'application/octet-stream'),
        kind: isImage ? 'image' : 'doc',
        width: pre.width,
        height: pre.height,
        variants: { original: originalKey, display: key, thumb: thumbKey },
      })
    } catch (e) {
      this.logger.warn(`[ingest] 登记去重表失败: ${e}`)
    }

    return {
      key,
      thumbKey,
      originalKey,
      hash,
      sizeBytes: display.buffer.length,
      width: pre.width,
      height: pre.height,
      mimeType: isImage ? 'image/webp' : (mimeType || 'application/octet-stream'),
      deduped: false,
      optimized: isImage,
    }
  }

  /**
   * **中间上传**（`purpose != save`，如 AI 识别前的图片）专用入口。
   *
   * 依据：复习本与项目设计.md §11.3 策略 5②「识别中间过程图即用即删，不落库」
   *      与策略 7「只存必需的」。
   *
   * 与正式 ingest() 的三点差别（每点都省一份真实存储）：
   *   1. **只存一档**（display）：中间态没有列表展示需求 ⇒ 不生成 thumb；
   *      用完即弃 ⇒ 不存 original 高清留档。
   *   2. **不 acquire**：不占引用计数。若走正式路径 acquire，中间图会因「不落库、
   *      无人 release」而 ref_count 恒为 1 ⇒ **GC 永远扫不到 → 永久泄漏**（这是修复前的实际行为）。
   *   3. **登记为 temp**（ref_count=0）⇒ 到期后由**已有的孤儿 GC** 自动回收，无需新增定时任务。
   *
   * 内容寻址 ⇒ 同一张图重复中间上传落在同一个 key，天然幂等、不重复占空间。
   */
  async ingestTemp(buffer: Buffer, mimeType: string): Promise<IngestResult> {
    let pre: PreprocessResult
    try {
      pre = await preprocessImage(buffer, mimeType || 'application/octet-stream')
    } catch (e) {
      this.logger.warn(`[ingest:temp] 预处理异常，按原文件处理: ${e}`)
      pre = null as unknown as PreprocessResult
    }
    if (!pre) return this.ingestRaw(buffer, mimeType, sha256(buffer))

    const hash = pre.hash
    const isImage = pre.optimized
    const display = isImage ? pre.display : pre.original

    // 已存在（无论正式资产还是 temp）⇒ 直接复用，**不重复上传、不改 kind**
    try {
      const existing = await this.blobs.find(hash)
      if (existing) {
        const variants = (existing.variants || {}) as Record<string, string>
        const key = variants.display || existing.storage_key
        this.logger.log(`[ingest:temp] 复用已有对象 ${hash.slice(0, 12)}… kind=${existing.kind}`)
        return {
          key, thumbKey: key, originalKey: key, hash,
          sizeBytes: existing.size_bytes ?? display.buffer.length,
          width: existing.width ?? pre.width,
          height: existing.height ?? pre.height,
          mimeType: isImage ? 'image/webp' : (mimeType || 'application/octet-stream'),
          deduped: true,
          optimized: isImage,
        }
      }
    } catch (e) {
      this.logger.warn(`[ingest:temp] 查询已有对象失败，按新对象上传: ${e}`)
    }

    let key: string
    try {
      key = await this.storage.uploadTemp(display.buffer, hash, display.ext, display.mime)
    } catch (e) {
      this.logger.error(`[ingest:temp] 上传失败，回退原文件: ${e}`)
      return this.ingestRaw(buffer, mimeType, hash)
    }

    try {
      await this.blobs.registerTemp({
        contentHash: hash,
        storageKey: key,
        sizeBytes: display.buffer.length,
        mimeType: isImage ? 'image/webp' : (mimeType || 'application/octet-stream'),
        width: pre.width,
        height: pre.height,
        variants: { display: key },
      })
    } catch (e) {
      this.logger.warn(`[ingest:temp] 登记失败（将由 GC 兜底）: ${e}`)
    }

    return {
      key, thumbKey: key, originalKey: key, hash,
      sizeBytes: display.buffer.length,
      width: pre.width,
      height: pre.height,
      mimeType: isImage ? 'image/webp' : (mimeType || 'application/octet-stream'),
      deduped: false,
      optimized: isImage,
    }
  }

  /** 非图片 / 降级：单 key 上传 */
  private async ingestKeyOnly(buffer: Buffer, hash: string, ext: string, mime: string): Promise<string> {
    const key = `blobs/${hash.slice(0, 2)}/${hash}/original.${ext}`
    return this.storage.uploadBuffer(buffer, key, mime || 'application/octet-stream')
  }

  /** 最兜底路径：完全不做任何处理，只保证文件能存上 */
  private async ingestRaw(buffer: Buffer, mimeType: string, hash: string): Promise<IngestResult> {
    const ext = (mimeType || '').includes('pdf') ? 'pdf' : 'bin'
    const key = await this.storage.uploadBuffer(
      buffer,
      `raw/${Date.now()}-${hash.slice(0, 8)}.${ext}`,
      mimeType || 'application/octet-stream',
    )
    return {
      key, thumbKey: key, originalKey: key, hash,
      sizeBytes: buffer.length, width: 0, height: 0,
      mimeType: mimeType || 'application/octet-stream',
      deduped: false, optimized: false,
    }
  }
}
