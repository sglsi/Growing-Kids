// 测「程序化插入」（点数学符号面板）：插入后文本/光标是否正确、能否继续打字
import { connectPage } from './ide-cdp.mjs'

const { cdp, target } = await connectPage(process.argv[2] || 'detail')
const idx = Number(process.argv[3] || 0)
console.log(`页面：${target.url}\n`)

const state = async () =>
  JSON.parse(
    await cdp.eval(`(() => {
      const el = [...document.querySelectorAll('textarea')][${idx}]
      return JSON.stringify({ value: el.value, len: el.value.length, sel: el.selectionStart, focused: document.activeElement === el })
    })()`)
  )

const rect = async () =>
  JSON.parse(
    await cdp.eval(`(() => {
      const el = [...document.querySelectorAll('textarea')][${idx}]
      const b = el.getBoundingClientRect()
      return JSON.stringify({ x: b.x + b.width / 2, y: b.y + 20 })
    })()`)
  )

/** 按可见文本找元素并点击（用 CDP 真实鼠标事件） */
const clickText = async (text, nth = 0) => {
  const r = await cdp.eval(`(() => {
    const all = [...document.querySelectorAll('div,span,button,text,view')]
    const hits = all.filter(el => {
      const t = (el.innerText || '').trim()
      if (t !== ${JSON.stringify(text)}) return false
      const b = el.getBoundingClientRect()
      return b.width > 0 && b.height > 0
    })
    const el = hits[${nth}]
    if (!el) return '[]'
    const b = el.getBoundingClientRect()
    return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2, n: hits.length })
  })()`)
  const o = JSON.parse(r)
  if (o === '[]' || !o.x) return false
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: o.x, y: o.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: o.x, y: o.y, button: 'left', clickCount: 1 })
  await new Promise((r) => setTimeout(r, 600))
  return o
}

// 1. 清空并输入
const b = await rect()
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 })
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 })
await new Promise((r) => setTimeout(r, 250))
await cdp.eval(`(() => { const el=[...document.querySelectorAll('textarea')][${idx}]; el.focus(); el.setSelectionRange(0, el.value.length) })()`)
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' })
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' })
await new Promise((r) => setTimeout(r, 300))
await cdp.send('Input.insertText', { text: 'x等于' })
await new Promise((r) => setTimeout(r, 500))
let s = await state()
console.log(`输入后：${JSON.stringify(s.value)} 光标=${s.sel}`)

// 2. 光标放到末尾，打开符号面板
await cdp.eval(`(() => { const el=[...document.querySelectorAll('textarea')][${idx}]; el.focus(); el.setSelectionRange(${s.len},${s.len}) })()`)
const opened = await clickText('Ω 数学符号')
console.log(`点「Ω 数学符号」：${opened ? '已点击' : '没找到按钮'}`)

// 3. 面板里点一个符号（常见：× ÷ ≠ ≤ √ 或 "数学符号不会打" 附近）
const sym = await clickText('×')
console.log(`点符号「×」：${sym ? '已点击' : '没找到'}`)
s = await state()
console.log(`插入后：${JSON.stringify(s.value)} 光标=${s.sel}${s.value.includes('×') ? '  ✓ 符号已插入' : '  🔴 符号没进去'}`)

// 4. 继续打字（关键：插入后光标是否还可用）
await cdp.send('Input.insertText', { text: '3' })
await new Promise((r) => setTimeout(r, 500))
const s2 = await state()
console.log(`续打「3」：${JSON.stringify(s2.value)} 光标=${s2.sel}`)
if (s2.value.startsWith(s.value) && s2.sel === s.sel + 1) {
  console.log('  ✓ 插入后可继续在符号后打字')
} else {
  console.log(`  ⚠️ 续打结果与预期不同（插入后文本 ${JSON.stringify(s.value)} 光标 ${s.sel}）`)
}

cdp.close()
