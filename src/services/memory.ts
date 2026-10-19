import { Network } from '@/network'

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
  return Network.request<MemoryListResp>({
    url: '/memories',
    method: 'GET',
    data: {
      category: q.category,
      subject_id: q.subjectId,
      tag: q.tag,
      keyword: q.keyword,
      since: q.since,
      page: q.page ?? 1,
      page_size: q.pageSize ?? 20,
    },
  })
}

/** 详情 */
export function fetchMemoryDetail(id: string) {
  return Network.request<MemoryDetailResp>({ url: `/memories/${id}`, method: 'GET' })
}

/** 创建 */
export function createMemory(payload: CreateMemoryPayload) {
  return Network.request<Memory>({ url: '/memories', method: 'POST', data: payload })
}

/** 修改 */
export function updateMemory(id: string, payload: UpdateMemoryPayload) {
  return Network.request<Memory>({ url: `/memories/${id}`, method: 'PATCH', data: payload })
}

/** 删除（软删） */
export function deleteMemory(id: string) {
  return Network.request<{ id: string }>({ url: `/memories/${id}`, method: 'DELETE' })
}

/** 批量删除 */
export function batchDeleteMemories(ids: string[]) {
  return Network.request<{ count: number }>({
    url: '/memories/batch-delete',
    method: 'POST',
    data: { ids },
  })
}

/** 追加媒体 */
export function addMemoryMedia(memoryId: string, payload: CreateMemoryMediaPayload) {
  return Network.request<MemoryMedia>({
    url: `/memories/${memoryId}/media`,
    method: 'POST',
    data: payload,
  })
}

/** 删除媒体 */
export function deleteMemoryMedia(memoryId: string, mediaId: string) {
  return Network.request<{ id: string }>({
    url: `/memories/${memoryId}/media/${mediaId}`,
    method: 'DELETE',
  })
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