import {
  Controller, Get, Post, Put, Delete, Body, Param, Query, Req, HttpCode, BadRequestException,
} from '@nestjs/common'
import { TimelineService } from './timeline.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'
import type {
  CreateTimelineDto, UpdateTimelineDto, TimelineScope,
} from './timeline.types'

interface IdsBody { ids?: string[] }

@Controller('timeline')
export class TimelineController {
  constructor(private readonly timelineService: TimelineService) {}

  @Get()
  @HttpCode(200)
  async list(
    @Req() req: RequestWithUser,
    @Query('scope') scope?: TimelineScope,
    @Query('subject_id') subjectId?: string,
    @Query('tag') tag?: string,
    @Query('keyword') keyword?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    const userId = requireUserId(req)
    const data = await this.timelineService.list(userId, {
      scope, subject_id: subjectId, tag, keyword,
      page: page ? Number(page) : 1,
      page_size: pageSize ? Number(pageSize) : 20,
    })
    data.list = await this.timelineService.withUrls(data.list)
    return { code: 200, msg: 'success', data }
  }

  @Get('overview')
  @HttpCode(200)
  async overview(@Req() req: RequestWithUser) {
    const userId = requireUserId(req)
    const data = await this.timelineService.overview(userId)
    data.recent = await this.timelineService.withUrls(data.recent)
    return { code: 200, msg: 'success', data }
  }

  @Post()
  @HttpCode(200)
  async create(@Req() req: RequestWithUser, @Body() dto: CreateTimelineDto) {
    const userId = requireUserId(req)
    const item = await this.timelineService.create(userId, dto)
    const [withUrl] = await this.timelineService.withUrls([item])
    return { code: 200, msg: 'success', data: withUrl }
  }

  @Post('review-book')
  @HttpCode(200)
  async addToReview(@Req() req: RequestWithUser, @Body() body: IdsBody) {
    const userId = requireUserId(req)
    const ids = this.parseIds(body)
    const data = await this.timelineService.addToReviewBook(userId, ids)
    return { code: 200, msg: 'success', data }
  }

  @Delete('review-book')
  @HttpCode(200)
  async removeFromReview(@Req() req: RequestWithUser, @Body() body: IdsBody) {
    const userId = requireUserId(req)
    const ids = this.parseIds(body)
    const data = await this.timelineService.removeFromReviewBook(userId, ids)
    return { code: 200, msg: 'success', data }
  }

  @Post('batch-delete')
  @HttpCode(200)
  async batchDelete(@Req() req: RequestWithUser, @Body() body: IdsBody) {
    const userId = requireUserId(req)
    const ids = this.parseIds(body)
    const data = await this.timelineService.removeMany(userId, ids)
    return { code: 200, msg: 'success', data }
  }

  @Get(':id')
  @HttpCode(200)
  async findOne(@Req() req: RequestWithUser, @Param('id') id: string) {
    const userId = requireUserId(req)
    const data = await this.timelineService.findOne(userId, id)
    return { code: 200, msg: 'success', data }
  }

  @Put(':id')
  @HttpCode(200)
  async update(@Req() req: RequestWithUser, @Param('id') id: string, @Body() dto: UpdateTimelineDto) {
    const userId = requireUserId(req)
    const data = await this.timelineService.update(userId, id, dto)
    return { code: 200, msg: 'success', data }
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Req() req: RequestWithUser, @Param('id') id: string) {
    const userId = requireUserId(req)
    const data = await this.timelineService.remove(userId, id)
    return { code: 200, msg: 'success', data }
  }

  private parseIds(body: IdsBody): string[] {
    if (!body || !Array.isArray(body.ids)) throw new BadRequestException('ids 必须是数组')
    return body.ids
  }
}
