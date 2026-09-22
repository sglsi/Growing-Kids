export type MaterialType = 'image' | 'document'

export interface Material {
  id: string
  name: string
  type: MaterialType
  file_key: string
  url: string
  mime_type: string
  size_bytes: number
  subject_id: string | null
  used: boolean
  created_at: string
}

export interface CreateMaterialInput {
  name: string
  type: MaterialType
  file_key: string
  url: string
  mime_type?: string
  size_bytes?: number
  subject_id?: string | null
  used?: boolean
}

export interface MaterialQuery {
  type?: MaterialType
  subject_id?: string
  keyword?: string
  page?: number
  page_size?: number
}
