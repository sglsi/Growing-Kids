import { Controller, Post, Body, Req, HttpCode, BadRequestException } from '@nestjs/common'
import { SearchService } from './search.service'
import { requireAiEnabled, type RequestWithUser } from '../shared/user-context'

@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  /**
   * 联网搜题：把题目文本发出去做 web 检索，再由大模型整理解答。
   *
   * 🔴 **AI 外发闸门（2026-10-27 分模块验证发现并修复）**
   *
   * 这是全项目**唯一会同时联网检索 + 调用第三方大模型**的端点。改造
   * `users.ai_enabled`（OPS-18 R-合规-02）时，`chat/message` 与 `answer-search`
   * 都补了 `requireAiEnabled()`，唯独这里漏了 ⇒ 用户明明关着"AI 与在线检索"
   * 开关，题目文本照样被发到外部，开关形同虚设。
   *
   * 更糟的是它连 `requireUserId` 都没有：不带任何身份即可调用，等于对外开了一个
   * 匿名的大模型代理。现一并收口。
   *
   * 顺序：先校验参数（无效输入直接 400，不必惊动闸门），再判闸门（403）。
   */
  @Post('solve')
  @HttpCode(200)
  async solve(@Req() req: RequestWithUser, @Body() body: { question_content: string }) {
    if (!body.question_content) throw new BadRequestException('question_content 不能为空')
    const userId = requireAiEnabled(req)
    const data = await this.searchService.solveQuestion(body.question_content, userId)
    return { code: 200, msg: 'success', data }
  }
}
