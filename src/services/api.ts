// ============================================================
// v4 API 层
// 依据：server-v4/src/auth/auth.controller.ts
//
// 关键点（务必遵守微信规范）：
//  - 前端只用 wx.login() 拿 code，绝不直接调 api.weixin.qq.com（该域名不可加入
//    request 合法域名，且 AppSecret 必须仅存服务端）
//  - code 一次性、5 分钟有效，拿到后立刻 POST 给 /api/auth/login
//  - 登录成功后后端返回正式用户 user.id，覆盖本地 X-User-Id（原匿名 id 失效之
//    前已在后端完成数据迁移）
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

/**
 * 给一个 Promise 加超时：超时则 reject（附带友好文案），避免智能处理/网络请求无限转圈。
 */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

// ============================================================
// 文件上传
//   purpose='save'  → 让后端把图片/文档归档进「最近题目 / 资料库」
//   purpose='temp' 或省略 → 仅返回可访问 URL，不落库（用于 AI 处理前的中间上传）
// ============================================================
export interface UploadOpts {
  purpose?: 'save' | 'temp'
}

export async function uploadFile(
  filePath: string,
  opts: UploadOpts = {},
): Promise<{ key: string; url: string; type: 'image' | 'document'; timeline_id?: string; library_id?: string }> {
  const url = opts.purpose === 'save' ? '/api/upload?purpose=save' : '/api/upload'
  const res = await Network.uploadFile({
    url,
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

export function uploadImage(filePathOrUrl: string, opts: UploadOpts = {}): Promise<{ key: string; url: string; timeline_id?: string }> {
  if (/^https?:\/\//.test(filePathOrUrl)) {
    return Promise.resolve({ key: '', url: filePathOrUrl })
  }
  return uploadFile(filePathOrUrl, opts)
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

/**
 * 把 LLM 识别出的学科名（中文，可能不规范，如「初中物理」「数学题」）匹配到用户已有的某个学科，返回 subject_id。
 * 匹配不到返回 null，调用方再回退到默认学科。
 * 匹配优先级：精确(忽略大小写) → 互相包含 → 常见别名归一（处理学段化/口语化表述）。
 */
export function matchSubject(name: string, subjects: Subject[]): string | null {
  if (!name || !subjects?.length) return null
  const lower = name.trim().toLowerCase()
  if (!lower) return null
  // 1. 精确匹配
  let hit = subjects.find((s) => s.name.toLowerCase() === lower)
  if (hit) return hit.id
  // 2. 互相包含
  hit = subjects.find((s) => {
    const sn = s.name.toLowerCase()
    return sn.includes(lower) || lower.includes(sn)
  })
  if (hit) return hit.id
  // 3. 常见别名归一
  const aliases: Record<string, string[]> = {
    语文: ['语文', '中文', '汉语', '文言文', '作文'],
    数学: ['数学', '代数', '几何', '数学校'],
    英语: ['英语', '英文'],
    物理: ['物理'],
    化学: ['化学'],
    生物: ['生物'],
    历史: ['历史'],
    地理: ['地理'],
    政治: ['政治', '道法', '思想品德', '道德与法治', '法治'],
    生活: ['生活', '生活常识', '常识', '其他', '其它', '综合', '通用', '未分类'],
  }
  for (const canon of Object.keys(aliases)) {
    if (aliases[canon].some((k) => lower.includes(k))) {
      hit = subjects.find((s) => s.name === canon)
      if (hit) return hit.id
    }
  }
  return null
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
  /** LLM 自动识别出的学科名称（中文，可能不规范），用于自动归类 */
  subject?: string
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
    subject: raw.subject || '',
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
  // AI 处理前的中间上传：用 purpose=temp，不要落库（避免自动进「最近题目」）
  const { url } = await uploadFile(filePathOrUrl, { purpose: 'temp' })
  return url
}

export interface ProcessImageOpts {
  /** true=处理完成后归档进「最近题目」；默认 false=仅预览 */
  save?: boolean
  /** 整体超时（毫秒），到点直接失败而不无限转圈，默认 90s */
  timeout?: number
}

export async function processImage(action: ImageAction, filePathOrUrl: string, opts: ProcessImageOpts = {}) {
  const image_url = await ensureImageUrl(filePathOrUrl)
  return withTimeout(
    unwrapResponse<{ url: string; key: string; timeline_id: string }>(
      Network.request({
        url: '/api/image/process',
        method: 'POST',
        data: { action, image_url, save: opts.save === true },
        header: authHeaders(),
      }),
    ),
    opts.timeout || 90000,
    '图片处理超时（90s），可能是原图过大或网络较慢。建议先用「编辑裁剪」缩小图片后重试。',
  )
}

// ============================================================
// 图片直存
// ============================================================
/**
 * 把一张图片直接保存为「最近题目」条目（不依赖 OCR）。
 *
 * v4 语义说明：
 *  - 上传时带 purpose=save，后端 /api/upload 才会把图片归档进「最近题目」；
 *    其余上传（如 AI 处理前的中间上传） deliberately 不落库。
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
