export interface Document {
  id: string
  user_id: string
  title: string
  /** docx: Word 汇总；pdf: 合成 PDF */
  type: string
  file_key: string
  mime_type: string | null
  size_bytes: number | null
  meta?: Record<string, unknown>
  created_at: string
  url?: string
}

export interface CreateDocumentInput {
  title: string
  type: string
  file_key: string
  mime_type?: string
  size_bytes?: number
  meta?: Record<string, unknown>
}

export interface DocumentQuery {
  type?: string
  keyword?: string
  page?: number
  page_size?: number
}
