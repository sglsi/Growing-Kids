import { User } from '../users/users.types'

/** 微信 code2session 返回体 */
export interface WechatSession {
  openid?: string
  session_key?: string
  unionid?: string
  errcode?: number
  errmsg?: string
}

export interface LoginDto {
  /** wx.login() 拿到的临时凭证 */
  code: string
  /** 当前设备上的匿名 user_id（可选）；用于把匿名数据迁移到正式账号 */
  anonymous_id?: string
  /** 昵称 / 头像（可选） */
  nickname?: string
  avatar_url?: string
}

/** H5 扫码登录·手机端授权（扫码落地页调用） */
export interface QrAuthorizeDto {
  /** 二维码票据 token */
  token: string
  /** 手机端 wx.login() 拿到的临时凭证 */
  code: string
  /** H5 端当前匿名 user_id（可选）；授权成功即把它的数据迁到正式账号 */
  anonymous_id?: string
}

export interface UpdateProfileDto {
  nickname?: string
  avatar_url?: string
}

export interface LoginResult {
  user: User
  migrated: {
    subjects: number
    timeline_items: number
    library_docs: number
    documents: number
  }
}
