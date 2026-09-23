import { Module } from '@nestjs/common'
import { ImageController } from './image.controller'
import { ImageService } from './image.service'
import { StorageService } from '../storage/storage.service'
import { MaterialsModule } from '../materials/materials.module'

@Module({
  imports: [MaterialsModule],
  controllers: [ImageController],
  providers: [ImageService, StorageService],
  exports: [ImageService],
})
export class ImageModule {}