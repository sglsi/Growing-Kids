import { Controller, Get, Query, Req, HttpCode, BadRequestException } from '@nestjs/common'
import { NetdiskSearchService } from './netdisk-search.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'

/**
 * 网盘资料检索的直连端点。
 *
 * 主要给排障用（「资料库搜题」实际走 answer-search 内部调用，不经过这里）：
 * 单独打这个接口能看到提了哪些 key、每条候选的命中方式和覆盖度，
 * 出问题时不至于只有一个「没搜到」。
 */
@Controller('netdisk')
export class NetdiskController {
  constructor(private readonly svc: NetdiskSearchService) {}

  @Get('search')
  @HttpCode(200)
  async search(
    @Req() req: RequestWithUser,
    @Query('q') q?: string,
    @Query('deep') deep?: string,
  ) {
    const userId = requireUserId(req)
    const question = (q || '').trim()
    if (!question) throw new BadRequestException('q 不能为空')
    const data = await this.svc.search(userId, question, { deep: deep !== '0' })
    return { code: 200, msg: 'success', data }
  }

  @Get('stats')
  @HttpCode(200)
  async stats(@Req() req: RequestWithUser) {
    const userId = requireUserId(req)
    const data = await this.svc.stats(userId)
    return { code: 200, msg: 'success', data }
  }
}
