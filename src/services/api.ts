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

// ---------- 学科 ----------
export function fetchSubjects() {
  return unwrap<Subject[]>(
    Network.request({ url: '/api/subjects', method: 'GET' })
  )
}

// ---------- 题目 ----------
export interface QuestionQuery {
  subjectId?: string
  keyword?: string
  startDate?: string
  endDate?: string
  page?: number
  pageSize?: number
}

export function fetchQuestions(q: QuestionQuery = {}) {
  const data: Record<string, any> = {}
  if (q.subjectId) data.subject_id = q.subjectId
  if (q.keyword) data.keyword = q.keyword
  if (q.startDate) data.start_date = q.startDate
  if (q.endDate) data.end_date = q.endDate
  if (q.page !== undefined) data.page = q.page
  if (q.pageSize !== undefined) data.page_size = q.pageSize
  return unwrap<{ list: QuestionWithSubject[]; total: number; page: number; page_size: number }>(
    Network.request({ url: '/api/questions', method: 'GET', data })
  )
}

export function fetchQuestionDetail(id: string) {
  return unwrap<QuestionWithSubject>(
    Network.request({ url: `/api/questions/${id}`, method: 'GET' })
  )
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
}

export function createQuestion(payload: QuestionPayload) {
  return unwrap<Question>(
    Network.request({ url: '/api/questions', method: 'POST', data: payload })
  )
}

export function updateQuestion(id: string, payload: Partial<QuestionPayload>) {
  return unwrap<Question>(
    Network.request({ url: `/api/questions/${id}`, method: 'PATCH', data: payload })
  )
}

export function deleteQuestion(id: string) {
  return unwrap<{ id: string }>(
    Network.request({ url: `/api/questions/${id}`, method: 'DELETE' })
  )
}

// ---------- OCR 识别 ----------
// 整卷识别：上传图片，返回结构化错题（题干/原错答/正确答案）
export function recognizePaper(filePath: string, subjectId?: string) {
  return new Promise<RecognizeResult[]>((resolve, reject) => {
    Network.uploadFile({
      url: subjectId ? `/api/recognition/paper?subject_id=${subjectId}` : '/api/recognition/paper',
      filePath,
      name: 'file'
    }).then(res => {
      console.log('[OCR Response]', res.statusCode, res.data)
      const body = JSON.parse(res.data) as ApiEnvelope<RecognizeResult[]>
      if (res.statusCode === 200) resolve(body.data)
      else reject(new Error(body.msg || '识别失败'))
    }).catch(reject)
  })
}

export interface RecognizeResult {
  question_content: string
  wrong_answer: string
  answer_content: string
  solution: string
  source: string
  has_answer: boolean
}

// 题目/答案分传：一次上传两组图片，自动识别并按题号关联
export function recognizeSeparate(questionFile: string, answerFile: string) {
  return new Promise<SeparateResult>((resolve, reject) => {
    // 先上传题目图
    Network.uploadFile({ url: '/api/recognition/upload', filePath: questionFile, name: 'file' })
      .then(r1 => {
        const b1 = JSON.parse(r1.data) as ApiEnvelope<{ key: string }>
        const qKey = b1.data.key
        // 再上传答案图
        Network.uploadFile({ url: '/api/recognition/upload', filePath: answerFile, name: 'file' })
          .then(r2 => {
            const b2 = JSON.parse(r2.data) as ApiEnvelope<{ key: string }>
            const aKey = b2.data.key
            Network.request({
              url: '/api/recognition/associate',
              method: 'POST',
              data: { question_keys: [qKey], answer_keys: [aKey] }
            }).then(r3 => {
              console.log('[Associate Response]', r3.data)
              const body = r3.data as ApiEnvelope<SeparateResult>
              resolve(body.data)
            }).catch(reject)
          }).catch(reject)
      }).catch(reject)
  })
}

export interface SeparateResult {
  matched: RecognizeResult[]
  unmatched_questions: string[]
}

// ---------- 联网搜题 ----------
export function searchSolution(question: string, subjectName?: string) {
  return unwrap<{ answer: string; solution: string; references: { title: string; url: string }[] }>(
    Network.request({
      url: '/api/questions/search-solution',
      method: 'POST',
      data: { question, subject_name: subjectName }
    })
  )
}

// ---------- 文档导出 ----------
export interface ExportParams {
  subject_id?: string
  start_date?: string
  end_date?: string
  report?: boolean
}

export function exportDocument(params: ExportParams) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '' && v !== false)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&')
  return unwrap<{ url: string; file_key: string; count: number }>(
    Network.request({ url: `/api/documents/export?${qs}`, method: 'GET' })
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
  return unwrap<Overview>(
    Network.request({ url: '/api/questions/overview', method: 'GET' })
  )
}
