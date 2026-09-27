import { Module } from '@nestjs/common'
import { ImageController } from './image.controller'
import { ImageService } from './image.service'
import { StorageModule } from '../storage/storage.module'
import { TimelineModule } from '../timeline/timeline.module'
import { OcrModule } from '../ocr/ocr.module'

@Module({
  imports: [StorageModule, TimelineModule, OcrModule],
  controllers: [ImageController],
  providers: [ImageService],
  exports: [ImageService],
})
export class ImageModule {}
