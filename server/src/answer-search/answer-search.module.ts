import { Module } from '@nestjs/common'
import { AnswerSearchService } from './answer-search.service'
import { AnswerSearchController } from './answer-search.controller'
import { TimelineModule } from '../timeline/timeline.module'
import { OcrModule } from '../ocr/ocr.module'

@Module({
  imports: [TimelineModule, OcrModule],
  controllers: [AnswerSearchController],
  providers: [AnswerSearchService],
  exports: [AnswerSearchService],
})
export class AnswerSearchModule {}
