export interface User {
  id: string
  open_id: string | null
  device_id?: string | null
  nickname: string | null
  avatar_url: string | null
  is_anonymous: boolean
  expire_at: string | null
  created_at: string
  /**
   * 角色（0017 新增）：`user` | `admin`。
   * 只有 admin 能写全局表（`knowledge_articles`），见 OPS-18 `R-技术-08`。
   * 早期行/未跑 0017 的环境可能取不到该字段 ⇒ 一律按 `user` 处理（fail-closed）。
   */
  role?: 'user' | 'admin'
}

/** 匿名用户保留时长：30 天（deviceId 持久化后按设备认身份，见 0011 migration） */
export const ANONYMOUS_TTL_MS = 30 * 24 * 60 * 60 * 1000
