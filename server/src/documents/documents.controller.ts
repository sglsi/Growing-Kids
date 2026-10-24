import { Controller, Get, Patch, Delete, Body, Post, Query, Param, Req, HttpCode, HttpException, HttpStatus } from '@nestjs/common'
import { DocumentsService } from './documents.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'
import type { DocumentQuery } from './documents.types'

interface IdsBody {
  ids?: string[]
}

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get()
  @HttpCode(200)
  async list(@Req() req: RequestWithUser, @Query() query: DocumentQuery) {
    try {
      const userId = requireUserId(req)
      const data = await this.documentsService.list(userId, query)
      return { code: 200, msg: 'success', data }
    } catch (e) {
      // ⚠️ 必须传字符串：早期用 { code, msg } 对象，全局过滤器的 messageOf 读
      // r.message 读不到（字段叫 msg）⇒ 回退 e.message = "Http Exception"，
      // 真实错误信息永远到不了前端（2026-10-24 实测 documents rename 发现）。
      throw new HttpException((e as Error).message, HttpStatus.INTERNAL_SERVER_ERROR)
    }
  }

  @Patch(':id')
  @HttpCode(200)
  async rename(@Req() req: RequestWithUser, @Param('id') id: string, @Body() body: { title?: string }) {
    // 不套 try/catch：让 service 的 BadRequest/NotFound 原样透出
    // （早期版本在这里二次包装成 HttpException，msg 会被 Nest 默认响应吞掉）
    const userId = requireUserId(req)
    const data = await this.documentsService.rename(userId, id, body?.title || '')
    return { code: 200, msg: 'success', data }
  }

  @Post('batch-delete')
  @HttpCode(200)
  async batchDelete(@Req() req: RequestWithUser, @Body() body: IdsBody) {
    const ids = Array.isArray(body?.ids) ? body.ids : []
    if (!ids.length) return { code: 200, msg: 'success', data: { removed: 0 } }
    try {
      const userId = requireUserId(req)
      const data = await this.documentsService.removeMany(userId, ids)
      return { code: 200, msg: 'success', data }
    } catch (e) {
      // ⚠️ 必须传字符串：早期用 { code, msg } 对象，全局过滤器的 messageOf 读
      // r.message 读不到（字段叫 msg）⇒ 回退 e.message = "Http Exception"，
      // 真实错误信息永远到不了前端（2026-10-24 实测 documents rename 发现）。
      throw new HttpException((e as Error).message, HttpStatus.INTERNAL_SERVER_ERROR)
    }
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Req() req: RequestWithUser, @Param('id') id: string) {
    try {
      const userId = requireUserId(req)
      const data = await this.documentsService.remove(userId, id)
      return { code: 200, msg: 'success', data }
    } catch (e) {
      // ⚠️ 必须传字符串：早期用 { code, msg } 对象，全局过滤器的 messageOf 读
      // r.message 读不到（字段叫 msg）⇒ 回退 e.message = "Http Exception"，
      // 真实错误信息永远到不了前端（2026-10-24 实测 documents rename 发现）。
      throw new HttpException((e as Error).message, HttpStatus.INTERNAL_SERVER_ERROR)
    }
  }
}
