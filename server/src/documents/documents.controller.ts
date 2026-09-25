import { Controller, Get, Delete, Body, Post, Query, Param, Req, HttpCode, HttpException, HttpStatus } from '@nestjs/common'
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
      throw new HttpException({ code: 500, msg: (e as Error).message }, HttpStatus.INTERNAL_SERVER_ERROR)
    }
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
      throw new HttpException({ code: 500, msg: (e as Error).message }, HttpStatus.INTERNAL_SERVER_ERROR)
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
      throw new HttpException({ code: 500, msg: (e as Error).message }, HttpStatus.INTERNAL_SERVER_ERROR)
    }
  }
}
