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

export interface RecognizePairDto {
  subject_id: string
  question_image_keys: string[]
  answer_image_keys: string[]
}

export interface RecognizeDocDto {
  subject_id: string
  file_type?: string
  // 文档已上传到对象存储后的公网 URL（支持 pdf/doc/docx/txt 等）
  file_url: string
}
