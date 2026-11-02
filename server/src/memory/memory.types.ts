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

  // ---- 列表专用聚合字段（2026-11-02 新增）----
  // 列表接口原本只给 `cover_key`（对象存储 key），而小程序 `<Image src>` /
  // `<Video poster>` 只能吃 URL 且**不发任何头部** ⇒ 前端拿 key 拼不出可用地址，
  // 卡片上的图片/视频/音频缩略图整片空白。这里由服务端用 getPublicUrl() 直接给 URL，
  // 前端不必知道存储驱动（local 拼后端地址、supabase 给公开/签名直链）。
  cover_url?: string | null
  cover_thumb_url?: string | null
  /** 该记忆的媒体种类（去重、按 sort_order 出现顺序），列表卡片据此决定画什么格 */
  media_kinds?: MemoryKind[]
  /** 各类型媒体数量，例：{ image: 3, video: 1, audio: 2 }（卡片右下角显示计数） */
  media_counts?: Partial<Record<MemoryKind, number>>
  /** 首个视频时长（秒）：卡片上要显示 "▶ 0:32" */
  video_duration?: number | null
  /** 首个视频的首帧图 URL（卡片缩略图；为空时前端画黑底播放图标） */
  video_thumb_url?: string | null
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