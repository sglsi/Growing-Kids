/**
 * OpenCV（WASM）懒加载单例 —— Phase 3 共享基础设施。
 *
 * 为什么必须是单例 + 懒加载：
 *  - `@techstark/opencv-js` 的 WASM 初始化成本高（数十~数百 ms，常驻约 5-10MB 堆），
 *    在 1-2 核虚拟主机上绝不能重复初始化，也不能在 Nest 启动时同步阻塞加载。
 *  - 因此**不在模块顶层 import**，一律在函数内 `await getCV()`。
 *
 * 加载正确姿势（已实测）：`require('@techstark/opencv-js')` 返回的**可能是一个 Promise**
 *  （`instanceof Promise === true`），必须 await 它；否则等 `onRuntimeInitialized`。
 *
 * 降级：加载失败或超时（>8s）→ 置 cvFailed=true **永久禁用**，所有能力回退到纯 sharp 路径，
 * 业务不报错（对应方案 §九「WASM 可用性」风险的兜底）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type CV = any

let cvPromise: Promise<CV | null> | null = null
let cvFailed = false

const LOAD_TIMEOUT_MS = 8000

/** 环境开关：IMG_CV=off 可强制不加载（纯 sharp 环境）。 */
function cvDisabledByEnv(): boolean {
  return (process.env.IMG_CV || 'on').toLowerCase() === 'off'
}

/**
 * 取得（可能懒加载）的 OpenCV 实例；失败/禁用时返回 null（永不抛）。
 * 记忆化：同一进程只初始化一次。
 */
export function getCV(): Promise<CV | null> {
  if (cvFailed || cvDisabledByEnv()) return Promise.resolve(null)
  if (cvPromise) return cvPromise

  cvPromise = (async (): Promise<CV | null> => {
    try {
      // 动态 require：避免顶层 import 触发 WASM 同步加载
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod: any = require('@techstark/opencv-js')
      const ready = await new Promise<CV | null>((resolve) => {
        let settled = false
        const done = (v: CV | null) => {
          if (settled) return
          settled = true
          resolve(v)
        }
        const timer = setTimeout(() => done(null), LOAD_TIMEOUT_MS)
        // 情况一：模块本身是 Promise（实测 @techstark 常见形态）
        if (mod && typeof mod.then === 'function') {
          mod.then((cv: CV) => { clearTimeout(timer); done(cv) }, () => { clearTimeout(timer); done(null) })
          return
        }
        // 情况二：已经就绪
        if (mod && mod.Mat) { clearTimeout(timer); done(mod); return }
        // 情况三：挂 onRuntimeInitialized
        try {
          mod.onRuntimeInitialized = () => { clearTimeout(timer); done(mod) }
        } catch {
          clearTimeout(timer)
          done(null)
        }
      })

      if (!ready || !ready.Mat) {
        cvFailed = true
        console.warn('[image-cv] OpenCV WASM 未就绪，已永久降级到纯 sharp 路径')
        return null
      }
      console.log('[image-cv] OpenCV WASM 加载完成')
      return ready
    } catch (e) {
      cvFailed = true
      console.warn('[image-cv] OpenCV 加载失败，已永久降级到纯 sharp 路径：', (e as Error)?.message)
      return null
    }
  })()

  return cvPromise
}

/** 当前是否可用（不触发加载，仅看已知状态）。 */
export function cvAvailable(): boolean {
  return !cvFailed && !cvDisabledByEnv()
}

/** 释放某个 Mat 或 MatVector，忽略异常（CV 对象需显式 delete，防 WASM 堆泄漏）。 */
export function safeDelete(...objs: any[]): void {
  for (const o of objs) {
    try { if (o && typeof o.delete === 'function') o.delete() } catch { /* ignore */ }
  }
}
