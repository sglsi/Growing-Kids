import {
  Controller, Post, Req, HttpCode, UseInterceptors,
  UploadedFile, BadRequestException, HttpException, HttpStatus,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { memoryStorage } from 'multer'
import { StorageService } from '../storage/storage.service'
import { IngestService } from '../storage/ingest.service'
import { TimelineService } from '../timeline/timeline.service'
import { LibraryService } from '../library/library.service'
import { QuotaService } from '../quota/quota.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'

const IMAGE_MIME_PREFIX = 'image/'

@Controller('upload')
export class UploadController {
  constructor(
    private readonly storageService: StorageService,
    private readonly ingestService: IngestService,
    private readonly timelineService: TimelineService,
    private readonly libraryService: LibraryService,
    private readonly quotaService: QuotaService,
  ) {}

  @Post()
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  async upload(@Req() req: RequestWithUser, @UploadedFile() file: Express.Multer.File) {
    const userId = requireUserId(req)
    if (!file) {
      throw new BadRequestException('未接收到文件（字段名必须为 file）')
    }
    let buffer: Buffer
    if (file.buffer) {
      buffer = file.buffer
    } else if (file.path) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('fs')
      buffer = await fs.promises.readFile(file.path)
    } else {
      throw new BadRequestException('未接收到文件内容')
    }

    const nameParts = file.originalname.split('.')
    const ext = (nameParts.length > 1 ? nameParts.pop()! : 'jpg').toLowerCase()
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const contentType = file.mimetype || 'application/octet-stream'
    const isImage = contentType.startsWith(IMAGE_MIME_PREFIX)

    // purpose=save 才写入「最近题目 / 资料库」；其余（如 AI 处理前的中间上传）仅返回可访问 URL，不落库。
    //
    // ⚠️ 关键修复：purpose 可能来自两处，必须都读——
    //   - query string：`/api/upload?purpose=save`（旧前端写法）
    //   - multipart 表单字段：formData.purpose（新前端写法）
    // 之前只读 req.body.purpose，而前端把 purpose 放在 URL 查询串里（multer 解析
    // multipart 后 req.body 不含它），导致 archive 恒为 false → 图片/文档永不落库，
    // 表现为「点了保存图片提示已保存，但最近题目/资料库中无记录」。
    const q = (req.query || {}) as Record<string, unknown>
    const b = (req.body || {}) as Record<string, unknown>
    const purposeRaw = b.purpose ?? q.purpose ?? ''
    const purpose = String(Array.isArray(purposeRaw) ? purposeRaw[0] : purposeRaw).trim()
    const archive = purpose === 'save' || purpose === '1' || purpose === 'true'

    // ===== 存储优化管线（复习本与项目设计.md §11.3 策略 1/2/4 + 5②/7）=====
    // 压缩（→WebP+缩略图）→ 内容去重（命中复用，不重复占对象存储）→ 落库。
    // IngestService 内部全程兜底：任何一步失败都会降级为「原样上传」，绝不阻断上传。
    //
    // ===== 配额预检（策略 6）=====
    // 灰度由 QUOTA_MODE 控制：off / shadow / warn 都不阻断；只有 block 才真正拦截。
    // 临时对象（temp）不占用户长期配额 —— 它 24 小时后就回收，用户也不消费它。
    if (purpose !== 'temp') {
      const quota = await this.quotaService.checkUpload(userId, buffer.length)
      if (!quota.allowed) {
        throw new HttpException(
          {
            code: quota.code,
            msg: quota.code === 'QUOTA_COUNT'
              ? '图片张数已达上限，请清理后重试或升级'
              : '存储空间已满，请清理后重试或升级',
            data: {
              used_bytes: quota.usage.usedBytes,
              quota_bytes: quota.usage.quotaBytes,
              used_count: quota.usage.usedCount,
              quota_count: quota.usage.quotaCount,
              tier: quota.usage.tier,
            },
          },
          HttpStatus.PAYLOAD_TOO_LARGE, // 413
        )
      }
    }

    // ⚠️ 分流判据必须是**显式声明** purpose='temp'，不能用「archive 是否为真」代替：
    //   识别链路（整卷识别 / 题答分传 / 文档识别）上传时不带 purpose ⇒ archive=false，
    //   但它们的 key 会写进识别结果的 question_image_keys 被题目正式引用。
    //   若按 archive=false 一律当 temp 回收，24 小时后这些图会被删 ⇒ **已保存的题目图片裂掉**。
    //   所以只有调用方明确声明「这是用完即弃的中间态」才走 temp（策略 5② + 策略 7）；
    //   其余一律走正式路径 —— 宁可多占一份空间，不可误删一张在用图片。
    const isTemp = purpose === 'temp'
    // memory 上传（成长记忆：图片 / 音频 / 视频）走正式存储但不归档到 timeline / library，
    // 仅返回 key/url，由 memory 模块在 addMedia 时把 key 关联到 memory_media。
    const isMemory = purpose === 'memory'
    const ing = isTemp
      ? await this.ingestService.ingestTemp(buffer, contentType)
      : await this.ingestService.ingest(buffer, contentType)
    const key = ing.key
    const fileHash = ing.hash

    let timelineId = ''
    let libraryId = ''

    if (archive && !isMemory) {
      if (isImage) {
        // 图片 → 统一收件箱（最近题目）
        // 写入 thumb_key / width / height，使列表能走缩略图（此前这些字段恒空 → 列表拉原图）
        const item = await this.timelineService.create(userId, {
          kind: 'image',
          title: file.originalname || fileName,
          file_key: key,
          thumb_key: ing.thumbKey,
          mime_type: ing.mimeType,
          width: ing.width || undefined,
          height: ing.height || undefined,
          size_bytes: ing.sizeBytes,
          file_hash: fileHash,
          source: 'album',
        })
        timelineId = item.id
      } else {
        // 文档 → 资料库
        const doc = await this.libraryService.create(userId, {
          name: file.originalname || fileName,
          file_key: key,
          thumb_key: ing.thumbKey,
          mime_type: ing.mimeType,
          width: ing.width || undefined,
          height: ing.height || undefined,
          size_bytes: ing.sizeBytes,
          file_hash: fileHash,
          source: 'upload',
        })
        libraryId = doc.id
      }
    }

    // 落库的上传会改变用量 ⇒ 让配额缓存立即失效（下次重算）
    if (purpose !== 'temp') this.quotaService.invalidate(userId)

    console.log('[upload] 上传成功', {
      userId,
      key,
      purpose,
      quotaMode: this.quotaService.mode,
      archive,
      timelineId,
      libraryId,
      optimized: ing.optimized,
      deduped: ing.deduped,
      originalBytes: buffer.length,
      storedBytes: ing.sizeBytes,
      savedPct: buffer.length ? `${(100 - (ing.sizeBytes / buffer.length) * 100).toFixed(1)}%` : '-',
    })
    return {
      code: 200,
      msg: 'success',
      data: {
        key,
        url: await this.storageService.getPublicUrl(key),
        thumb_key: ing.thumbKey,
        thumb_url: await this.storageService.getPublicUrl(ing.thumbKey),
        type: isImage ? 'image' : 'document',
        timeline_id: timelineId,
        library_id: libraryId,
        size_bytes: ing.sizeBytes,
        width: ing.width || undefined,
        height: ing.height || undefined,
        deduped: ing.deduped,
      },
    }
  }
}
