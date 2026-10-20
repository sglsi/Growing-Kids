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

/** 打开对象存储文件（文档/PDF），失败则复制链接 */
export function openStorageFile(url: string, isPdf = false) {
  Taro.showLoading({ title: '打开文档…' })
  Network.downloadFile({
    url,
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
    fail: () => {
      Taro.hideLoading()
      Taro.setClipboardData({ data: url })
      Taro.showToast({ title: '加载失败，地址已复制', icon: 'none' })
    },
  })
}
