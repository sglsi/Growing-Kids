export type TimelineKind = 'image' | 'question'

export type TimelineScope = 'recent' | 'review'

/** 题目的结构化内容（存于 timeline_items.content） */
export interface QuestionContent {
  question?: string
  answer?: string
  solution?: string
  wrong_answer?: string
  images?: string[]
  status?: 'answered' | 'pending'
  /** 题面图 file_key（与答题卡图区分存储，避免混在 images[] 里分不清） */
  question_images?: string[]
  /** 答题卡 / 答案图 file_key */
  answer_images?: string[]
  /** 层级：1=大题/父题，2=小题/子题 */
  level?: number
  /** 所属父题在识别结果数组中的下标；顶层题为 null */
  parent_index?: number | null
  /** 所属大题完整题干（子题携带，可脱离父题独立读懂） */
  stem?: string
}

export interface TimelineItem {
  id: string
  user_id: string
  subject_id: string | null
  kind: TimelineKind
  title: string | null
  // 文件（kind=image）
  file_key: string | null
  thumb_key: string | null
  mime_type: string | null
  width: number | null
  height: number | null
  size_bytes: number | null
  file_hash: string | null
  // 题目（kind=question）
  content: QuestionContent
  source: string | null
  // 复习本
  in_review_book: boolean
  added_to_review_at: string | null
  // 标签与状态
  tags: string[]
  mastered: boolean
  mastered_at: string | null
  created_at: string
  updated_at: string
  // 关联学科（select 时附带）
  subjects?: { id: string; name: string; color: string } | null
}

/** 返回给前端时补的签名 URL */
export interface TimelineItemWithUrl extends TimelineItem {
  url?: string
  thumb_url?: string
  image_urls?: string[]
  /** 题面图签名 URL（来自 content.question_images） */
  question_image_urls?: string[]
  /** 答题卡/答案图签名 URL（来自 content.answer_images） */
  answer_image_urls?: string[]
}

export interface TimelineListQuery {
  scope?: TimelineScope
  subject_id?: string
  tag?: string
  keyword?: string
  /** ISO 时间，过滤 created_at >= since（review 模式下按 added_to_review_at） */
  since?: string
  page?: number
  page_size?: number
}

export interface CreateTimelineDto {
  kind: TimelineKind
  subject_id?: string | null
  title?: string
  source?: string
  tags?: string[]
  // image 专用
  file_key?: string
  thumb_key?: string
  mime_type?: string
  width?: number
  height?: number
  size_bytes?: number
  file_hash?: string
  // question 专用
  content?: QuestionContent
}

export type UpdateTimelineDto = Partial<
  Pick<TimelineItem, 'title' | 'subject_id' | 'tags' | 'mastered' | 'file_key' | 'thumb_key'> &
  { content: QuestionContent }
>
