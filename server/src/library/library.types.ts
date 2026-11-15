/** D-068：资料库文件夹（无限层级，parent_id 自引用） */
export interface LibraryFolder {
  id: string
  user_id: string
  parent_id: string | null
  name: string
  created_at: string
}

export interface LibraryDoc {
  id: string
  user_id: string
  subject_id: string | null
  /** D-068：所属文件夹；null / undefined = 未归类（显示在根目录）。可选是因为 0033 未执行时该列不存在 */
  folder_id?: string | null
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
  /** D-068：归档到指定文件夹；不传 / null = 根目录（未归类） */
  folder_id?: string | null
}

export interface LibraryQuery {
  subject_id?: string
  keyword?: string
  /**
   * 按年级检索（`P-005`）：与题目同口径 —— 本年级优先，0 命中才向相邻年级扩散。
   * 不传 = 不按年级过滤（未选年级的用户照常全量返回，不拦截）。
   */
  grade?: number
  /**
   * D-068：按文件夹过滤。
   *  - 'root' / 空 ⇒ 只看未归类（folder_id is null）
   *  - 具体 id    ⇒ 只看该文件夹直属资料
   *  - undefined  ⇒ **不过滤**（默认全量，保证旧客户端与检索链路口径不变）
   */
  folder_id?: string
  page?: number
  page_size?: number
}
