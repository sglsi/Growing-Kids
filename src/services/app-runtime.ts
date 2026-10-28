// ============================================================
// 小程序运行时保障（2026-10-28 上线前补齐）
// ═══════════════════════════════════════════════════════════
// 三件在开发环境「看不出问题」、上线后必然出事的事：
//
// 1. **版本更新**：小程序没有 H5 那种刷新即生效。用户手里的旧包会一直用到
//    微信自己决定更新为止（通常 24h 内，但不可控），期间线上改了 bug、
//    改了接口，用户看到的仍是旧行为。必须主动检测并引导重启。
// 2. **网络状态**：局域网调试时后端永远可达；真机在电梯/地铁/弱网下请求
//    超时，界面只表现为「转圈」，用户不知道是断网还是功能坏了。
// 3. **错误可观测**：上线后拿不到用户手机上的 console。微信提供「实时日志」
//    （mp 后台 → 运维中心 → 实时日志），按 openid 可查，是唯一零后端改造
//    就能拿到线上报错的通道。
//
// 设计约束：
// - **零新依赖、零后端接口**：只调微信基础库，不引入上报服务。
// - **任何一步失败都不得阻塞启动**：全部 try/catch，最坏情况是没有监控。
// - **只在 weapp 生效**：编译期 TARO_ENV 常量让 H5/其它端的分支被裁掉。
// ============================================================
import Taro from '@tarojs/taro'

/** 微信实时日志（getRealtimeLogManager 返回值的最小可用面） */
interface RealtimeLogger {
  info?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
  setFilterMsg?: (msg: string) => void
}

/** 版本更新管理器（getUpdateManager 返回值的最小可用面） */
interface UpdateManager {
  onCheckForUpdate: (cb: (res: { hasUpdate: boolean }) => void) => void
  onUpdateReady: (cb: () => void) => void
  onUpdateFailed: (cb: () => void) => void
  applyUpdate: () => void
}

/** 取实时日志器（开发者工具与部分基础库没有该 API ⇒ 可能返回 undefined） */
function realtimeLogger(): RealtimeLogger | undefined {
  try {
    const f = (Taro as unknown as { getRealtimeLogManager?: () => RealtimeLogger }).getRealtimeLogManager
    const log = f?.()
    // 便于在 mp 后台「实时日志」按关键字过滤本小程序的报错
    log?.setFilterMsg?.('gk')
    return log
  } catch {
    return undefined
  }
}

let logger: RealtimeLogger | undefined

/** 写一条错误日志：实时日志优先，退回 console（开发态） */
function reportError(tag: string, detail: unknown): void {
  const msg = `[${tag}] ${typeof detail === 'string' ? detail : safeStringify(detail)}`
  try {
    logger?.error?.(msg)
  } catch {
    /* 忽略 */
  }
  if (!logger) console.error(msg)
}

function safeStringify(v: unknown): string {
  try {
    if (v instanceof Error) return `${v.name}: ${v.message}`
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

// ── 1. 版本更新 ─────────────────────────────────────────────
// 模块级 flag：避免 onUpdateReady 被回调多次时重复弹窗
let updatePrompted = false

/**
 * 检测新版本并引导重启。
 *
 * ⚠️ 仅在**正式版/体验版**生效：开发版与开发者工具不会触发更新，
 *    这是基础库行为，不是本代码的 bug（本地看不到弹窗属正常）。
 *
 * 选择「稍后」不强制——用户在做题中途被强制重启会丢输入，代价高于用旧版。
 */
export function checkAppUpdate(): void {
  if (TARO_ENV !== 'weapp') return
  try {
    const getManager = (Taro as unknown as { getUpdateManager?: () => UpdateManager }).getUpdateManager
    if (typeof getManager !== 'function') return
    const um = getManager()

    um.onCheckForUpdate((res) => {
      if (!res?.hasUpdate) return
      try {
        logger?.info?.('[update] 检测到新版本，等待下载')
      } catch {
        /* 忽略 */
      }
    })

    um.onUpdateReady(() => {
      if (updatePrompted) return
      updatePrompted = true
      Taro.showModal({
        title: '更新提示',
        content: '新版本已经准备好，重启后生效（当前数据不会丢失）。',
        confirmText: '立即重启',
        cancelText: '稍后',
        success: (r) => {
          if (r.confirm) um.applyUpdate()
        },
      })
    })

    um.onUpdateFailed(() => {
      // 下载失败（弱网/存储不足）：不打扰，下次冷启动会重试
      try {
        logger?.warn?.('[update] 新版本下载失败')
      } catch {
        /* 忽略 */
      }
    })
  } catch (err) {
    reportError('update', err)
  }
}

// ── 2. 网络状态 ─────────────────────────────────────────────
let lastConnected: boolean | null = null

/** 监听网络变化：断网/恢复各提示一次，且只在**真的变了**时提示 */
export function watchNetworkStatus(): void {
  if (TARO_ENV !== 'weapp') return
  try {
    const on = (Taro as unknown as {
      onNetworkStatusChange?: (cb: (res: { isConnected: boolean; networkType: string }) => void) => void
    }).onNetworkStatusChange
    if (typeof on !== 'function') return

    on((res) => {
      const isConnected = !!res?.isConnected
      if (lastConnected === isConnected) return
      lastConnected = isConnected
      if (!isConnected) {
        Taro.showToast({
          title: '网络已断开，联网功能暂时不可用',
          icon: 'none',
          duration: 2500,
        })
        try {
          logger?.warn?.(`[network] disconnected type=${res?.networkType}`)
        } catch {
          /* 忽略 */
        }
      } else {
        Taro.showToast({ title: '网络已恢复', icon: 'none', duration: 1500 })
      }
    })
  } catch (err) {
    reportError('network', err)
  }
}

// ── 3. 错误监控 ─────────────────────────────────────────────
/** 注册全局错误捕获（JS 异常 / 未处理 Promise / 页面不存在） */
export function installErrorMonitor(): void {
  if (TARO_ENV !== 'weapp') return
  try {
    const onError = (Taro as unknown as { onError?: (cb: (msg: string) => void) => void }).onError
    onError?.((msg) => reportError('onError', msg))

    const onReject = (Taro as unknown as {
      onUnhandledRejection?: (cb: (res: { reason: unknown }) => void) => void
    }).onUnhandledRejection
    onReject?.((res) => reportError('unhandledRejection', res?.reason))

    const onNotFound = (Taro as unknown as {
      onPageNotFound?: (cb: (res: { path?: string; query?: unknown }) => void) => void
    }).onPageNotFound
    onNotFound?.((res) => reportError('pageNotFound', res?.path))
  } catch (err) {
    console.error('[monitor] 注册失败', err)
  }
}

/**
 * 一次性挂载全部运行时保障（在 App 的 useEffect 里调用）。
 * 顺序无关，彼此独立；任一失败不影响其余。
 */
export function installAppRuntime(): void {
  if (TARO_ENV !== 'weapp') return
  logger = realtimeLogger()
  installErrorMonitor()
  watchNetworkStatus()
  checkAppUpdate()
}
