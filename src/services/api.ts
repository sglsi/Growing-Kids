// ============================================================
// v4 API 层
// 依据：server-v4/MIGRATION.md §2 接口映射表
// 变化要点：
//  1. 全部接口按用户隔离：首次请求后端会建匿名用户并回传 X-User-Id，
//     本层自动捕获并持久化（Taro storage），后续请求带上续用同一身份。
//  2. questions / materials 双接口 → timeline / library
//  3. 新增复习本：scope=review、/timeline/review-book
// ============================================================

import Taro from '@tarojs/taro'
import { Network } from '@/network'
import { buildHeaders, captureUserId } from '@/services/net'
import type {
  ApiEnvelope, Paged, TimelineItem, Subject, LibraryDoc, DocItem, Overview,
} from '@/types'

export type { TimelineItem, Subject, LibraryDoc, DocItem, Overview, Paged }
export { getUserId } from '@/services/net'

/** 构造带身份头的请求头（首次为匿名，后端回传 X-User-Id 后续用） */
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return buildHeaders(extra)
}

type ReqResult = Taro.request.SuccessCallbackResult<any>

// 统一解包：res.data 是 HTTP body，业务数据在 data 字段
async function unwrap<T>(p: Promise<ReqResult>): Promise<T> {
  const res = await p
  captureUserId(res)
  console.log('[API Response]', res.statusCode, res.data)
  const body = res.data as ApiEnvelope<T>
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(body?.msg || `请求失败(${res.statusCode})`)
  }
  if (body?.code !== undefined && body.code !== 200) {
    throw new Error(body.msg || '请求失败')
  }
  return body.data
}

// 上传文件到对象存储，返回 key 与公网 url（后端会一并归档到 timeline / library）
export async function uploadFile(
  filePath: string,
): Promise<{ key: string; url: string; type: 'image' | 'document'; timeline_id?: string; library_id?: string }> {
  const res = await Network.uploadFile({
    url: '/api/upload',
    filePath,
    name: 'file',
    header: authHeaders(),
  })
  captureUserId(res)
  console.log('[Upload Response]', res.statusCode, res.data)
  const body = typeof res.data === 'string'
    ? JSON.parse(res.data)
    : (res.data as ApiEnvelope<{ key: string; url: string; type: 'image' | 'document'; timeline_id?: string; library_id?: string }>)
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(body?.msg || '上传失败')
  return body.data
}

// 校验并解包识别类接口响应（不允许静默失败）
async function unwrapResponse<T>(p: Promise<ReqResult>): Promise<T> {
  const res = await p
  captureUserId(res)
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

// ============================================================
// 学科
// ============================================================
export function fetchSubjects() {
  return unwrap<Subject[]>(Network.request({ url: '/api/subjects', method: 'GET', header: authHeaders() }))
}

export function createSubject(payload: { name: string; color?: string; sort_order?: number }) {
  return unwrap<Subject>(Network.request({ url: '/api/subjects', method: 'POST', data: payload, header: authHeaders() }))
}

export function updateSubject(id: string, payload: { name?: string; color?: string; sort_order?: number }) {
  return unwrap<Subject>(Network.request({ url: `/api/subjects/${id}`, method: 'PUT', data: payload, header: authHeaders() }))
}

export function deleteSubject(id: string) {
  return unwrap<{ id: string }>(Network.request({ url: `/api/subjects/${id}`, method: 'DELETE', header: authHeaders() }))
}

// ============================================================
// 统一收件箱 timeline（最近题目 / 复习本）
// ============================================================
export interface TimelineQuery {
  /** recent=最近全部（图+题）；review=复习本 */
  scope?: 'recent' | 'review'
  subjectId?: string
  tag?: string
  keyword?: string
  page?: number
  pageSize?: number
}

export function fetchTimeline(q: TimelineQuery = {}) {
  const data: Record<string, unknown> = {}
  data.scope = q.scope || 'recent'
  if (q.subjectId) data.subject_id = q.subjectId
  if (q.tag) data.tag = q.tag
  if (q.keyword) data.keyword = q.keyword
  if (q.page !== undefined) data.page = q.page
  if (q.pageSize !== undefined) data.page_size = q.pageSize
  return unwrap<Paged<TimelineItem>>(
    Network.request({ url: '/api/timeline', method: 'GET', data, header: authHeaders() }),
  )
}

/** 兼容旧签名：fetchQuestions → 最近题目 */
export function fetchQuestions(q: {
  subjectId?: string
  keyword?: string
  page?: number
  pageSize?: number
} = {}) {
  return fetchTimeline({ scope: 'recent', ...q })
}

export function fetchTimelineDetail(id: string) {
  return unwrap<TimelineItem>(
    Network.request({ url: `/api/timeline/${id}`, method: 'GET', header: authHeaders() }),
  )
}

export interface TimelineContentPayload {
  question?: string
  answer?: string
  solution?: string
  wrong_answer?: string
  images?: string[]
  status?: 'answered' | 'pending'
}

export interface CreateTimelinePayload {
  kind: 'image' | 'question'
  subject_id?: string | null
  title?: string
  source?: string
  tags?: string[]
  // question
  content?: TimelineContentPayload
  // image
  file_key?: string
  thumb_key?: string
  mime_type?: string
  size_bytes?: number
  file_hash?: string
}

export function createTimeline(payload: CreateTimelinePayload) {
  return unwrap<TimelineItem>(
    Network.request({ url: '/api/timeline', method: 'POST', data: payload, header: authHeaders() }),
  )
}

/** 兼容旧签名：createQuestion → 创建 kind=question 条目 */
export function createQuestion(payload: {
  subject_id?: string | null
  question_content: string
  question_image_keys?: string[]
  answer_content?: string
  answer_image_keys?: string[]
  solution?: string
  wrong_answer?: string
  source?: string
  status?: 'answered' | 'pending'
  mastered?: boolean
}) {
  const images = [...(payload.question_image_keys || []), ...(payload.answer_image_keys || [])]
  return createTimeline({
    kind: 'question',
    subject_id: payload.subject_id ?? null,
    source: payload.source,
    content: {
      question: payload.question_content,
      answer: payload.answer_content || '',
      solution: payload.solution || '',
      wrong_answer: payload.wrong_answer || '',
      images,
      status: payload.status || (payload.answer_content ? 'answered' : 'pending'),
    },
  })
}

export function updateTimeline(
  id: string,
  payload: {
    title?: string
    subject_id?: string | null
    tags?: string[]
    mastered?: boolean
    content?: TimelineContentPayload
  },
) {
  return unwrap<TimelineItem>(
    Network.request({ url: `/api/timeline/${id}`, method: 'PUT', data: payload, header: authHeaders() }),
  )
}

/** 兼容旧签名：updateQuestion → 更新题目内容 */
export function updateQuestion(
  id: string,
  payload: {
    subject_id?: string
    question_content?: string
    answer_content?: string
    solution?: string
    wrong_answer?: string
    status?: 'answered' | 'pending'
    mastered?: boolean
    tags?: string[]
  },
) {
  const patch: Parameters<typeof updateTimeline>[1] = {}
  if (payload.subject_id !== undefined) patch.subject_id = payload.subject_id
  if (payload.mastered !== undefined) patch.mastered = payload.mastered
  if (payload.tags !== undefined) patch.tags = payload.tags
  if (
    payload.question_content !== undefined ||
    payload.answer_content !== undefined ||
    payload.solution !== undefined ||
    payload.wrong_answer !== undefined ||
    payload.status !== undefined
  ) {
    patch.content = {
      question: payload.question_content,
      answer: payload.answer_content,
      solution: payload.solution,
      wrong_answer: payload.wrong_answer,
      status: payload.status,
    }
  }
  return updateTimeline(id, patch)
}

export function deleteTimeline(id: string) {
  return unwrap<{ id: string }>(
    Network.request({ url: `/api/timeline/${id}`, method: 'DELETE', header: authHeaders() }),
  )
}

/** 兼容旧签名 */
export const deleteQuestion = deleteTimeline

/** 批量软删 */
export function batchDeleteTimeline(ids: string[]) {
  return unwrap<{ removed: number }>(
    Network.request({ url: '/api/timeline/batch-delete', method: 'POST', data: { ids }, header: authHeaders() }),
  )
}

/** 加入复习本 */
export function addToReviewBook(ids: string[]) {
  return unwrap<{ updated: number }>(
    Network.request({ url: '/api/timeline/review-book', method: 'POST', data: { ids }, header: authHeaders() }),
  )
}

/** 移出复习本 */
export function removeFromReviewBook(ids: string[]) {
  return unwrap<{ updated: number }>(
    Network.request({ url: '/api/timeline/review-book', method: 'DELETE', data: { ids }, header: authHeaders() }),
  )
}

// ============================================================
// 资料库 library（外部文档）
// ============================================================
export interface LibraryQuery {
  subjectId?: string
  keyword?: string
  page?: number
  pageSize?: number
}

export function fetchLibrary(q: LibraryQuery = {}) {
  const data: Record<string, unknown> = {}
  if (q.subjectId) data.subject_id = q.subjectId
  if (q.keyword) data.keyword = q.keyword
  data.page = q.page ?? 1
  data.page_size = q.pageSize ?? 20
  return unwrap<Paged<LibraryDoc>>(
    Network.request({ url: '/api/library', method: 'GET', data, header: authHeaders() }),
  )
}

/** 兼容旧签名：fetchMaterials(type=document) → 资料库 */
export function fetchMaterials(opts: { type?: 'image' | 'document'; subjectId?: string; page?: number; pageSize?: number } = {}) {
  if (opts.type === 'document') {
    return fetchLibrary({ subjectId: opts.subjectId, page: opts.page, pageSize: opts.pageSize })
  }
  // type=image / 未指定 → 走统一收件箱（图片已并入 timeline）
  return fetchTimeline({ scope: 'recent', subjectId: opts.subjectId, page: opts.page, pageSize: opts.pageSize })
}

export function createLibraryDoc(payload: {
  name: string
  file_key: string
  subject_id?: string | null
  mime_type?: string
  size_bytes?: number
  source?: string
  tags?: string[]
}) {
  return unwrap<LibraryDoc>(
    Network.request({ url: '/api/library', method: 'POST', data: payload, header: authHeaders() }),
  )
}

export function deleteLibraryDoc(id: string) {
  return unwrap<{ id: string }>(
    Network.request({ url: `/api/library/${id}`, method: 'DELETE', header: authHeaders() }),
  )
}

export function batchDeleteLibrary(ids: string[]) {
  return unwrap<{ removed: number }>(
    Network.request({ url: '/api/library/batch-delete', method: 'POST', data: { ids }, header: authHeaders() }),
  )
}

// ============================================================
// 首页概览
// ============================================================
export function fetchOverview() {
  return unwrap<Overview>(
    Network.request({ url: '/api/timeline/overview', method: 'GET', header: authHeaders() }),
  )
}

// ============================================================
// OCR 识别
// ============================================================
export interface RecognizeResult {
  question_content: string
  wrong_answer: string
  answer_content: string
  solution: string
  source: string
  has_answer: boolean
  question_image_keys?: string[]
}

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

// 整卷识别：上传图片，返回结构化题目
export async function recognizePaper(filePath: string, subjectId: string) {
  const { key } = await uploadFile(filePath)
  const data = await unwrapResponse<{ items: RecognizeResult[] }>(
    Network.request({
      url: '/api/ocr/recognize-exam',
      method: 'POST',
      data: { subject_id: subjectId, image_keys: [key] },
      header: authHeaders(),
    }),
  )
  const items = (data?.items || []).map(normalizeItem)
  if (items.length === 0) {
    throw new Error('未识别到题目，请确认图片清晰、内容为题目，或裁剪后重试')
  }
  return items
}

// 题目/答案分传
export async function recognizeSeparate(questionFile: string, answerFile: string) {
  const [q, a] = await Promise.all([uploadFile(questionFile), uploadFile(answerFile)])
  const data = await unwrapResponse<RecognizeResult>(
    Network.request({
      url: '/api/ocr/recognize-pair',
      method: 'POST',
      data: { question_image_keys: [q.key], answer_image_keys: [a.key] },
      header: authHeaders(),
    }),
  )
  const item = normalizeItem(data)
  if (!item.question_content) {
    throw new Error('未能将题目与答案关联，请确认两张图片内容清晰')
  }
  return { matched: [item], unmatched_questions: [] as string[] }
}

// 文档导入识别
export async function recognizeDocument(filePath: string, subjectId: string) {
  const { url } = await uploadFile(filePath)
  const data = await unwrapResponse<{ items: RecognizeResult[] }>(
    Network.request({
      url: '/api/ocr/recognize-doc',
      method: 'POST',
      data: { subject_id: subjectId, file_url: url },
      header: authHeaders(),
    }),
  )
  const items = (data?.items || []).map(normalizeItem)
  if (items.length === 0) {
    throw new Error('未识别到题目，请确认文档内容为文字（扫描件PDF请用拍照识别）')
  }
  return items
}

// 直接用对象存储 URL 走整卷识别（供资料图片复用）
export async function recognizePaperByUrl(url: string, subjectId: string) {
  const data = await unwrapResponse<{ items: RecognizeResult[] }>(
    Network.request({
      url: '/api/ocr/recognize-exam-url',
      method: 'POST',
      data: { subject_id: subjectId, urls: [url] },
      header: authHeaders(),
    }),
  )
  const items = (data?.items || []).map(normalizeItem)
  if (items.length === 0) throw new Error('未识别到题目，请确认素材内容清晰')
  return items
}

// 直接用对象存储 URL 走文档识别
export async function recognizeDocumentByUrl(url: string, subjectId: string) {
  const data = await unwrapResponse<{ items: RecognizeResult[] }>(
    Network.request({
      url: '/api/ocr/recognize-doc',
      method: 'POST',
      data: { subject_id: subjectId, file_url: url },
      header: authHeaders(),
    }),
  )
  const items = (data?.items || []).map(normalizeItem)
  if (items.length === 0) throw new Error('未识别到题目，请确认文档内容为文字')
  return items
}

// ============================================================
// 联网搜题
// ============================================================
export function searchSolution(question: string) {
  return unwrap<{ answer: string; solution: string; references: { title: string; url: string }[] }>(
    Network.request({
      url: '/api/search/solve',
      method: 'POST',
      data: { question_content: question },
      header: authHeaders(),
    }),
  )
}

// ============================================================
// 文档导出 / 汇总
// ============================================================
export interface ExportParams {
  subject_id?: string
  start_date?: string
  end_date?: string
  title?: string
  include_mastered?: boolean
}

export function exportDocument(params: ExportParams) {
  return unwrap<{ url: string; file_key: string; title: string }>(
    Network.request({ url: '/api/document/export', method: 'POST', data: params, header: authHeaders() }),
  )
}

export function fetchDocuments(opts: { type?: string; keyword?: string; page?: number; pageSize?: number } = {}) {
  const { type, keyword, page = 1, pageSize = 30 } = opts
  const data: Record<string, unknown> = {}
  if (type) data.type = type
  if (keyword) data.keyword = keyword
  data.page = page
  data.page_size = pageSize
  return unwrap<{ total: number; list: DocItem[] }>(
    Network.request({ url: '/api/documents', method: 'GET', data, header: authHeaders() }),
  )
}

export function batchDeleteDocuments(ids: string[]) {
  return unwrap<{ removed: number }>(
    Network.request({ url: '/api/documents/batch-delete', method: 'POST', data: { ids }, header: authHeaders() }),
  )
}

export function deleteDocument(id: string) {
  return unwrap<{ id: string }>(
    Network.request({ url: `/api/documents/${id}`, method: 'DELETE', header: authHeaders() }),
  )
}

// ============================================================
// 图片合成 PDF（素材 id 现指 timeline item id）
// ============================================================
export function combineToPdf(ids: string[]) {
  return unwrap<{ url: string; key: string; doc_id: string; pages: number }>(
    Network.request({ url: '/api/pdf/combine', method: 'POST', data: { ids }, header: authHeaders() }),
  )
}

// ============================================================
// 图片处理（AI）：自动调正 / 智能高清 / 去手写
// ============================================================
export type ImageAction = 'auto' | 'enhance' | 'erase'

async function ensureImageUrl(filePathOrUrl: string): Promise<string> {
  if (/^https?:\/\//.test(filePathOrUrl)) return filePathOrUrl
  const { url } = await uploadFile(filePathOrUrl)
  return url
}

export async function processImage(action: ImageAction, filePathOrUrl: string) {
  const image_url = await ensureImageUrl(filePathOrUrl)
  return unwrapResponse<{ url: string; key: string; timeline_id: string }>(
    Network.request({
      url: '/api/image/process',
      method: 'POST',
      data: { action, image_url },
      header: authHeaders(),
    }),
  )
}

// ============================================================
// 图片直存
// ============================================================
export async function uploadImage(filePathOrUrl: string): Promise<{ key: string; url: string; timeline_id?: string }> {
  if (/^https?:\/\//.test(filePathOrUrl)) {
    return { key: '', url: filePathOrUrl }
  }
  return uploadFile(filePathOrUrl)
}

/**
 * 把一张图片直接保存为「最近题目」条目（不依赖 OCR）。
 *
 * v4 语义说明：
 *  - 后端 /api/upload 检测到图片时，**已自动**建好 kind=image 的 timeline 条目，
 *    并在响应里返回 timeline_id —— 因此这里只需用 uploadImage 拿到的 key 直接建档，
 *    不再靠「翻页找 file_key」那种脆弱匹配。
 *  - 若调用方已持有 timeline_id（推荐路径），直接透传即可，避免重复建档。
 */
export async function saveQuestionAsImage(
  subjectId: string,
  imageKey: string,
  imageUrl?: string,
  timelineId?: string,
) {
  // 1) 上传已建档：只补学科归属，不重复插入
  if (timelineId) {
    if (subjectId) return updateTimeline(timelineId, { subject_id: subjectId })
    const it = await fetchTimelineDetail(timelineId)
    return it
  }
  // 2) 兜底：按 key/url 建一个 image 条目（例如网络图无 key 时）
  return createTimeline({
    kind: 'image',
    subject_id: subjectId || null,
    title: '图片资料',
    file_key: imageKey || imageUrl || '',
    source: 'camera',
  })
}
