export interface RecognizedItem {
  question_content: string
  wrong_answer: string
  answer_content: string
  solution: string
  source: string
  status: 'answered' | 'pending'
  question_image_keys: string[]
}

export interface RecognizeExamDto {
  subject_id: string
  image_keys: string[]
}

export interface RecognizeExamUrlDto {
  subject_id: string
  urls: string[]
}

export interface RecognizePairDto {
  question_image_keys: string[]
  answer_image_keys: string[]
}

export interface RecognizeDocDto {
  file_url: string
}

// ---------- 本地 OCR 侧车（PaddleOCR + RapidOCR 融合）响应契约 ----------
// 与 ocr-engine/main.py 的 /recognize 输出对齐
export type OcrBox = [number, number, number, number]

export interface LocalOcrTextRegion {
  text: string
  box: OcrBox
  score: number
}

export interface LocalOcrLayoutBlock {
  type: string
  box: OcrBox
  text: string
}

export interface LocalOcrResult {
  raw_text: string
  text_regions: LocalOcrTextRegion[]
  layout: LocalOcrLayoutBlock[]
  tables: unknown[]
  formulas: unknown[]
  confidence: number
  engine_used: string[]
  low_confidence: boolean
}
