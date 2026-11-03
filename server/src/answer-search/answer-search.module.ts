import { Module } from '@nestjs/common'
import { AnswerSearchService } from './answer-search.service'
import { AnswerSearchController } from './answer-search.controller'
import { TimelineModule } from '../timeline/timeline.module'
import { OcrModule } from '../ocr/ocr.module'
import { NetdiskModule } from '../netdisk/netdisk.module'

@Module({
  // NetdiskModule：mode=kb 时先查百度网盘资料，未命中再查 ima（思傅 2026-11-03 定）
  imports: [TimelineModule, OcrModule, NetdiskModule],
  controllers: [AnswerSearchController],
  providers: [AnswerSearchService],
  exports: [AnswerSearchService],
})
export class AnswerSearchModule {}
