// ============================================================
// v4 统一数据模型 + 展示工具
// 依据：数据库重新设计-v4.md（统一 timeline_items + 多租户 + 匿名）
// 说明：旧的 Question / Material 双模型已合并为 TimelineItem
// ============================================================

// 学科
export interface Subject {
  id: string
  user_id: string
  name: string
  color: string
  sort_order: number
  created_at?: string
}

// 题目结构化内容（存于 timeline_items.content）
export interface QuestionContent {
  question?: string
  answer?: string
  solution?: string
  wrong_answer?: string
  /** 题目关联的图片 key（展示时后端补 image_urls） */
  images?: string[]
  status?: 'answered' | 'pending'
}

export type TimelineKind = 'image' | 'question'
export type TimelineScope = 'recent' | 'review'

// 统一收件箱条目（最近题目 / 复习本 / 资料图片 三合一）
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

  // 关联学科（后端 select 时附带）
  subjects?: Pick<Subject, 'id' | 'name' | 'color'> | null

  // 返回前端时后端补的签名 URL
  url?: string
  thumb_url?: string
  image_urls?: string[]
}

// 资料库文档（外部 PDF / Word / TXT 等）
export interface LibraryDoc {
  id: string
  user_id: string
  subject_id: string | null
  name: string
  file_key: string
  mime_type: string | null
  size_bytes: number | null
  source: string | null
  tags: string[]
  created_at: string
  url?: string
  subjects?: Pick<Subject, 'id' | 'name' | 'color'> | null
}

// 我的文档（汇总 Word / 合成 PDF）
export interface DocItem {
  id: string
  user_id: string
  title: string
  type: string
  file_key: string
  mime_type: string | null
  size_bytes: number | null
  meta?: Record<string, unknown>
  created_at: string
  url?: string
}

// 通用信封响应
export interface ApiEnvelope<T> {
  code: number
  msg: string
  data: T
}

// 分页结果
export interface Paged<T> {
  list: T[]
  total: number
  page: number
  page_size: number
}

// 首页概览统计
export interface Overview {
  total: number
  week_total: number
  pending: number
  review_total: number
  subject_stats: { subject_id: string; name: string; color: string; count: number; week_count: number }[]
  recent: TimelineItem[]
}

// ------------------------------------------------------------
// 学科颜色 → 完整 Tailwind 类名
// ⚠️ 必须为完整字符串，JIT 才能识别（不可拼接）
// 与后端 DEFAULT_SUBJECTS 的 color 取值一一对应
// ------------------------------------------------------------
export interface SubjectColorToken {
  badge: string
  bar: string
  dot: string
  soft: string
  text: string
}

export const SUBJECT_COLOR_MAP: Record<string, SubjectColorToken> = {
  'red-500': { badge: 'bg-red-50 text-red-700 border-red-200', bar: 'bg-red-500', dot: 'bg-red-500', soft: 'bg-red-50', text: 'text-red-700' },
  'blue-500': { badge: 'bg-blue-50 text-blue-700 border-blue-200', bar: 'bg-blue-500', dot: 'bg-blue-500', soft: 'bg-blue-50', text: 'text-blue-700' },
  'green-500': { badge: 'bg-green-50 text-green-700 border-green-200', bar: 'bg-green-500', dot: 'bg-green-500', soft: 'bg-green-50', text: 'text-green-700' },
  'purple-500': { badge: 'bg-purple-50 text-purple-700 border-purple-200', bar: 'bg-purple-500', dot: 'bg-purple-500', soft: 'bg-purple-50', text: 'text-purple-700' },
  'orange-500': { badge: 'bg-orange-50 text-orange-700 border-orange-200', bar: 'bg-orange-500', dot: 'bg-orange-500', soft: 'bg-orange-50', text: 'text-orange-700' },
  'teal-500': { badge: 'bg-teal-50 text-teal-700 border-teal-200', bar: 'bg-teal-500', dot: 'bg-teal-500', soft: 'bg-teal-50', text: 'text-teal-700' },
  'amber-500': { badge: 'bg-amber-50 text-amber-700 border-amber-200', bar: 'bg-amber-500', dot: 'bg-amber-500', soft: 'bg-amber-50', text: 'text-amber-700' },
  'cyan-500': { badge: 'bg-cyan-50 text-cyan-700 border-cyan-200', bar: 'bg-cyan-500', dot: 'bg-cyan-500', soft: 'bg-cyan-50', text: 'text-cyan-700' },
  'pink-500': { badge: 'bg-pink-50 text-pink-700 border-pink-200', bar: 'bg-pink-500', dot: 'bg-pink-500', soft: 'bg-pink-50', text: 'text-pink-700' },
  'gray-500': { badge: 'bg-gray-50 text-gray-600 border-gray-200', bar: 'bg-gray-500', dot: 'bg-gray-500', soft: 'bg-gray-50', text: 'text-gray-600' },
  // 兼容旧数据中可能出现的色值
  'rose-600': { badge: 'bg-rose-50 text-rose-700 border-rose-200', bar: 'bg-rose-600', dot: 'bg-rose-600', soft: 'bg-rose-50', text: 'text-rose-700' },
  'emerald-700': { badge: 'bg-emerald-50 text-emerald-700 border-emerald-200', bar: 'bg-emerald-700', dot: 'bg-emerald-700', soft: 'bg-emerald-50', text: 'text-emerald-700' },
  'violet-600': { badge: 'bg-violet-50 text-violet-700 border-violet-200', bar: 'bg-violet-600', dot: 'bg-violet-600', soft: 'bg-violet-50', text: 'text-violet-700' },
}

export function getSubjectColor(color?: string) {
  if (color && SUBJECT_COLOR_MAP[color]) return SUBJECT_COLOR_MAP[color]
  return SUBJECT_COLOR_MAP['gray-500']
}

// ------------------------------------------------------------
// 展示工具
// ------------------------------------------------------------
export function itemTitle(item: TimelineItem): string {
  if (item.title) return item.title
  if (item.kind === 'question') return item.content?.question || '（图片题目）'
  return '图片资料'
}

export function itemAnswered(item: TimelineItem): boolean {
  return item.kind === 'question' && !!item.content?.answer
}

export function itemStatus(item: TimelineItem): 'answered' | 'pending' {
  if (item.kind !== 'question') return 'answered'
  return item.content?.status || (item.content?.answer ? 'answered' : 'pending')
}

/** 跨端时间格式化 YYYY-MM-DD HH:mm */
export function formatTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 简短日期 M/D */
export function formatDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 跨端截断（小程序对 line-clamp 支持不稳定） */
export function truncate(s: string, n: number): string {
  if (!s) return ''
  return s.length > n ? `${s.slice(0, n)}…` : s
}
