// ============================================================
// 身份令牌引导（2026-10-27 严格令牌化的前端配套）
//
// 背景：后端严格模式下业务请求只认 `X-Auth-Token`（裸 X-User-Id 一律不采信，
// 见 GK-OPS-18 R-技术-09）。首次启动的小程序手上没有令牌，会收到
// 401 + `data.reason = NEED_AUTH_TOKEN`。此时用 `X-Device-Id` 换一张令牌：
//   POST /api/auth/anonymous
// 同一设备永远换回同一匿名身份（device_id 唯一索引），不会每次新建号。
//
// ⚠️ 本文件刻意**不 import `@/services/net`**：net.ts 依赖 Network，Network 又要
// 调本文件，三方成环在 Taro 打包后会出现「某个导出 undefined」的诡异问题。
// 因此这里自己读写 storage（key 与 net.ts 保持一致，改动需同步两处）。
// ============================================================
import Taro from '@tarojs/taro'

const USER_ID_KEY = 'gk_user_id'
const DEVICE_ID_KEY = 'gk_device_id'
const AUTH_TOKEN_KEY = 'gk_auth_token'

function read(key: string): string {
  try {
    return Taro.getStorageSync(key) || ''
  } catch {
    return ''
  }
}

function write(key: string, v: string) {
  try {
    Taro.setStorageSync(key, v)
  } catch {
    /* ignore */
  }
}

/** 当前存储的令牌（可能为空） */
export function currentToken(): string {
  return read(AUTH_TOKEN_KEY)
}

/** 设备锚点：一次生成、永存（与 net.ts 同逻辑） */
export function ensureDeviceId(): string {
  let id = read(DEVICE_ID_KEY)
  if (!id) {
    id = 'dev_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
    write(DEVICE_ID_KEY, id)
  }
  return id
}

function baseUrl(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  const base = PROJECT_DOMAIN || (TARO_ENV === 'h5' ? '' : 'http://127.0.0.1:3001')
  return `${base}${url}`
}

/** 单飞：并发 10 个请求同时 401 时只换一次令牌，避免把设备号刷出一堆匿名账号 */
let inflight: Promise<string> | null = null

/**
 * 换取（或直接返回已有的）匿名身份令牌。
 * @returns 令牌字符串；失败返回 ''（调用方应放弃重试，按原错误处理）
 */
export function ensureAuthToken(): Promise<string> {
  const existing = currentToken()
  if (existing) return Promise.resolve(existing)
  if (inflight) return inflight

  inflight = new Promise<string>((resolve) => {
    const deviceId = ensureDeviceId()
    if (!deviceId) {
      resolve('')
      return
    }
    // 必须直连 Taro.request（不能用 Network）：本文件被 Network 依赖（401 换令牌），
    // 反过来 import Network 会成环，打包后可能出现 Network 为 undefined
    // （Taro 编译到 CJS，环引用拿到的是半成品）。此处属经评估的例外。
    // eslint-disable-next-line no-restricted-properties
    Taro.request({
      url: baseUrl('/api/auth/anonymous'),
      method: 'POST',
      header: { 'X-Device-Id': deviceId, 'Content-Type': 'application/json' },
      data: {},
      success: (res) => {
        const body = res.data as { data?: { auth_token?: string; user_id?: string } }
        const token = body?.data?.auth_token || ''
        const uid = body?.data?.user_id || ''
        if (uid) write(USER_ID_KEY, uid)
        if (token) write(AUTH_TOKEN_KEY, token)
        if (!token) console.warn('[auth-bootstrap] 换令牌失败：响应里没有 auth_token', res.statusCode)
        resolve(token)
      },
      fail: (e) => {
        console.warn('[auth-bootstrap] 换令牌请求失败', e?.errMsg || e)
        resolve('')
      },
    })
  }).finally(() => {
    inflight = null
  })

  return inflight
}

/** 令牌失效时清掉本地（保留 device id：靠它换回同一匿名身份） */
export function clearAuthToken() {
  try {
    Taro.removeStorageSync(AUTH_TOKEN_KEY)
  } catch {
    /* ignore */
  }
}
