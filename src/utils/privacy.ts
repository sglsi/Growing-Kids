import Taro from '@tarojs/taro'

/**
 * 小程序隐私保护指引授权枢纽（2026-10-26 新增）
 *
 * ## 为什么需要
 * 2023-10 起，凡是调用隐私接口（本项目用到 `chooseMedia` / `chooseImage`，
 * 用于拍照录题、相册归档、答案附件）的小程序，都必须：
 *   ① 在 mp 后台「设置 → 服务内容声明 → 用户隐私保护指引」声明收集的隐私类型；
 *   ② app.json 打开 `"__usePrivacyCheck__": true`；
 *   ③ 首次触发隐私接口时弹出自定义弹窗，由用户明确同意后才能继续。
 * 否则**非开发版环境（体验版/正式版）调用直接失败**，且提审会被驳回。
 * 开发版因 `urlCheck:false` + 开发者工具豁免而毫无感知——这正是之前一直没暴露的原因。
 *
 * ## 为什么用全局监听而不是每个调用点各写一遍
 * `Taro.onNeedPrivacyAuthorization` 是微信官方推荐的接入方式：任意隐私接口被调用时
 * 基础库会先挂起该调用、触发本事件，开发者弹窗、用户表态后调 `resolve()`
 * 放行或拒绝。**一处注册、全站生效**——识别页/资料库/记忆/答案附件 4 处调用点
 * 都不用改，也不会有漏网的新调用点。
 *
 * ⚠️ 必须在隐私接口调用**之前**注册 ⇒ 在 App 根组件挂载时安装。
 */

type PrivacyResolve = (option: {
  event: 'exposureAuthorization' | 'agree' | 'disagree'
  /** event='agree' 时必填，基础库会校验这个 button 是否真的被点过 */
  buttonId?: string
}) => void

/** 同意按钮的 DOM id：resolve 时要回传同一个值，基础库据此核验点击真实性 */
export const AGREE_BUTTON_ID = 'gk-agree-privacy-btn'

let installed = false
/** 当前挂起的那次隐私授权（同一时刻只可能有一次，故单个足够） */
let pendingResolve: PrivacyResolve | null = null
/** 需要弹窗时的订阅者（当前只有 PrivacyGate 一个） */
const subscribers = new Set<(need: boolean) => void>()

// ---------------- 隐私 API 的取用方式（2026-10-29 修正） ----------------
//
// ⚠️ **Taro 4.1.9 运行时没有隐私 API**：`@tarojs/taro` 里
// `onNeedPrivacyAuthorization` / `getPrivacySetting` / `openPrivacyContract` /
// `requirePrivacyAuthorize` **只存在于 types（.d.ts），没有 JS 实现**，
// 所以 `Taro.onNeedPrivacyAuthorization` 在真机上是 `undefined`。
//
// 后果极其隐蔽：`typeof Taro.onNeedPrivacyAuthorization === 'function'` 恒为 false
// ⇒ `installPrivacyListener()` 直接 return，监听从未注册 ⇒ 隐私接口（拍照/相册/
// 选文件/录音）被基础库**永久挂起**，Promise 既不 resolve 也不 reject
// ⇒ 用户看到的就是「点了按钮毫无反应，连报错都没有」。
//
// 官方解法有两条：① `@tarojs/plugin-inject` 注入 syncApis；② 直接走原生 `wx`。
// 这里选 ②：不新增构建插件（少一层编译期魔法），且 H5 端 `wx` 不存在时自动回落。
// 取自 `globalThis.wx` 而非全局变量 `wx`，可避免 eslint no-undef 与 H5 端引用报错。

type WxPrivacyApi = {
  onNeedPrivacyAuthorization?: (listener: PrivacyResolve) => void
  getPrivacySetting?: (opt: {
    success?: (res: { needAuthorization?: boolean; privacyContractName?: string }) => void
    fail?: (e: unknown) => void
  }) => void
  openPrivacyContract?: (opt?: { success?: () => void; fail?: (e: unknown) => void }) => void
  requirePrivacyAuthorize?: (opt?: { success?: () => void; fail?: (e: unknown) => void }) => void
}

type WxOnNeedPrivacy = (listener: (resolve: PrivacyResolve) => void) => void

function getWx(): WxPrivacyApi | null {
  const g = globalThis as unknown as { wx?: WxPrivacyApi }
  const wx = g.wx
  return wx && typeof wx === 'object' ? wx : null
}

/**
 * 取隐私 API：**原生优先**，Taro 仅作兜底（将来 Taro 补了实现也不必改这里）。
 * 不用泛型索引签名：泛型在 union 上会推断成交叉类型，导致回调参数类型错乱。
 */
function nativeApi<T>(name: string): T | null {
  const wx = getWx() as Record<string, unknown> | null
  const fromWx = wx?.[name]
  if (typeof fromWx === 'function') return fromWx as T
  const fromTaro = (Taro as unknown as Record<string, unknown>)[name]
  if (typeof fromTaro === 'function') return fromTaro as T
  return null
}

/**
 * 注册全局隐私授权监听。重复调用安全（幂等）。
 * H5 / 抖音端无此 API ⇒ 直接跳过，不影响其他端。
 */
export function installPrivacyListener(): void {
  if (installed) return
  const onNeed =
    nativeApi<WxOnNeedPrivacy>('onNeedPrivacyAuthorization') as WxOnNeedPrivacy | null
  if (!onNeed) {
    // 走到这里说明 wx 也不可用（H5/抖音端），或基础库过低。
    // 打日志而不是静默：真机上「隐私接口点了没反应」第一个要查的就是这行。
    console.warn('[privacy] 无 onNeedPrivacyAuthorization（原生与 Taro 均不可用），将退回平台默认弹窗')
    return
  }
  installed = true
  try {
    onNeed((resolve: PrivacyResolve) => {
      pendingResolve = resolve
      subscribers.forEach((fn) => fn(true))
    })
  } catch (e) {
    // best-effort：监听失败不能阻塞启动；届时隐私接口会直接失败，日志可查
    console.error('[privacy] 注册隐私授权监听失败', e)
  }
}

/** 订阅「需要授权」事件，返回取消订阅函数 */
export function onNeedPrivacy(fn: (need: boolean) => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

/**
 * 弹窗已展示 → 告知平台（不影响后续 agree/disagree）。
 * 这一步会把「我们确实向用户说明了隐私」这件事上报给微信，建议在弹窗 mount 后调用。
 */
export function notifyExposure(): void {
  try {
    pendingResolve?.({ event: 'exposureAuthorization' })
  } catch (e) {
    console.error('[privacy] 曝光通知失败', e)
  }
}

/**
 * 取出并清空挂起的 resolve。
 * ⚠️ 必须「取出即清空」：一次授权只对应一次挂起调用，
 *    重复 resolve 会让基础库报错「resolve is not a function」。
 */
export function consumePending(): PrivacyResolve | null {
  const r = pendingResolve
  pendingResolve = null
  return r
}

/** 打开官方隐私保护指引（mp 后台配置的那份） */
export function openPrivacyContract(): void {
  const open = nativeApi<NonNullable<WxPrivacyApi['openPrivacyContract']>>('openPrivacyContract')
  if (!open) {
    Taro.showToast({ title: '当前环境不支持查看隐私指引', icon: 'none' })
    return
  }
  try {
    open({ fail: (e) => console.error('[privacy] 打开隐私指引失败', e) })
  } catch (e) {
    console.error('[privacy] 打开隐私指引异常', e)
  }
}

/**
 * 主动查询当前是否还需授权（用于「设置页」显示进度，或隐私接口调用前的预检）。
 * H5 / 未声明隐私类型时返回 null（= 无从判断，按「不需要」处理）。
 */
export function queryNeedAuthorization(): Promise<boolean | null> {
  const getSetting = nativeApi<NonNullable<WxPrivacyApi['getPrivacySetting']>>('getPrivacySetting')
  if (!getSetting) return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      getSetting({
        success: (res) => resolve(!!res?.needAuthorization),
        fail: () => resolve(null),
      })
    } catch {
      resolve(null)
    }
  })
}

// ---------------- 调用隐私接口前的主动授权（2026-10-29 新增） ----------------

/**
 * ## 为什么需要「主动」而不是等基础库回调
 * 被动模式依赖两个前提同时成立：① 我们的 `onNeedPrivacyAuthorization` 真的注册上了；
 * ② 平台侧隐私指引已配置好、弹窗能渲染出来。任一条不成立，调用就会**静默挂起**——
 * 用户看到的是「点了没反应」，日志里什么都没有（不 reject，所以 catch 也进不去）。
 *
 * 主动模式 `wx.requirePrivacyAuthorize` 把这条链路变成**有返回值**的：
 *   - 已同意 → 直接 success
 *   - 未同意 → 触发我们的弹窗 → 同意/拒绝都有明确 success/fail
 *   - 平台没配指引 → fail（errno 112）⇒ 我们能明确告诉用户「不是你的问题，是小程序没配好」
 *
 * 所以每个隐私接口调用点都先 `if (!(await guardPrivacy('选择图片'))) return`。
 */
export type PrivacyAuthResult = 'ok' | 'denied' | 'not-configured' | 'unavailable'

/** 隐私状态查询的超时（毫秒）。超时按「不阻塞用户」处理，放行并由后续接口自己报错。 */
const PRIVACY_PROBE_TIMEOUT = 3000

/**
 * 探针失效标记：一旦 `getPrivacySetting` 超时过一次，后续直接放行不再探。
 * 否则每次点按都要白等 3 秒——把「点了没反应」换成「点了反应很慢」，等于没解决。
 */
let probeBroken = false

export function ensurePrivacyAuthorized(): Promise<PrivacyAuthResult> {
  const getSetting = nativeApi<NonNullable<WxPrivacyApi['getPrivacySetting']>>('getPrivacySetting')
  // 环境不支持（H5 / 低版本基础库）⇒ 交给原接口行为，不在这里拦
  if (!getSetting) return Promise.resolve('unavailable')
  if (probeBroken) return Promise.resolve('unavailable')

  return new Promise((resolve) => {
    let settled = false
    const finish = (r: PrivacyAuthResult) => {
      if (settled) return
      settled = true
      resolve(r)
    }
    // 看门狗：getPrivacySetting 本身也可能因平台异常不回调，不能把用户卡在这里
    const timer = setTimeout(() => {
      probeBroken = true
      console.warn('[privacy] getPrivacySetting 超时，后续调用直接放行')
      finish('unavailable')
    }, PRIVACY_PROBE_TIMEOUT)
    const done = (r: PrivacyAuthResult) => {
      clearTimeout(timer)
      finish(r)
    }

    try {
      getSetting({
        success: (res) => {
          if (!res?.needAuthorization) return done('ok')
          const require = nativeApi<NonNullable<WxPrivacyApi['requirePrivacyAuthorize']>>('requirePrivacyAuthorize')
          if (!require) return done('unavailable')
          try {
            require({
              success: () => done('ok'),
              fail: (e) => done(isPrivacyNotDeclared(e) ? 'not-configured' : 'denied'),
            })
          } catch (e) {
            console.error('[privacy] requirePrivacyAuthorize 异常', e)
            done('unavailable')
          }
        },
        fail: () => done('unavailable'),
      })
    } catch (e) {
      console.error('[privacy] getPrivacySetting 异常', e)
      done('unavailable')
    }
  })
}

/**
 * 隐私接口调用前的统一闸门。返回 true 才可以继续。
 * 返回 false 时**已经**给出用户可读的提示，调用方直接 return 即可。
 *
 * @param action 动作名，用于文案，如「选择图片」「录音」
 */
export async function guardPrivacy(action: string): Promise<boolean> {
  const r = await ensurePrivacyAuthorized()
  if (r === 'not-configured') {
    // 这是**平台侧未配置**，不是用户操作问题。文案要指出去哪里解决，
    // 否则用户会反复点同一个按钮（之前正是这样被当成「UI 卡死」）。
    Taro.showModal({
      title: '隐私指引未配置',
      content: `小程序尚未在微信后台配置《用户隐私保护指引》，因此无法${action}。请联系开发者完成配置后重试。`,
      showCancel: false,
    })
    return false
  }
  if (r === 'denied') {
    Taro.showToast({ title: `未同意隐私保护指引，无法${action}`, icon: 'none' })
    return false
  }
  return true
}

// ---------------- 隐私接口失败的统一归因（2026-10-27 新增） ----------------

/**
 * ## 为什么需要这一段
 * 全站 6 处选图/选文件原本都是 `catch {}`（或只看 `/cancel/i`），把**所有失败**
 * 都当成「用户取消」吞掉。于是「隐私指引没配」这种确定性故障，在真机上表现为
 * **点了拍照按钮毫无反应、连报错都没有**——看起来像 UI 卡死，排查成本极高。
 *
 * 归因只有三类，处理方式完全不同：
 *   cancel  → 用户自己点了取消，**不许弹提示**（弹了很烦）
 *   privacy → errno 112，平台侧没声明 ⇒ 用户怎么点都没用，必须说清楚
 *   error   → 其他（权限被系统禁、临时文件失效…）⇒ 提示 + 记全错
 */

type MiniErr = {
  errMsg?: string
  errno?: number
  message?: string
  detail?: { errMsg?: string; errno?: number }
}

function readErr(e: unknown): { msg: string; errno?: number } {
  const o = (e ?? {}) as MiniErr
  return {
    msg: o.errMsg || o.message || o.detail?.errMsg || String(e ?? ''),
    errno: typeof o.errno === 'number' ? o.errno : o.detail?.errno,
  }
}

/** 用户主动取消（点了取消/返回）。这类「失败」不该弹任何提示。 */
export function isUserCancel(e: unknown): boolean {
  return /cancel/i.test(readErr(e).msg)
}

/**
 * 隐私协议未在平台完成声明 —— 微信返回 `errno 112` /
 * `api scope is not declared in the privacy agreement`。
 *
 * ⚠️ 这个错误在开发版**几乎不会出现**（`urlCheck:false` + 开发者工具豁免），
 * 只在体验版/正式版爆发 ⇒ 一旦命中就是「平台侧没配」，与代码无关。
 */
export function isPrivacyNotDeclared(e: unknown): boolean {
  const { msg, errno } = readErr(e)
  return errno === 112 || /api scope is not declared|privacy agreement/i.test(msg)
}

export type ChooseFailKind = 'cancel' | 'privacy' | 'error'

/**
 * 选图 / 选文件失败的统一收口：归因 + 提示 + 记全错。
 * 调用方一般只需 `catch (e) { reportChooseFail(e, '选择图片') }`。
 *
 * @param fallbackTitle 非取消、非隐私时的提示；不传则用「{action}失败，请重试」。
 *        个别位置原有更具信息量的文案（如 H5 端「请在小程序中从聊天选择」），
 *        通过它保留，避免归因改造把有效提示吞掉。
 */
export function reportChooseFail(
  e: unknown,
  action = '选择',
  fallbackTitle?: string
): ChooseFailKind {
  if (isUserCancel(e)) return 'cancel'
  // 项目约定：best-effort catch 必须把完整错误打出来
  console.error(`[privacy] ${action}失败`, e)
  if (isPrivacyNotDeclared(e)) {
    Taro.showToast({ title: `隐私授权未生效，无法${action}`, icon: 'none' })
    return 'privacy'
  }
  Taro.showToast({ title: fallbackTitle || `${action}失败，请重试`, icon: 'none' })
  return 'error'
}
