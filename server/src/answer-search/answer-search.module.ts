import { Module } from '@nestjs/common'
import { AnswerSearchService } from './answer-search.service'
import { AnswerSearchController } from './answer-search.controller'
import { TimelineModule } from '../timeline/timeline.module'
import { OcrModule } from '../ocr/ocr.module'
import { NetdiskModule } from '../netdisk/netdisk.module'

@Module({
  // NetdiskModule：mode=kb 时查运营者公共资料库（D-060 移除外部知识库）
  imports: [TimelineModule, OcrModule, NetdiskModule],
  controllers: [AnswerSearchController],
  providers: [AnswerSearchService],
  exports: [AnswerSearchService],
})
export class AnswerSearchModule {}
