// 真实账号数据的逐条渲染实测（思傅 2026-11-01 提供账号）
//
// 起因：前十一轮的所有用例都是我造的合成数据（「计算 13 + 27 =」这种），
// 它能证明输入框不跳光标，但证明不了**真实题目能不能正常显示**。
// 真实数据里有长英文作文、有 $\dfrac 公式、有大量图片题、有 OCR 出来的错字
// （「ZACB」「4Z022」这类），合成数据一个都覆盖不到。
//
// 判据（任一即 FAIL）：
//   1. 导航失败 / 正文 < 20 字（白屏）
//   2. 图片全部加载失败（naturalWidth === 0）—— 存储地址配错时正是这个表现，
//      而且**不会报错**，只是整片空白，靠肉眼很难把它和「本来就没图」区分开
//   3. 正文出现未处理痕迹（[object Object] / NaN / undefined 的 / ** 等）
//   4. 逻辑层捕获到 console.error / wx.onError / unhandledRejection
//
// 用法：node scripts/ide-realdata.mjs            # 全部条目
//       node scripts/ide-realdata.mjs 3          # 只看第 5 条（下标从 0 起）
import { connectApp, connectPage } from './ide-cdp.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BASE = 'http://42.192.36.120'
const ERROR_MARKERS = ['[object Object]', 'Cannot read', 'is not a function', 'undefined 的', 'NaN', '出错了', '加载失败', '**']

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
  try { return JSON.parse(list || '[]') } catch { return [] }
}

/** 用模拟器里已登录的令牌取条目清单（证明"我看到的"就是"账户里的"） */
async function fetchItems() {
  const { cdp } = await connectApp()
  const raw = await cdp.eval(`new Promise((resolve) => {
    const token = wx.getStorageSync('gk_auth_token')
    wx.request({
      url: ${JSON.stringify(BASE + '/api/timeline?limit=100')},
      header: { 'X-Auth-Token': token },
      success: (r) => resolve(JSON.stringify(r.data && r.data.data ? r.data.data.list : [])),
      fail: (e) => resolve('[]'),
    })
  })`)
  cdp.close()
  try { return JSON.parse(raw || '[]') } catch { return [] }
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

/** 详情页快照：正文 / 图片真实加载情况 / 公式是否露源码
 *
 * ⚠️ 小程序里的 `<Image>` **不是 `<img>`**：Taro 编译成 `<wx-image>`，
 * 图片本体挂在内层 div 的 `background-image` 上。所以 `document.images` 永远是 0，
 * 拿它判「图片没加载」会得到一个漂亮的假通过（第一版就栽在这）。
 * 正确做法：取出所有指向 `/api/storage/files/` 的 URL，逐个 `new Image()` 真载一次。
 */
async function snapshot() {
  const { cdp } = await connectPage('detail')
  const info = JSON.parse(await cdp.eval(`(async () => {
    const text = (document.body.innerText || '').replace(/\\s+/g, ' ').trim()
    const urls = []
    document.querySelectorAll('*').forEach((e) => {
      const bg = getComputedStyle(e).backgroundImage || ''
      const m = bg.match(/url\\("?([^")]+)"?\\)/)
      if (m && m[1].includes('/api/storage/files/') && !urls.includes(m[1])) urls.push(m[1])
    })
    const probe = await Promise.all(urls.slice(0, 12).map((u) => new Promise((res) => {
      const im = new Image()
      im.onload = () => res({ ok: im.naturalWidth > 0, w: im.naturalWidth })
      im.onerror = () => res({ ok: false, w: 0 })
      im.src = u
      setTimeout(() => res({ ok: false, w: 0 }), 8000)
    })))
    const tas = document.querySelectorAll('textarea')
    return JSON.stringify({
      url: location.href,
      len: text.length,
      text: text.slice(0, 220),
      nodes: document.querySelectorAll('*').length,
      imgs: urls.length,
      imgsLoaded: probe.filter((p) => p.ok).length,
      imgSizes: probe.slice(0, 4).map((p) => p.w).join('/'),
      tas: tas.length,
      // 公式源码是否裸露在页面上（正常应由 latex 渲染成图形）
      rawDollar: /\\$\\\\?(dfrac|frac|sqrt)|\\$[^$]{2,40}\\$/.test(text),
    })
  })()`))
  cdp.close()
  return info
}

const onlyArg = process.argv[2]
const all = await fetchItems()
const items = onlyArg ? [all[Number(onlyArg)]].filter(Boolean) : all

console.log((await installHook()) === 'hooked' ? '已装错误钩子' : '钩子已存在')
console.log(`账户条目：${all.length} 条，本次实测 ${items.length} 条\n`)

const results = []
for (let i = 0; i < items.length; i++) {
  const it = items[i]
  await resetErrors()
  const navRes = await nav(`/pages/detail/index?id=${it.id}`)
  await sleep(3600)
  let snap = null
  let pageErr = ''
  try { snap = await snapshot() } catch (e) { pageErr = e.message }
  const errs = await readErrors()

  const fails = []
  if (navRes !== 'ok') fails.push(`导航失败(${navRes})`)
  if (pageErr) fails.push(`快照失败: ${pageErr}`)
  if (snap) {
    if (snap.len < 20) fails.push(`正文过短(${snap.len}字)`)
    if (snap.imgs > 0 && snap.imgsLoaded === 0) fails.push(`图片全未加载(${snap.imgs}张)`)
    const hit = ERROR_MARKERS.filter((m) => snap.text.includes(m))
    if (hit.length) fails.push(`正文含错误痕迹: ${hit.join(',')}`)
  }
  if (errs.length) fails.push(`逻辑层错误 ${errs.length} 条`)

  const pass = fails.length === 0
  results.push({ it, pass, fails, snap, errs })

  const title = String(it.title || '').replace(/\n/g, ' ').slice(0, 24)
  console.log(`${pass ? '✅' : '❌'} [${i}] ${it.kind} 「${title}」`)
  console.log(`     正文 ${snap?.len ?? '-'} 字 / 图片 ${snap?.imgsLoaded ?? '-'}/${snap?.imgs ?? '-'} 已载 / 背景图 ${snap?.bgDivs ?? '-'} / textarea ${snap?.tas ?? '-'}${snap?.rawDollar ? ' / 公式源码疑似裸露' : ''}`)
  if (snap) console.log(`     ${snap.text.slice(0, 110)}`)
  for (const f of fails) console.log(`     ✗ ${f}`)
  for (const e of errs.slice(0, 3)) console.log(`     · ${e}`)
}

const bad = results.filter((r) => !r.pass)
console.log(`\n${'='.repeat(64)}`)
console.log(`真实数据实测：${results.length - bad.length}/${results.length} 通过`)
if (bad.length) {
  console.log('未通过：' + bad.map((b, i) => `「${String(b.it.title || '').slice(0, 14)}」`).join(' '))
  process.exitCode = 1
}
