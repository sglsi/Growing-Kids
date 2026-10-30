import { Module } from '@nestjs/common'
import { JobsController } from './jobs.controller'
import { JobsService } from './jobs.service'
import { ImageModule } from '../image/image.module'
import { OcrModule } from '../ocr/ocr.module'
import { AnswerSearchModule } from '../answer-search/answer-search.module'
import { SearchModule } from '../search/search.module'

/**
 * 异步任务模块
 *
 * 依赖是**单向**的（jobs → image / ocr / answer-search / search），不构成循环。
 * ⚠️ `SearchModule` 原先没导出 `SearchService`，这里需要它执行 search-solve
 *    ⇒ 已在该模块补 `exports`。
 * ⚠️ `doc-recognize`（GK-23-21）需要 `OcrService.recognizeDoc`：多页 PDF 的
 *    文字层提取 + 扫描页逐页 OCR 是**分钟级**，同步接口必撞微信 60s 天花板。
 */
@Module({
  imports: [ImageModule, OcrModule, AnswerSearchModule, SearchModule],
  controllers: [JobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
