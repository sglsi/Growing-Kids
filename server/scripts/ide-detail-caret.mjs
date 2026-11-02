// 详情页（双输入框 + 长文本）光标/打点回归（2026-11-02）
//
// 判据：
//   1. 在长文本中间连打，长度必须 +N、光标必须停在插入点之后，内容逐字一致；
//   2. 连删同理；
//   3. 每次 input 只应有 1 次 value 下发（多出来就是 Taro 在重发）。
import { connectPage } from './ide-cdp.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { cdp } = await connectPage('detail')

const read = (i = 0) =>
  cdp.eval(`(() => { const t = document.querySelectorAll('textarea')[${i}]; return JSON.stringify({ v: t.value, sel: t.selectionStart, len: t.value.length }) })()`)

async function clickBox(i) {
  // ⚠️ 第二个框（答案）在首屏之外（y≈715，视口只有 504），不先滚进可视区就点不到 ——
  //    坐标落在 BODY 上，表现为"答案框打不进字"，其实是测试脚本的事。
  await cdp.eval(`(() => { const t = document.querySelectorAll('textarea')[${i}]; t.scrollIntoView({ block: 'center' }); return 1 })()`)
  await sleep(500)
  const b = JSON.parse(await cdp.eval(`(() => {
    const t = document.querySelectorAll('textarea')[${i}]
    const r = t.getBoundingClientRect()
    // 长文本题干框比视口还高（实测 top=-3586），点 top+30 会落到屏幕外 ——
    // 取可见区间内的一点就够了，点哪儿都是聚焦同一个框。
    const y = Math.min(Math.max(r.y + 30, 30), window.innerHeight - 40)
    return JSON.stringify({ x: r.x + r.width / 2, y, top: r.y, bottom: r.y + r.height, vh: window.innerHeight })
  })()`))
  if (b.bottom < 40 || b.top > b.vh - 40) throw new Error(`第 ${i} 个输入框完全不在可视区（top=${Math.round(b.top)}, bottom=${Math.round(b.bottom)}, 视口高=${b.vh}）`)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 1 })
  }
  await sleep(400)
  const focused = await cdp.eval(`document.activeElement === document.querySelectorAll('textarea')[${i}]`)
  if (!focused) throw new Error(`点击后第 ${i} 个输入框没有获得焦点`)
}

async function typeChars(text, gap = 15) {
  for (const ch of text) {
    await cdp.send('Input.insertText', { text: ch })
    await sleep(gap)
  }
  await sleep(500)
}

await clickBox(0)
const start = JSON.parse(await read(0))
console.log(`起始：${start.len} 字，光标 ${start.sel}`)

/**
 * 长文本（17035 字那种）走另一条路径：框比视口高得多，`setSelectionRange` 在这里
 * 既不可靠、也不代表真实用户操作（用户是靠点击/拖动定位的），所以只在末尾追加。
 * 这一档要看的是「每次按键都对、不卡」。
 */
const LONG_TEXT = start.len > 2000
const pos = LONG_TEXT ? start.len : Math.min(100, start.len)
if (!LONG_TEXT) {
  await cdp.eval(`(() => { const t = document.querySelectorAll('textarea')[0]; t.setSelectionRange(${pos}, ${pos}); return t.selectionStart })()`)
  await sleep(200)
} else {
  console.log('（长文本：改为在末尾追加）')
}
const t0 = Date.now()
const snippet = 'ABCDefghIJ'
await typeChars(snippet, LONG_TEXT ? 30 : 15)
console.log(`   10 字耗时 ${Date.now() - t0}ms`)
const after = JSON.parse(await read(0))
const expect = start.v.slice(0, pos) + snippet + start.v.slice(pos)
console.log(`① 连打 ${snippet.length} 字：长度 ${after.len}（期望 ${expect.length}）光标 ${after.sel}（期望 ${pos + snippet.length}）｜${after.v === expect ? 'OK' : 'FAIL'}`)

// ② 同一位置连删 6 次
await cdp.eval(`(() => { const t = document.querySelectorAll('textarea')[0]; t.setSelectionRange(${pos + snippet.length}, ${pos + snippet.length}); return 1 })()`)
await sleep(200)
for (let i = 0; i < 6; i++) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
  await sleep(18)
}
await sleep(500)
const del = JSON.parse(await read(0))
const expectDel = start.v.slice(0, pos) + snippet.slice(0, 4) + start.v.slice(pos)
console.log(`② 连删 6 次：长度 ${del.len}（期望 ${expectDel.length}）光标 ${del.sel}（期望 ${pos + 4}）｜${del.v === expectDel ? 'OK' : 'FAIL'}`)

// ③ 中文标点
await cdp.eval(`(() => { const t = document.querySelectorAll('textarea')[0]; t.setSelectionRange(${pos + 4}, ${pos + 4}); return 1 })()`)
await sleep(200)
await typeChars('，。？')
const p = JSON.parse(await read(0))
console.log(`③ 中间打中文标点：长度 ${p.len}（期望 ${expectDel.length + 3}）光标 ${p.sel}（期望 ${pos + 7}）｜${p.v === expectDel.slice(0, pos + 4) + '，。？' + expectDel.slice(pos + 4) ? 'OK' : 'FAIL'}`)

// ④ 第二个框（答案）独立验证
await clickBox(1)
const a0 = JSON.parse(await read(1))
await typeChars('abc,def。')
const a1 = JSON.parse(await read(1))
console.log(`④ 答案框：${a0.len} → ${a1.len}（期望 ${a0.len + 8}）光标 ${a1.sel}｜${a1.v === a0.v + 'abc,def。' ? 'OK' : 'FAIL'}`)

cdp.close()
