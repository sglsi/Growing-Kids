// ============================================================
// 登录相关数据模型
// 依据：server-v4/src/auth/auth.types.ts
// 机制：wx.login() → code → 后端 code2session（AppSecret 只在服务端）
//      → openid → 找/建正式用户 → 可选迁移匿名数据 → 返回身份
// ============================================================

/** 与后端 users 表对齐的当前用户 */
export interface AuthUser {
  id: string
  open_id: string | null
  nickname: string | null
  avatar_url: string | null
  is_anonymous: boolean
  expire_at: string | null
  created_at: string
}

/** 登录时匿名数据迁移结果 */
export interface MigratedCount {
  subjects: number
  timeline_items: number
  library_docs: number
  documents: number
}

export interface LoginResult {
  user: AuthUser
  migrated: MigratedCount
}

export interface UpdateProfilePayload {
  nickname?: string
  avatar_url?: string
}

/** 本地登录态（持久化到 storage，用于「我的」页秒开与按钮态） */
export interface AuthState {
  userId: string
  nickname: string
  avatarUrl: string
  isAnonymous: boolean
}

export const AUTH_STORAGE_KEY = 'gk_auth_state'
