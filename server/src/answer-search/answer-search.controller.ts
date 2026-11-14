import { Controller, Post, Body, Param, Req, HttpCode } from '@nestjs/common'
import { requireAiEnabled, requireUserId, type RequestWithUser } from '../shared/user-context'
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
   *   kb     = 资料库：**只检索运营者公共资料库**（秒级），不喂给 AI
   *   ai     = AI 解题：**只做模型推理**，不检索，明确标注未联网核实
   */
  @Post(':id')
  @HttpCode(200)
  async searchAnswer(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Body() body: { force?: boolean; mode?: 'search' | 'ai' | 'kb' } = {},
  ) {
    // R-合规-02：联网检索（search）与大模型解题（ai）**都是外发**，未开启 AI 外发时
    // 一律 403 AI_DISABLED；仅本地模式下滑题功能整体不可用，这是有意的：本地题库能
    // 兜住的用它兜，兜不住的宁可不给答案，也不偷偷发出去。
    //
    // ⚠️ kb（知识库）**单独放行**（思傅 2026-11-03 反馈「从我的资料库搜答案没了」）：
    //    它只检索公共资料库、不做任何 AI 生成，属于「去资料里找」，
    //    既不是深度合成类服务，也不该被「AI 与在线检索」开关连坐。
    //    代价是这一路不受开关约束 ⇒ 隐私政策里已单独写明：只在你点击时才发送题干。
    const mode = body?.mode === 'ai' ? 'ai' : body?.mode === 'kb' ? 'kb' : 'search'
    const userId = mode === 'kb' ? requireUserId(req) : requireAiEnabled(req)
    const data = await this.answerSearchService.searchAnswer(userId, id, {
      force: !!body?.force,
      mode,
    })
    return { code: 200, msg: 'success', data }
  }
}
