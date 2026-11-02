import { connectPage } from './ide-cdp.mjs'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const { cdp } = await connectPage(process.argv[2] || 'memory/edit')
const read = () => cdp.eval(`(() => { const t = document.querySelector('textarea'); return JSON.stringify({ v: t.value, sel: t.selectionStart }) })()`)
const box = JSON.parse(await cdp.eval(`(() => { const b = document.querySelector('textarea').getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + 20 }) })()`))
for (const type of ['mousePressed', 'mouseReleased']) {
  await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 })
}
await sleep(400)
await cdp.eval(`(() => { const t = document.querySelector('textarea'); t.focus(); t.setSelectionRange(0, t.value.length); return 1 })()`)
for (let i = 0; i < 80; i++) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
  await sleep(8)
  if (await cdp.eval(`document.querySelector('textarea').value.length`) === 0) break
}
await sleep(200)
await cdp.eval(`(() => { const t = document.querySelector('textarea'); t.focus(); t.setSelectionRange(0, 0); return 1 })()`)
const targets = [
  { label: '英文标点', text: 'Hello, world! How are you?' },
  { label: '中文标点', text: '甲乙丙，丁戊。己庚？' },
  { label: '中英混排', text: 'a，b。c！d' },
]
for (const t of targets) {
  const before = JSON.parse(await read())
  for (const ch of t.text) { await cdp.send('Input.insertText', { text: ch }); await sleep(25) }
  await sleep(500)
  const after = JSON.parse(await read())
  const expect = before.v + t.text
  console.log(`${t.label}: 期望长度 ${expect.length} 实际 ${after.v.length} 光标 ${after.sel} ｜ ${after.v === expect ? 'OK' : 'FAIL ' + JSON.stringify(after.v)}`)
}
cdp.close()
