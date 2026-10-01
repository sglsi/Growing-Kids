/**
 * memory.types.ts
 * 成长记忆相关 DTO 与领域类型
 */

export type MemoryCategory = 'study' | 'life' | 'hobby' | 'feel' | 'other'
export type MemoryMood = 'happy' | 'calm' | 'excited' | 'thoughtful' | 'sad' | 'proud'
export type MemoryKind = 'image' | 'audio' | 'video'

export const MEMORY_CATEGORIES: ReadonlyArray<{ value: MemoryCategory; label: string }> = [
  { value: 'study', label: '学习' },
  { value: 'life',  label: '生活' },
  { value: 'hobby', label: '爱好' },
  { value: 'feel',  label: '感触' },
  { value: 'other', label: '其他' },
]

export const MEMORY_MOODS: ReadonlyArray<{ value: MemoryMood; label: string }> = [
  { value: 'happy',     label: '开心' },
  { value: 'calm',      label: '平静' },
  { value: 'excited',   label: '激动' },
  { value: 'thoughtful',label: '沉思' },
  { value: 'sad',       label: '难过' },
  { value: 'proud',     label: '自豪' },
]

export interface Memory {
  id: string
  user_id: string
  title?: string | null
  content?: string | null
  category: MemoryCategory
  mood?: MemoryMood | null
  subject_id?: string | null
  tags: string[]
  cover_key?: string | null
  cover_mime?: string | null
  media_count: number
  audio_duration?: number | null
  occurred_at: string
  created_at: string
  updated_at: string
  deleted_at?: string | null
}

export interface MemoryMedia {
  id: string
  memory_id: string
  user_id: string
  file_key: string
  thumb_key?: string | null
  mime_type: string
  width?: number | null
  height?: number | null
  size_bytes?: number | null
  duration_sec?: number | null
  transcript?: string | null
  kind: MemoryKind
  sort_order: number
  created_at: string
}

export interface MemoryListQuery {
  category?: MemoryCategory | string
  subject_id?: string
  tag?: string
  keyword?: string
  since?: string
  page?: number
  page_size?: number
}

export interface CreateMemoryDto {
  title?: string
  content?: string
  category?: MemoryCategory
  mood?: MemoryMood
  subject_id?: string
  tags?: string[]
  occurred_at?: string
}

export interface UpdateMemoryDto {
  title?: string
  content?: string
  category?: MemoryCategory
  mood?: MemoryMood | null
  subject_id?: string | null
  tags?: string[]
  occurred_at?: string
}

export interface CreateMemoryMediaDto {
  file_key: string
  thumb_key?: string
  mime_type: string
  width?: number
  height?: number
  size_bytes?: number
  duration_sec?: number
  kind: MemoryKind
  sort_order?: number
}