import { Module } from '@nestjs/common'
import { OcrController } from './ocr.controller'
import { OcrService } from './ocr.service'
import { StorageService } from '../storage/storage.service'

@Module({
  controllers: [OcrController],
  providers: [OcrService, StorageService],
})
export class OcrModule {}
