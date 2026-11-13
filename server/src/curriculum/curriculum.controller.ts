import { Controller, Get, Req, HttpCode } from '@nestjs/common'
import { CurriculumService } from './curriculum.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'

/**
 * P-028 / D-045 · Q1② 独立只读端点 `GET /api/curriculum/topics`。
 *
 * 🔴 设计约束（改之前先读 D-045）：
 *   ① **只有一个 GET**，没有 POST/PUT/DELETE/PATCH —— 维度表全局只读，服务端不暴露写端点。
 *   ② **要求正常身份**：`requireUserId` 走 `X-Auth-Token` 唯一信任根；
 *      🔴 **刻意不加入 `PUBLIC_ROUTES`** —— 字典虽无用户数据，但加白名单会扩大匿名
 *      暴露面，而前端所有自家 `/api` 请求本来就带 `authHeaders()`。选更小暴露面。
 *      若将来改成免登录，必须同步 `PUBLIC_ROUTES` 并重过隐私评估（D-045 撤销条件）。
 *   ③ 主检索 result 结构**零改动** ⇒ `CACHE_VERSION` 保持 v14，不 bump、不同步 M37。
 *   ④ 表未上生产时由 service 返回 `available:false`，本端点不抛 500。
 */
@Controller('curriculum')
export class CurriculumController {
  constructor(private readonly curriculumService: CurriculumService) {}

  @Get('topics')
  @HttpCode(200)
  async topics(@Req() req: RequestWithUser) {
    requireUserId(req)
    const data = await this.curriculumService.listTopics()
    return { code: 200, msg: 'success', data }
  }
}
