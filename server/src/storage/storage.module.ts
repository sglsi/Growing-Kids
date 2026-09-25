import { Module, Global } from '@nestjs/common'
import { StorageService } from './storage.service'

/**
 * 对象存储（TOS/S3）能力模块。
 * 全局提供 StorageService，供 timeline/library/documents/pdf/document/image/ocr 等模块使用。
 */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}