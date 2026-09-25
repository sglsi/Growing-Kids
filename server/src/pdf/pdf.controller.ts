import { Controller, Post, Body, Req, HttpCode, BadRequestException } from '@nestjs/common'
import { PdfService } from './pdf.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'

@Controller('pdf')
export class PdfController {
  constructor(private readonly pdfService: PdfService) {}

  @Post('combine')
  @HttpCode(200)
  async combine(@Req() req: RequestWithUser, @Body() body: { ids: string[] }) {
    if (!body || !Array.isArray(body.ids)) throw new BadRequestException('ids 必须是数组')
    const userId = requireUserId(req)
    const data = await this.pdfService.combineIntoPdf(userId, body.ids)
    return { code: 200, msg: 'success', data }
  }
}
