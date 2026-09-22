import { Controller, Post, Body, HttpCode } from '@nestjs/common'
import { OcrService } from './ocr.service'
import type { RecognizeExamDto, RecognizePairDto, RecognizeDocDto } from './ocr.types'

@Controller('ocr')
export class OcrController {
  constructor(private readonly ocrService: OcrService) {}

  @Post('recognize-exam')
  @HttpCode(200)
  async recognizeExam(@Body() dto: RecognizeExamDto) {
    const data = await this.ocrService.recognizeExam(dto.subject_id, dto.image_keys)
    return { code: 200, msg: 'success', data }
  }

  @Post('recognize-pair')
  @HttpCode(200)
  async recognizePair(@Body() dto: RecognizePairDto) {
    const data = await this.ocrService.recognizePair(dto.question_image_keys, dto.answer_image_keys)
    return { code: 200, msg: 'success', data }
  }

  @Post('recognize-doc')
  @HttpCode(200)
  async recognizeDoc(@Body() dto: RecognizeDocDto) {
    const data = await this.ocrService.recognizeDoc(dto.file_url)
    return { code: 200, msg: 'success', data }
  }
}
