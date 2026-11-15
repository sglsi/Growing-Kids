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
import { isRemoteImageUrl } from '@/utils/url'
import { buildHeaders, captureUserId } from '@/services/net'
import { invalidateDomain } from '@/services/cache'
import { runJob } from '@/services/jobs'
import type {
  ApiEnvelope, Paged, TimelineItem, Subject, LibraryDoc, DocItem, Overview, GradeScope,
  SimilarItem, ReviewPlan, ReviewSummary, AnswerAttachment, AnswerSource,
} from '@/types'
// P-028 / D-045：知识点讲解标签只读字典（Q1② 独立端点，主 result 零改动）
import type { CurriculumTopicsPayload, CurriculumTopicRow } from '@/lib/curriculum-tags'

export type {
  TimelineItem, Subject, LibraryDoc, DocItem, Overview, Paged, ReviewSummary, ReviewPlan, GradeScope,
}
export type { CurriculumTopicsPayload, CurriculumTopicRow }
export { getUserId } from '@/services/net'

/** 构造带身份头的请求头（首次为匿名，后端回传 X-User-Id 后续用） */
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return buildHeaders(extra)
}

type ReqResult = Taro.request.SuccessCallbackResult<any>

// 统一解包：res.data 是 HTTP body，业务数据在 data 字段
/** 带业务码/HTTP 状态的错误：供上层按 code 做差异化提示（如 SR 限流降级）。 */
export class ApiError extends Error {
  code?: string
  status: number
  data?: Record<string, unknown>
  constructor(msg: string, status: number, code?: string, data?: Record<string, unknown>) {
    super(msg)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.data = data
  }
}

async function unwrap<T>(p: Promise<ReqResult>): Promise<T> {
  const res = await p
  captureUserId(res)
  console.log('[API Response]', res.statusCode, res.data)
  const body = res.data as ApiEnvelope<T>
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new ApiError(body?.msg || `请求失败(${res.statusCode})`, res.statusCode, (body as any)?.code, (body as any)?.data)
  }
  if (body?.code !== undefined && body.code !== 200) {
    throw new Error(body.msg || '请求失败')
  }
  return body.data
}

/**
 * 写操作收口：请求**成功**后才按域失效本地缓存（SWR 方案的一环）。
 *
 * 用法：return invalidateAfter(unwrap<T>(Network.request({...})), 'tl')
 *   - 'tl'   timeline 域（列表/详情/概览）——题目任何写操作
 *   - 'subj' 学科域；'lib' 资料库域；'doc' 文档域
 *   - 多域可传多个：invalidateAfter(p, 'subj', 'tl')
 *
 * 失败不清：请求 reject 时缓存原样保留（仍反映服务端现状，页面回退显示缓存）。
 * 对应思傅 2026-10-21「没触发数据库操作时只读缓存；触发了就让缓存失效」。
 */
function invalidateAfter<T>(p: Promise<T>, ...domains: string[]): Promise<T> {
  if (!domains.length) return p
  return p.then(
    (v) => {
      for (const d of domains) invalidateDomain(d)
      return v
    },
    (e) => {
      throw e
    },
  )
}

// 校验并解包识别类接口响应（不允许静默失败）
async function unwrapResponse<T>(p: Promise<ReqResult>): Promise<T> {
  const res = await p
  captureUserId(res)
  console.log('[API Response]', res.statusCode, res.data)
  const body = res.data as ApiEnvelope<T>
  if (res.statusCode < 200 || res.statusCode >= 300) {
    if (res.statusCode === 413) throw new ApiError('图片过大（超过限制），请裁剪或压缩后再识别', 413, (body as any)?.code, (body as any)?.data)
    throw new ApiError(body?.msg || `识别服务异常(${res.statusCode})`, res.statusCode, (body as any)?.code, (body as any)?.data)
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
//   purpose='memory' → 归档进「成长记忆」（2026-10-01 远端新增）
// ============================================================
export interface UploadOpts {
  /**
   * 上传用途（后端 upload.controller 的 purpose 语义表）：
   *  - 'save'   ：归档——图片建一条 timeline(kind=image)、文档建一条 library 条目
   *  - 'temp'   ：临时——ref_count=0，24h 后由孤儿 GC 回收（用完即弃的中间态）
   *  - 'memory' ：持久化但不建条目（成长记忆，key 由 memory_media 关联）
   *  - 'attach' ：持久化但**不建条目**——作为附件被别处引用（例：错题提取的裁剪图，
   *               key 由题目的 content.question_images 引用）
   * ⚠️ 附件类（attach）写错成 save 会在上传时就多出一条「最近题目」，
   *    与随后保存的题目重复 ⇒ 首页同一题显示两行（2026-10-21 复测分家真因）。
   */
  purpose?: 'save' | 'temp' | 'memory' | 'attach'
  /**
   * 归档目标（思傅 2026-10-24：资料库导入图片）。仅 purpose='save' 时有意义：
   *  - 不传    ：默认分流——图片进 timeline 收件箱、文档进 library
   *  - 'library'：图片也归档到资料库（library 条目而非 timeline 条目）
   */
  archiveTo?: 'library'
  /**
   * 原始文件名（思傅 2026-10-23 修「资料库文档中文名不显示」）：
   * 微信 uploadFile 的 multipart filename 取的是**临时文件路径名**（tmp_xxx.pdf），
   * 后端拿不到用户选文件的真实名字 ⇒ 资料库里显示一串随机名。
   * 这里把真实文件名走 formData.original_name 上传（表单字段值是 UTF-8 安全的，
   * 不像 Content-Disposition 的 filename 头会被按 latin1 读成乱码），
   * 后端优先读它来命名 library 条目 / timeline 标题。
   */
  fileName?: string
  /** D-068：归档到指定资料库文件夹（仅 purpose='save' 时有效）；不传 = 根目录 */
  folderId?: string
}

// ============================================================
// 上传前客户端粗压（复习本与项目设计.md §11.3 策略 1）
//
// 作用：省**上传流量**与时间。服务端仍会用 sharp 精压一遍（权威压缩点），
// 所以这里即使失败/被跳过，最终存储体积依然受控 —— 是「优化」不是「依赖」。
// 参数与 image-editor.tsx 的 MAX_SIDE/COMPRESS_QUALITY 保持一致。
// ============================================================
const UPLOAD_MAX_SIDE = 1600
const UPLOAD_COMPRESS_QUALITY = 80

/** 把本地图片压到长边 ≤1600 / q80；非图片、已足够小、或压缩失败时原样返回 */
async function compressForUpload(filePath: string): Promise<string> {
  if (!filePath || isRemoteImageUrl(filePath)) return filePath
  // 只压图片扩展名，避免把 PDF/docx 交给 getImageInfo 报错
  if (!/\.(jpe?g|png|webp|bmp|heic|heif)$/i.test(filePath)) return filePath
  try {
    const info = await Taro.getImageInfo({ src: filePath })
    const longSide = Math.max(info.width || 0, info.height || 0)
    if (!longSide || longSide <= UPLOAD_MAX_SIDE) return filePath
    const ratio = UPLOAD_MAX_SIDE / longSide
    const res = await Taro.compressImage({
      src: filePath,
      quality: UPLOAD_COMPRESS_QUALITY,
      compressedWidth: Math.max(1, Math.round(info.width * ratio)),
      compressedHeight: Math.max(1, Math.round(info.height * ratio)),
    })
    return res.tempFilePath || filePath
  } catch {
    // 任何异常都回退原路径：宁可多传点流量，也不能让上传失败
    return filePath
  }
}

export async function uploadFile(
  filePath: string,
  opts: UploadOpts = {},
): Promise<{
  key: string
  url: string
  thumb_key?: string
  thumb_url?: string
  type: 'image' | 'document'
  timeline_id?: string
  library_id?: string
  deduped?: boolean
  /** #121 业务条目层去重：命中已有条目，本次未新建 */
  duplicated?: boolean
  /** 命中的条目原本在回收站，已恢复 */
  restored?: boolean
}> {
  // 上传前先在本机粗压（省流量）；服务端还会再精压一次
  const srcPath = await compressForUpload(filePath)
  // purpose / archive_to 同时放进 query（url）与 multipart 表单字段（formData），双保险：
  // 部分容器/中间层会丢弃 query，部分会丢弃表单字段，两端都读即可确保后端拿到。
  const qs: string[] = []
  if (opts.purpose) qs.push(`purpose=${opts.purpose}`)
  if (opts.archiveTo) qs.push(`archive_to=${opts.archiveTo}`)
  if (opts.folderId) qs.push(`folder_id=${encodeURIComponent(opts.folderId)}`)
  const url = `/api/upload${qs.length ? `?${qs.join('&')}` : ''}`
  const formData: Record<string, string> = {}
  if (opts.purpose) formData.purpose = opts.purpose
  if (opts.archiveTo) formData.archive_to = opts.archiveTo
  // D-068：与 purpose 同样双写 query + formData，防中间层丢参数
  if (opts.folderId) formData.folder_id = opts.folderId
  // 原始文件名随表单上传（UTF-8 安全；见 UploadOpts.fileName 注释）
  if (opts.fileName) formData.original_name = encodeURIComponent(opts.fileName)
  const res = await Network.uploadFile({
    url,
    filePath: srcPath,
    name: 'file',
    header: authHeaders(),
    formData,
    // ⚠️ 微信 request / uploadFile 的 **默认与最大超时都是 60s**（官方服务市场文档），
    //    写 60000 是「真实生效的最大值」；写更大的值不会有任何效果。
    //    背景：后端冷启动 ~17s + 跨境延迟 + 慢网上传几 MB 卷子照片，逼近 60s
    //    天花板时前端必然被掐断，表现为「图片上传失败」。
    //    这条路**没有前端解法**（超时不可调、上传不可异步化），只能减少上传体积：
    //    选图时已走压缩（image-editor.tsx 的 compressImage），这里是最后一道兜底。
    //    ⚠️ 上传失败时提示「请换一张小一些的图」，不要提示「网络不好」——
    //       那是把硬限制说成偶发故障，用户会一直重试。
    timeout: 60000,
  })
  captureUserId(res)
  console.log('[Upload Response]', res.statusCode, res.data)
  const body = typeof res.data === 'string'
    ? JSON.parse(res.data)
    : (res.data as ApiEnvelope<{
        key: string
        url: string
        thumb_key?: string
        thumb_url?: string
        type: 'image' | 'document'
        timeline_id?: string
        library_id?: string
        deduped?: boolean
        /** #121 业务层去重：命中已有条目，本次未新建（不要当成"新增成功"来提示） */
        duplicated?: boolean
        /** 命中的那份原本在回收站，已被恢复回列表 */
        restored?: boolean
      }>)
  if (res.statusCode < 200 || res.statusCode >= 300) {
    // 配额超限（413）时把 code 带出去，便于 UI 区分「空间满」与「张数满」并引导清理/升级
    const err = new Error(body?.msg || '上传失败') as Error & { quotaCode?: string; quota?: unknown }
    if (body?.code === 'QUOTA_BYTES' || body?.code === 'QUOTA_COUNT') {
      err.quotaCode = body.code
      err.quota = body.data
    }
    throw err
  }
  // 上传即建条目的 purpose（save/memory）要失效对应缓存域；
  // temp/attach 不建条目，无需失效。
  if (opts.purpose === 'save') {
    // archive_to=library 的图片只建 library 条目，tl 域其实无变化，
    // 但 tl 一并失效成本极低（下次拉取即刷新），换来的是「绝不会漏刷新」。
    invalidateDomain('tl')
    invalidateDomain('lib')
  } else if (opts.purpose === 'memory') {
    invalidateDomain('mem')
  }
  return body.data
}

/**
 * 上传图片并返回可访问 URL / key。
 *
 * ⚠️ 关键修复：当入参是远程 URL（例如「智能高清 / 去手写」处理后的结果图）时，
 * 若 purpose='save' 需要落库，则必须先把它下载成本地临时文件再真正上传，
 * 否则直接返回原 URL 会导致后端完全没有收到上传请求 → 永不落库，
 * 表现为「提示已保存，但最近题目/资料库无记录」。
 * 对 purpose!=='save'（仅取 URL 作中间态）仍可沿用原 URL，无需重复上传。
 */
export async function uploadImage(
  filePathOrUrl: string,
  opts: UploadOpts = {},
): Promise<{ key: string; url: string; thumb_key?: string; thumb_url?: string; timeline_id?: string }> {
  // ⚠️ 必须用 isRemoteImageUrl：开发者工具的 tempFilePath 是 `http://tmp/…`，
  // 若当成远程 URL 复用 → 根本不上传 → 后端拿到 `http://tmp/…` →
  // `getaddrinfo ENOTFOUND tmp`（全页 OCR / 智能高清全线失败的元凶）。
  const isRemote = isRemoteImageUrl(filePathOrUrl)
  if (!isRemote) {
    const up = await uploadFile(filePathOrUrl, opts)
    return { key: up.key, url: up.url, thumb_key: up.thumb_key, thumb_url: up.thumb_url, timeline_id: up.timeline_id }
  }

  // 远程图：只有在需要落库（save）时才下载再上传；否则直接复用 URL
  if (opts.purpose !== 'save') {
    return { key: '', url: filePathOrUrl }
  }
  // ⚠️ 显式 timeout 30s：微信默认 60s，慢网下干等太久（2026-10-21 真机教训）
  const dl = await Network.downloadFile({ url: filePathOrUrl, timeout: 30000 })
  const localPath = (dl as any)?.tempFilePath
  if (!localPath) throw new Error('处理结果下载失败，无法保存')
  const up = await uploadFile(localPath, opts)
  return { key: up.key, url: up.url, thumb_key: up.thumb_key, thumb_url: up.thumb_url, timeline_id: up.timeline_id }
}

// ============================================================
// 学科
// ============================================================
export function fetchSubjects() {
  return unwrap<Subject[]>(Network.request({ url: '/api/subjects', method: 'GET', header: authHeaders() }))
}

/**
 * P-028 / D-045 · Q1②：拉取国家课标维度表字典（只读）。
 *
 * 🔴 只在用户打开「知识点提示」开关时才调用；主检索 result 结构零改动，
 *    `CACHE_VERSION` 保持 v14。服务端表未上生产时返回 `available:false`，
 *    前端据此不渲染标签，不抛错、不 toast 打扰。
 * 🔴 请求走 `authHeaders()` ⇒ 带 `X-Auth-Token`；端点**刻意不在 PUBLIC_ROUTES**。
 */
export function fetchCurriculumTopics() {
  return unwrap<CurriculumTopicsPayload>(
    Network.request({ url: '/api/curriculum/topics', method: 'GET', header: authHeaders() }),
  )
}

export function createSubject(payload: { name: string; color?: string; sort_order?: number }) {
  return invalidateAfter(
    unwrap<Subject>(Network.request({ url: '/api/subjects', method: 'POST', data: payload, header: authHeaders() })),
    'subj', 'tl',
  )
}

export function updateSubject(id: string, payload: { name?: string; color?: string; sort_order?: number }) {
  return invalidateAfter(
    unwrap<Subject>(Network.request({ url: `/api/subjects/${id}`, method: 'PUT', data: payload, header: authHeaders() })),
    'subj', 'tl',
  )
}

export function deleteSubject(id: string) {
  return invalidateAfter(
    unwrap<{ id: string }>(Network.request({ url: `/api/subjects/${id}`, method: 'DELETE', header: authHeaders() })),
    'subj', 'tl',
  )
}

/**
 * 把 LLM 识别出的学科名（中文，可能不规范，如「初中物理」「数学题」）匹配到用户已有的某个学科，返回 subject_id。
 * 匹配不到返回 null，调用方再回退到默认学科。
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
  /** ISO 时间，过滤 created_at >= since（review 模式下按 added_to_review_at） */
  since?: string
  /** 只看今天该复习（含逾期）；置 true 时后端自动按复习本语义过滤 */
  due?: boolean
  /** 复习本排序：due（默认，按到期）/ added（按加入时间） */
  sort?: 'due' | 'added'
  /**
   * 按年级检索（`P-005`）：本年级优先，**本年级 0 命中**才向相邻年级扩散（最多 2 级）。
   * 不传 = 不按年级过滤（未选年级的用户照常全量返回，不做任何拦截）。
   */
  grade?: number
  page?: number
  pageSize?: number
}

export function fetchTimeline(q: TimelineQuery = {}) {
  const data: Record<string, unknown> = {}
  data.scope = q.scope || 'recent'
  if (q.subjectId) data.subject_id = q.subjectId
  if (q.tag) data.tag = q.tag
  if (q.keyword) data.keyword = q.keyword
  if (q.since) data.since = q.since
  if (q.due) data.due = '1'
  if (q.sort && q.sort !== 'due') data.sort = q.sort
  // ⚠️ 用真值判断即可：0 不是合法年级，不需要 `!== undefined` 的写法
  if (q.grade) data.grade = q.grade
  if (q.page !== undefined) data.page = q.page
  if (q.pageSize !== undefined) data.page_size = q.pageSize
  return unwrap<Paged<TimelineItem>>(
    Network.request({ url: '/api/timeline', method: 'GET', data, header: authHeaders() }),
  )
}

/** 复习排程汇总：今日该复习 / 未排程 / 已毕业 */
export function fetchReviewSummary() {
  return unwrap<ReviewSummary>(
    Network.request({ url: '/api/timeline/review/summary', method: 'GET', header: authHeaders() }),
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
  /** 题面图 file_key（与答题卡图区分存储） */
  question_images?: string[]
  /** 答题卡/答案图 file_key */
  answer_images?: string[]
  /** 层级：1=大题/父题，2=小题/子题 */
  level?: number
  /** 所属父题下标；顶层为 null */
  parent_index?: number | null
  /** 所属大题完整题干（子题携带，独立可读） */
  stem?: string
  /** P3：规范题号标签（如 "预习案·Ⅱ.汉译英 18"），错题库唯一指认题目 */
  question_label?: string
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
  return invalidateAfter(
    unwrap<TimelineItem>(
      Network.request({ url: '/api/timeline', method: 'POST', data: payload, header: authHeaders() }),
    ),
    'tl',
  )
}

/** 批量创建多条 timeline 条目（一次提取多道题时替代循环单条，一次落库） */
export function createTimelineBatch(payloads: CreateTimelinePayload[]) {
  return invalidateAfter(
    unwrap<{ list: TimelineItem[] }>(
      Network.request({ url: '/api/timeline/batch', method: 'POST', data: { items: payloads }, header: authHeaders() }),
    ),
    'tl',
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
  level?: number
  parent_index?: number | null
  stem?: string
}) {
  return createTimeline({
    kind: 'question',
    subject_id: payload.subject_id ?? null,
    source: payload.source,
    content: {
      question: payload.question_content,
      answer: payload.answer_content || '',
      solution: payload.solution || '',
      wrong_answer: payload.wrong_answer || '',
      status: payload.status || (payload.answer_content ? 'answered' : 'pending'),
      // 题面图 / 答题卡图区分存储，并落地层级（不再混写 images[]，前端只读 question_images/answer_images）
      question_images: payload.question_image_keys || [],
      answer_images: payload.answer_image_keys || [],
      level: typeof payload.level === 'number' ? payload.level : undefined,
      parent_index: payload.parent_index ?? null,
      stem: payload.stem || '',
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
    /** kind=image 的原位替换：直接更新条目指向的文件 key（列表顺序不变） */
    file_key?: string
    /**
     * 缩略图 key。与 file_key 是**两个独立存储位置**，换主图必须同步换它，
     * 否则列表仍渲染旧 thumb_url（思傅 2026-10-21 反馈）。
     * 传 null = 显式清空，让列表回退用 file_key 对应的主图。
     */
    thumb_key?: string | null
  },
) {
  return invalidateAfter(
    unwrap<TimelineItem>(
      Network.request({ url: `/api/timeline/${id}`, method: 'PUT', data: payload, header: authHeaders() }),
    ),
    'tl',
  )
}

/** 兼容旧签名：updateQuestion → 更新题目内容 */
export function updateQuestion(
  id: string,
  payload: {
    /** null = 显式清空为「未分类」。⚠️ 绝不能传 ''（会撞 timeline_items 的学科外键） */
    subject_id?: string | null
    question_content?: string
    answer_content?: string
    solution?: string
    wrong_answer?: string
    status?: 'answered' | 'pending'
    mastered?: boolean
    tags?: string[]
    /** 题面图 file_key 全量替换（详情页「编辑图片」后原位替换；后端按 content 合并） */
    question_images?: string[]
    /** 答题卡/答案图 file_key 全量替换（思傅 2026-10-23：详情页支持删除答案图） */
    answer_images?: string[]
    /** 旧版图片 file_key 全量替换（content.images 兜底渲染路径，思傅 2026-10-23） */
    images?: string[]
    /** 答案附件全量替换（思傅 2026-10-21：图片 / 文档 / 文本） */
    answer_attachments?: AnswerAttachment[]
    /** 答案来源：manual 手填 / search 联网搜索 / ocr / mixed */
    answer_source?: AnswerSource | 'mixed'
    /** 参考来源；知识库条目没有外链，url 可空 */
    answer_refs?: { title: string; url?: string }[]
    /** 最近一次联网搜答案时间 */
    answer_searched_at?: string
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
    payload.status !== undefined ||
    payload.question_images !== undefined ||
    payload.answer_images !== undefined ||
    payload.images !== undefined ||
    payload.answer_attachments !== undefined ||
    payload.answer_source !== undefined ||
    payload.answer_refs !== undefined ||
    payload.answer_searched_at !== undefined
  ) {
    patch.content = {
      question: payload.question_content,
      answer: payload.answer_content,
      solution: payload.solution,
      wrong_answer: payload.wrong_answer,
      status: payload.status,
      ...(payload.question_images !== undefined ? { question_images: payload.question_images } : {}),
      // 答题卡/答案图、旧版图片的全量替换（后端按 content 字段合并，未传的字段不受影响）
      ...(payload.answer_images !== undefined ? { answer_images: payload.answer_images } : {}),
      ...(payload.images !== undefined ? { images: payload.images } : {}),
      // 答案：附件 / 来源 / 参考链接（后端按 content 字段合并，未传的字段不受影响）
      ...(payload.answer_attachments !== undefined ? { answer_attachments: payload.answer_attachments } : {}),
      ...(payload.answer_source !== undefined ? { answer_source: payload.answer_source } : {}),
      ...(payload.answer_refs !== undefined ? { answer_refs: payload.answer_refs } : {}),
      ...(payload.answer_searched_at !== undefined ? { answer_searched_at: payload.answer_searched_at } : {}),
    } as NonNullable<Parameters<typeof updateTimeline>[1]>['content']
  }
  return updateTimeline(id, patch)
}

export function deleteTimeline(id: string) {
  return invalidateAfter(
    unwrap<{ id: string }>(
      Network.request({ url: `/api/timeline/${id}`, method: 'DELETE', header: authHeaders() }),
    ),
    'tl',
  )
}

/** 兼容旧签名 */
export const deleteQuestion = deleteTimeline

/** 批量软删 */
export function batchDeleteTimeline(ids: string[]) {
  return invalidateAfter(
    unwrap<{ removed: number }>(
      Network.request({ url: '/api/timeline/batch-delete', method: 'POST', data: { ids }, header: authHeaders() }),
    ),
    'tl',
  )
}

/**
 * 用「编辑后的图片」替换「最近题目」里的一条已有图片条目。
 *
 * 场景（用户反馈 #3）：首页点开已加入最近题目的图片，再做裁剪 / 智能高清 / 去手写。
 *
 * ⚠️ 必须用「原位替换」（PUT file_key/thumb_key），不能用「新建条目+软删旧条目」：
 *   旧方案的"新建"会让新条目插到列表最前、"软删"失败时旧条目残留 → 列表顺序每编辑一次变一次，
 *   用户按记忆位置点「更多」会打开**别的题目的图**（正是「编辑 A 后操作 B，看到的却是 A」的根因）。
 *   原位替换后条目 id 不变、位置不变、学科/复习本等属性全部保留。
 *
 * 做法：编辑结果以 purpose='attach' 上传（持久化、不建条目）→
 *       PUT /api/timeline/:id 更新 file_key/thumb_key。
 *
 * ⚠️ 两处历史坑（2026-10-21 思傅反馈修复）：
 *   1) 旧代码只 PUT `file_key` 不 PUT `thumb_key`。列表卡片渲染的是
 *      `item.thumb_url || item.url`，而 thumb_url 来自**另一列** thumb_key
 *      ⇒ 主图换了、缩略图还指向旧文件 ⇒ 列表/点开仍显示「未修改的图片」
 *      （这不是缓存问题，是两张图分别存在 DB 的不同位置）。
 *   2) 旧代码用 purpose='temp' 上传：temp 走 ingestTemp，ref_count=0，
 *      24h 后就被孤儿 GC 真删 ⇒ 换过的图第二天裂掉。改用 'attach'
 *      （走正式 ingest、登记引用计数、但不建条目）。
 *
 * @returns 原条目 id（位置不变）
 */
export async function replaceTimelineImage(
  oldItem: { id: string; subject_id?: string | null },
  editedFileOrUrl: string,
): Promise<{ id: string }> {
  const up = await uploadImage(editedFileOrUrl, { purpose: 'attach' })
  if (!up?.key) throw new Error('编辑结果上传失败，请重试')
  // thumb_key 同步换新；服务端没给出缩略图时显式置 null，让列表回退用主图（绝不留旧缩略图）
  await updateTimeline(oldItem.id, { file_key: up.key, thumb_key: up.thumb_key || null })
  return { id: oldItem.id }
}

/** 线上后端图像能力自检（GET /api/image/capabilities）。
 *  404 = 线上是旧版后端（没有本地 straighten/enhance/erase_v2 管线）；
 *  200 = 新版，data.version ≥ 3。前端在图像功能失败时据此区分「服务未更新」与「处理失败」。 */
export async function fetchImageCapabilities(): Promise<{
  supported: boolean
  version?: number
  pipeline_mode?: string
  /** true = 请求根本没发出去/超时（通道问题，与服务版本无关） */
  networkError?: boolean
}> {
  try {
    const data = await unwrap<{ version: number; pipeline_mode: string }>(
      Network.request({ url: '/api/image/capabilities', method: 'GET', header: authHeaders() }),
    )
    return { supported: true, version: data?.version, pipeline_mode: data?.pipeline_mode }
  } catch (e) {
    // 区分两类失败（修复「未包含所需的处理模块」误报）：
    //  - 服务端有响应但路由不存在（ApiError 带 HTTP 状态码，如 404）= 旧版后端 → supported:false
    //  - 请求未发出/超时（Taro request:fail，无状态码）= 通道问题 → networkError:true
    //    此前一律按「服务版本过旧」提示，把真机调试断链/局域网不通误报成后端缺模块。
    const status = e instanceof ApiError ? e.status : 0
    const isNetworkFail = !status || /request:fail|time ?out|超时|aborted/i.test((e as Error)?.message || '')
    console.warn(
      `[capabilities] 能力自检失败（${isNetworkFail ? '网络/通道错误' : `服务端响应 ${status}`}）:`,
      e,
    )
    return { supported: false, networkError: isNetworkFail }
  }
}

/** OCR 诊断（GET /api/image/ocr-diagnose）。
 *  逐项实测快速/精准两条识别路径与侧车状态，返回结构化报告，
 *  用于定位「本页未检测到文本」这类静默空结果的根因。
 *  失败（如 404 旧版后端无此路由）时 rejected，调用方提示「请先更新后端」。 */
export async function diagnoseOcr(): Promise<Record<string, unknown>> {
  return unwrap<Record<string, unknown>>(
    Network.request({ url: '/api/image/ocr-diagnose', method: 'GET', header: authHeaders() }),
  )
}

/** 加入复习本 */
export function addToReviewBook(ids: string[]) {
  return invalidateAfter(
    unwrap<{ updated: number }>(
      Network.request({ url: '/api/timeline/review-book', method: 'POST', data: { ids }, header: authHeaders() }),
    ),
    'tl',
  )
}

/** 移出复习本 */
export function removeFromReviewBook(ids: string[]) {
  return invalidateAfter(
    unwrap<{ updated: number }>(
      Network.request({ url: '/api/timeline/review-book', method: 'DELETE', data: { ids }, header: authHeaders() }),
    ),
    'tl',
  )
}

/** P2-17 相似题推荐：基于用户自建错题历史（文本+标签相似） */
export function fetchSimilar(id: string, limit = 5) {
  return unwrap<SimilarItem[]>(
    Network.request({ url: `/api/timeline/${id}/similar`, method: 'POST', data: { limit }, header: authHeaders() }),
  )
}

/**
 * C4 复习排程：记录一次复习结果。
 *
 * ⚠️ 必须传对错（'correct' | 'wrong'）：
 *   旧签名只发空 body = 「今天复习了 ✓」，做对做错一样推进档位，
 *   等于把「是否真的记住」从数据里抹掉了 —— 分散练习因此拿不到效应量。
 *   做错归零并次日再来，做对推进一档，满五档毕业。
 */
export function markReviewed(id: string, result: 'correct' | 'wrong' = 'correct') {
  return invalidateAfter(
    unwrap<{
      review_count: number
      review_lapses: number
      last_reviewed_at: string
      next_review_at: string | null
      plan: ReviewPlan
    }>(
      Network.request({
        url: `/api/timeline/${id}/review`,
        method: 'POST',
        data: { result },
        header: authHeaders(),
      }),
    ),
    'tl',
  )
}

// ============================================================
// 资料库 library（外部文档）
// ============================================================
/** D-068：资料库文件夹（无限层级，parent_id 自引用） */
export interface LibraryFolder {
  id: string
  user_id: string
  parent_id: string | null
  name: string
  created_at: string
}

export interface LibraryQuery {
  subjectId?: string
  keyword?: string
  /** 按年级检索（`P-005`）：与题目同口径，不传 = 不按年级过滤 */
  grade?: number
  /**
   * D-068：按文件夹过滤。不传 = 全量（旧口径）；'root' = 未归类；具体 id = 该文件夹直属资料。
   * ⚠️ 缓存 key 必须带它，否则切换文件夹会命中上一个目录的缓存（与 grade 同坑）。
   */
  folderId?: string
  page?: number
  pageSize?: number
}

export function fetchLibrary(q: LibraryQuery = {}) {
  const data: Record<string, unknown> = {}
  if (q.subjectId) data.subject_id = q.subjectId
  if (q.keyword) data.keyword = q.keyword
  if (q.grade) data.grade = q.grade
  if (q.folderId) data.folder_id = q.folderId
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
  return invalidateAfter(
    unwrap<LibraryDoc>(
      Network.request({ url: '/api/library', method: 'POST', data: payload, header: authHeaders() }),
    ),
    'lib',
  )
}

/**
 * D-063：多张图片按 `keys` 数组顺序合成**一份一图一页 PDF**，只归档成品到资料库。
 * 原图走 `purpose=temp` 上传（不建条目、由孤儿 GC 回收），故这里只需提交 key 列表。
 * 成功后失效 `lib` 缓存域，页面 `load({silent:true})` 才能拉到新条目。
 */
export function combineLibraryImages(keys: string[], name: string, folderId?: string) {
  return invalidateAfter(
    unwrap<LibraryDoc & { pages: number; images: number }>(
      Network.request({
        url: '/api/library/combine-images',
        method: 'POST',
        data: { keys, name, ...(folderId ? { folder_id: folderId } : {}) },
        header: authHeaders(),
      }),
    ),
    'lib',
  )
}

// ============================================================
// D-068 资料库文件夹（无限层级）
// ============================================================
export function fetchLibraryFolders() {
  return unwrap<LibraryFolder[]>(
    Network.request({ url: '/api/library/folders', method: 'GET', header: authHeaders() }),
  )
}

export function createLibraryFolder(name: string, parentId?: string | null) {
  return unwrap<LibraryFolder>(
    Network.request({
      url: '/api/library/folders', method: 'POST',
      data: { name, parent_id: parentId ?? null }, header: authHeaders(),
    }),
  )
}

export function renameLibraryFolder(id: string, name: string) {
  return unwrap<LibraryFolder>(
    Network.request({
      url: `/api/library/folders/${id}`, method: 'PATCH',
      data: { name }, header: authHeaders(),
    }),
  )
}

export function moveLibraryFolder(id: string, parentId: string | null) {
  return unwrap<LibraryFolder>(
    Network.request({
      url: `/api/library/folders/${id}`, method: 'PATCH',
      data: { parent_id: parentId }, header: authHeaders(),
    }),
  )
}

export function deleteLibraryFolder(id: string) {
  return invalidateAfter(
    unwrap<{ id: string; promoted_docs: number; promoted_folders: number }>(
      Network.request({ url: `/api/library/folders/${id}`, method: 'DELETE', header: authHeaders() }),
    ),
    'lib',
  )
}

/** 把资料移入文件夹；null / 'root' = 移回根目录（未归类） */
export function moveLibraryDocToFolder(id: string, folderId: string | null) {
  return invalidateAfter(
    unwrap<{ id: string; folder_id: string | null }>(
      Network.request({
        url: `/api/library/${id}`, method: 'PATCH',
        data: { folder_id: folderId }, header: authHeaders(),
      }),
    ),
    'lib',
  )
}

export function deleteLibraryDoc(id: string) {
  return invalidateAfter(
    unwrap<{ id: string }>(
      Network.request({ url: `/api/library/${id}`, method: 'DELETE', header: authHeaders() }),
    ),
    'lib',
  )
}

export function batchDeleteLibrary(ids: string[]) {
  return invalidateAfter(
    unwrap<{ removed: number }>(
      Network.request({ url: '/api/library/batch-delete', method: 'POST', data: { ids }, header: authHeaders() }),
    ),
    'lib',
  )
}

/** 重命名资料库条目（思傅 2026-10-24） */
export function renameLibraryDoc(id: string, name: string) {
  return invalidateAfter(
    unwrap<{ id: string; name: string }>(
      Network.request({ url: `/api/library/${id}`, method: 'PATCH', data: { name }, header: authHeaders() }),
    ),
    'lib',
  )
}

/**
 * 更新资料库条目（思傅 2026-10-24：重命名 + 归属学科二合一）。
 * subject_id 传 null = 未分类；只传需要改的字段即可。
 */
export function updateLibraryDoc(id: string, patch: { name?: string; subject_id?: string | null }) {
  return invalidateAfter(
    unwrap<{ id: string; name: string; subject_id: string | null }>(
      Network.request({ url: `/api/library/${id}`, method: 'PATCH', data: patch, header: authHeaders() }),
    ),
    'lib',
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
// 存储配额（策略 6）
// ============================================================

export interface StorageUsage {
  used_bytes: number
  used_count: number
  quota_bytes: number
  quota_count: number
  tier: string
  pct: number
}

/** 当前存储用量与档位；失败返回 null（前端降级为不展示，不阻断页面） */
export async function fetchStorageUsage(): Promise<StorageUsage | null> {
  try {
    return await unwrap<StorageUsage>(
      Network.request({ url: '/api/quota/usage', method: 'GET', header: authHeaders() }),
    )
  } catch {
    return null
  }
}

/** 把字节格式化成人类可读（MB/GB） */
export function formatBytes(bytes: number): string {
  const b = Number(bytes) || 0
  if (b >= 1024 * 1024 * 1024) return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(0)} MB`
  return `${Math.round(b / 1024)} KB`
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
  /** 层级：1=大题/父题，2=小题/子题 */
  level?: number
  /** 所属父题下标；顶层为 null */
  parent_index?: number | null
  /** 所属大题的完整题干（子题已自动携带/前置到 question_content） */
  stem?: string
  /** 答题卡/答案图 file_key（与题面图区分） */
  answer_image_keys?: string[]
  /** P2：该题在题面页上的像素框（叠加视图 + 用户改框基线） */
  box?: { x0: number; y0: number; x1: number; y1: number }
  /** P2：系统判定（wrong=错题；叠加视图颜色编码） */
  verdict?: 'wrong' | 'correct' | 'blank' | 'unknown'
  /** P1：规范题号标签（如 "预习案·Ⅱ.汉译英 18"） */
  question_label?: string
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
    /** 切块流程：每道错题块都自带其答案图 key（按题号关联后的结果） */
    answer_image_keys: raw.answer_image_keys || [],
    subject: raw.subject || '',
    level: typeof raw.level === 'number' ? raw.level : 1,
    parent_index: raw.parent_index ?? null,
    stem: raw.stem || '',
    box: raw.box,
    verdict: raw.verdict,
    question_label: raw.question_label,
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

// 题目/答案分传：题目图（带红笔批改）+ 答案图，切块→逐块识别→按题号关联成多道题
//
// ⚠️ 已切到新的 /api/image/extract-wrong 接口（落实"切块 + 逐块识别"原始意图）：
//   后端先本地切块（红笔锚定，allowVlm=false）、再对每块单独跑本地 OCR 侧车，
//   返回的是"切出的题块图 key + 该区域 OCR 文本"（而非整图），并回传每题的 answer_image_keys。
// P2：响应另带 blocks（全部系统题块，供叠加视图）/page（页尺寸）/question_url（改框重切源）。
export async function recognizeSeparate(questionFile: string, answerFile: string) {
  const [q, a] = await Promise.all([uploadFile(questionFile), uploadFile(answerFile)])
  const data = await unwrapResponse<{
    items: RecognizeResult[]
    answer_image_keys?: string[]
    unmatched_questions?: string[]
    blocks?: WrongBlockSummary[]
    page?: { w: number; h: number }
    question_url?: string
    page_text?: PageTextSegment[]
  }>(
    Network.request({
      url: '/api/image/extract-wrong',
      method: 'POST',
      data: { image_url: q.url, answer_image_keys: [a.key] },
      header: authHeaders(),
    }),
  )
  const items = (data?.items || []).map(normalizeItem)
  if (!items.length || !items.some((it) => it.question_content)) {
    throw new Error('未能从图片中切出错题区域，请确认图片清晰、有红笔批改痕迹')
  }
  return {
    matched: items,
    unmatched_questions: data?.unmatched_questions || [],
    answer_image_keys: data?.answer_image_keys || [a.key],
    blocks: data?.blocks || [],
    page: data?.page || { w: 0, h: 0 },
    question_url: data?.question_url || q.url,
    page_text: data?.page_text || [],
  }
}

/** P2：系统切出的题块摘要（叠加视图渲染 + 改框基线） */
export interface WrongBlockSummary {
  id: number
  box: { x0: number; y0: number; x1: number; y1: number }
  verdict: 'wrong' | 'correct' | 'blank' | 'unknown'
  question_label?: string
}

/**
 * OCR 文本片段（一个**段落**，不是一行）。
 * 分段在后端完成：精准走 PP-StructureV3 版面块，快速走行级递归 XY-Cut（见 ocr-segment.ts）。
 */
export interface PageTextSegment {
  text: string
  box: { x0: number; y0: number; x1: number; y1: number }
  /** 所属栏索引（0 起；单栏页恒 0） */
  col: number
  /** 段落语义类型 */
  kind?: 'text' | 'title' | 'table' | 'formula' | 'other'
  /** 本段由几行合并而来（1 = 单行） */
  lines?: number
  /** 分段来源：layout=引擎版面块｜xycut=行级 XY-Cut */
  source?: 'layout' | 'xycut'
}

/** P2：用户改框后的重切重识（与 extract-wrong 同链路，保存以用户框为准） */
export async function recropWrongBlock(params: {
  image_url: string
  box: { x0: number; y0: number; x1: number; y1: number }
  system_box?: { x0: number; y0: number; x1: number; y1: number }
  question_label?: string
  answer_content?: string
  answer_image_keys?: string[]
}) {
  const data = await unwrapResponse<{
    item: RecognizeResult
    box: { x0: number; y0: number; x1: number; y1: number }
    feedback?: { iou: number; area_delta_pct: number; offset: { dx: number; dy: number } }
  }>(
    Network.request({
      url: '/api/image/extract-wrong-recrop',
      method: 'POST',
      data: params,
      header: authHeaders(),
    }),
  )
  return {
    item: normalizeItem(data.item),
    box: data.box,
    feedback: data.feedback,
  }
}

// 文档导入识别
/**
 * 文档（多页 PDF / Word / TXT）识别。
 *
 * ⚠️ GK-23-21：原先走**同步** `/api/ocr/recognize-doc` + `withTimeout(240s)`。
 *    那是自欺——微信 `wx.request` 的超时上限就是 60s，写 240s 请求照样在 60s 被掐断，
 *    所以「多页 PDF 必失败」不是后端慢，是**这条链路从设计上就跑不完**。
 *    现在与精准 OCR 一样走 `POST /api/jobs` 202 + 轮询，每次请求都是毫秒级。
 */
export async function recognizeDocument(
  filePath: string,
  subjectId: string,
  opts?: { shouldAbort?: () => boolean; onProgress?: (info: { stage: string; waitedMs: number }) => void },
) {
  const { url } = await uploadFile(filePath)
  const data = await runJob<{ items: RecognizeResult[]; rawText?: string }>(
    'doc-recognize',
    // subject_id 后端 recognizeDoc 不消费（归类由用户在结果页选），保留字段只为兼容旧报文
    { file_url: url, subject_id: subjectId },
    {
      ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts?.shouldAbort ? { shouldAbort: opts.shouldAbort } : {}),
    },
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
export async function recognizeDocumentByUrl(
  url: string,
  subjectId: string,
  opts?: { shouldAbort?: () => boolean; onProgress?: (info: { stage: string; waitedMs: number }) => void },
) {
  // 同上（GK-23-21）：同步端点必撞 60s 天花板，改异步任务
  const data = await runJob<{ items: RecognizeResult[]; rawText?: string }>(
    'doc-recognize',
    { file_url: url, subject_id: subjectId },
    {
      ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts?.shouldAbort ? { shouldAbort: opts.shouldAbort } : {}),
    },
  )
  const items = (data?.items || []).map(normalizeItem)
  if (items.length === 0) throw new Error('未识别到题目，请确认文档内容为文字')
  return items
}

/**
 * 把「识别结果」直接导出为一个 Word 文档。
 * 后端生成 docx → 上传存储 → 写入 documents 记录（「文档」页可见），返回可直接打开的地址。
 */
export async function exportRecognizedDocx(
  items: Array<RecognizeResult & { images?: string[] }>,
  title?: string,
) {
  const data = await unwrapResponse<{ url: string; file_key: string; title: string }>(
    Network.request({
      url: '/api/ocr/export-docx',
      method: 'POST',
      data: { items, title: title || '' },
      header: authHeaders(),
    }),
  )
  return data
}

// ---------- #150 人工辅助错题整理（OCR 文本栏 + 粘贴栏） ----------

/**
 * 全页 OCR 文本栏：摆正 + 全页 OCR + 阅读序平铺。
 * 不做红笔检测/切块——文本供用户在右侧栏复制，粘进底部粘贴栏。
 * 返回摆正后的页面图 URL：前端展示与「页内裁剪」都用它（与 OCR 同一坐标系）。
 * @param mode fast=快速（RapidOCR 1~3s/页）| precise=精准（PaddleOCR 全链路 15~20s/页，默认）
 */
export async function ocrPage(
  imageUrl: string,
  mode: 'fast' | 'precise' = 'precise',
  opts?: {
    /**
     * 是否先几何摆正，默认 true（整页拍照图需要）。
     * ⭐「先裁剪 → 再对裁剪图 OCR」必须传 false：裁剪图已是正矩形，
     *    再摆正只会二次透视把小图拉塌（历史故障：识别后图被换成 37×39 裂图）。
     */
    rectify?: boolean
    /** 进度回调（仅精准模式有：该模式慢到必须给用户反馈） */
    onProgress?: (info: { stage: string; waitedMs: number }) => void
    /** 取消探针（页面卸载时置为 true，立刻停止轮询；见 services/jobs.ts GK-23-19） */
    shouldAbort?: () => boolean
  },
) {
  const params = { image_url: imageUrl, mode, rectify: opts?.rectify !== false }

  // ⚠️ 精准模式走**异步任务**：全链路（摆正 ~17s + PP-StructureV3 ~50s）实测 ~67s，
  //    而微信 request 的超时上限就是 60s —— 同步请求在小程序端**必然**被掐断，
  //    与网络好坏无关（OPS-18 `R-上线-01`）。改成「提交 + 轮询」后每次请求都是毫秒级。
  const data = mode === 'precise'
    ? await runJob<{
        page: { w: number; h: number }
        page_text: PageTextSegment[]
        image_url: string
        orient_suspect?: boolean
      }>('ocr-page', params, {
        ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
        ...(opts?.shouldAbort ? { shouldAbort: opts.shouldAbort } : {}),
      })
    : await unwrapResponse<{
        page: { w: number; h: number }
        page_text: PageTextSegment[]
        image_url: string
        orient_suspect?: boolean
      }>(
        Network.request({
          url: '/api/image/ocr-page',
          method: 'POST',
          data: params,
          header: authHeaders(),
          // 快速模式 1~3s/页；上限写 55s —— 必须 **小于 60s**，
          // 写再大也不会生效（微信的默认是 60s，最大值也是 60s）
          timeout: 55000,
        }),
      )

  return {
    page: data?.page || { w: 0, h: 0 },
    page_text: data?.page_text || [],
    image_url: data?.image_url || imageUrl,
    orient_suspect: data?.orient_suspect === true,
  }
}

/** 粘贴栏条目：文本 + 手动裁剪的错题图片 URL 列表 */
export interface BoardExportItem {
  question_content: string
  images?: string[]
}

/**
 * 粘贴栏导出 Word（#150）：与 exportRecognizedDocx 同一端点，
 * items 带 images 时服务端把裁剪图嵌入 docx（题干之后，宽度自适应）。
 */
export async function exportBoardDocx(items: BoardExportItem[], title?: string) {
  const data = await unwrapResponse<{ url: string; file_key: string; title: string }>(
    Network.request({
      url: '/api/ocr/export-docx',
      method: 'POST',
      data: { items, title: title || '' },
      header: authHeaders(),
    }),
  )
  return data
}

// ============================================================
// 联网搜题
// ============================================================
/**
 * 联网搜题（AI 解题）。
 *
 * ⚠️ 走**异步任务**：联网检索 + 大模型实测 60~90s，超过微信 request 的 60s
 *    超时天花板（OPS-18 `R-上线-01`）。
 *
 * ⚠️ 返回字段以**后端为准**：`answer_content` / `solution` / `references`。
 *    旧签名写的是 `answer`（前端从未有调用方，故未被发现），已一并订正。
 */
export function searchSolution(question: string) {
  return runJob<{ answer_content: string; solution: string; references: { title: string; url: string; site_name?: string }[] }>(
    'search-solve',
    { question_content: question },
  )
}

// ============================================================
// 题目答案：联网搜答案（思傅 2026-10-21）
// ============================================================

/**
 * P-015 / D-018：参考例题（题目不完全一致、但解题思路可借鉴的库内原题）。
 * 与后端 `server/src/shared/question-reference.ts` 的 ReferenceExample 字段对齐；
 * 按项目惯例不跨端 import。🔴 stem 与 solution 来自同一道题，绝不拼接。
 */
export interface ReferenceExample {
  stem: string
  solution: string
  sourceId: string
  sourceName: string
  objectIndex: number
  label: string
  charStart: number
  charEnd: number
  sharedSignals: string[]
  solutionChars: number
  /**
   * P-017 / D-020：原题快照（含图形与公式）的公开 URL。
   * 缺失 = 这道题没有快照（转换失败 / 题干定位不到），前端不得用别的题顶替。
   */
  figureUrl?: string
  figureWidth?: number
  figureHeight?: number
  figurePage?: number
  /**
   * P-018 / D-021：题干**原位**图片（公式 / 几何图），按 `charOffset` 升序。
   * 与 `figureUrl`（整题块级快照）不同：这些图要按偏移插回题干文字中间。
   * 🔴 缺失 = 这道题没抠到图，按纯文本渲染；**不得拿相邻题目的图顶替**。
   */
  inlineFigures?: InlineFigure[]
}

/** P-018 / D-021：题干原位图片（与后端 `question-reference.ts` 对齐，不跨端 import）。 */
export interface InlineFigure {
  /** 相对 `stem` 的 UTF-16 索引：`stem.slice(0, charOffset)` + 图 + `stem.slice(charOffset)` */
  charOffset: number
  /** formula＝行内公式；figure＝几何图/图片 */
  kind: 'formula' | 'figure'
  url: string
  width: number
  height: number
}

/** 联网搜答案的返回（与后端 answer-search.service 对齐） */
export interface AnswerSearchResult {
  /**
   * search = 联网检索到真实来源；netdisk = 命中百度网盘里的自有资料（先于 kb）；
   * kb = 来自资料库；llm = 无检索、纯模型推理；none = 都不可用
   */
  source: 'search' | 'netdisk' | 'kb' | 'llm' | 'none'
  /**
   * P-006 / D-009：原题判定档位（mode=kb 的 netdisk/kb 结果才会带）。
   *  - exact = 找到了这道题 + 定位到答案/解析段 ⇒ 可采纳
   *  - topic = 只找到同主题资料 ⇒ answer 为空、禁止采纳
   *  - none  = 什么都没找到 ⇒ 不渲染结果卡片
   * ⚠️ 只有显式 topic/none 才拦；字段缺失（联网搜题 / AI 解题 / 老缓存）沿用原逻辑。
   */
  match_level?: 'exact' | 'topic' | 'none'
  /** 是否经过核实（检索类=true；纯模型推理=false） */
  verified: boolean
  answer: string
  solution: string
  /** 参考来源；知识库条目没有外链，url 为空（不提供复制） */
  refs: { title: string; url?: string }[]
  confidence: number
  note?: string
  cached?: boolean
  /**
   * P-009 / D-012：exact 的来源位置（出自哪份资料、第几题、原文哪一段）。
   * 只在 match_level='exact' 时出现；topic / none 一律不带。后端字段同名，
   * 前端当前只在 note 里展示题号，结构化字段留给后续「跳原文定位」。
   */
  source_location?: {
    source_id?: string
    source_name?: string
    object_index: number
    label: string
    char_start: number
    char_end: number
  }
  /**
   * P-015 / D-018：没有找到原题答案时，可借鉴解题思路的库内例题。
   * 🔴 只作展示：answer 仍为空、verified 仍为 false、不提供「采纳」。
   *    展示前必须先渲染 reference_disclaimer（缺失时用前端镜像兜底）。
   */
  references?: ReferenceExample[]
  reference_disclaimer?: string
}

/**
 * 为指定题目获取答案。
 *
 * ⚠️ 本接口**不写库** —— 只返回候选答案，用户点「采纳」后才由调用方写入，
 *    杜绝模型幻觉答案静默污染题库（设计方案 §2.3 安全阀）。
 *
 * mode（思傅 2026-10-23 拆分）：
 *   'search' = 联网搜题：只做真实网络检索，直接给来源摘要+链接，不喂给 AI
 *   'kb'     = 资料库：只检索运营者公共资料库（秒级），不喂给 AI
 *   'ai'     = AI 解题：只做模型推理，不检索，明确标注未联网核实
 */
export function searchAnswer(
  itemId: string,
  force = false,
  mode: 'search' | 'ai' | 'kb' = 'search',
  opts?: {
    onProgress?: (info: { stage: string; waitedMs: number }) => void
    /** 取消探针（组件卸载时置 true，立刻停止轮询；见 services/jobs.ts GK-23-19） */
    shouldAbort?: () => boolean
  },
) {
  // ⚠️ 走**异步任务**：扣子联网搜端到端实测 110~135s（bot 跑检索插件 ~100~115s
  //    + 提炼 ~10~60s），而微信 request 超时上限就是 60s —— 同步请求在真机上
  //    **从来就没成功过**（OPS-18 `R-上线-01`）。改成提交 + 轮询后每次请求毫秒级。
  return runJob<AnswerSearchResult>(
    'answer-search',
    { item_id: itemId, force, mode },
    {
      ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts?.shouldAbort ? { shouldAbort: opts.shouldAbort } : {}),
    },
  )
}

/** 采纳搜到的答案：写入题目（带来源标记与参考链接） */
export function adoptAnswer(
  itemId: string,
  payload: { answer: string; solution?: string; refs?: { title: string; url?: string }[]; source: AnswerSource | 'mixed' },
) {
  return updateQuestion(itemId, {
    answer_content: payload.answer,
    solution: payload.solution,
    status: payload.answer ? 'answered' : 'pending',
    answer_source: payload.source,
    answer_refs: payload.refs,
    answer_searched_at: new Date().toISOString(),
  })
}

/** 保存答案附件（图片 / 文档 / 文本），与题目同记录存储 */
export function saveAnswerAttachments(itemId: string, attachments: AnswerAttachment[]) {
  return updateQuestion(itemId, {
    answer_attachments: attachments,
    answer_source: 'manual',
    answer_searched_at: new Date().toISOString(),
  })
}

/**
 * 一次性保存答案的**全部字段**（文本 + 附件 + 来源 + 参考链接）。
 *
 * 为什么必须一次调用：后端 `content` 是按字段合并的，分开调用虽不会互相清掉，
 * 但两次写之间用户若改了别的字段（如题干）会被其中一次覆盖，且多一次往返。
 * 统一入口既安全又少一个请求。
 */
export function saveAnswer(
  itemId: string,
  payload: {
    answer?: string
    solution?: string
    attachments?: AnswerAttachment[]
    source?: AnswerSource | 'mixed'
    refs?: { title: string; url?: string }[]
  },
) {
  return updateQuestion(itemId, {
    answer_content: payload.answer,
    solution: payload.solution,
    // ⚠️ 只在确实传了文本答案时才改 status：否则「仅添加附件」会把已有答案的
    //    条目误标成 pending（列表角标「待找答案」就冒出来了）。
    status: payload.answer !== undefined ? (payload.answer ? 'answered' : 'pending') : undefined,
    answer_attachments: payload.attachments,
    answer_source: payload.source,
    answer_refs: payload.refs,
    answer_searched_at: new Date().toISOString(),
  })
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
  /** 指定题目 id 白名单（详情页「导出打印」只导本题）；提供时后端忽略学科/时间/掌握筛选 */
  ids?: string[]
  /**
   * true = 答疑解惑（含答案/解析）；**不传 = 打印练习卷（不含答案）**。
   * ⚠️ 2026-10-28 起与 combineToPdf 一致：默认不含答案（旧默认是含答案）。
   */
  include_answers?: boolean
}

export function exportDocument(params: ExportParams) {
  return invalidateAfter(
    unwrap<{ url: string; file_key: string; title: string }>(
      Network.request({ url: '/api/document/export', method: 'POST', data: params, header: authHeaders() }),
    ),
    'doc',
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
  return invalidateAfter(
    unwrap<{ removed: number }>(
      Network.request({ url: '/api/documents/batch-delete', method: 'POST', data: { ids }, header: authHeaders() }),
    ),
    'doc',
  )
}

export function deleteDocument(id: string) {
  return invalidateAfter(
    unwrap<{ id: string }>(
      Network.request({ url: `/api/documents/${id}`, method: 'DELETE', header: authHeaders() }),
    ),
    'doc',
  )
}

/** 重命名导出文档（思傅 2026-10-24） */
export function renameDocument(id: string, title: string) {
  return invalidateAfter(
    unwrap<{ id: string; title: string }>(
      Network.request({ url: `/api/documents/${id}`, method: 'PATCH', data: { title }, header: authHeaders() }),
    ),
    'doc',
  )
}

// ============================================================
// 图片合成 PDF / Word（素材 id 现指 timeline item id）
// ============================================================

/** 合成格式：pdf=多图拼页省纸；docx=顺排可编辑（家长可加批注再打印） */
export type CombineFormat = 'pdf' | 'docx'

export interface CombineResult {
  url: string
  key: string
  doc_id: string
  /** PDF 为实际页数；DOCX 为按图高估算的页数 */
  pages: number
  /** PDF 为版面填充率；DOCX 恒为 0 */
  fillRatio: number
  images: number
}

export function combineToPdf(ids: string[], format: CombineFormat = 'pdf', includeAnswers = false) {
  return invalidateAfter(
    unwrap<CombineResult>(
      Network.request({
        url: '/api/pdf/combine',
        method: 'POST',
        data: { ids, format, include_answers: !!includeAnswers },
        header: authHeaders(),
      }),
    ),
    'doc',
  )
}

// ============================================================
// 图片处理（AI）：自动调正 / 智能高清 / 去手写
// ============================================================
export type ImageAction = 'auto' | 'enhance' | 'erase' | 'erase_v2'

/**
 * 图片处理结果。
 *
 * ⭐ `debug.notice`：后端在「安全地原样返回原图」时会带上它（未检出手写 /
 *   未识别到歪斜 / 高清未通过内容校验）。前端**必须**据此弹窗告知，
 *   否则用户看到的就是「点了没反应」——这正是连着五轮反馈的根因。
 */
/** 多模式并列输出中的单项（P1 预览自选） */
export interface EnhanceModeAsset {
  url: string
  key: string
  width: number
  height: number
  sizeBytes: number
}

export interface ImageProcessResult {
  url: string
  key: string
  timeline_id: string
  /** 五模式并列输出（multi_modes=true 时返回）：原图/增强/黑白/增亮/灰度 */
  modes?: Record<'original' | 'enhance' | 'bw' | 'brighten' | 'gray', EnhanceModeAsset>
  debug?: {
    needManual?: boolean
    notice?: { level: 'info' | 'warn'; title: string; message: string }
    /** 智能默认档：后端单色源检测自动选中的模式（未显式指定 preset 时才有） */
    autoPreset?: string
    [k: string]: unknown
  }
}

async function ensureImageUrl(filePathOrUrl: string): Promise<string> {
  if (isRemoteImageUrl(filePathOrUrl)) return filePathOrUrl
  // AI 处理前的中间上传：用 purpose=temp，不要落库（避免自动进「最近题目」）
  const { url } = await uploadFile(filePathOrUrl, { purpose: 'temp' })
  return url
}

export interface ProcessImageOpts {
  /** true=处理完成后归档进「最近题目」；默认 false=仅预览 */
  save?: boolean
  /** 整体超时（毫秒），到点直接失败而不无限转圈，默认 90s */
  timeout?: number
  /**
   * 智能高清(enhance)专用：升采样倍率，默认 2，支持 2/3/4。
   * 仅在后端 IMG_PIPELINE_MODE ∈ {new, hybrid} 时生效；否则后端回落图生图。
   */
  sr_scale?: 2 | 3 | 4
  /**
   * 智能高清(enhance)专用：推理模式。
   *  - 'classical'（默认）：轻量零权重 SR，CPU 上快、对文档文字稳
   *  - 'espcn'：ESPCN 神经网络推理（需后端配置真权重，较慢但细节更好）
   */
  sr_mode?: 'classical' | 'espcn'
  /**
   * 智能高清(enhance)专用：⭐ 输出模式（P1，对齐扫描全能王五种模式）。
   *  - 'original' 原图（不做像素增强）
   *  - 'enhance'  增强并锐化（彩色，默认）
   *  - 'bw'       黑白/文档（硬二值化，**纯黑白打印件最优**）
   *  - 'brighten' 增亮（拍摄偏暗/阴影重）
   *  - 'gray'     灰度（去色但保留灰阶层次）
   * 不传则由后端**智能默认档**自动判定（单色源→黑白，否则增强）。
   */
  enhance_preset?: 'original' | 'enhance' | 'bw' | 'brighten' | 'gray'
  /**
   * 智能高清(enhance)专用：⭐ 强度档位 'weak' | 'medium'(默认) | 'strong'。
   * 把"是否过头"的把控权交给用户（方案 §P1）。
   */
  enhance_strength?: 'weak' | 'medium' | 'strong'
  /**
   * 智能高清(enhance)专用：⭐ 一次产出**五种模式的预览图**（multi_modes=true），
   * 结果在 `ImageProcessResult.modes` 返回，用于前端并列渲染缩略图让用户自选
   * （方案 §P1「预览自选 UX」）。预览为轻量档，选定模式后再请求最终高清画质。
   */
  multi_modes?: boolean
  /**
   * 自动调正(auto)专用：前端手动拉出的试卷四角，**归一化 [0,1]**（相对原图），顺序任意。
   * 提供则后端直接做透视压平（100% 保真，不重画）；缺省则走自动检测。
   */
  manual_corners?: [number, number][]
  /**
   * 自动调正(auto)专用：是否尝试曲面展开，默认 false（当前经典法实测不达标，会安全回落平面）。
   */
  dewarp_curved?: boolean
  /**
   * 去手写(erase_v2)专用：**框选补擦**区域数组，归一化坐标（相对原图，取值 0~1）。
   *
   * ⭐ 这是「自动检测不可能 100%」的兜底通道（方案 §5.10）：
   *   用户圈出来的区域在服务端**无条件并入**手写 mask——不参与任何「是否印刷」判据，
   *   实测框选区掩膜内残留 0.0%。前端口径与后端 `ProcessImageDto.manual_regions` 严格一致。
   *
   * ⚠️ 注意：整图 mask 覆盖率 >70% 的兜底保护仍然生效（防止整页被涂白），
   *    正常框选（几块手写区）远达不到该阈值。
   */
  manual_regions?: Array<{ x: number; y: number; w: number; h: number }>
  /**
   * 去手写(erase_v2)专用：⭐ 擦除模式（v18.2）。
   *  - 'union'（默认）：三通道并集，适合**黑笔/铅笔**作答卷；
   *  - 'color'：仅彩色笔迹 + 印刷保护，适合**红/蓝笔批改/作答卷**——
   *    红笔卷上深色/槽位通道会把印刷正文连同红笔一起吞掉（实测 mask 内
   *    被删像素 42.5% 是印刷），color 模式误删降 52%~99%、印刷零误伤。
   */
  erase_mode?: 'union' | 'color'
}

export async function processImage(action: ImageAction, filePathOrUrl: string, opts: ProcessImageOpts = {}) {
  const image_url = await ensureImageUrl(filePathOrUrl)
  // 仅按动作携带对应参数，避免污染其它动作的请求体
  const extra: Record<string, unknown> = {}
  if (action === 'enhance') {
    if (opts.sr_scale) extra.sr_scale = opts.sr_scale
    if (opts.sr_mode) extra.sr_mode = opts.sr_mode
    // P1 多模式 / 智能默认档 / 强度档位
    if (opts.enhance_preset) extra.enhance_preset = opts.enhance_preset
    if (opts.enhance_strength) extra.enhance_strength = opts.enhance_strength
    if (opts.multi_modes) extra.multi_modes = true
  }
  if (action === 'auto') {
    if (opts.manual_corners?.length === 4) extra.manual_corners = opts.manual_corners
    if (opts.dewarp_curved) extra.dewarp_curved = true
  }
  // 去手写框选补擦：用户圈选区域原样透传给后端（仅在有区域时携带）
  if (action === 'erase_v2') {
    if (opts.manual_regions && opts.manual_regions.length > 0) {
      extra.manual_regions = opts.manual_regions
    }
    if (opts.erase_mode) extra.erase_mode = opts.erase_mode
  }
  return withTimeout(
    unwrapResponse<ImageProcessResult>(
      Network.request({
        url: '/api/image/process',
        method: 'POST',
        data: { action, image_url, save: opts.save === true, ...extra },
        header: authHeaders(),
      }),
    ),
    // 180s：高清扩展（SR + OCR 一致性校验）实测 54s（x2/classical），
    // x3/x4 与神经网络模式更久，90s 默认值会在真机上被掐断（思傅 2026-10-19 实测）。
    opts.timeout || 180000,
    '图片处理超时（90s），可能是原图过大或网络较慢。建议先用「编辑裁剪」缩小图片后重试。',
  )
}

// ============================================================
// 图片直存
// ============================================================
/**
 * 把一张图片直接保存为「最近题目」条目（不依赖 OCR）。
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

// ============================================================
// 🔴 2026-11-14（D-058）：原「智能客服 / 知识库管理」前端 API 封装整段删除。
//
// 个人主体下 AI 助手对用户完全不可用：
//   ① 资质：办不了「深度合成-AI 问答」类目（需法人 + 算法备案）；
//   ② 前端：AI_PUBLIC_ENTRY = false，D-057 已删净「我的」页与答题页入口；
//   ③ 服务端：POST /api/chat/message、POST /api/chat 均过 requireAiEnabled()
//      fail-closed，真实用户 ai_enabled 全为 false ⇒ 必然 403 AI_DISABLED。
// 两个页面（pages/chat/index、pages/chat/admin）已无任何入口，属死页面；
// 连同页面源码、路由、通用对话 service（src/services/chat.ts）一并删除，
// 避免小程序包里残留大模型话术被审核认定为「提供 AI 服务」。
//
// ⚠️ 服务端 ChatModule / requireAiEnabled() 闸门**刻意保留**：删了才是真的
//    把合规后门打开；M49 A3 专条守此。数据库 chat_* 表与 migrations 亦保留。
// ============================================================

// ------------------------------------------------------------
// 账号注销（OPS-18 R-合规-03）
// ------------------------------------------------------------

export interface PurgeResult {
  userId: string
  dryRun: boolean
  blobsTotal: number
  blobsReleased: number
  blobsKeptForOtherUsers: number
  legacyObjectsDeleted: number
  rowsDeleted: Record<string, number>
  ocrResultsKept: number
  note: string
}

/**
 * 注销账号：删除本人账号与全部业务数据（不可恢复）。
 *
 * @param dryRun true = 只统计「会删什么、留什么」，不真删（用于二次确认页展示）
 *
 * ⚠️ 共享内容不跟着删：同一份文件若其他账号也在引用，只减引用计数；
 *    跨用户共享的识别缓存（ocr_results）不参与账号删除。
 */
// ---------------- 用户设置（OPS-18 R-合规-02：AI 外发开关） ----------------

/** 学年到期的升年级建议（`P-005` 决策 7）。服务端只给建议，绝不自动写入 */
export interface GradeRollover {
  /** 当前年级 */
  from: number
  /** 建议升入的年级 */
  suggested: number
  /** 当前学年起始年（2026 = 2026-09 ~ 2027-08 学年） */
  school_year: number
}

export interface UserSettings {
  /** 是否允许把题目内容发往第三方 AI（联网检索 / 大模型）。false = 仅本地 */
  ai_enabled: boolean
  /** 当前年级 1–12；null = 未选择（检索不按年级过滤） */
  grade?: number | null
  /** 年级展示名（后端给，避免两端各拼一遍） */
  grade_label?: string
  /** 升年级建议；null = 不需要提示 */
  grade_rollover?: GradeRollover | null
  /** 角色（后端一直有返回，这里补上类型） */
  role?: 'user' | 'admin'
}

/** 读取用户设置 */
export function getSettings() {
  return unwrap<UserSettings>(
    Network.request({ url: '/api/settings', method: 'GET', header: authHeaders() }),
  )
}

/**
 * 设置 / 清空年级（`P-005`）。
 *
 * @param grade 1–12；**传 `null` 表示取消年级**（合法意图，不是「不改」）
 *
 * ⚠️ 与 `setAiEnabled` 不同，改年级后**不需要** `invalidateUserFlags`：
 *    年级不参与任何服务端拦截，只在下次新建条目时被读取做快照。
 */
export function setGrade(grade: number | null) {
  return unwrap<{ grade: number | null; grade_label: string; confirmed_year: number | null }>(
    Network.request({
      url: '/api/settings/grade',
      method: 'PUT',
      data: { grade },
      header: authHeaders(),
    }),
  )
}

/**
 * 设置 AI 外发开关。
 * 关掉后后端会在 `/api/chat*` 与 `/api/answer-search/*` 直接 403（AI_DISABLED），
 * 不是只靠前端藏按钮——前端藏按钮只是体验。
 */
export function setAiEnabled(enabled: boolean) {
  return unwrap<{ ai_enabled: boolean }>(
    Network.request({
      url: '/api/settings/ai',
      method: 'PUT',
      data: { enabled },
      header: authHeaders(),
    }),
  )
}

export function purgeAccount(dryRun = false) {
  return unwrap<PurgeResult>(
    Network.request({
      url: `/api/account${dryRun ? '?dry_run=1' : ''}`,
      method: 'DELETE',
      header: authHeaders(),
    }),
  )
}
