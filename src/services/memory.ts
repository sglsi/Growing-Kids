import { Network } from '@/network'
import { invalidateDomain } from '@/services/cache'
import { captureUserId } from '@/services/net'

/**
 * 统一解包：与 `services/api.ts` 的 `unwrap` 同口径（HTTP 2xx + body.code===200 → body.data）。
 *
 * 🔴 为什么这里必须自己解包（2026-10-29 分模块测试发现并修复，缺陷 P0-A）：
 * `Network.request` 返回的是 **Taro 完整响应对象**（`{ statusCode, data:{code,msg,data} }`），
 * 不是业务数据。本文件原先直接把它当业务数据返回，调用方只能写
 * `(res as any).data?.data || res` 这种双重解包，且**解出来的仍是后端 snake_case 字段**，
 * 而本文件的 `Memory` 类型是驼峰 ⇒ `m.occurredAt` 恒 undefined ⇒ 记忆列表按月份分组时
 * 全部 `continue` ⇒ 页面显示「共 N 条」却一张卡片都没有。
 */
async function unwrap<T>(p: Promise<any>): Promise<T> {
  const res = await p
  captureUserId(res)
  const body = res?.data
  if (!res || res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(body?.msg || `请求失败(${res?.statusCode ?? '无响应'})`)
  }
  if (body?.code !== undefined && body.code !== 200) {
    throw new Error(body.msg || '请求失败')
  }
  return body.data as T
}

/** 写操作收口：成功后失效 mem 缓存域（与 api.ts 的 invalidateAfter 同义） */
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

export type MemoryCategory = 'study' | 'life' | 'hobby' | 'feel' | 'other'
export type MemoryMood = 'happy' | 'calm' | 'excited' | 'thoughtful' | 'sad' | 'proud'
export type MemoryKind = 'image' | 'audio' | 'video'

export interface Memory {
  id: string
  userId: string
  title?: string | null
  content?: string | null
  category: MemoryCategory
  mood?: MemoryMood | null
  subjectId?: string | null
  subject?: { id: string; name: string; color?: string } | null
  tags: string[]
  coverKey?: string | null
  coverMime?: string | null
  coverUrl?: string | null
  thumbUrl?: string | null
  mediaCount: number
  audioDuration?: number | null
  occurredAt: string
  createdAt: string
  updatedAt: string
}

export interface MemoryMedia {
  id: string
  memoryId: string
  kind: MemoryKind
  fileKey: string
  thumbKey?: string | null
  mimeType: string
  width?: number | null
  height?: number | null
  sizeBytes?: number | null
  durationSec?: number | null
  transcript?: string | null
  sortOrder: number
  url?: string
  thumbUrl?: string
}

export interface MemoryListQuery {
  category?: MemoryCategory | string
  subjectId?: string
  tag?: string
  keyword?: string
  since?: string
  page?: number
  pageSize?: number
}

export interface MemoryListResp {
  list: Memory[]
  total: number
  page: number
  page_size: number
}

export interface MemoryDetailResp {
  memory: Memory
  media: MemoryMedia[]
}

export interface CreateMemoryPayload {
  title?: string
  content?: string
  category?: MemoryCategory
  mood?: MemoryMood
  subject_id?: string
  tags?: string[]
  occurred_at?: string
}

export interface UpdateMemoryPayload {
  title?: string
  content?: string
  category?: MemoryCategory
  mood?: MemoryMood | null
  subject_id?: string | null
  tags?: string[]
  occurred_at?: string
}

export interface CreateMemoryMediaPayload {
  kind: MemoryKind
  file_key: string
  thumb_key?: string
  mime_type: string
  width?: number
  height?: number
  size_bytes?: number
  duration_sec?: number
  sort_order?: number
}

/** 列表 */
export function fetchMemories(q: MemoryListQuery = {}) {
  // ⚠️ 必须过滤空值：直接把 undefined 塞进 data 会拼出 ?category=undefined&... 这类脏参数，
  //    后端拿到字符串 "undefined" 会当成真值去过滤 ⇒ 不报错但永远查不到数据（比 404 更隐蔽）。
  const raw: Record<string, unknown> = {
    category: q.category,
    subject_id: q.subjectId,
    tag: q.tag,
    keyword: q.keyword,
    since: q.since,
    page: q.page ?? 1,
    page_size: q.pageSize ?? 20,
  }
  const data: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null || v === '') continue
    data[k] = v
  }
  return unwrap<Record<string, unknown>>(
    Network.request({ url: '/api/memories', method: 'GET', data }),
  ).then(normalizeMemoryListResp)
}

/** 详情 */
export function fetchMemoryDetail(id: string) {
  return unwrap<Record<string, unknown>>(
    Network.request({ url: `/api/memories/${id}`, method: 'GET' }),
  ).then((raw) => ({
    memory: normalizeMemory((raw.memory || {}) as Record<string, unknown>),
    media: ((raw.media || []) as Record<string, unknown>[]).map(normalizeMemoryMedia),
  }))
}

/** 创建 */
export function createMemory(payload: CreateMemoryPayload) {
  return invalidateAfter(
    unwrap<Record<string, unknown>>(
      Network.request({ url: '/api/memories', method: 'POST', data: payload }),
    ).then(normalizeMemory),
    'mem',
  )
}

/** 修改 */
export function updateMemory(id: string, payload: UpdateMemoryPayload) {
  return invalidateAfter(
    unwrap<Record<string, unknown>>(
      Network.request({ url: `/api/memories/${id}`, method: 'PATCH', data: payload }),
    ).then(normalizeMemory),
    'mem',
  )
}

/** 删除（软删） */
export function deleteMemory(id: string) {
  return invalidateAfter(
    Network.request<{ id: string }>({ url: `/api/memories/${id}`, method: 'DELETE' }),
    'mem',
  )
}

/** 批量删除 */
export function batchDeleteMemories(ids: string[]) {
  return invalidateAfter(
    Network.request<{ count: number }>({
      url: '/api/memories/batch-delete',
      method: 'POST',
      data: { ids },
    }),
    'mem',
  )
}

/** 追加媒体 */
export function addMemoryMedia(memoryId: string, payload: CreateMemoryMediaPayload) {
  return invalidateAfter(
    Network.request<MemoryMedia>({
      url: `/api/memories/${memoryId}/media`,
      method: 'POST',
      data: payload,
    }),
    'mem',
  )
}

/** 删除媒体 */
export function deleteMemoryMedia(memoryId: string, mediaId: string) {
  return invalidateAfter(
    Network.request<{ id: string }>({
      url: `/api/memories/${memoryId}/media/${mediaId}`,
      method: 'DELETE',
    }),
    'mem',
  )
}

/** 分类与心情常量 */
export const MEMORY_CATEGORIES: ReadonlyArray<{ value: MemoryCategory; label: string }> = [
  { value: 'study', label: '学习' },
  { value: 'life',  label: '生活' },
  { value: 'hobby', label: '爱好' },
  { value: 'feel',  label: '感触' },
  { value: 'other', label: '其他' },
]

export const MEMORY_MOODS: ReadonlyArray<{ value: MemoryMood; label: string; emoji: string }> = [
  { value: 'happy',     label: '开心',   emoji: '😊' },
  { value: 'calm',      label: '平静',   emoji: '😌' },
  { value: 'excited',   label: '激动',   emoji: '🤩' },
  { value: 'thoughtful',label: '沉思',   emoji: '🤔' },
  { value: 'sad',       label: '难过',   emoji: '😢' },
  { value: 'proud',     label: '自豪',   emoji: '😎' },
]

/** 工具：根据 value 找 label */
export function getMemoryCategoryLabel(v: string | null | undefined): string {
  const item = MEMORY_CATEGORIES.find((c) => c.value === v)
  return item ? item.label : '生活'
}

export function getMemoryMoodLabel(v: string | null | undefined): string {
  const item = MEMORY_MOODS.find((m) => m.value === v)
  return item ? item.label : ''
}

export function getMemoryMoodEmoji(v: string | null | undefined): string {
  const item = MEMORY_MOODS.find((m) => m.value === v)
  return item ? item.emoji : ''
}

/** 把后端 snake_case 字段映射为前端驼峰（统一在 service 层完成） */
export function normalizeMemory(raw: Record<string, unknown>): Memory {
  const subjects = raw.subjects as { id: string; name: string; color?: string } | undefined
  return {
    id: String(raw.id),
    userId: String(raw.user_id || ''),
    title: (raw.title as string | null) ?? null,
    content: (raw.content as string | null) ?? null,
    category: (raw.category as MemoryCategory) || 'life',
    mood: (raw.mood as MemoryMood | null) ?? null,
    subjectId: (raw.subject_id as string | null) ?? null,
    subject: subjects
      ? { id: subjects.id, name: subjects.name, color: subjects.color }
      : null,
    tags: (raw.tags as string[]) || [],
    coverKey: (raw.cover_key as string | null) ?? null,
    coverMime: (raw.cover_mime as string | null) ?? null,
    mediaCount: (raw.media_count as number) || 0,
    audioDuration: (raw.audio_duration as number | null) ?? null,
    occurredAt: (raw.occurred_at as string) || '',
    createdAt: (raw.created_at as string) || '',
    updatedAt: (raw.updated_at as string) || '',
  }
}

export function normalizeMemoryListResp(raw: Record<string, unknown>): MemoryListResp {
  const list = ((raw.list || []) as Record<string, unknown>[]).map(normalizeMemory)
  return {
    list,
    total: (raw.total as number) || 0,
    page: (raw.page as number) || 1,
    page_size: (raw.page_size as number) || 20,
  }
}

export function normalizeMemoryMedia(raw: Record<string, unknown>): MemoryMedia {
  return {
    id: String(raw.id),
    memoryId: String(raw.memory_id || ''),
    kind: raw.kind as MemoryKind,
    fileKey: String(raw.file_key || ''),
    thumbKey: (raw.thumb_key as string | null) ?? null,
    mimeType: String(raw.mime_type || ''),
    width: (raw.width as number | null) ?? null,
    height: (raw.height as number | null) ?? null,
    sizeBytes: (raw.size_bytes as number | null) ?? null,
    durationSec: (raw.duration_sec as number | null) ?? null,
    transcript: (raw.transcript as string | null) ?? null,
    sortOrder: (raw.sort_order as number) || 0,
    url: (raw.url as string | undefined) ?? undefined,
    thumbUrl: (raw.thumb_url as string | undefined) ?? undefined,
  }
}