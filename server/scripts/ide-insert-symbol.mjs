// 「插入数学符号」回归（2026-11-02）
//
// 这条路径和普通打字完全不同：页面要 setState 改文本 + `request(pos)` 下发 cursor +
// `refocus()` 造 focus 边沿，三件事必须在**同一批**里到达视图层，否则光标会落在末尾。
// 判据：
//   ① 符号必须插在光标处（不是末尾），文本长度 +1；
//   ② 插入后光标停在符号之后（pos+1）；
//   ③ **插入后继续打字**，新字符必须跟在这个位置，不能跳末尾。
import { connectPage } from './ide-cdp.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { cdp } = await connectPage('detail')

const read = () =>
  cdp.eval(`(() => { const t = document.querySelectorAll('textarea')[0]; return JSON.stringify({ v: t.value, sel: t.selectionStart }) })()`)

async function tap(text) {
  const pt = JSON.parse(await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('*')].find((e) => (e.textContent || '').trim() === ${JSON.stringify(text)} && e.children.length === 0)
    if (!el) return 'null'
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
  })()`))
  if (pt === 'null') throw new Error(`找不到按钮：${text}`)
  await sleep(300)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', buttons: 1, clickCount: 1 })
  }
  await sleep(500)
}

// 聚焦题干框并定位到中间
const box = JSON.parse(await cdp.eval(`(() => {
  const t = document.querySelectorAll('textarea')[0]
  t.scrollIntoView({ block: 'center' })
  const r = t.getBoundingClientRect()
  return JSON.stringify({ x: r.x + r.width / 2, y: r.y + 30 })
})()`))
await sleep(300)
for (const type of ['mousePressed', 'mouseReleased']) {
  await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 })
}
await sleep(400)

const before = JSON.parse(await read())
const pos = Math.min(60, before.v.length)
await cdp.eval(`(() => { document.querySelectorAll('textarea')[0].setSelectionRange(${pos}, ${pos}); return 1 })()`)
await sleep(200)

await tap('Ω 数学符号')
const panel = await cdp.eval(`(() => {
  const out = []
  document.querySelectorAll('*').forEach((e) => {
    const t = (e.textContent || '').trim()
    if (t && t.length <= 4 && e.children.length === 0 && /^[α-ωΑ-Ω√±×÷≤≥≠∫∑∞°²³½]$/.test(t)) out.push(t)
  })
  return JSON.stringify([...new Set(out)].slice(0, 8))
})()`)
console.log(`面板符号：${panel}`)
const symbol = JSON.parse(panel)[0]
if (!symbol) throw new Error('符号面板没打开（找不到候选符号）')

await tap(symbol)
await sleep(400)
const after = JSON.parse(await read())
const expect = before.v.slice(0, pos) + symbol + before.v.slice(pos)
console.log(`① 插入「${symbol}」：长度 ${after.v.length}（期望 ${expect.length}）｜${after.v === expect ? 'OK' : 'FAIL'}`)
console.log(`② 光标 ${after.sel}（期望 ${pos + 1}）｜${after.sel === pos + 1 ? 'OK' : 'FAIL'}`)

// ③ 插入后继续打字（这是历史故障点：符号一到，后面打的字跑末尾）
await cdp.send('Input.insertText', { text: 'Q' })
await sleep(400)
const typed = JSON.parse(await read())
const expect2 = before.v.slice(0, pos) + symbol + 'Q' + before.v.slice(pos)
console.log(`③ 插入后继续打 Q：光标 ${typed.sel}（期望 ${pos + 2}）｜${typed.v === expect2 ? 'OK' : 'FAIL'}`)

cdp.close()
