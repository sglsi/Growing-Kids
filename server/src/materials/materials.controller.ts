import {
  Controller, Get, Post, Delete, Body, Param, Query, HttpCode,
} from '@nestjs/common'
import { MaterialsService } from './materials.service'
import type { MaterialQuery, MaterialType } from './materials.types'

@Controller('materials')
export class MaterialsController {
  constructor(private readonly materialsService: MaterialsService) {}

  @Get()
  async list(
    @Query('type') type?: MaterialType,
    @Query('subject_id') subjectId?: string,
    @Query('keyword') keyword?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    const query: MaterialQuery = {
      type, subject_id: subjectId, keyword,
      page: page ? Number(page) : 1,
      page_size: pageSize ? Number(pageSize) : 20,
    }
    const data = await this.materialsService.list(query)
    return { code: 200, msg: 'success', data }
  }

  @Post(':id/used')
  @HttpCode(200)
  async markUsed(@Param('id') id: string) {
    await this.materialsService.markUsed(id)
    return { code: 200, msg: 'success', data: { id } }
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Param('id') id: string) {
    const data = await this.materialsService.remove(id)
    return { code: 200, msg: 'success', data }
  }
}
