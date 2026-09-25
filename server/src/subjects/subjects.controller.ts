import { Controller, Get, Post, Put, Delete, Body, Param, Req, HttpCode } from '@nestjs/common'
import { SubjectsService } from './subjects.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'
import type { Subject } from './subjects.types'

@Controller('subjects')
export class SubjectsController {
  constructor(private readonly subjectsService: SubjectsService) {}

  @Get()
  @HttpCode(200)
  async findAll(@Req() req: RequestWithUser) {
    const userId = requireUserId(req)
    const data = await this.subjectsService.findAll(userId)
    return { code: 200, msg: 'success', data }
  }

  @Post()
  @HttpCode(200)
  async create(@Req() req: RequestWithUser, @Body() body: { name: string; color?: string; sort_order?: number }) {
    const userId = requireUserId(req)
    const data = await this.subjectsService.create(userId, body.name, body.color, body.sort_order)
    return { code: 200, msg: 'success', data }
  }

  @Put(':id')
  @HttpCode(200)
  async update(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Body() body: Partial<Pick<Subject, 'name' | 'color' | 'sort_order'>>,
  ) {
    const userId = requireUserId(req)
    const data = await this.subjectsService.update(userId, id, body)
    return { code: 200, msg: 'success', data }
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Req() req: RequestWithUser, @Param('id') id: string) {
    const userId = requireUserId(req)
    const data = await this.subjectsService.remove(userId, id)
    return { code: 200, msg: 'success', data }
  }
}
