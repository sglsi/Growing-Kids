import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, HttpCode,
  BadRequestException,
} from '@nestjs/common'
import { MemoryService } from './memory.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'
import type { CreateMemoryDto, UpdateMemoryDto, CreateMemoryMediaDto } from './memory.types'

interface IdsBody { ids?: string[] }

@Controller('memories')
export class MemoryController {
  constructor(private readonly memoryService: MemoryService) {}

  @Get()
  @HttpCode(200)
  async list(
    @Req() req: RequestWithUser,
    @Query('category') category?: string,
    @Query('subject_id') subjectId?: string,
    @Query('tag') tag?: string,
    @Query('keyword') keyword?: string,
    @Query('since') since?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    const userId = requireUserId(req)
    const data = await this.memoryService.list(userId, {
      category,
      subject_id: subjectId,
      tag,
      keyword,
      since,
      page: page ? Number(page) : 1,
      page_size: pageSize ? Number(pageSize) : 20,
    })
    return { code: 200, msg: 'success', data }
  }

  @Get(':id')
  @HttpCode(200)
  async detail(@Req() req: RequestWithUser, @Param('id') id: string) {
    const userId = requireUserId(req)
    const { memory, media } = await this.memoryService.findOne(userId, id)
    const mediaWithUrls = await this.memoryService.withMediaUrls(media)
    return { code: 200, msg: 'success', data: { memory, media: mediaWithUrls } }
  }

  @Post()
  @HttpCode(200)
  async create(@Req() req: RequestWithUser, @Body() dto: CreateMemoryDto) {
    const userId = requireUserId(req)
    const memory = await this.memoryService.create(userId, dto)
    return { code: 200, msg: 'success', data: memory }
  }

  @Patch(':id')
  @HttpCode(200)
  async update(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Body() dto: UpdateMemoryDto,
  ) {
    const userId = requireUserId(req)
    const memory = await this.memoryService.update(userId, id, dto)
    return { code: 200, msg: 'success', data: memory }
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Req() req: RequestWithUser, @Param('id') id: string) {
    const userId = requireUserId(req)
    const data = await this.memoryService.remove(userId, id)
    return { code: 200, msg: 'success', data }
  }

  @Post('batch-delete')
  @HttpCode(200)
  async batchDelete(@Req() req: RequestWithUser, @Body() body: IdsBody) {
    const userId = requireUserId(req)
    if (!body || !Array.isArray(body.ids)) throw new BadRequestException('ids 必须是数组')
    const data = await this.memoryService.removeMany(userId, body.ids)
    return { code: 200, msg: 'success', data }
  }

  @Post(':id/media')
  @HttpCode(200)
  async addMedia(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Body() dto: CreateMemoryMediaDto,
  ) {
    const userId = requireUserId(req)
    const data = await this.memoryService.addMedia(userId, id, dto)
    return { code: 200, msg: 'success', data }
  }

  @Delete(':id/media/:mediaId')
  @HttpCode(200)
  async removeMedia(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Param('mediaId') mediaId: string,
  ) {
    const userId = requireUserId(req)
    const data = await this.memoryService.removeMedia(userId, id, mediaId)
    return { code: 200, msg: 'success', data }
  }
}