// 真实题目上的输入实测（不打标点、不改内容，只验证光标与文本完整性）
//
// 为什么要在真实数据上再做一遍：合成用例里我输的是「甲乙丙丁…」，最长 300 字；
// 真实账户里有一条 17249 字的英语整卷。受控输入框在长文本下最容易露馅
// （Taro 每次 commit 都要把整段 value 传回逻辑层），这是合成数据碰不到的场景。
//
// 安全性：只改 DOM 里的文本、**不点保存**。详情页的 dirty 标记只用于阻止
// 后台刷新覆盖草稿，不会自动回写；脚本结束前会用接口复查服务端内容未变。
//
// 用法：node scripts/ide-realdata-input.mjs 1     # 第 2 条（下标从 0 起）
import { connectApp, connectPage } from './ide-cdp.mjs'

const BASE = 'http://42.192.36.120'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const idx = Number(process.argv[2] || 1)

async function appEval(expr) {
  const { cdp } = await connectApp()
  const r = await cdp.eval(expr)
  cdp.close()
  return r
}

const listRaw = await appEval(`new Promise((resolve) => {
  wx.request({
    url: ${JSON.stringify(BASE + '/api/timeline?limit=100')},
    header: { 'X-Auth-Token': wx.getStorageSync('gk_auth_token') },
    success: (r) => resolve(JSON.stringify(r.data && r.data.data ? r.data.data.list : [])),
    fail: () => resolve('[]'),
  })
})`)
const items = JSON.parse(listRaw || '[]')
const item = items[idx]
if (!item) {
  console.log(`没有第 ${idx} 条`)
  process.exit(1)
}

console.log(`目标：第 ${idx} 条「${String(item.title || '').replace(/\n/g, ' ').slice(0, 26)}」`)

// 记录服务端原始内容，末尾复查
const before = JSON.stringify(item.content)

await appEval(`new Promise((r) => wx.reLaunch({ url: ${JSON.stringify('/pages/detail/index?id=' + item.id)}, success: () => r('ok'), fail: () => r('fail') }))`)
await sleep(3800)

const { cdp, target } = await connectPage('detail')
console.log(`页面：${target.url}\n`)

const stateAt = async (i) =>
  JSON.parse(await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('textarea')][${i}]
    if (!el) return JSON.stringify({ missing: true })
    return JSON.stringify({ len: el.value.length, sel: el.selectionStart,
                            head: el.value.slice(0, 8), tail: el.value.slice(-8),
                            focused: document.activeElement === el })
  })()`))

const focusAt = async (i, at) => {
  const b = JSON.parse(
    await cdp.eval(`(() => { const b = [...document.querySelectorAll('textarea')][${i}].getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + 22 }) })()`)
  )
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 })
  await sleep(250)
  await cdp.eval(`(() => { const el = [...document.querySelectorAll('textarea')][${i}]; el.focus(); el.setSelectionRange(${at}, ${at}) })()`)
  await sleep(200)
}

const MARK = '［实测］'
let fails = 0
const check = (label, ok, detail) => {
  if (!ok) fails++
  console.log(`  ${ok ? '✓' : '🔴'} ${label.padEnd(24)} ${detail}`)
}

for (const i of [0, 1]) {
  const s0 = await stateAt(i)
  if (s0.missing) {
    console.log(`\n【第 ${i} 个输入框】不存在，跳过`)
    continue
  }
  console.log(`\n【第 ${i} 个输入框】原始 ${s0.len} 字，头「${s0.head}」尾「${s0.tail}」`)
  const at = Math.min(120, Math.floor(s0.len / 3))
  await focusAt(i, at)
  const s1 = await stateAt(i)
  check('聚焦成功', s1.focused, `focused=${s1.focused}`)
  check('光标就位', s1.sel === at, `期望 ${at} / 实际 ${s1.sel}`)

  await cdp.send('Input.insertText', { text: MARK })
  await sleep(700)
  const s2 = await stateAt(i)
  check(`长度 +${MARK.length}`, s2.len === s0.len + MARK.length, `${s0.len} → ${s2.len}`)
  check('光标跟在插入后', s2.sel === at + MARK.length, `期望 ${at + MARK.length} / 实际 ${s2.sel}`)
  const midOk = await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('textarea')][${i}]
    return String(el.value.indexOf(${JSON.stringify(MARK)}) === ${at})
  })()`)
  check('插入落在指定位置', midOk === 'true', `indexOf=${await cdp.eval(`String([...document.querySelectorAll('textarea')][${i}].value.indexOf(${JSON.stringify(MARK)}))`)}`)
  check('尾部文本未丢', s2.tail === s0.tail || s2.len > s0.len, `尾「${s2.tail}」`)

  // 连续退掉刚插入的标记，恢复原貌
  for (let k = 0; k < MARK.length; k++) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
    await sleep(120)
  }
  await sleep(400)
  const s3 = await stateAt(i)
  check('退格后还原长度', s3.len === s0.len, `${s3.len} vs 原始 ${s0.len}`)
  check('还原后光标', s3.sel === at, `期望 ${at} / 实际 ${s3.sel}`)
}

await sleep(300)
cdp.close()

// 复查服务端：整个过程中没有点保存，内容必须一字未变
const after = JSON.parse(
  await appEval(`new Promise((resolve) => {
    wx.request({
      url: ${JSON.stringify(BASE + '/api/timeline/' + item.id)},
      header: { 'X-Auth-Token': wx.getStorageSync('gk_auth_token') },
      success: (r) => resolve(JSON.stringify(r.data && r.data.data ? r.data.data.content : null)),
      fail: () => resolve('null'),
    })
  })`) || 'null'
)
console.log(`\n服务端内容未变：${JSON.stringify(after) === before ? '✓ 是（未误保存）' : '🔴 否（内容被改了）'}`)
if (JSON.stringify(after) !== before) fails++

console.log(`\n结果：${fails === 0 ? '全部通过' : `${fails} 项失败`}`)
process.exitCode = fails === 0 ? 0 : 1
