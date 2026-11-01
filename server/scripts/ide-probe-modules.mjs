// 模块探测：导航到指定页面，列出页面文字、可点击项与输入框实况
//
// 用法：node scripts/ide-probe-modules.mjs recognize,chat/admin
//
// 存在的意义：不同模块的输入框出现条件不同（识别页要切「错题提取」tab，
// 客服话术页要先点「新建」弹层）。盲跑用例前先看清 DOM，避免把
// "没找到输入框" 误当成 "输入框坏了"。
import { connectApp, connectPage } from './ide-cdp.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 逻辑层跳页（reLaunch 保证页面栈干净） */
async function nav(url) {
  const { cdp } = await connectApp()
  const r = await cdp.eval(`(async () => {
    if (typeof wx === 'undefined') return 'no wx'
    return await new Promise((resolve) => {
      wx.reLaunch({ url: ${JSON.stringify(url)}, success: () => resolve('ok'), fail: (e) => resolve('fail: ' + JSON.stringify(e)) })
    })
  })()`)
  cdp.close()
  return r
}

/** 页面快照：文字 / 输入框 / 可点击候选 */
async function snapshot(pageName) {
  const { cdp } = await connectPage(pageName)
  const info = JSON.parse(
    await cdp.eval(`(() => {
      const tas = [...document.querySelectorAll('textarea')].map((el, i) => {
        const b = el.getBoundingClientRect()
        return { i, value: el.value, len: el.value.length, sel: el.selectionStart,
                 w: Math.round(b.width), h: Math.round(b.height),
                 ph: (el.getAttribute('placeholder') || '').slice(0, 30) }
      })
      const leaves = [...document.querySelectorAll('*')]
        .filter((e) => e.children.length === 0 && e.textContent.trim() && e.textContent.trim().length <= 12)
      const texts = [...new Set(leaves.map((e) => e.textContent.trim()))]
      return JSON.stringify({ url: location.href, tas, texts: texts.slice(0, 40),
                              body: document.body.innerText.slice(0, 300) })
    })()`)
  )
  cdp.close()
  return info
}

/** 按文字点击（模拟真实手指） */
async function clickText(pageName, text) {
  const { cdp } = await connectPage(pageName)
  const hit = JSON.parse(
    await cdp.eval(`(() => {
      const el = [...document.querySelectorAll('*')].find(
        (e) => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(text)}
      )
      if (!el) return JSON.stringify({ ok: false })
      const b = el.getBoundingClientRect()
      return JSON.stringify({ ok: true, x: b.x + b.width / 2, y: b.y + b.height / 2 })
    })()`)
  )
  if (!hit.ok) {
    cdp.close()
    return false
  }
  const { x, y } = hit
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  cdp.close()
  return true
}

const targets = (process.argv[2] || 'recognize').split(',').map((s) => s.trim())

for (const t of targets) {
  const [page, action] = t.split('@')
  console.log(`\n${'='.repeat(60)}\n▶ ${page}${action ? '  (点击：' + action + ')' : ''}`)
  // 页面路径有两种形态（pages/x/index 与 pages/x/y），先试带 index 的
  let r1 = await nav(`/pages/${page}/index`)
  if (typeof r1 === 'string' && r1.startsWith('fail')) r1 = await nav(`/pages/${page}`)
  console.log('nav:', r1)
  await sleep(3500)
  if (action) {
    const ok = await clickText(page, action)
    console.log(`点击「${action}」:`, ok ? '已触发' : '未找到该文字')
    await sleep(2500)
  }
  const snap = await snapshot(page)
  console.log('输入框数:', snap.tas.length)
  for (const t of snap.tas) {
    console.log(`  [${t.i}] len=${t.len} sel=${t.sel} ${t.w}x${t.h} ph="${t.ph}"`)
  }
  console.log('页面文字:', snap.body.replace(/\n+/g, ' | ').slice(0, 220))
  console.log('可点文字:', snap.texts.join(' / '))
}
