import { Controller, Post, Body, HttpCode, Req } from '@nestjs/common'
import { ImageService } from './image.service'
import type { ProcessImageDto } from './image.types'
import type { Request } from 'express'

@Controller('image')
export class ImageController {
  constructor(private readonly imageService: ImageService) {}

  // 图片处理：auto 自动调正 / enhance 智能高清 / erase 去手写
  @Post('process')
  @HttpCode(200)
  async process(@Body() dto: ProcessImageDto, @Req() req: Request) {
    const data = await this.imageService.process(dto, (req.headers || {}) as Record<string, string>)
    return { code: 200, msg: 'success', data }
  }
}