import { Controller, Post, Body, Req, HttpCode, BadRequestException } from '@nestjs/common'
import { PdfService, type CombineFormat } from './pdf.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'

@Controller('pdf')
export class PdfController {
  constructor(private readonly pdfService: PdfService) {}

  /**
   * 把选中的图片素材合成为一份文件并归档到文档页。
   *
   * `format`：
   *  - `pdf`（默认）：多图智能拼页，省纸少留白，适合直接打印；
   *  - `docx`：图片顺排进 Word，适合家长二次编辑、加批注后再打印。
   */
  @Post('combine')
  @HttpCode(200)
  async combine(@Req() req: RequestWithUser, @Body() body: { ids: string[]; format?: CombineFormat }) {
    if (!body || !Array.isArray(body.ids)) throw new BadRequestException('ids 必须是数组')
    const userId = requireUserId(req)
    const format: CombineFormat = body.format === 'docx' ? 'docx' : 'pdf'
    const data = await this.pdfService.combine(userId, body.ids, format)
    return { code: 200, msg: 'success', data }
  }
}
