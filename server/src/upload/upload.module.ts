import { Module } from '@nestjs/common'
import { UploadController } from './upload.controller'
import { StorageService } from '../storage/storage.service'
import { MaterialsModule } from '../materials/materials.module'

@Module({
  imports: [MaterialsModule],
  controllers: [UploadController],
  providers: [StorageService],
})
export class UploadModule {}
