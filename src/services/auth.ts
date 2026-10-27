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
import { buildHeaders, captureUserId, getUserId, setAuthToken, setUserId } from '@/services/net'
import { clearAllCache } from '@/services/cache'
import { clearAiSetting } from '@/services/ai-settings'
import { resetWakeState } from '@/services/wake'
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

/**
 * 扫码登录落身份：把后端返回的 user 写入本地（与 login() 内同一套动作）。
 * H5 扫码登录（qr-login-modal）授权成功后调用。
 */
export function applyLoginUser(user: AuthUser): void {
  setUserId(user.id)
  saveAuthState(toAuthState(user))
  // 与 login() 同一动作：身份切换后旧缓存作废（详见 cache.ts 的 userId 隔离设计）
  clearAllCache()
  clearAiSetting()
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
  // 身份令牌（服务端签发）：存本地，后续请求带 X-Auth-Token 防伪造身份头
  if (res.auth_token) setAuthToken(res.auth_token)
  saveAuthState(toAuthState(res.user))
  // 匿名 → 正式：userId 变了，旧匿名身份下的本地缓存全部作废（数据虽已迁移，
  // 缓存 key 按 userId 隔离，不清会残留一段无人认领的缓存；顺带防切换账号串数据）
  clearAllCache()
  clearAiSetting()
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
 * 后端无状态，前端清掉本地正式身份即可；下次请求会按设备找回/新建匿名身份
 * （匿名数据 30 天后由后端清理，不残留）
 */
export async function logout(): Promise<void> {
  try {
    await Network.request({ url: '/api/auth/logout', method: 'POST', header: buildHeaders() })
  } catch {
    /* 退出失败不阻塞本地清理 */
  }
  saveAuthState(null)
  try {
    // 身份与令牌一起清：token 不清的话，登出后请求仍带旧令牌，
    // 后端验签通过会把你当仍登录（思傅 2026-10-24 令牌方案的必要一步）
    Taro.removeStorageSync('gk_user_id')
    Taro.removeStorageSync('gk_auth_token')
  } catch {
    /* ignore */
  }
  // 本地读缓存（SWR）按 userId 隔离，登出即整体清空，防止下次登录看到上账号数据
  clearAllCache()
  clearAiSetting()
  // 唤醒状态一并重置：防止「上一个环境已确认就绪」的 30s 缓存挡住新环境的唤醒判定
  resetWakeState()
}

/**
 * 匿名可用 + 引导登录（思傅 2026-10-20 拍板策略）：
 * 保存类操作成功后调用——未登录则延迟弹一次轻提示（让位给成功 toast），
 * 不打断主流程；已登录则静默。匿名身份按设备保留 30 天（users TTL），
 * 登录后匿名数据自动迁移到微信账号。
 */
export function nudgeLoginIfAnonymous(): void {
  if (isLoggedIn()) return
  setTimeout(() => {
    Taro.showToast({ title: '登录微信，多端同步不丢失', icon: 'none' })
  }, 1600)
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
    // 关键修复：登录报错常含「未配置 WX_APPID」等较长说明，showToast 会被截断成
    // 「……」导致看不到根因。改用 showModal 完整展示，便于直接定位部署配置问题。
    Taro.showModal({
      title: '微信登录失败',
      content: msg,
      showCancel: false,
      confirmText: '知道了',
    })
    return false
  }
}
