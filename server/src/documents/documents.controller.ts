import { Controller, Get, Delete, Body, Post, Query, Param, HttpCode, HttpException, HttpStatus } from '@nestjs/common'
import { DocumentsService } from './documents.service'
import type { DocumentQuery } from './documents.types'

interface IdsBody {
  ids?: string[]
}

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get()
  @HttpCode(200)
  async list(@Query() query: DocumentQuery) {
    try {
      const data = await this.documentsService.list(query)
      return { code: 200, msg: 'success', data }
    } catch (e) {
      throw new HttpException({ code: 500, msg: (e as Error).message }, HttpStatus.INTERNAL_SERVER_ERROR)
    }
  }

  @Post('batch-delete')
  @HttpCode(200)
  async batchDelete(@Body() body: IdsBody) {
    const ids = Array.isArray(body?.ids) ? body.ids : []
    if (!ids.length) return { code: 200, msg: 'success', data: { removed: 0 } }
    try {
      const data = await this.documentsService.removeMany(ids)
      return { code: 200, msg: 'success', data }
    } catch (e) {
      throw new HttpException({ code: 500, msg: (e as Error).message }, HttpStatus.INTERNAL_SERVER_ERROR)
    }
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Param('id') id: string) {
    try {
      const data = await this.documentsService.remove(id)
      return { code: 200, msg: 'success', data }
    } catch (e) {
      throw new HttpException({ code: 500, msg: (e as Error).message }, HttpStatus.INTERNAL_SERVER_ERROR)
    }
  }
}