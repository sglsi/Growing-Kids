import { Module } from '@nestjs/common'
import { OcrController } from './ocr.controller'
import { OcrService } from './ocr.service'
import { StorageModule } from '../storage/storage.module'
import { DocumentsModule } from '../documents/documents.module'

@Module({
  // DocumentsModule：导出 Word 时写入 documents 记录（前端「文档」页可见可打开）
  imports: [StorageModule, DocumentsModule],
  controllers: [OcrController],
  providers: [OcrService],
  // 供 ImageService 复用（Phase 3 交付 3：处理前后 OCR 一致性校验）
  exports: [OcrService],
})
export class OcrModule {}
