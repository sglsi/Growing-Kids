export interface Document {
  id: string
  title: string
  /** docx: Word 汇总；pdf: 合成 PDF */
  type: string
  file_key: string
  url: string
  mime_type: string
  size_bytes: number
  created_at: string
}

export interface CreateDocumentInput {
  title: string
  type: string
  file_key: string
  url: string
  mime_type?: string
  size_bytes?: number
}

export interface DocumentQuery {
  type?: string
  keyword?: string
  page?: number
  page_size?: number
}