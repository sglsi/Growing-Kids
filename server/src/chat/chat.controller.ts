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
import { requireUserId, type RequestWithUser } from '../shared/user-context'

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  // -------- 知识库管理 --------
  @Get('knowledge')
  @HttpCode(200)
  async listKnowledge() {
    const data = await this.chatService.listKnowledge()
    return { code: 200, msg: 'success', data }
  }

  @Post('knowledge')
  @HttpCode(200)
  async createKnowledge(
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
    const data = await this.chatService.createKnowledge(body)
    return { code: 200, msg: 'success', data }
  }

  @Patch('knowledge/:id')
  @HttpCode(200)
  async updateKnowledge(
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
    const data = await this.chatService.updateKnowledge(id, body)
    return { code: 200, msg: 'success', data }
  }

  @Delete('knowledge/:id')
  @HttpCode(200)
  async removeKnowledge(@Param('id') id: string) {
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
