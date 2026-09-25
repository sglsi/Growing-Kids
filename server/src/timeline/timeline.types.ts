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
}

export interface TimelineListQuery {
  scope?: TimelineScope
  subject_id?: string
  tag?: string
  keyword?: string
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
  Pick<TimelineItem, 'title' | 'subject_id' | 'tags' | 'mastered'> & { content: QuestionContent }
>
