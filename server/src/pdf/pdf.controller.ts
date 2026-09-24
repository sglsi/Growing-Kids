import { Controller, Post, Body, HttpCode, BadRequestException } from '@nestjs/common'
import { PdfService } from './pdf.service'

@Controller('pdf')
export class PdfController {
  constructor(private readonly pdfService: PdfService) {}

  @Post('combine')
  @HttpCode(200)
  async combine(@Body() body: { ids: string[] }) {
    if (!body || !Array.isArray(body.ids)) throw new BadRequestException('ids 必须是数组')
    const data = await this.pdfService.combineIntoPdf(body.ids)
    return { code: 200, msg: 'success', data }
  }
}