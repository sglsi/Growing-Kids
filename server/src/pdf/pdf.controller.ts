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
   *
   * `include_answers`（思傅 2026-10-26）：默认 false = 纯题目卷（不带答案/解析）；
   * true = 本题答案/解析/错误作答一并合成。
   */
  @Post('combine')
  @HttpCode(200)
  async combine(@Req() req: RequestWithUser, @Body() body: { ids: string[]; format?: CombineFormat; include_answers?: boolean }) {
    if (!body || !Array.isArray(body.ids)) throw new BadRequestException('ids 必须是数组')
    const userId = requireUserId(req)
    const format: CombineFormat = body.format === 'docx' ? 'docx' : 'pdf'
    const data = await this.pdfService.combine(userId, body.ids, format, body.include_answers === true)
    return { code: 200, msg: 'success', data }
  }
}
