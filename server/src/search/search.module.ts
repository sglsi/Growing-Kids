import { Module } from '@nestjs/common'
import { SearchController } from './search.controller'
import { SearchService } from './search.service'

@Module({
  controllers: [SearchController],
  providers: [SearchService],
  // 导出供 JobsModule 复用（异步执行 search-solve）：
  // 该链路实测 60~90s，超过微信 request 的 60s 超时天花板（OPS-18 R-上线-01）
  exports: [SearchService],
})
export class SearchModule {}
