import {
  Controller, Post, HttpCode, UseInterceptors,
  UploadedFile, BadRequestException,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { memoryStorage } from 'multer'
import { StorageService } from '../storage/storage.service'

@Controller('upload')
export class UploadController {
  constructor(private readonly storageService: StorageService) {}

  @Post()
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  async upload(@UploadedFile() file: Express.Multer.File) {
    let buffer: Buffer
    if (file?.buffer) {
      buffer = file.buffer
    } else if (file?.path) {
      // 极少数走磁盘的情况
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('fs')
      buffer = await fs.promises.readFile(file.path)
    } else {
      throw new BadRequestException('未接收到文件')
    }

    const ext = (file.originalname.split('.').pop() || 'jpg').toLowerCase()
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const key = await this.storageService.uploadBuffer(buffer, fileName, file.mimetype)
    const url = await this.storageService.getPublicUrl(key)

    console.log('[upload] 上传成功', { fileName: file.originalname, mimetype: file.mimetype, key })
    return { code: 200, msg: 'success', data: { key, url } }
  }
}
