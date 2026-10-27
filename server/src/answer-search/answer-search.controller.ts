import { Controller, Post, Body, Param, Req, HttpCode } from '@nestjs/common'
import { requireAiEnabled, type RequestWithUser } from '../shared/user-context'
import { AnswerSearchService } from './answer-search.service'

@Controller('answer-search')
export class AnswerSearchController {
  constructor(private readonly answerSearchService: AnswerSearchService) {}

  /**
   * 为指定题目搜答案。
   *
   * ⚠️ 本接口**不写库** —— 只返回候选答案，由前端展示后用户点「采纳」才写入，
   *    杜绝模型幻觉答案静默污染题库（设计方案 §2.3 安全阀）。
   *
   * mode（思傅 2026-10-23 明确拆分）：
   *   search = 联网搜题：**只做真实网络检索**，不喂给 AI 解题，直接给来源摘要+链接
   *   kb     = 知识库：**只检索 ima 知识库**（秒级），不喂给 AI；未配凭据时返回配置指引
   *   ai     = AI 解题：**只做模型推理**，不检索，明确标注未联网核实
   */
  @Post(':id')
  @HttpCode(200)
  async searchAnswer(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Body() body: { force?: boolean; mode?: 'search' | 'ai' | 'kb' } = {},
  ) {
    // R-合规-02：三条通道（search 联网检索 / kb ima / ai 大模型）**全部是外发**，
    // 未开启 AI 外发时一律 403 AI_DISABLED。仅本地模式下滑题功能整体不可用，
    // 这是有意的：本地题库能兜住的用它兜，兜不住的宁可不给答案，也不偷偷发出去。
    const userId = requireAiEnabled(req)
    const mode = body?.mode === 'ai' ? 'ai' : body?.mode === 'kb' ? 'kb' : 'search'
    const data = await this.answerSearchService.searchAnswer(userId, id, {
      force: !!body?.force,
      mode,
    })
    return { code: 200, msg: 'success', data }
  }
}
