import { Module } from '@nestjs/common'
import { UploadController } from './upload.controller'
import { StorageModule } from '../storage/storage.module'
import { TimelineModule } from '../timeline/timeline.module'
import { LibraryModule } from '../library/library.module'

@Module({
  imports: [StorageModule, TimelineModule, LibraryModule],
  controllers: [UploadController],
})
export class UploadModule {}
