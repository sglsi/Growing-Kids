import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common'
import { ChatService } from './chat.service'
import { requireAdmin, requireAiEnabled, requireUserId, type RequestWithUser } from '../shared/user-context'

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  // -------- 知识库管理 --------
  // ⚠️ 授权（2026-10-27 起）：knowledge_articles 是**全局表**（无 user_id），
  //    这里四个端点此前无任何身份校验 ⇒ 任意请求可增删改所有用户可见的客服知识库
  //    （内容直接拼进 system prompt，等于可操纵所有用户的助手人设）。
  //    现已 **fail-closed**：必须 users.role = 'admin' 才放行（0017 迁移），
  //    CHAT_ADMIN_IDS 白名单仅为迁移期兼容并会打 warn。见 OPS-18 R-技术-08。
  //    提权：node server/scripts/promote-admin.mjs --device-id dev_xxx（≤60s 生效）。
  @Get('knowledge')
  @HttpCode(200)
  async listKnowledge(@Req() req: RequestWithUser) {
    // 读也走同一套门：知识库列表属后台运维视图，不对外。
    await requireAdmin(req)
    const data = await this.chatService.listKnowledge()
    return { code: 200, msg: 'success', data }
  }

  @Post('knowledge')
  @HttpCode(200)
  async createKnowledge(
    @Req() req: RequestWithUser,
    @Body()
    body: {
      title: string
      content: string
      category?: string
      tags?: string[]
      is_active?: boolean
      sort_order?: number
    },
  ) {
    await requireAdmin(req)
    const data = await this.chatService.createKnowledge(requireUserId(req), body)
    return { code: 200, msg: 'success', data }
  }

  @Patch('knowledge/:id')
  @HttpCode(200)
  async updateKnowledge(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Body()
    body: {
      title?: string
      content?: string
      category?: string | null
      tags?: string[]
      is_active?: boolean
      sort_order?: number
    },
  ) {
    await requireAdmin(req)
    const data = await this.chatService.updateKnowledge(requireUserId(req), id, body)
    return { code: 200, msg: 'success', data }
  }

  @Delete('knowledge/:id')
  @HttpCode(200)
  async removeKnowledge(@Req() req: RequestWithUser, @Param('id') id: string) {
    await requireAdmin(req)
    const data = await this.chatService.removeKnowledge(id)
    return { code: 200, msg: 'success', data }
  }

  // -------- 对话 --------
  @Post('message')
  @HttpCode(200)
  async sendMessage(
    @Req() req: RequestWithUser,
    @Body() body: { session_id?: string; content: string },
  ) {
    // R-合规-02：未开启 AI 外发 ⇒ 仅本地模式，这条消息不得发给大模型
    const userId = requireAiEnabled(req)
    const data = await this.chatService.sendMessage(userId, body.session_id ?? null, body.content)
    return { code: 200, msg: 'success', data }
  }

  @Get('messages')
  @HttpCode(200)
  async listMessages(
    @Req() req: RequestWithUser,
    @Query('session_id') sessionId: string,
  ) {
    const userId = requireUserId(req)
    const data = await this.chatService.listMessages(sessionId, userId)
    return { code: 200, msg: 'success', data }
  }

  // -------- 通用对话（中性 LLM，不带小程序知识库/人设；区别于上面的智能客服 /message）--------
  // 走 LLMClient 降级链（扣子→DeepSeek→混元）。扣子时由 bot 自身中性人设作答。
  // 安全：PAT 只在后端；前端经此代理，绝不直连 api.coze.cn。
  @Post()
  @HttpCode(200)
  async chat(
    @Req() req: RequestWithUser,
    @Body() body: { message: string; history?: { role: 'user' | 'assistant'; content: string }[] },
  ) {
    // R-合规-02：同上，通用对话是纯外发，必须过闸门
    requireAiEnabled(req)
    const answer = await this.chatService.genericChat(body?.message, body?.history)
    return { code: 200, msg: 'success', data: { answer } }
  }
}
