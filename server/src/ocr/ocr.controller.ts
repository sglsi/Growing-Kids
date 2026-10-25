import { Controller, Post, Body, Req, HttpCode, BadRequestException } from '@nestjs/common'
import { OcrService } from './ocr.service'
import { StorageService } from '../storage/storage.service'
import { DocumentsService } from '../documents/documents.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'
import type { RecognizeExamDto, RecognizePairDto, RecognizeDocDto, RecognizeExamUrlDto, ExportDocxItem } from './ocr.types'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

interface ExportDocxDto {
  /**
   * 导出条目：既兼容「识别结果原样回传」（RecognizedItem 形状），
   * 也支持 #150 人工辅助整理的「文本 + 手动裁剪图片 URL」（ExportDocxItem.images）。
   */
  items?: ExportDocxItem[]
  /** 文档标题，默认「识别结果」 */
  title?: string
}

@Controller('ocr')
export class OcrController {
  constructor(
    private readonly ocrService: OcrService,
    private readonly storageService: StorageService,
    private readonly documentsService: DocumentsService,
  ) {}

  @Post('recognize-exam')
  @HttpCode(200)
  async recognizeExam(@Body() dto: RecognizeExamDto) {
    const data = await this.ocrService.recognizeExam(dto.subject_id, dto.image_keys, dto.force)
    return { code: 200, msg: 'success', data }
  }

  @Post('recognize-exam-url')
  @HttpCode(200)
  async recognizeExamByUrl(@Body() dto: RecognizeExamUrlDto) {
    const data = await this.ocrService.recognizeExamByUrls(dto.subject_id, dto.urls, dto.force)
    return { code: 200, msg: 'success', data }
  }

  @Post('recognize-pair')
  @HttpCode(200)
  async recognizePair(@Body() dto: RecognizePairDto) {
    const result = await this.ocrService.recognizePair(dto.question_image_keys, dto.answer_image_keys, dto.force)
    // 答案图 keys 原样回传：前端保存时挂到 answer_images，与 question_images 区分存储
    return { code: 200, msg: 'success', data: { items: result.items, answer_image_keys: dto.answer_image_keys } }
  }

  @Post('recognize-doc')
  @HttpCode(200)
  async recognizeDoc(@Body() dto: RecognizeDocDto) {
    const data = await this.ocrService.recognizeDoc(dto.file_url, dto.force)
    return { code: 200, msg: 'success', data }
  }

  /**
   * 把识别结果直接存储为一个 Word 文档：
   * 生成 docx → 上传存储 → 写入 documents 记录（从而在「文档」页可见、可打开）。
   */
  @Post('export-docx')
  @HttpCode(200)
  async exportDocx(@Req() req: RequestWithUser, @Body() dto: ExportDocxDto) {
    const userId = requireUserId(req)
    const items = Array.isArray(dto.items) ? dto.items : []
    if (!items.length) throw new BadRequestException('没有可导出的识别内容')

    const title = (dto.title || '').trim() || `识别结果 · ${new Date().toLocaleDateString('zh-CN')}`
    const buffer = await this.ocrService.exportDocx(items, title)

    const fileName = `${Date.now()}.docx`
    const fileKey = await this.storageService.uploadBuffer(buffer, fileName, DOCX_MIME)
    const url = await this.storageService.getPublicUrl(fileKey)
    console.log('[ocr/export-docx] 已生成并上传', { userId, title, fileKey, bytes: buffer.length, count: items.length })

    // 写入 documents 记录 → 前端「文档」页即可见、可打开（用户诉求的"能打开的位置"）
    try {
      await this.documentsService.create(userId, {
        title,
        type: 'docx',
        file_key: fileKey,
        mime_type: DOCX_MIME,
        size_bytes: buffer.length,
      })
    } catch (e) {
      console.error('[ocr/export-docx] 文档记录入库失败（不影响返回）', e)
    }

    return { code: 200, msg: 'success', data: { url, file_key: fileKey, title } }
  }
}
