import { Module } from '@nestjs/common'
import { OcrController } from './ocr.controller'
import { OcrService } from './ocr.service'
import { OcrCacheService } from './ocr-cache.service'
import { EnvRecoveryService } from './env-recovery.service'
import { StorageModule } from '../storage/storage.module'
import { DocumentsModule } from '../documents/documents.module'

@Module({
  // DocumentsModule：导出 Word 时写入 documents 记录（前端「文档」页可见可打开）
  imports: [StorageModule, DocumentsModule],
  controllers: [OcrController],
  // EnvRecoveryService：OCR venv 自动恢复（沙箱重置自愈），OcrService 启动钩子/调用点使用
  // OcrCacheService：识别结果持久缓存（#121 同文件去重：同一份内容只识别一次）
  providers: [OcrService, OcrCacheService, EnvRecoveryService],
  // 供 ImageService 复用（Phase 3 交付 3：处理前后 OCR 一致性校验）
  exports: [OcrService, OcrCacheService],
})
export class OcrModule {}
