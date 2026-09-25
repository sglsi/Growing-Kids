import {
  Controller, Get, Post, Delete, Body, Param, Query, Req, HttpCode, BadRequestException,
} from '@nestjs/common'
import { LibraryService } from './library.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'
import type { CreateLibraryDocDto } from './library.types'

interface IdsBody { ids?: string[] }

@Controller('library')
export class LibraryController {
  constructor(private readonly libraryService: LibraryService) {}

  @Get()
  @HttpCode(200)
  async list(
    @Req() req: RequestWithUser,
    @Query('subject_id') subjectId?: string,
    @Query('keyword') keyword?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    const userId = requireUserId(req)
    const data = await this.libraryService.list(userId, {
      subject_id: subjectId, keyword,
      page: page ? Number(page) : 1,
      page_size: pageSize ? Number(pageSize) : 20,
    })
    data.list = await this.libraryService.withUrls(data.list)
    return { code: 200, msg: 'success', data }
  }

  @Post()
  @HttpCode(200)
  async create(@Req() req: RequestWithUser, @Body() dto: CreateLibraryDocDto) {
    const userId = requireUserId(req)
    const doc = await this.libraryService.create(userId, dto)
    const [withUrl] = await this.libraryService.withUrls([doc])
    return { code: 200, msg: 'success', data: withUrl }
  }

  @Post('batch-delete')
  @HttpCode(200)
  async batchDelete(@Req() req: RequestWithUser, @Body() body: IdsBody) {
    const userId = requireUserId(req)
    if (!body || !Array.isArray(body.ids)) throw new BadRequestException('ids 必须是数组')
    const data = await this.libraryService.removeMany(userId, body.ids)
    return { code: 200, msg: 'success', data }
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Req() req: RequestWithUser, @Param('id') id: string) {
    const userId = requireUserId(req)
    const data = await this.libraryService.remove(userId, id)
    return { code: 200, msg: 'success', data }
  }
}
