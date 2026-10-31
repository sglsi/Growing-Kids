// 加压测试：中文 / 快速连打 / 删除键 / 全选替换 / 两个输入框
import { connectPage } from './ide-cdp.mjs'

const pageName = process.argv[2] || 'detail'
const idx = Number(process.argv[3] || 0)
const { cdp, target } = await connectPage(pageName)
console.log(`页面：${target.url}  第 ${idx} 个输入框\n`)

const rect = async () =>
  JSON.parse(
    await cdp.eval(`(() => {
      const el = [...document.querySelectorAll('textarea')][${idx}]
      const b = el.getBoundingClientRect()
      return JSON.stringify({ x: b.x + b.width / 2, y: b.y + 20 })
    })()`)
  )
const state = async () =>
  JSON.parse(
    await cdp.eval(`(() => {
      const el = [...document.querySelectorAll('textarea')][${idx}]
      return JSON.stringify({ value: el.value, len: el.value.length, sel: el.selectionStart, focused: document.activeElement === el })
    })()`)
  )
const click = async () => {
  const b = await rect()
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 })
  await new Promise((r) => setTimeout(r, 250))
}
const type = async (t, wait = 400) => {
  await cdp.send('Input.insertText', { text: t })
  await new Promise((r) => setTimeout(r, wait))
}
const setSel = async (p) =>
  cdp.eval(`(() => { const el=[...document.querySelectorAll('textarea')][${idx}]; el.focus(); el.setSelectionRange(${p},${p}); return el.selectionStart })()`)
const back = async (wait = 400) => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' })
  await new Promise((r) => setTimeout(r, wait))
}

let fails = 0
const check = (label, s, want, wantText) => {
  const okSel = want === undefined || s.sel === want
  const okText = wantText === undefined || s.value === wantText
  if (!okSel || !okText) fails++
  const tag = okSel && okText ? '✓' : '🔴'
  console.log(`  ${tag} ${label.padEnd(18)} 文本=${JSON.stringify(s.value).padEnd(26)} 光标=${s.sel}${want !== undefined && !okSel ? `（期望 ${want}）` : ''}${wantText !== undefined && !okText ? `（期望文本 ${JSON.stringify(wantText)}）` : ''}`)
}

// 清空
await click()
await cdp.eval(`(() => { const el=[...document.querySelectorAll('textarea')][${idx}]; el.focus(); el.setSelectionRange(0, el.value.length) })()`)
await back()

console.log('【1】中文输入 + 中间插标点')
await type('今天做数学题')
let s = await state()
check('打完中文', s, 6, '今天做数学题')
await setSel(3)
await type('，')
s = await state()
check('中间插中文逗号', s, 4, '今天做，数学题')

console.log('\n【2】英文夹中文混输')
await setSel(0)
await type('OK ')
s = await state()
check('行首插英文', s, 3)

console.log('\n【3】快速连打（不等渲染）')
const at = (await state()).sel
await cdp.send('Input.insertText', { text: 'abcdef' })
await new Promise((r) => setTimeout(r, 700))
s = await state()
check('快速连打 6 字', s, at + 6)

console.log('\n【4】中间快速退格 5 次')
await setSel(8)
for (let i = 1; i <= 5; i++) {
  await back(150)
}
s = await state()
check('连退 5 次后光标', s, 3)

console.log('\n【5】全选替换')
await cdp.eval(`(() => { const el=[...document.querySelectorAll('textarea')][${idx}]; el.focus(); el.setSelectionRange(0, el.value.length) })()`)
await type('替换后的文本')
s = await state()
check('全选后输入', s, 6, '替换后的文本')

console.log('\n【6】中间插入后立即继续打字（不等渲染）')
await setSel(2)
await cdp.send('Input.insertText', { text: 'X' })
await new Promise((r) => setTimeout(r, 80))
await cdp.send('Input.insertText', { text: 'Y' })
await new Promise((r) => setTimeout(r, 700))
s = await state()
check('插 XY 后', s, 4, '替换XY后的文本')

console.log(`\n${fails === 0 ? '✅ 全部通过' : `🔴 失败 ${fails} 处`}`)
cdp.close()
