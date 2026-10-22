import { Controller, Post, Body, Param, Req, HttpCode } from '@nestjs/common'
import { requireUserId, type RequestWithUser } from '../shared/user-context'
import { AnswerSearchService } from './answer-search.service'

@Controller('answer-search')
export class AnswerSearchController {
  constructor(private readonly answerSearchService: AnswerSearchService) {}

  /**
   * 为指定题目联网搜答案。
   *
   * ⚠️ 本接口**不写库** —— 只返回候选答案，由前端展示后用户点「采纳」才写入，
   *    杜绝模型幻觉答案静默污染题库（设计方案 §2.3 安全阀）。
   */
  @Post(':id')
  @HttpCode(200)
  async searchAnswer(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Body() body: { force?: boolean } = {},
  ) {
    const userId = requireUserId(req)
    const data = await this.answerSearchService.searchAnswer(userId, id, { force: !!body?.force })
    return { code: 200, msg: 'success', data }
  }
}
