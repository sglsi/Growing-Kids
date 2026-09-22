import {
  Controller, Post, HttpCode, UseInterceptors,
  UploadedFile, BadRequestException,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { memoryStorage } from 'multer'
import { StorageService } from '../storage/storage.service'
import { MaterialsService } from '../materials/materials.service'

const IMAGE_MIME_PREFIX = 'image/'

@Controller('upload')
export class UploadController {
  constructor(
    private readonly storageService: StorageService,
    private readonly materialsService: MaterialsService,
  ) {}

  @Post()
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  async upload(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('未接收到文件（字段名必须为 file）')
    }
    let buffer: Buffer
    if (file.buffer) {
      buffer = file.buffer
    } else if (file.path) {
      // 极少数走磁盘的情况
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
    const key = await this.storageService.uploadBuffer(buffer, fileName, contentType)
    const url = await this.storageService.getPublicUrl(key)
    const materialType = contentType.startsWith(IMAGE_MIME_PREFIX) ? 'image' : 'document'

    // 导入的文件/图片统一作为素材入库，供后续复用
    let materialId = ''
    try {
      const material = await this.materialsService.createMaterial({
        name: file.originalname || fileName,
        type: materialType,
        file_key: key,
        url,
        mime_type: contentType,
        size_bytes: buffer.length,
      })
      materialId = material.id
    } catch (e) {
      console.error('[upload] 素材入库失败（不影响识别）', e)
    }

    console.log('[upload] 上传成功', {
      fileName: file.originalname, mimetype: file.mimetype, key, materialId,
    })
    return {
      code: 200,
      msg: 'success',
      data: { key, url, material_id: materialId, type: materialType },
    }
  }
}
