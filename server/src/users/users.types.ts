export interface User {
  id: string
  open_id: string | null
  nickname: string | null
  avatar_url: string | null
  is_anonymous: boolean
  expire_at: string | null
  created_at: string
}

/** 匿名用户保留时长：1 天 */
export const ANONYMOUS_TTL_MS = 24 * 60 * 60 * 1000
