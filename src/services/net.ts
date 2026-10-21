// ============================================================
// 网络/身份辅助（与 services/api.ts 内部保持一致）
// 抽出来给组件/页面共用，避免各处重复处理 X-User-Id
// ============================================================
import Taro from '@tarojs/taro'
import { Network } from '@/network'

export const USER_ID_KEY = 'gk_user_id'
export const DEVICE_ID_KEY = 'gk_device_id'

export function getUserId(): string {
  try {
    return Taro.getStorageSync(USER_ID_KEY) || ''
  } catch {
    return ''
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
  const headers: Record<string, string> = { ...extra }
  if (uid) headers['X-User-Id'] = uid
  if (did) headers['X-Device-Id'] = did
  return headers
}

/** 从响应中捕获匿名身份回传头 */
export function captureUserId(res: { header?: Record<string, string> }) {
  try {
    const headers = res?.header || {}
    const uid = headers['X-User-Id'] || headers['x-user-id']
    if (uid) setUserId(uid)
  } catch {
    /* ignore */
  }
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
