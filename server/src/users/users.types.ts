export interface User {
  id: string
  open_id: string | null
  device_id?: string | null
  nickname: string | null
  avatar_url: string | null
  is_anonymous: boolean
  expire_at: string | null
  created_at: string
}

/** 匿名用户保留时长：30 天（deviceId 持久化后按设备认身份，见 0011 migration） */
export const ANONYMOUS_TTL_MS = 30 * 24 * 60 * 60 * 1000
