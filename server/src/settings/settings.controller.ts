import { BadRequestException, Body, Controller, Get, HttpCode, Put, Req } from '@nestjs/common'
import { invalidateUserFlags, requireUserId, type RequestWithUser } from '../shared/user-context'
import { UsersService } from '../users/users.service'

/**
 * 用户设置（目前只有一项：AI 外发开关）
 * ------------------------------------------------------------------
 * OPS-18 `R-合规-02` 的落地口。
 *
 * 产品口径（思傅 2026-10-27 明确）：
 *   **由用户自己决定是否开放 ima 与 LLM 访问**——开了才走大模型/在线检索，
 *   没开就只走本地（本机 OCR 侧车 + 本地题库），任何内容不出机器。
 *
 * 为什么默认关：
 *   数据主体是未成年人。缺省"默认外发"需要在监管与家长两头都自证合规，
 *   而缺省"默认不外发"只需要一句话说明白。后者的合规成本低得多。
 *
 * ⚠️ 真正的拦截点在 `shared/user-context.ts` 的 `requireAiEnabled()`，
 *    本接口只负责读写开关。只藏前端按钮不叫控制。
 */
@Controller('settings')
export class SettingsController {
  constructor(private readonly usersService: UsersService) {}

  /** 读取当前开关（前端启动时预热，用于决定是否展示 AI 入口） */
  @Get()
  @HttpCode(200)
  async getSettings(@Req() req: RequestWithUser) {
    const userId = requireUserId(req)
    const flags = await this.usersService.findFlags(userId)
    return { code: 200, msg: 'success', data: { ai_enabled: flags.aiEnabled, role: flags.role } }
  }

  /** 设置 AI 外发开关 */
  @Put('ai')
  @HttpCode(200)
  async setAiEnabled(@Req() req: RequestWithUser, @Body() body: { enabled?: unknown }) {
    const userId = requireUserId(req)
    if (typeof body?.enabled !== 'boolean') {
      throw new BadRequestException('enabled 必须是布尔值')
    }
    const enabled = await this.usersService.setAiEnabled(userId, body.enabled)
    // 立刻失效缓存：否则用户打开开关后还要等最多 60s 才能用，会被当成"没生效"
    await invalidateUserFlags(userId)
    return { code: 200, msg: 'success', data: { ai_enabled: enabled } }
  }
}
