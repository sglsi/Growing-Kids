import {
  Controller, Get, Post, Delete, Body, Param, Query, Req, HttpCode, BadRequestException,
} from '@nestjs/common'
import { MaterialsService } from './materials.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'
import type { MaterialQuery, MaterialType } from './materials.types'

@Controller('materials')
export class MaterialsController {
  constructor(private readonly materialsService: MaterialsService) {}

  @Get()
  async list(
    @Req() req: RequestWithUser,
    @Query('type') type?: MaterialType,
    @Query('subject_id') subjectId?: string,
    @Query('keyword') keyword?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    const userId = requireUserId(req)
    const query: MaterialQuery = {
      type, subject_id: subjectId, keyword,
      page: page ? Number(page) : 1,
      page_size: pageSize ? Number(pageSize) : 20,
    }
    const data = await this.materialsService.list(userId, query)
    return { code: 200, msg: 'success', data }
  }

  @Post(':id/used')
  @HttpCode(200)
  async markUsed(@Req() req: RequestWithUser, @Param('id') id: string) {
    const userId = requireUserId(req)
    await this.materialsService.markUsed(userId, id)
    return { code: 200, msg: 'success', data: { id } }
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Req() req: RequestWithUser, @Param('id') id: string) {
    const userId = requireUserId(req)
    const data = await this.materialsService.remove(userId, id)
    return { code: 200, msg: 'success', data }
  }

  @Post('batch-delete')
  @HttpCode(200)
  async removeMany(@Req() req: RequestWithUser, @Body() body: { ids: string[] }) {
    const userId = requireUserId(req)
    if (!body || !Array.isArray(body.ids)) throw new BadRequestException('ids 必须是数组')
    const data = await this.materialsService.removeMany(userId, body.ids)
    return { code: 200, msg: 'success', data }
  }
}
