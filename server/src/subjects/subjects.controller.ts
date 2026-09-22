import { Controller, Get, HttpCode } from '@nestjs/common'
import { SubjectsService } from './subjects.service'

@Controller('subjects')
export class SubjectsController {
  constructor(private readonly subjectsService: SubjectsService) {}

  @Get()
  @HttpCode(200)
  async findAll() {
    const data = await this.subjectsService.findAll()
    return { code: 200, msg: 'success', data }
  }
}
