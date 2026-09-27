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
}

export interface LibraryQuery {
  subject_id?: string
  keyword?: string
  page?: number
  page_size?: number
}
