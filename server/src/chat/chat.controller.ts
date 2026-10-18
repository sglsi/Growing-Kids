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
}
