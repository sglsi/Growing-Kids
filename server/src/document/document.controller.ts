import { Controller, Body, Post, Req, HttpCode } from '@nestjs/common'
import { DocumentService } from './document.service'
import { StorageService } from '../storage/storage.service'
import { DocumentsService } from '../documents/documents.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'

interface ExportBody {
  subject_id?: string
  start_date?: string
  end_date?: string
  title?: string
  include_mastered?: boolean
  /** 指定题目 id 白名单（详情页「导出打印」只导本题）；提供时忽略学科/时间/掌握筛选 */
  ids?: string[]
  /** false = 纯题目卷；undefined = 旧行为（含答案） */
  include_answers?: boolean
}

@Controller('document')
export class DocumentController {
  constructor(
    private readonly documentService: DocumentService,
    private readonly storageService: StorageService,
    private readonly documentsService: DocumentsService,
  ) {}

  @Post('export')
  @HttpCode(200)
  async exportDocx(@Req() req: RequestWithUser, @Body() body: ExportBody) {
    const userId = requireUserId(req)
    const title = body.title || '成长学童·题目汇总'
    const buffer = await this.documentService.exportDocx(userId, {
      subject_id: body.subject_id,
      start_date: body.start_date,
      end_date: body.end_date,
      title,
      include_mastered: body.include_mastered,
      ids: Array.isArray(body.ids) ? body.ids : undefined,
      include_answers: body.include_answers,
    })

    const fileName = `${Date.now()}.docx`
    const fileKey = await this.storageService.uploadBuffer(buffer, fileName, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    const url = await this.storageService.getPublicUrl(fileKey)
    console.log('[document/export] 已生成并上传', { userId, title, fileKey, bytes: buffer.length })

    try {
      await this.documentsService.create(userId, {
        title,
        type: 'docx',
        file_key: fileKey,
        mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size_bytes: buffer.length,
      })
    } catch (e) {
      console.error('[document/export] 文档记录入库失败（不影响返回）', e)
    }

    return { code: 200, msg: 'success', data: { url, file_key: fileKey, title } }
  }
}
