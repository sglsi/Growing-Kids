import { Controller, Post, Body, HttpCode, Req } from '@nestjs/common'
import { ImageService } from './image.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'
import type { ProcessImageDto } from './image.types'

@Controller('image')
export class ImageController {
  constructor(private readonly imageService: ImageService) {}

  // 图片处理：
  //   auto     自动调正
  //   enhance  智能高清
  //   erase    去手写（图生图重绘，阶段一增强）
  //   erase_v2 去手写（mask + 局部修复，阶段二，不重排）
  @Post('process')
  @HttpCode(200)
  async process(@Body() dto: ProcessImageDto, @Req() req: RequestWithUser) {
    const userId = requireUserId(req)
    const headers = (req.headers || {}) as Record<string, string>

    // 阶段二：走 mask + 局部修复路径（不做整图重绘）
    if (dto.action === 'erase_v2') {
      const data = await this.imageService.eraseV2(userId, dto, headers)
      return { code: 200, msg: 'success', data }
    }

    const data = await this.imageService.process(userId, dto, headers)
    return { code: 200, msg: 'success', data }
  }
}
