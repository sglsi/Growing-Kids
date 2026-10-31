// 光标行为测试（在真实 IDE 模拟器里做）
// 用法：node scripts/ide-caret-test.mjs [页面名] [textarea索引]
import { connectPage } from './ide-cdp.mjs'

const pageName = process.argv[2] || 'detail'
const idx = Number(process.argv[3] || 0)

const { cdp, target } = await connectPage(pageName)
console.log(`页面：${target.url}`)

const rect = async () =>
  JSON.parse(
    await cdp.eval(`(() => {
      const el = [...document.querySelectorAll('textarea')][${idx}]
      if (!el) return '[]'
      const b = el.getBoundingClientRect()
      return JSON.stringify({ x: b.x + b.width / 2, y: b.y + 20, w: b.width, h: b.height })
    })()`)
  )

const state = async () =>
  JSON.parse(
    await cdp.eval(`(() => {
      const el = [...document.querySelectorAll('textarea')][${idx}]
      if (!el) return '{}'
      return JSON.stringify({ value: el.value, len: el.value.length, sel: el.selectionStart, focused: document.activeElement === el })
    })()`)
  )

const click = async () => {
  const b = await rect()
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 })
  await new Promise((r) => setTimeout(r, 300))
}

const type = async (t) => {
  await cdp.send('Input.insertText', { text: t })
  await new Promise((r) => setTimeout(r, 450))
}

const setSel = async (p) =>
  cdp.eval(`(() => { const el=[...document.querySelectorAll('textarea')][${idx}]; el.focus(); el.setSelectionRange(${p},${p}); return el.selectionStart })()`)

const key = async (code, vk) => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, key: code === 8 ? 'Backspace' : code, code: code === 8 ? 'Backspace' : code })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, key: code === 8 ? 'Backspace' : code, code: code === 8 ? 'Backspace' : code })
  await new Promise((r) => setTimeout(r, 400))
}

const line = (label, s, want) => {
  const ok = want === undefined ? '' : s.sel === want ? '  ✓' : `  🔴 跳了（期望 ${want}，末尾 ${s.len}）`
  console.log(`  ${label.padEnd(20)} 文本=${JSON.stringify(s.value).padEnd(22)} 光标=${String(s.sel).padEnd(3)}${ok}`)
  return s.sel === want
}

let fails = 0

console.log('\n=== 1. 清空并输入完整句 ===')
await click()
// 全选删除
await cdp.eval(`(() => { const el=[...document.querySelectorAll('textarea')][${idx}]; el.focus(); el.setSelectionRange(0, el.value.length) })()`)
await key(8, 8)
await type('hello world')
let s = await state()
if (!line('打完 hello world', s, 11)) fails++

console.log('\n=== 2. 光标移到第 5 位，中间插入 "X" ===')
await setSel(5)
s = await state()
line('定位到 5', s, 5)
await type('X')
s = await state()
if (!line('中间插入 X', s, 6)) fails++

console.log('\n=== 3. 中间插入逗号 "," ===')
await setSel(6)
await type(',')
s = await state()
if (!line('中间插逗号', s, 7)) fails++

console.log('\n=== 4. 中间插入空格 ===')
await setSel(3)
await type(' ')
s = await state()
if (!line('中间插空格', s, 4)) fails++

console.log('\n=== 5. 中间连续退格 3 次 ===')
for (let i = 1; i <= 3; i++) {
  const before = await state()
  await key(8, 8)
  s = await state()
  if (!line(`第 ${i} 次退格`, s, Math.max(0, before.sel - 1))) fails++
}

console.log('\n=== 6. 末尾追加句号 ===')
s = await state()
await setSel(s.len)
await type('.')
s = await state()
if (!line('末尾句号', s, s.len)) fails++

console.log(`\n${fails === 0 ? '✅ 全部通过' : `🔴 失败 ${fails} 处`}`)
cdp.close()
