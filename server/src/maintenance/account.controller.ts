// ============================================================
// 账号注销（OPS-18 `R-合规-03`）
//
// 为什么要有这个端点：用户（家长，数据主体是未成年人）必须能**自己**删掉全部数据，
// 而不是「发邮件联系开发者」。这也是小程序隐私合规审核会看的点。
//
// 语义：
//   DELETE /api/account            → 真删（不可恢复）
//   DELETE /api/account?dry_run=1  → 只统计会删什么、留什么，不真删
//
// ⚠️ 共享内容不跟着删：文件按引用计数处理（别人还在用就保留），
//    识别缓存 ocr_results 是跨用户内容寻址缓存，一律不动。详见 MaintenanceService.purgeUserData。
// ============================================================

import { Controller, Delete, Query, Req } from '@nestjs/common'
import { MaintenanceService } from './maintenance.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'

@Controller('account')
export class AccountController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Delete()
  async purge(@Req() req: RequestWithUser, @Query('dry_run') dryRun?: string) {
    const userId = requireUserId(req)
    const result = await this.maintenance.purgeUserData(userId, {
      dryRun: dryRun === '1' || dryRun === 'true',
    })
    return { code: 200, msg: 'success', data: result }
  }
}
