import { Module } from '@nestjs/common'
import { JobsController } from './jobs.controller'
import { JobsService } from './jobs.service'
import { ImageModule } from '../image/image.module'
import { AnswerSearchModule } from '../answer-search/answer-search.module'
import { SearchModule } from '../search/search.module'

/**
 * 异步任务模块
 *
 * 依赖是**单向**的（jobs → image / answer-search / search），不构成循环。
 * ⚠️ `SearchModule` 原先没导出 `SearchService`，这里需要它执行 search-solve
 *    ⇒ 已在该模块补 `exports`。
 */
@Module({
  imports: [ImageModule, AnswerSearchModule, SearchModule],
  controllers: [JobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
