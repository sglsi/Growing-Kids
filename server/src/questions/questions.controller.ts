import {
  Controller, Get, Post, Put, Delete,
  Body, Param, Query, Req, HttpCode,
} from '@nestjs/common'
import { QuestionsService } from './questions.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'
import type { CreateQuestionDto, UpdateQuestionDto } from './questions.types'

@Controller('questions')
export class QuestionsController {
  constructor(private readonly questionsService: QuestionsService) {}

  @Get()
  @HttpCode(200)
  async list(
    @Req() req: RequestWithUser,
    @Query('subject_id') subjectId?: string,
    @Query('keyword') keyword?: string,
    @Query('start_date') startDate?: string,
    @Query('end_date') endDate?: string,
    @Query('mastered') mastered?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    const userId = requireUserId(req)
    const data = await this.questionsService.list(userId, {
      subject_id: subjectId,
      keyword,
      start_date: startDate,
      end_date: endDate,
      mastered: mastered !== undefined && mastered !== '' ? mastered === 'true' : undefined,
      page: page ? Number(page) : undefined,
      page_size: pageSize ? Number(pageSize) : undefined,
    })
    return { code: 200, msg: 'success', data }
  }

  @Get('overview')
  @HttpCode(200)
  async overview(@Req() req: RequestWithUser) {
    const userId = requireUserId(req)
    const data = await this.questionsService.overview(userId)
    return { code: 200, msg: 'success', data }
  }

  @Get(':id')
  @HttpCode(200)
  async findOne(@Req() req: RequestWithUser, @Param('id') id: string) {
    const userId = requireUserId(req)
    const data = await this.questionsService.findOne(userId, id)
    return { code: 200, msg: 'success', data }
  }

  @Post()
  @HttpCode(200)
  async create(@Req() req: RequestWithUser, @Body() dto: CreateQuestionDto) {
    const userId = requireUserId(req)
    const data = await this.questionsService.create(userId, dto)
    return { code: 200, msg: 'success', data }
  }

  @Put(':id')
  @HttpCode(200)
  async update(@Req() req: RequestWithUser, @Param('id') id: string, @Body() dto: UpdateQuestionDto) {
    const userId = requireUserId(req)
    const data = await this.questionsService.update(userId, id, dto)
    return { code: 200, msg: 'success', data }
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Req() req: RequestWithUser, @Param('id') id: string) {
    const userId = requireUserId(req)
    const data = await this.questionsService.remove(userId, id)
    return { code: 200, msg: 'success', data }
  }
}
