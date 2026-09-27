import { Controller, Get, Req } from '@nestjs/common'
import { TierStatsService } from './tier-stats.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'

/**
 * 存储运维接口。
 *
 * GET /api/storage/tier-stats —— 分层统计（策略 3）
 *   用途一：在云控制台配生命周期规则**前后各调一次**，核对省了多少，而不是只看账单猜；
 *   用途二：容量告警数据源（total.bytes 超过阈值即告警，设计文档 §11.5 第 6 条）。
 *
 * 需登录（requireUserId）：这是全库级别的用量数据，不应对外开放。
 */
@Controller('storage')
export class StorageController {
  constructor(private readonly service: TierStatsService) {}

  @Get('tier-stats')
  async tierStats(@Req() req: RequestWithUser) {
    requireUserId(req)
    const data = await this.service.report()
    return { code: 200, msg: 'success', data }
  }
}
