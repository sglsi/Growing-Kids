import { Controller, Get, Body, Post, Query, HttpCode } from '@nestjs/common'
import { DocumentService } from './document.service'
import { StorageService } from '../storage/storage.service'

interface ExportBody {
  subject_id?: string
  start_date?: string
  end_date?: string
  title?: string
  include_mastered?: boolean
}

@Controller('document')
export class DocumentController {
  constructor(
    private readonly documentService: DocumentService,
    private readonly storageService: StorageService,
  ) {}

  @Post('export')
  @HttpCode(200)
  async exportDocx(@Body() body: ExportBody) {
    const title = body.title || '成长学童·题目汇总'
    const buffer = await this.documentService.exportDocx({
      subject_id: body.subject_id,
      start_date: body.start_date,
      end_date: body.end_date,
      title,
      include_mastered: body.include_mastered,
    })

    const fileName = `${Date.now()}.docx`
    const fileKey = await this.storageService.uploadBuffer(buffer, fileName, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    const url = await this.storageService.getPublicUrl(fileKey)
    console.log('[document/export] 已生成并上传', { title, fileKey, bytes: buffer.length })

    return { code: 200, msg: 'success', data: { url, file_key: fileKey, title } }
  }
}