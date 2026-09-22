import { Controller, Post, Body, HttpCode, BadRequestException } from '@nestjs/common'
import { SearchService } from './search.service'

@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Post('solve')
  @HttpCode(200)
  async solve(@Body() body: { question_content: string }) {
    if (!body.question_content) throw new BadRequestException('question_content 不能为空')
    const data = await this.searchService.solveQuestion(body.question_content)
    return { code: 200, msg: 'success', data }
  }
}
