// 学科
export interface Subject {
  id: string
  name: string
  color: string
  sort_order: number
}

// 题目
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
  mastered: boolean
  mastered_at: string | null
  recognized_at: string
  created_at: string
  updated_at: string
}

// 带学科信息的题目（后端 join 返回）
export interface QuestionWithSubject extends Question {
  subjects: Pick<Subject, 'id' | 'name' | 'color'> | null
}

// 通用信封响应
export interface ApiEnvelope<T> {
  code: number
  msg: string
  data: T
}

// 学科颜色 → 完整 Tailwind 类名（必须为完整字符串，JIT 才能识别）
export const SUBJECT_COLOR_MAP: Record<string, { badge: string; bar: string; dot: string }> = {
  'rose-600': { badge: 'bg-rose-50 text-rose-700 border-rose-200', bar: 'bg-rose-600', dot: 'bg-rose-600' },
  'blue-600': { badge: 'bg-blue-50 text-blue-700 border-blue-200', bar: 'bg-blue-600', dot: 'bg-blue-600' },
  'emerald-700': { badge: 'bg-emerald-50 text-emerald-700 border-emerald-200', bar: 'bg-emerald-700', dot: 'bg-emerald-700' },
  'cyan-600': { badge: 'bg-cyan-50 text-cyan-700 border-cyan-200', bar: 'bg-cyan-600', dot: 'bg-cyan-600' },
  'violet-600': { badge: 'bg-violet-50 text-violet-700 border-violet-200', bar: 'bg-violet-600', dot: 'bg-violet-600' },
  'green-600': { badge: 'bg-green-50 text-green-700 border-green-200', bar: 'bg-green-600', dot: 'bg-green-600' },
  'red-700': { badge: 'bg-red-50 text-red-700 border-red-200', bar: 'bg-red-700', dot: 'bg-red-700' },
  'amber-600': { badge: 'bg-amber-50 text-amber-700 border-amber-200', bar: 'bg-amber-600', dot: 'bg-amber-600' },
  'orange-700': { badge: 'bg-orange-50 text-orange-700 border-orange-200', bar: 'bg-orange-700', dot: 'bg-orange-700' },
  'gray-500': { badge: 'bg-gray-50 text-gray-600 border-gray-200', bar: 'bg-gray-500', dot: 'bg-gray-500' },
}

export function getSubjectColor(color: string) {
  return SUBJECT_COLOR_MAP[color] || SUBJECT_COLOR_MAP['gray-500']
}
