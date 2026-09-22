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
