// ============================================================
// 认证服务：微信登录 / 退出 / 当前用户 / 更新资料
// 依据：server-v4/src/auth/auth.controller.ts
//
// 关键点（务必遵守微信规范）：
//  - 前端只用 wx.login() 拿 code，绝不直接调 api.weixin.qq.com（该域名不可加入
//    request 合法域名，且 AppSecret 必须仅存服务端）
//  - code 一次性、5 分钟有效，拿到后立刻 POST 给 /api/auth/login
//  - 登录成功后后端返回正式用户 user.id，覆盖本地 X-User-Id（原匿名 id 失效之
//    前已在后端完成数据迁移）
// ============================================================

import Taro from '@tarojs/taro'
import { Network } from '@/network'
import { buildHeaders, captureUserId, getUserId, setUserId } from '@/services/net'
import type {
  ApiEnvelope,
} from '@/types'
import {
  AUTH_STORAGE_KEY,
  type AuthState,
  type AuthUser,
  type LoginResult,
  type UpdateProfilePayload,
} from '@/types/auth'

export type { AuthState, AuthUser, LoginResult, UpdateProfilePayload }
export { getUserId }

// ------------------------------------------------------------
// 本地登录态
// ------------------------------------------------------------

/** 读取本地登录态；无则返回 null */
export function getAuthState(): AuthState | null {
  try {
    const raw = Taro.getStorageSync(AUTH_STORAGE_KEY)
    if (!raw) return null
    const state = (typeof raw === 'string' ? JSON.parse(raw) : raw) as AuthState
    return state?.userId ? state : null
  } catch {
    return null
  }
}

/** 是否已登录（正式账号，非匿名） */
export function isLoggedIn(): boolean {
  const s = getAuthState()
  return !!s && !s.isAnonymous
}

function saveAuthState(state: AuthState | null) {
  try {
    if (!state) Taro.removeStorageSync(AUTH_STORAGE_KEY)
    else Taro.setStorageSync(AUTH_STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* ignore */
  }
}

/** 由后端用户对象生成本地态（匿名用户也存，用于展示「未登录」） */
export function toAuthState(user: AuthUser): AuthState {
  return {
    userId: user.id,
    nickname: user.nickname || '',
    avatarUrl: user.avatar_url || '',
    isAnonymous: !!user.is_anonymous,
  }
}

// ------------------------------------------------------------
// wx.login 封装（Promise 化）
// ------------------------------------------------------------
function wxLogin(): Promise<string> {
  return new Promise((resolve, reject) => {
    Taro.login({
      success: (res) => {
        if (res.code) resolve(res.code)
        else reject(new Error('未获取到登录凭证（code）'))
      },
      fail: (err) => reject(new Error(err.errMsg || '微信登录失败')),
    })
  })
}

// ------------------------------------------------------------
// 统一解包（与 api.ts 一致，同时捕获身份回传头）
// ------------------------------------------------------------
async function unwrap<T>(p: Promise<Taro.request.SuccessCallbackResult<any>>): Promise<T> {
  const res = await p
  captureUserId(res)
  const body = res.data as ApiEnvelope<T>
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(body?.msg || `请求失败(${res.statusCode})`)
  }
  if (body?.code !== undefined && body.code !== 200) {
    throw new Error(body.msg || '请求失败')
  }
  return body.data
}

// ------------------------------------------------------------
// 登录
// ------------------------------------------------------------

/**
 * 微信登录（后端换 openid）
 *
 * @param profile 可选：用户授权拿到的昵称 / 头像（wx.getUserProfile 已收紧，
 *                通常由用户手动填写），传了后端会一并写入 users 表
 * @returns 登录结果（含正式用户 + 匿名数据迁移条数）
 */
export async function login(profile?: UpdateProfilePayload): Promise<LoginResult> {
  const code = await wxLogin()
  const anonymousId = getUserId() // 迁移用：当前设备上的匿名身份

  const res = await unwrap<LoginResult>(
    Network.request({
      url: '/api/auth/login',
      method: 'POST',
      header: buildHeaders({ 'Content-Type': 'application/json' }),
      data: { code, anonymous_id: anonymousId || undefined, ...profile },
    }),
  )

  // 关键：把身份切换到正式用户，后续所有请求都用它
  setUserId(res.user.id)
  saveAuthState(toAuthState(res.user))
  return res
}

/** 拉取当前用户（用本地 X-User-Id 校验登录态是否仍有效） */
export async function fetchMe(): Promise<AuthUser> {
  const user = await unwrap<AuthUser>(
    Network.request({ url: '/api/auth/me', method: 'GET', header: buildHeaders() }),
  )
  saveAuthState(toAuthState(user))
  return user
}

/** 更新昵称 / 头像 */
export async function updateProfile(payload: UpdateProfilePayload): Promise<AuthUser> {
  const user = await unwrap<AuthUser>(
    Network.request({
      url: '/api/auth/profile',
      method: 'PATCH',
      header: buildHeaders({ 'Content-Type': 'application/json' }),
      data: payload,
    }),
  )
  saveAuthState(toAuthState(user))
  return user
}

/**
 * 退出登录
 * 后端无状态，前端清掉本地正式身份即可；下次请求会自动获得新的匿名身份
 * （匿名数据 1 天后由后端清理，不残留）
 */
export async function logout(): Promise<void> {
  try {
    await Network.request({ url: '/api/auth/logout', method: 'POST', header: buildHeaders() })
  } catch {
    /* 退出失败不阻塞本地清理 */
  }
  saveAuthState(null)
  try {
    Taro.removeStorageSync('gk_user_id')
  } catch {
    /* ignore */
  }
}

/** 弹出登录（首页顶部 / 我的页共用）；返回是否登录成功 */
export async function promptLogin(): Promise<boolean> {
  try {
    Taro.showLoading({ title: '登录中…' })
    const res = await login()
    Taro.hideLoading()
    const m = res.migrated
    const moved = m.subjects + m.timeline_items + m.library_docs + m.documents
    Taro.showToast({
      title: moved > 0 ? `登录成功，已同步 ${moved} 条记录` : '登录成功',
      icon: 'success',
    })
    return true
  } catch (e) {
    Taro.hideLoading()
    const msg = e instanceof Error ? e.message : '登录失败'
    Taro.showToast({ title: msg, icon: 'none' })
    return false
  }
}
