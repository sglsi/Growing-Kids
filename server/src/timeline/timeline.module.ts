import { Module } from '@nestjs/common'
import { TimelineController } from './timeline.controller'
import { TimelineService } from './timeline.service'
import { StorageModule } from '../storage/storage.module'
import { SecurityModule } from '../security/security.module'

@Module({
  imports: [StorageModule, SecurityModule],
  controllers: [TimelineController],
  providers: [TimelineService],
  exports: [TimelineService],
})
export class TimelineModule {}
