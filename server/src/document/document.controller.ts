import { Controller, Post, Body, Res, HttpCode, HttpStatus } from '@nestjs/common'
import type { Response } from 'express'
import { DocumentService } from './document.service'

interface ExportBody {
  subject_id?: string
  start_date?: string
  end_date?: string
  title?: string
}

@Controller('document')
export class DocumentController {
  constructor(private readonly documentService: DocumentService) {}

  @Post('export')
  @HttpCode(200)
  async exportDocx(@Body() body: ExportBody, @Res() res: Response) {
    const title = body.title || '错题本'
    const buffer = await this.documentService.exportDocx({
      subject_id: body.subject_id,
      start_date: body.start_date,
      end_date: body.end_date,
      title,
    })

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(title)}.docx`,
    })
    res.status(HttpStatus.OK).send(buffer)
  }
}
