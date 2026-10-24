// ============================================================
// 后端自动唤醒（2026-10-24 晚，思傅定）
// ═══════════════════════════════════════════════════════════
// 背景：看门狗（每分钟自查+重拉）已取消——它每分钟的 node 窗口和后端重启时
// OCR python sidecar 的窗口严重干扰用户操作。改为「前端驱动」：
//   小程序请求遇到连接类错误（ERR_CONNECTION_TIMED_OUT / errno 600001 等）
//   → 自动请求唤醒服务（wake-server，端口 3002）
//   → 后端没在跑就拉起并等待就绪（health 通）
//   → 自动重放原请求。用户无感知，且平时零定时任务、零窗口。
//
// 本模块零依赖 network.ts（避免循环 import），只用 Taro.request 直调。
// ============================================================
import Taro from '@tarojs/taro'

/** 唤醒服务地址：与后端同 host（PROJECT_DOMAIN 推导），端口 3002。
 *  IP 变了改 .env.local 重新编译（与后端同一约束，一起变）。 */
export function wakeBaseUrl(): string {
  const base = PROJECT_DOMAIN || ''
  if (!base) return '' // H5 未配置域名时无唤醒（走 devServer 代理，非真机场景）
  try {
    return base.replace(/:\d+$/, '') + ':3002'
  } catch {
    return ''
  }
}

/** 连接类错误判定：只在「根本摸不到后端」时唤醒。
 *  注意排除 invalid url / domain list（域名校验问题，唤醒无用）。 */
export function isConnError(err: unknown): boolean {
  const msg = String((err as { errMsg?: string })?.errMsg || err || '')
  if (/invalid url|domain list|not in domain/i.test(msg)) return false
  return /ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_NETWORK|ECONNREFUSED|ECONNRESET|errno: ?600001|net::ERR_/i.test(
    msg,
  )
}

// ── 单 flight + 结果缓存 + 失败冷却 ─────────────────────────
let inFlight: Promise<boolean> | null = null
let lastOkAt = 0 // 最近一次确认就绪的时间（30s 内直接放行，免打唤醒）
let lastFailAt = 0 // 最近一次唤醒失败（60s 冷却，避免每个失败请求都白等）

const OK_CACHE_MS = 30_000
const FAIL_COOLDOWN_MS = 60_000
const WAKE_POST_TIMEOUT = 8_000 // 唤醒 POST 上限（本地服务，8s 足够）
const WAIT_READY_TIMEOUT = 20_000 // 单轮 wait-ready（微信单请求 60s 上限内）
const WAIT_READY_ROUNDS = 2 // 最多 2 轮 = 40s（OCR 冷启动+模型加载慢，给足）

function req<T = unknown>(url: string, method: 'GET' | 'POST', timeout: number): Promise<T> {
  return new Promise((resolve, reject) => {
    Taro.request({
      url,
      method,
      timeout,
      header: { 'Content-Type': 'application/json' },
      success: (r) => {
        if (r.statusCode >= 200 && r.statusCode < 300) resolve(r.data as T)
        else reject(new Error(`wake http ${r.statusCode}`))
      },
      fail: reject,
    })
  })
}

/**
 * 确保后端可达：需要时唤醒并等待就绪。
 *  - 已就绪（30s 内确认过）→ 立即 true
 *  - 并发调用共享同一次唤醒（单 flight）：页面同时发多个请求只唤醒一次
 *  - 失败 60s 内不再尝试（防每个请求都白等 8s）
 */
export function ensureBackendAwake(): Promise<boolean> {
  if (Date.now() - lastOkAt < OK_CACHE_MS) return Promise.resolve(true)
  if (Date.now() - lastFailAt < FAIL_COOLDOWN_MS) return Promise.resolve(false)
  if (inFlight) return inFlight
  const base = wakeBaseUrl()
  if (!base) return Promise.resolve(false)

  inFlight = (async () => {
    try {
      // ① 已就绪？快速通道
      const st = await req<{ running?: boolean }>(`${base}/status`, 'GET', 5_000)
      if (st?.running) {
        lastOkAt = Date.now()
        return true
      }
      // ② 没在跑 → 拉起（唤醒服务内部去重/冷却，安全）
      const w = await req<{ status?: string }>(`${base}/wake`, 'POST', WAKE_POST_TIMEOUT)
      console.warn('[wake] 唤醒结果', w)
      // ③ 等待就绪（后端冷启动 + OCR 模型加载可能数十秒）
      for (let i = 0; i < WAIT_READY_ROUNDS; i++) {
        const r = await req<{ ready?: boolean }>(
          `${base}/wait-ready?timeout=${WAIT_READY_TIMEOUT / 1000}`,
          'GET',
          WAIT_READY_TIMEOUT + 5_000,
        )
        if (r?.ready) {
          lastOkAt = Date.now()
          console.warn('[wake] 后端已就绪，原请求将自动重放')
          return true
        }
      }
      lastFailAt = Date.now()
      return false
    } catch (e) {
      // 唤醒服务本身也不可达（电脑关机/服务未启动）：记冷却，交还原错误
      console.warn('[wake] 唤醒服务不可达', String((e as Error)?.message || e))
      lastFailAt = Date.now()
      return false
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/** 手动重置缓存（登出/切账号时调用，避免旧状态挡住新环境的唤醒） */
export function resetWakeState() {
  lastOkAt = 0
  lastFailAt = 0
}
