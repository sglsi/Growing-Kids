import {
  Controller, Post, Req, HttpCode, UseInterceptors,
  UploadedFile, BadRequestException,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { memoryStorage } from 'multer'
import { createHash } from 'crypto'
import { StorageService } from '../storage/storage.service'
import { TimelineService } from '../timeline/timeline.service'
import { LibraryService } from '../library/library.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'

const IMAGE_MIME_PREFIX = 'image/'

@Controller('upload')
export class UploadController {
  constructor(
    private readonly storageService: StorageService,
    private readonly timelineService: TimelineService,
    private readonly libraryService: LibraryService,
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
    const fileHash = createHash('sha256').update(buffer).digest('hex')
    const key = await this.storageService.uploadBuffer(buffer, fileName, contentType)
    const isImage = contentType.startsWith(IMAGE_MIME_PREFIX)

    let timelineId = ''
    let libraryId = ''

    if (isImage) {
      // 图片 → 统一收件箱（最近题目）
      try {
        const item = await this.timelineService.create(userId, {
          kind: 'image',
          title: file.originalname || fileName,
          file_key: key,
          mime_type: contentType,
          size_bytes: buffer.length,
          file_hash: fileHash,
          source: 'album',
        })
        timelineId = item.id
      } catch (e) {
        console.error('[upload] 图片入 timeline 失败（不影响返回）', e)
      }
    } else {
      // 文档 → 资料库
      try {
        const doc = await this.libraryService.create(userId, {
          name: file.originalname || fileName,
          file_key: key,
          mime_type: contentType,
          size_bytes: buffer.length,
          source: 'upload',
        })
        libraryId = doc.id
      } catch (e) {
        console.error('[upload] 文档入资料库失败（不影响返回）', e)
      }
    }

    console.log('[upload] 上传成功', { userId, key, timelineId, libraryId })
    return {
      code: 200,
      msg: 'success',
      data: {
        key,
        url: await this.storageService.getPublicUrl(key),
        type: isImage ? 'image' : 'document',
        timeline_id: timelineId,
        library_id: libraryId,
      },
    }
  }
}
