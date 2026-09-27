import { Controller, Post, Body, HttpCode, HttpException, Req } from '@nestjs/common'
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

    // 阶段三(Phase 1)：auto 走几何纠偏（本地，100% 保真），受 IMG_PIPELINE_MODE 灰度控制。
    // 默认 hybrid：新管线优先，任何异常自动回退到 process() 图生图兜底 —— 既不硬失败，
    // 又保证 Phase 1-3 功能**开箱可用**（旧默认 'gen' 会让新功能静默失效，表现为「点了没反应」）。
    const MODE = (process.env.IMG_PIPELINE_MODE || 'hybrid').toLowerCase()
    if ((MODE === 'new' || MODE === 'hybrid') && dto.action === 'auto') {
      try {
        const data = await this.imageService.straighten(userId, dto, headers)
        return { code: 200, msg: 'success', data }
      } catch (e) {
        if (MODE === 'hybrid') {
          console.warn('[image] auto 几何纠偏失败，回退图生图兜底', e)
        } else {
          throw e
        }
      }
    }

    // 阶段三(Phase 2)：enhance 走智能高清（本地 SR，CPU 推理，保真），同受 IMG_PIPELINE_MODE 灰度控制
    if ((MODE === 'new' || MODE === 'hybrid') && dto.action === 'enhance') {
      try {
        const data = await this.imageService.enhance(userId, dto, headers)
        return { code: 200, msg: 'success', data }
      } catch (e) {
        // ⚠️ 限流类错误（429/503）**绝不能**被 hybrid 兜底吞掉：
        //    否则会把「被闸拦下的重任务」直接推给更贵的图生图，等于绕过保护、放大负载。
        //    这类错误原样抛出，让前端据此提示并降级到 x2。
        if (e instanceof HttpException && this.isRateLimitError(e)) {
          throw e
        }
        if (MODE === 'hybrid') {
          console.warn('[image] 智能高清 SR 失败，回退图生图兜底', e)
        } else {
          throw e
        }
      }
    }

    const data = await this.imageService.process(userId, dto, headers)
    return { code: 200, msg: 'success', data }
  }

  /** 判断是否为 SR 限流类错误（429 / 503）——用于跳过 hybrid 兜底 */
  private isRateLimitError(e: HttpException): boolean {
    const status = e.getStatus()
    return status === 429 || status === 503
  }
}
