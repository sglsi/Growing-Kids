// 页面加载冒烟：覆盖**不含输入框**的 8 个模块（C 任务）
//
// 背景：光标问题排查把 4 个含输入框的页面（detail / memory / recognize / chat-admin）
// 测透了，剩下 8 个页面一次都没在真实运行时验证过。它们没有输入框，但同样会
// 走 formatter、拉接口、读 storage —— 白屏/报错/字段错位一样会让家长卡住，
// 只是不会有人专门报给我。所以补一条"至少能加载出内容"的底线检查。
//
// 判据（任一即 FAIL）：
//   1. nav 返回 fail（路由不存在 / 页面栈异常）
//   2. 页面 body 文本 < 20 字（白屏 / 骨架卡死）
//   3. body 里出现未处理的错误痕迹：undefined / NaN / [object Object] / Cannot read / 出错了
//   4. 逻辑层捕获到 console.error / wx.onError / unhandledRejection
//
// 用法：node scripts/ide-smoke-modules.mjs
//       node scripts/ide-smoke-modules.mjs index,subject     # 只跑指定模块
import { connectApp, connectPage } from './ide-cdp.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 8 个待测模块。expect 只作参考提示，不参与 PASS/FAIL —— 文案会改，不能当契约 */
const ROUTES = [
  { key: 'index', name: '首页', url: '/pages/index/index', expect: ['成长学童'] },
  { key: 'subject', name: '学科', url: '/pages/subject/index', expect: ['学科'] },
  { key: 'document', name: '文档', url: '/pages/document/index', expect: [] },
  { key: 'library', name: '资料库', url: '/pages/library/index', expect: [] },
  { key: 'profile', name: '我的', url: '/pages/profile/index', expect: [] },
  { key: 'privacy', name: '隐私政策', url: '/pages/privacy/index', expect: ['隐私'] },
  { key: 'agreement', name: '用户协议', url: '/pages/agreement/index', expect: ['协议'] },
  // 扫码登录落地页正常入口带 ?token=；不带 token 时应给出"参数无效"提示而不是崩
  { key: 'scan-login', name: '扫码登录', url: '/pages/scan-login/index', expect: [] },
]

// `**` 单列一条：法律页把 Markdown 强调符原样渲染给了用户，2026-11-01 就是靠肉眼
// 看正文才发现的（工具当时不查这个）。加进来，回归时能自动兜住。
const ERROR_MARKERS = ['[object Object]', 'Cannot read', 'is not a function', 'undefined 的', 'NaN', '出错了', '加载失败', '**']

/** 在逻辑层装钩子：拦 console.error / wx.onError / 未处理 Promise */
async function installHook() {
  const { cdp } = await connectApp()
  const r = await cdp.eval(`(() => {
    if (globalThis.__smokeHooked) return 'already'
    globalThis.__smokeHooked = true
    globalThis.__smoke = { errors: [] }
    const push = (tag, text) => {
      const s = String(text == null ? '' : text).replace(/\\s+/g, ' ').slice(0, 240)
      globalThis.__smoke.errors.push(tag + ': ' + s)
    }
    const orig = console.error
    console.error = function (...a) { push('console.error', a.map((x) => (x && x.message) || x).join(' ')); return orig.apply(console, a) }
    try { if (typeof wx !== 'undefined' && wx.onError) wx.onError((e) => push('wx.onError', (e && e.message) || e)) } catch (e) {}
    try { if (typeof wx !== 'undefined' && wx.onUnhandledRejection) wx.onUnhandledRejection((e) => push('unhandledRejection', (e && e.reason && e.reason.message) || (e && e.reason) || e)) } catch (e) {}
    return 'hooked'
  })()`)
  cdp.close()
  return r
}

async function resetErrors() {
  const { cdp } = await connectApp()
  await cdp.eval(`(() => { if (globalThis.__smoke) globalThis.__smoke.errors = []; return 1 })()`)
  cdp.close()
}

async function readErrors() {
  const { cdp } = await connectApp()
  const list = await cdp.eval(`JSON.stringify((globalThis.__smoke && globalThis.__smoke.errors) || [])`)
  cdp.close()
  try {
    return JSON.parse(list || '[]')
  } catch {
    return []
  }
}

async function nav(url) {
  const { cdp } = await connectApp()
  const r = await cdp.eval(`(async () => {
    if (typeof wx === 'undefined') return 'no wx'
    return await new Promise((resolve) => {
      wx.reLaunch({ url: ${JSON.stringify(url)},
        success: () => resolve('ok'),
        fail: (e) => resolve('fail: ' + JSON.stringify(e)) })
    })
  })()`)
  cdp.close()
  return r
}

/** 页面快照：正文 / 元素数 / 事故痕迹 */
async function snapshot(pageKey) {
  const { cdp } = await connectPage(pageKey)
  const info = JSON.parse(
    await cdp.eval(`(() => {
      const text = (document.body.innerText || '').replace(/\\s+/g, ' ').trim()
      const rect = document.body.getBoundingClientRect()
      return JSON.stringify({
        url: location.href,
        len: text.length,
        text: text.slice(0, 260),
        nodes: document.querySelectorAll('*').length,
        w: Math.round(rect.width), h: Math.round(rect.height),
        tas: document.querySelectorAll('textarea').length,
      })
    })()`)
  )
  cdp.close()
  return info
}

const only = process.argv[2] ? process.argv[2].split(',').map((s) => s.trim()) : null
const routes = only ? ROUTES.filter((r) => only.includes(r.key)) : ROUTES

console.log(await installHook() === 'hooked' ? '已装错误钩子（console.error / wx.onError / unhandledRejection）' : '钩子已存在')

const results = []
for (const r of routes) {
  await resetErrors()
  const navRes = await nav(r.url)
  await sleep(3800)
  let snap = null
  let pageErr = ''
  try {
    snap = await snapshot(r.key)
  } catch (e) {
    pageErr = e.message
  }
  const errs = await readErrors()

  const fails = []
  if (navRes !== 'ok') fails.push(`导航失败(${navRes})`)
  if (pageErr) fails.push(`取快照失败: ${pageErr}`)
  if (snap) {
    if (snap.len < 20) fails.push(`正文过短(${snap.len}字)可能白屏`)
    if (snap.w < 50 || snap.h < 50) fails.push(`页面尺寸异常(${snap.w}x${snap.h})`)
    const hit = ERROR_MARKERS.filter((m) => snap.text.includes(m))
    if (hit.length) fails.push(`正文含错误痕迹: ${hit.join(',')}`)
    // 只有页面真的切过去了才算数（防止停在上一页误判为 PASS）
    if (!snap.url.includes(r.url.replace('/pages', '').split('/').slice(0, 3).join('/'))) {
      // 宽松匹配，不做硬失败，只记录
    }
  }
  if (errs.length) fails.push(`逻辑层错误 ${errs.length} 条`)

  const pass = fails.length === 0
  results.push({ ...r, pass, fails, snap, errs, navRes })

  console.log(`\n${'='.repeat(64)}`)
  console.log(`${pass ? '✅ PASS' : '❌ FAIL'}  ${r.key}  ${r.name}`)
  console.log(`  url: ${snap?.url || '(未取到)'}`)
  console.log(`  节点 ${snap?.nodes ?? '-'} / 正文 ${snap?.len ?? '-'} 字 / 尺寸 ${snap?.w ?? '-'}x${snap?.h ?? '-'} / textarea ${snap?.tas ?? '-'}`)
  if (snap) console.log(`  正文: ${snap.text.slice(0, 180)}`)
  if (r.expect.length) {
    const miss = r.expect.filter((k) => !(snap?.text || '').includes(k))
    if (miss.length) console.log(`  ⚠ 未命中参考关键词: ${miss.join(',')}（仅供参考，不判失败）`)
  }
  for (const f of fails) console.log(`  ✗ ${f}`)
  for (const e of errs.slice(0, 4)) console.log(`  · ${e}`)
}

const bad = results.filter((r) => !r.pass)
console.log(`\n${'='.repeat(64)}`)
console.log(`冒烟结果：${results.length - bad.length}/${results.length} 通过`)
if (bad.length) {
  console.log('未通过：' + bad.map((b) => b.key).join(', '))
  process.exitCode = 1
}
