// ============================================================
// 网络/身份辅助（与 services/api.ts 内部保持一致）
// 抽出来给组件/页面共用，避免各处重复处理 X-User-Id
// ============================================================
import Taro from '@tarojs/taro'
import { Network } from '@/network'

export const USER_ID_KEY = 'gk_user_id'
export const DEVICE_ID_KEY = 'gk_device_id'
/** 身份令牌（服务端 HMAC 签发，30 天，后端每次响应滑动续签） */
export const AUTH_TOKEN_KEY = 'gk_auth_token'

export function getUserId(): string {
  try {
    return Taro.getStorageSync(USER_ID_KEY) || ''
  } catch {
    return ''
  }
}

export function getAuthToken(): string {
  try {
    return Taro.getStorageSync(AUTH_TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

export function setAuthToken(token?: string) {
  if (!token) return
  try {
    if (getAuthToken() !== token) Taro.setStorageSync(AUTH_TOKEN_KEY, token)
  } catch {
    /* ignore */
  }
}

export function setUserId(id?: string) {
  if (!id) return
  try {
    if (getUserId() !== id) Taro.setStorageSync(USER_ID_KEY, id)
  } catch {
    /* ignore */
  }
}

/**
 * 设备标识：一次生成、永存 storage。「同一设备 = 同一身份」的锚点
 * （思傅 2026-10-20 拍板方案 A）：匿名 user TTL 过期/本地 gk_user_id 丢失后，
 * 后端凭 X-Device-Id 找回同一匿名身份，旧数据不再「看不见」。
 */
export function getDeviceId(): string {
  try {
    let id = Taro.getStorageSync(DEVICE_ID_KEY)
    if (!id) {
      id = 'dev_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
      Taro.setStorageSync(DEVICE_ID_KEY, id)
    }
    return id as string
  } catch {
    return ''
  }
}

/** 构造带身份头的请求头 */
export function buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const uid = getUserId()
  const did = getDeviceId()
  const token = getAuthToken()
  const headers: Record<string, string> = { ...extra }
  if (uid) headers['X-User-Id'] = uid
  if (did) headers['X-Device-Id'] = did
  // 令牌优先：后端验签通过才认 uid，防伪造身份头（2026-10-24，思傅方案 A）
  if (token) headers['X-Auth-Token'] = token
  return headers
}

/**
 * 从响应中捕获身份回传头：X-User-Id（匿名建号回传）与 X-Auth-Token（滑动续签）。
 * 两个都存本地，后者每次被后端刷新，覆盖即可保持 30 天不过期。
 */
export function captureUserId(res: { header?: Record<string, string> }) {
  try {
    const headers = res?.header || {}
    const uid = headers['X-User-Id'] || headers['x-user-id']
    if (uid) setUserId(uid)
    const token = headers['X-Auth-Token'] || headers['x-auth-token']
    if (token) setAuthToken(token)
  } catch {
    /* ignore */
  }
}

/**
 * 对象存储 key → 可直接给 `<Image src>` 用的绝对地址。
 *
 * 为什么要它（思傅 2026-10-29「选了微信头像、提示保存中、过一会没变化」）：
 * 后端 `users.avatar_url` 存的是**内容寻址 key**（`blobs/be/…/display.webp`），
 * 不是 URL——签名 URL 24h 就失效，不能存。但页面直接拿 key 当 src 是裂图，
 * 于是头像区一直是空的（保存其实早成功了）。
 *
 * `/api/storage/files/*` 在 local 与 supabase 两种驱动下都可用：本地盘直接流盘，
 * supabase 由服务端下载后回传（同 openStorageFile，避免手机跨境直连）。
 */
export function storageFileUrl(key?: string | null): string {
  const k = (key || '').trim()
  if (!k) return ''
  if (/^https?:\/\//i.test(k)) return k
  const base = PROJECT_DOMAIN || (TARO_ENV === 'h5' ? '' : 'http://127.0.0.1:3001')
  return `${base}/api/storage/files/${k}`
}

export function isPdfFile(mimeOrUrl: string): boolean {
  return /pdf/i.test(mimeOrUrl)
}

/**
 * 打开对象存储文件（文档/PDF），失败则复制链接。
 *
 * @param fileKey 有则走后端代理 `/api/storage/files/{key}`（手机→局域网后端→对象存储），
 *   避开手机直连 Supabase（新加坡）的跨境慢网——2026-10-21 真机实测直连
 *   downloadFile 60s 超时（reportTask costTime too long: 60022ms）。
 *   无 key 才直连原 URL。复制兜底始终用原公网 URL（浏览器可开）。
 */
export function openStorageFile(url: string, isPdf = false, fileKey?: string) {
  Taro.showLoading({ title: '打开文档…' })
  const dlUrl = fileKey ? `/api/storage/files/${fileKey}` : url
  // ⚠️ 必须显式 timeout：微信 downloadFile 默认 60s，跨境/慢网下干等太久。
  // 30s 失败后走「复制链接」兜底，比干等 60s 体验好；失败时打 URL 便于后续诊断。
  Network.downloadFile({
    url: dlUrl,
    timeout: 30000,
    success: (d) => {
      Taro.hideLoading()
      Taro.openDocument({
        filePath: d.tempFilePath,
        fileType: isPdf ? 'pdf' : 'docx',
        showMenu: true,
        fail: () => {
          Taro.setClipboardData({ data: url })
          Taro.showToast({ title: '无法打开，地址已复制', icon: 'none' })
        },
      })
    },
    fail: (e) => {
      Taro.hideLoading()
      console.warn('[openStorageFile] 下载失败', { url: dlUrl, err: e?.errMsg || e })
      Taro.setClipboardData({ data: url })
      Taro.showToast({ title: '加载失败，地址已复制', icon: 'none' })
    },
  })
}
