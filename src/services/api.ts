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

// 校验并解包任意识别接口响应（识别接口不允许静默失败）
async function unwrapResponse<T>(p: Promise<Taro.request.SuccessCallbackResult<any>>): Promise<T> {
  const res = await p
  console.log('[API Response]', res.statusCode, res.data)
  const body = res.data as ApiEnvelope<T>
  if (res.statusCode < 200 || res.statusCode >= 300) {
    if (res.statusCode === 413) throw new Error('图片过大（超过限制），请裁剪或压缩后再识别')
    throw new Error(body?.msg || `识别服务异常(${res.statusCode})`)
  }
  if (body?.code !== undefined && body.code !== 200) {
    throw new Error(body.msg || '识别失败，请重试')
  }
  return body.data as T
}

// 把后端识别项（无 has_answer 字段）规范化
function normalizeItem(raw: RecognizeResult): RecognizeResult {
  return {
    question_content: raw.question_content || '',
    wrong_answer: raw.wrong_answer || '',
    answer_content: raw.answer_content || '',
    solution: raw.solution || '',
    source: raw.source || '',
    has_answer: !!raw.answer_content,
    question_image_keys: raw.question_image_keys || [],
  }
}

// 整卷识别：上传图片，返回结构化错题
export async function recognizePaper(filePath: string, subjectId: string) {
  const { key } = await uploadFile(filePath)
  const data = await unwrapResponse<{ items: RecognizeResult[] }>(
    Network.request({
      url: '/api/ocr/recognize-exam',
      method: 'POST',
      data: { subject_id: subjectId, image_keys: [key] },
    }),
  )
  const items = (data?.items || []).map(normalizeItem)
  if (items.length === 0) {
    throw new Error('未识别到题目，请确认图片清晰、内容为题目，或裁剪后重试')
  }
  return items
}

// 题目/答案分传：上传两组图片后自动关联
export async function recognizeSeparate(questionFile: string, answerFile: string) {
  const [q, a] = await Promise.all([uploadFile(questionFile), uploadFile(answerFile)])
  const data = await unwrapResponse<RecognizeResult>(
    Network.request({
      url: '/api/ocr/recognize-pair',
      method: 'POST',
      data: { question_image_keys: [q.key], answer_image_keys: [a.key] },
    }),
  )
  const item = normalizeItem(data)
  if (!item.question_content) {
    throw new Error('未能将题目与答案关联，请确认两张图片内容清晰')
  }
  return { matched: [item], unmatched_questions: [] as string[] }
}

// 文档导入识别：上传 pdf/doc/docx/txt 等，后端提取文本后识别
export async function recognizeDocument(filePath: string, subjectId: string) {
  const { url } = await uploadFile(filePath)
  const data = await unwrapResponse<{ items: RecognizeResult[] }>(
    Network.request({
      url: '/api/ocr/recognize-doc',
      method: 'POST',
      data: { subject_id: subjectId, file_url: url },
    }),
  )
  const items = (data?.items || []).map(normalizeItem)
  if (items.length === 0) {
    throw new Error('未识别到题目，请确认文档内容为文字（扫描件PDF请用拍照识别）')
  }
  return items
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

// ---------- 素材库 ----------
export interface Material {
  id: string
  name: string
  type: 'image' | 'document'
  file_key: string
  url: string
  mime_type: string
  size_bytes: number
  subject_id: string | null
  used: boolean
  created_at: string
}

export function fetchMaterials(type?: 'image' | 'document') {
  return unwrap<{ list: Material[]; total: number }>(
    Network.request({ url: '/api/materials', method: 'GET', data: type ? { type } : {} })
  )
}

// 直接用对象存储 URL 走整卷识别（供素材库复用，免本地文件）
export async function recognizePaperByUrl(url: string, subjectId: string) {
  const data = await unwrapResponse<{ items: RecognizeResult[] }>(
    Network.request({
      url: '/api/ocr/recognize-exam-url',
      method: 'POST',
      data: { subject_id: subjectId, urls: [url] },
    }),
  )
  const items = (data?.items || []).map(normalizeItem)
  if (items.length === 0) {
    throw new Error('未识别到题目，请确认素材内容清晰')
  }
  return items
}

// 直接用对象存储 URL 走文档识别（供素材库复用）
export async function recognizeDocumentByUrl(url: string, subjectId: string) {
  const data = await unwrapResponse<{ items: RecognizeResult[] }>(
    Network.request({
      url: '/api/ocr/recognize-doc',
      method: 'POST',
      data: { subject_id: subjectId, file_url: url },
    }),
  )
  const items = (data?.items || []).map(normalizeItem)
  if (items.length === 0) {
    throw new Error('未识别到题目，请确认文档内容为文字')
  }
  return items
}

// ---------- 图片处理（AI）：自动调正/智能高清/去手写 ----------
export type ImageAction = 'auto' | 'enhance' | 'erase'

// 根据文件内容自动上传到对象存储，返回公网 url（用于 AI 图片处理）
async function ensureImageUrl(filePathOrUrl: string): Promise<string> {
  if (/^https?:\/\//.test(filePathOrUrl)) return filePathOrUrl
  const { url } = await uploadFile(filePathOrUrl)
  return url
}

export async function processImage(action: ImageAction, filePathOrUrl: string) {
  const image_url = await ensureImageUrl(filePathOrUrl)
  const data = await unwrapResponse<{ url: string; key: string; material_id: string }>(
    Network.request({
      url: '/api/image/process',
      method: 'POST',
      data: { action, image_url },
    }),
  )
  return data
}

// ---------- 图片直存 ----------
// 上传本地图片/或已存网络图，返回 { key, url }
export async function uploadImage(filePathOrUrl: string): Promise<{ key: string; url: string }> {
  if (/^https?:\/\//.test(filePathOrUrl)) {
    // 网络图：直接视为依赖素材已入库，返回可用 url（key 空，以 url 为准展示）
    return { key: '', url: filePathOrUrl }
  }
  return uploadFile(filePathOrUrl)
}

// 将一张图片直接保存为错题（不依赖 OCR），question_image_keys 存图片 key 或 url
export function saveQuestionAsImage(subjectId: string, imageKey: string, imageUrl?: string) {
  return createQuestion({
    subject_id: subjectId,
    question_content: '（图片题目）',
    question_image_keys: imageKey ? [imageKey] : (imageUrl ? [imageUrl] : []),
    status: 'pending',
  })
}