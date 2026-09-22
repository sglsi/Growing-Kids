import {
  Controller, Get, Post, Put, Delete,
  Body, Param, Query, HttpCode,
} from '@nestjs/common'
import { QuestionsService } from './questions.service'
import type { CreateQuestionDto, UpdateQuestionDto } from './questions.types'

@Controller('questions')
export class QuestionsController {
  constructor(private readonly questionsService: QuestionsService) {}

  @Get()
  @HttpCode(200)
  async list(
    @Query('subject_id') subjectId?: string,
    @Query('keyword') keyword?: string,
    @Query('start_date') startDate?: string,
    @Query('end_date') endDate?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    const data = await this.questionsService.list({
      subject_id: subjectId,
      keyword,
      start_date: startDate,
      end_date: endDate,
      page: page ? Number(page) : undefined,
      page_size: pageSize ? Number(pageSize) : undefined,
    })
    return { code: 200, msg: 'success', data }
  }

  @Get('overview')
  @HttpCode(200)
  async overview() {
    const data = await this.questionsService.overview()
    return { code: 200, msg: 'success', data }
  }

  @Get(':id')
  @HttpCode(200)
  async findOne(@Param('id') id: string) {
    const data = await this.questionsService.findOne(id)
    return { code: 200, msg: 'success', data }
  }

  @Post()
  @HttpCode(200)
  async create(@Body() dto: CreateQuestionDto) {
    const data = await this.questionsService.create(dto)
    return { code: 200, msg: 'success', data }
  }

  @Put(':id')
  @HttpCode(200)
  async update(@Param('id') id: string, @Body() dto: UpdateQuestionDto) {
    const data = await this.questionsService.update(id, dto)
    return { code: 200, msg: 'success', data }
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Param('id') id: string) {
    const data = await this.questionsService.remove(id)
    return { code: 200, msg: 'success', data }
  }
}
