export interface LibraryDoc {
  id: string
  user_id: string
  subject_id: string | null
  name: string
  file_key: string
  thumb_key: string | null
  mime_type: string | null
  width: number | null
  height: number | null
  size_bytes: number | null
  file_hash: string | null
  source: string | null
  tags: string[]
  /**
   * 年级快照（migrations/0025，`P-005`）：1..12，null = 未标注（存量资料）。
   * 与题目同口径：写入时取用户当时年级，升学不改写。可选是因为 0025 未执行时该列不存在。
   */
  grade?: number | null
  created_at: string
  url?: string
  thumb_url?: string
  subjects?: { id: string; name: string; color: string } | null
}

export interface CreateLibraryDocDto {
  name: string
  file_key: string
  thumb_key?: string
  subject_id?: string | null
  mime_type?: string
  width?: number
  height?: number
  size_bytes?: number
  file_hash?: string
  source?: string
  tags?: string[]
  /** 年级快照；不传 ⇒ 取用户当前年级（`P-005` 决策 4） */
  grade?: number | null
}

export interface LibraryQuery {
  subject_id?: string
  keyword?: string
  /**
   * 按年级检索（`P-005`）：与题目同口径 —— 本年级优先，0 命中才向相邻年级扩散。
   * 不传 = 不按年级过滤（未选年级的用户照常全量返回，不拦截）。
   */
  grade?: number
  page?: number
  page_size?: number
}
