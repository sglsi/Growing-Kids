export interface Question {
  id: string
  subject_id: string
  question_content: string
  question_image_keys: string[]
  answer_content: string
  answer_image_keys: string[]
  solution: string
  wrong_answer: string
  source: string
  status: 'answered' | 'pending'
  recognized_at: string
  created_at: string
  updated_at: string
}

export interface QuestionWithSubject extends Question {
  subjects: { id: string; name: string; color: string } | null
}

export interface CreateQuestionDto {
  subject_id: string
  question_content: string
  question_image_keys?: string[]
  answer_content?: string
  answer_image_keys?: string[]
  solution?: string
  wrong_answer?: string
  source?: string
  status?: 'answered' | 'pending'
}

export type UpdateQuestionDto = Partial<CreateQuestionDto>
