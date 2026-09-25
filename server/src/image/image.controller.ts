import { Controller, Post, Body, HttpCode, Req } from '@nestjs/common'
import { ImageService } from './image.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'
import type { ProcessImageDto } from './image.types'

@Controller('image')
export class ImageController {
  constructor(private readonly imageService: ImageService) {}

  // 图片处理：auto 自动调正 / enhance 智能高清 / erase 去手写
  @Post('process')
  @HttpCode(200)
  async process(@Body() dto: ProcessImageDto, @Req() req: RequestWithUser) {
    const userId = requireUserId(req)
    const data = await this.imageService.process(userId, dto, (req.headers || {}) as Record<string, string>)
    return { code: 200, msg: 'success', data }
  }
}
