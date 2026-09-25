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
  subjects?: { id: string; name: string; color: string } | null
}

export interface CreateLibraryDocDto {
  name: string
  file_key: string
  subject_id?: string | null
  mime_type?: string
  size_bytes?: number
  source?: string
  tags?: string[]
}

export interface LibraryQuery {
  subject_id?: string
  keyword?: string
  page?: number
  page_size?: number
}
