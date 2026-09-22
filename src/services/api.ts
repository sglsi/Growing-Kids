import Taro from '@tarojs/taro'
import { Network } from '@/network'
import type { ApiEnvelope, Question, QuestionWithSubject, Subject } from '@/types'

export type { Question, QuestionWithSubject, Subject }

// 统一解包：res.data 是 HTTP body，业务数据在 data 字段
async function unwrap<T>(p: Promise<Taro.request.SuccessCallbackResult<any>>): Promise<T> {
  const res = await p
  console.log('[API Response]', res.statusCode, res.data)
  const body = res.data as ApiEnvelope<T>
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(body?.msg || `请求失败(${res.statusCode})`)
  }
  return body.data
}

// 上传文件到对象存储，返回 key 与公网 url
async function uploadFile(filePath: string): Promise<{ key: string; url: string }> {
  const res = await Network.uploadFile({ url: '/api/upload', filePath, name: 'file' })
  console.log('[Upload Response]', res.statusCode, res.data)
  const body = typeof res.data === 'string' ? JSON.parse(res.data) : (res.data as ApiEnvelope<{ key: string; url: string }>)
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(body?.msg || '上传失败')
  return body.data
}

// ---------- 学科 ----------
export function fetchSubjects() {
  return unwrap<Subject[]>(Network.request({ url: '/api/subjects', method: 'GET' }))
}

// ---------- 题目 ----------
export interface QuestionQuery {
  subjectId?: string
  keyword?: string
  startDate?: string
  endDate?: string
  mastered?: boolean
  page?: number
  pageSize?: number
}

export function fetchQuestions(q: QuestionQuery = {}) {
  const data: Record<string, any> = {}
  if (q.subjectId) data.subject_id = q.subjectId
  if (q.keyword) data.keyword = q.keyword
  if (q.startDate) data.start_date = q.startDate
  if (q.endDate) data.end_date = q.endDate
  if (q.mastered !== undefined) data.mastered = q.mastered
  if (q.page !== undefined) data.page = q.page
  if (q.pageSize !== undefined) data.page_size = q.pageSize
  return unwrap<{ list: QuestionWithSubject[]; total: number; page: number; page_size: number }>(
    Network.request({ url: '/api/questions', method: 'GET', data })
  )
}

export function fetchQuestionDetail(id: string) {
  return unwrap<QuestionWithSubject>(Network.request({ url: `/api/questions/${id}`, method: 'GET' }))
}

export interface QuestionPayload {
  subject_id: string
  question_content: string
  question_image_keys?: string[]
  answer_content?: string
  answer_image_keys?: string[]
  solution?: string
  wrong_answer?: string
  source?: string
  status?: 'answered' | 'pending'
  mastered?: boolean
}

export function createQuestion(payload: QuestionPayload) {
  return unwrap<Question>(Network.request({ url: '/api/questions', method: 'POST', data: payload }))
}

export function updateQuestion(id: string, payload: Partial<QuestionPayload>) {
  return unwrap<Question>(Network.request({ url: `/api/questions/${id}`, method: 'PUT', data: payload }))
}

export function deleteQuestion(id: string) {
  return unwrap<{ id: string }>(Network.request({ url: `/api/questions/${id}`, method: 'DELETE' }))
}

// ---------- OCR 识别 ----------
export interface RecognizeResult {
  question_content: string
  wrong_answer: string
  answer_content: string
  solution: string
  source: string
  has_answer: boolean
  question_image_keys?: string[]
}

// 整卷识别：上传图片，返回结构化错题
export async function recognizePaper(filePath: string, subjectId: string) {
  const { key } = await uploadFile(filePath)
  const res = await Network.request({
    url: '/api/ocr/recognize-exam',
    method: 'POST',
    data: { subject_id: subjectId, image_keys: [key] },
  })
  const body = res.data as ApiEnvelope<RecognizeResult[]>
  return body.data
}

export interface SeparateResult {
  matched: RecognizeResult[]
  unmatched_questions: string[]
}

// 题目/答案分传：上传两组图片后自动关联
export async function recognizeSeparate(questionFile: string, answerFile: string) {
  const [q, a] = await Promise.all([uploadFile(questionFile), uploadFile(answerFile)])
  const res = await Network.request({
    url: '/api/ocr/recognize-pair',
    method: 'POST',
    data: { question_image_keys: [q.key], answer_image_keys: [a.key] },
  })
  const body = res.data as ApiEnvelope<SeparateResult>
  return body.data
}

// 文档导入识别：上传 pdf/doc/docx/txt 等，后端提取文本后识别
export async function recognizeDocument(filePath: string, subjectId: string) {
  const { url } = await uploadFile(filePath)
  const res = await Network.request({
    url: '/api/ocr/recognize-doc',
    method: 'POST',
    data: { subject_id: subjectId, file_url: url },
  })
  const body = res.data as ApiEnvelope<{ items: RecognizeResult[] }>
  return (body.data?.items || []) as RecognizeResult[]
}

// ---------- 联网搜题 ----------
export function searchSolution(question: string) {
  return unwrap<{ answer: string; solution: string; references: { title: string; url: string }[] }>(
    Network.request({ url: '/api/search/solve', method: 'POST', data: { question_content: question } })
  )
}

// ---------- 文档导出 ----------
export interface ExportParams {
  subject_id?: string
  start_date?: string
  end_date?: string
  title?: string
  include_mastered?: boolean
}

export function exportDocument(params: ExportParams) {
  return unwrap<{ url: string; file_key: string; title: string }>(
    Network.request({ url: '/api/document/export', method: 'POST', data: params })
  )
}

// ---------- 首页概览统计 ----------
export interface Overview {
  total: number
  week_total: number
  pending: number
  subject_stats: { subject_id: string; name: string; color: string; count: number; week_count: number }[]
  recent: QuestionWithSubject[]
}

export function fetchOverview() {
  return unwrap<Overview>(Network.request({ url: '/api/questions/overview', method: 'GET' }))
}