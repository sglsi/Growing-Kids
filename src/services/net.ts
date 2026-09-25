// ============================================================
// 网络/身份辅助（与 services/api.ts 内部保持一致）
// 抽出来给组件/页面共用，避免各处重复处理 X-User-Id
// ============================================================
import Taro from '@tarojs/taro'
import { Network } from '@/network'

export const USER_ID_KEY = 'gk_user_id'

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

/** 构造带身份头的请求头 */
export function buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const uid = getUserId()
  return uid ? { ...extra, 'X-User-Id': uid } : { ...extra }
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
