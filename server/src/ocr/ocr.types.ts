export interface RecognizedItem {
  question_content: string
  wrong_answer: string
  answer_content: string
  solution: string
  source: string
  status: 'answered' | 'pending'
  question_image_keys: string[]
  /** LLM 自动识别出的学科名称（中文，如「数学」），前端据此匹配用户学科 */
  subject?: string
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
