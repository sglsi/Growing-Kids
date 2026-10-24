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
import { requireAdmin, requireUserId, type RequestWithUser } from '../shared/user-context'

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  // -------- 知识库管理 --------
  // ⚠️ 授权现状（2026-10-24 评估）：knowledge_articles 是**全局表**（无 user_id），
  //    这里四个端点此前无任何身份校验 ⇒ 任意请求可增删改所有用户可见的客服知识库
  //    （内容直接拼进 system prompt，等于可操纵所有用户的助手人设）。
  //    已加固：① 必须携带有效用户身份；② 若配置了 CHAT_ADMIN_IDS 则仅白名单可写。
  //    仍缺「角色体系」（users 表无 role 列）⇒ 已登记 GK-OPS-18，见 ADD-07 第 3 章。
  @Get('knowledge')
  @HttpCode(200)
  async listKnowledge(@Req() req: RequestWithUser) {
    // 与写操作同一套门：未配 CHAT_ADMIN_IDS 时放行 + warn（维持现状），
    // 配置后仅白名单可见。注意：匿名用户也会被中间件赋予身份，requireUserId 挡不住匿名。
    requireAdmin(req)
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
    requireAdmin(req)
    const data = await this.chatService.createKnowledge(body)
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
    requireAdmin(req)
    const data = await this.chatService.updateKnowledge(id, body)
    return { code: 200, msg: 'success', data }
  }

  @Delete('knowledge/:id')
  @HttpCode(200)
  async removeKnowledge(@Req() req: RequestWithUser, @Param('id') id: string) {
    requireAdmin(req)
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
    const userId = requireUserId(req)
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
    requireUserId(req)
    const answer = await this.chatService.genericChat(body?.message, body?.history)
    return { code: 200, msg: 'success', data: { answer } }
  }
}
