export type TimelineKind = 'image' | 'question'

export type TimelineScope = 'recent' | 'review'

import type { ErrorAnalysis } from '../ocr/ocr.types'

// ---------- 答案附件（思傅 2026-10-21：答案支持图片 / 文档 / 文本多类型） ----------

export type AnswerAttachmentType = 'image' | 'doc' | 'text'

/** 答案来源：手填 / 联网搜索 / OCR 识别 / 资料库选取（可溯源） */
export type AnswerSource = 'manual' | 'search' | 'ocr' | 'library'

/**
 * 一条答案附件。
 *
 * ⚠️ 一一对应保证：答案**内嵌在题目记录的 content 里**（不是独立表、不是靠外键），
 *    因此物理上不存在「答案挂到别的题上」的可能 —— 见「题目答案功能-设计方案.md」§1.2。
 */
export interface AnswerAttachment {
  /** 附件唯一 id（删除 / 排序 / 前端 key 用） */
  id: string
  type: AnswerAttachmentType
  /** 对象存储 key（image / doc） */
  file_key?: string
  /** 图片缩略图 key */
  thumb_key?: string
  /** 原始文件名（文档如「期中解析.pdf」） */
  name?: string
  mime?: string
  size?: number
  /** type=text 时承载正文 */
  text?: string
  source?: AnswerSource
  /** source=library 时的资料库条目 id */
  ref_id?: string
  /** source=search 时的参考链接 */
  refs?: { title: string; url: string }[]
  created_at: string
}

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
  /** P2-16 错因分析结论（本地规则引擎产出；SBERT 分可选） */
  error_analysis?: ErrorAnalysis
  /**
   * P3：规范题号标签（如 "预习案·Ⅱ.汉译英 18"）。
   * 两节各自重起题号时数字有歧义，标签才能唯一指认题目（#129 P1 产出，
   * P3 起随保存落库，供错题库查看/检索/复习时识别「这是哪一节哪一道」）。
   */
  question_label?: string
  /** P2-18 艾宾浩斯复习阶段计数：已完成的复习次数（计划由 created_at + 该值现算） */
  review_count?: number
  // ---------- 答案（思傅 2026-10-21）----------
  /** 答案附件：图片 / 文档 / 文本片段，与题目同记录存储 ⇒ 不可能挂错题 */
  answer_attachments?: AnswerAttachment[]
  /** 答案来源：manual 手填 / search 联网搜索 / ocr 识别 / mixed 混合 */
  answer_source?: AnswerSource | 'mixed'
  /** 联网搜索命中的参考来源（与附件解耦，便于单独展示「来源」） */
  answer_refs?: { title: string; url?: string }[]
  /** 最近一次联网搜答案的时间 */
  answer_searched_at?: string
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
  /** 答案附件（已补签名 URL / 缩略图 URL） */
  answer_attachments?: (AnswerAttachment & { url?: string; thumb_url?: string })[]
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
