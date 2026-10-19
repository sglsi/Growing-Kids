import { Controller, Get, Req } from '@nestjs/common'
import { QuotaService } from './quota.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'

/**
 * 配额接口（策略 6）。
 * GET /api/quota/usage —— 当前用量与档位，供前端「设置页用量条」展示。
 */
@Controller('quota')
export class QuotaController {
  constructor(private readonly quota: QuotaService) {}

  @Get('usage')
  async usage(@Req() req: RequestWithUser) {
    const userId = requireUserId(req)
    const data = await this.quota.usageOf(userId)
    return { code: 200, msg: 'success', data }
  }
}
