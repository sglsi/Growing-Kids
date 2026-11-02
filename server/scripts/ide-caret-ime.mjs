/**
 * 输入法 / 连删 场景的光标实测台（2026-11-02）
 *
 * 背景：前十一轮的测试全用 `Input.insertText` —— 它**绕过输入法组合过程**，直接往
 * 原生 textarea 里塞文本。所以"按住删除键连删"以及"输入法组合态上屏标点"这两条
 * 真机必现的路径，模拟器里一次都没被触发过。
 *
 * 本脚本在**页面 DOM 层**打桩，记录每一次 value 下发：
 *   · `same:true`  → 下发的值与原生当前文本一致，微信不会动文本、不会动光标；
 *   · `same:false` → 下发的是滞后文本，微信会把文本改回去、光标甩到末尾（故障本体）。
 *
 * 用法：node scripts/ide-caret-ime.mjs [burst|delete|all] [页面名]
 *   页面默认 memory/edit（单输入框、无数据依赖）。
 */
import { connectPage } from './ide-cdp.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SCENARIO = process.argv[2] || 'all'
const PAGE = process.argv[3] || 'memory/edit'

const { cdp, target } = await connectPage(PAGE)
console.log(`页面：${target.url}`)

async function focusByClick() {
  const rect = JSON.parse(await cdp.eval(`(() => {
    const el = document.querySelector('textarea')
    const b = el.getBoundingClientRect()
    return JSON.stringify({ x: b.x + b.width / 2, y: b.y + 20 })
  })()`))
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 })
  }
  await sleep(300)
}

async function clearAll() {
  await cdp.eval(`(() => {
    const el = document.querySelector('textarea')
    el.focus()
    el.setSelectionRange(0, el.value.length)
    return el.value.length
  })()`)
  for (let i = 0; i < 80; i++) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
    await sleep(8)
    const len = await cdp.eval(`document.querySelector('textarea').value.length`)
    if (len === 0) break
  }
  await sleep(400)
}

async function installProbe() {
  await cdp.eval(`(() => {
    const ta = document.querySelector('textarea')
    window.__writes = []
    window.__inputs = []
    if (window.__probed) return 'already'
    window.__probed = true
    const d = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
    Object.defineProperty(ta, 'value', {
      configurable: true,
      get() { return d.get.call(ta) },
      set(v) {
        const before = d.get.call(ta)
        const sel0 = ta.selectionStart
        d.set.call(ta, v)
        window.__writes.push({
          same: String(v) === before,
          want: String(v).slice(-8), have: before.slice(-8),
          sel0, sel1: ta.selectionStart, end: ta.value.length, at: Date.now(),
        })
      },
    })
    ta.addEventListener('input', () => window.__inputs.push({ v: ta.value.length, sel: ta.selectionStart, at: Date.now() }), true)
    return 'ok'
  })()`)
}

function report(label, writes, inputs, extra = '') {
  const stale = writes.filter((w) => !w.same)
  const toEnd = stale.filter((w) => w.sel1 === w.end)
  console.log(`\n── ${label} ──`)
  console.log(`   input 事件 ${inputs.length} 次 ｜ value 下发 ${writes.length} 次`)
  console.log(`   值与原生不一致 ${stale.length} 次 ｜ 其中光标被甩到末尾 ${toEnd.length} 次`)
  for (const s of stale.slice(0, 5)) {
    console.log(`     ↳ 想下发「…${s.want}」/ 原生「…${s.have}」 光标 ${s.sel0} → ${s.sel1}（末尾 ${s.end}）`)
  }
  if (extra) console.log(`   ${extra}`)
  return { writes: writes.length, stale: stale.length, toEnd: toEnd.length }
}

const results = {}

if (SCENARIO === 'burst' || SCENARIO === 'all') {
  await clearAll()
  await focusByClick()
  await installProbe()
  await cdp.eval('window.__writes = []; window.__inputs = []; 1')
  for (const ch of 'abcdefghijklmnop') {
    await cdp.send('Input.insertText', { text: ch })
    await sleep(15)
  }
  await sleep(700)
  const st = JSON.parse(await cdp.eval(`JSON.stringify({ val: document.querySelector('textarea').value, sel: document.querySelector('textarea').selectionStart })`))
  const w = JSON.parse(await cdp.eval('JSON.stringify(window.__writes)'))
  const i = JSON.parse(await cdp.eval('JSON.stringify(window.__inputs)'))
  results.burst = report('连打 16 字（15ms 间隔）', w, i, `最终长度 ${st.val.length}（期望 16）光标 ${st.sel}（期望 16）`)
}

if (SCENARIO === 'delete' || SCENARIO === 'all') {
  await clearAll()
  await focusByClick()
  await installProbe()
  const base = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'
  await cdp.send('Input.insertText', { text: base })
  await sleep(600)
  const len0 = await cdp.eval(`document.querySelector('textarea').value.length`)
  await cdp.eval(`(() => { const el = document.querySelector('textarea'); el.focus(); el.setSelectionRange(20, 20); window.__writes = []; window.__inputs = []; return el.selectionStart })()`)
  await sleep(150)
  for (let i = 0; i < 15; i++) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
    await sleep(18)
  }
  await sleep(700)
  const st = JSON.parse(await cdp.eval(`JSON.stringify({ len: document.querySelector('textarea').value.length, sel: document.querySelector('textarea').selectionStart })`))
  const w = JSON.parse(await cdp.eval('JSON.stringify(window.__writes)'))
  const i = JSON.parse(await cdp.eval('JSON.stringify(window.__inputs)'))
  results.delete = report(
    `连删 15 次（18ms 间隔，起点 20，${len0} 字）`,
    w,
    i,
    `最终长度 ${st.len}（期望 ${len0 - 15}）光标 ${st.sel}（期望 5）`,
  )
}

console.log('\n=== 汇总 ===')
for (const [k, v] of Object.entries(results)) {
  console.log(`${k.padEnd(8)} 下发 ${v.writes} ｜ 不一致 ${v.stale} ｜ 光标被甩末尾 ${v.toEnd}`)
}
if (!Object.keys(results).length) console.log('（没有匹配的场景）')

cdp.close()
