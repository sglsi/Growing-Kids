// 回车行为诊断：三种模拟方式，看哪一种真能在 textarea 里产生换行
//
// 背景：扩展用例里「回车插换行」失败（换行数 0）。需要先分清是
//   (a) 我用 CDP 按键的方式不对（模拟器层），还是
//   (b) 输入框/组件本身不吃回车（真机也会坏）。
// 判据：挂 keydown/beforeinput/input 探针，看事件到没到、value 变没变。
import { connectPage } from './ide-cdp.mjs'

const pageName = process.argv[2] || 'detail'
const idx = Number(process.argv[3] || 0)
const { cdp } = await connectPage(pageName)
const sel = `[...document.querySelectorAll('textarea')][${idx}]`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const val = async () => cdp.eval(`${sel}.value`)
const log = async () => cdp.eval('JSON.stringify(window.__log || [])')

await cdp.eval(`(() => { const el = ${sel}; el.focus(); el.setSelectionRange(0, el.value.length) })()`)
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
await sleep(400)
await cdp.send('Input.insertText', { text: 'AB' })
await sleep(600)

// 挂探针（捕获阶段，先于业务逻辑）
await cdp.eval(`(() => {
  window.__log = []
  const el = ${sel}
  for (const ev of ['keydown', 'keypress', 'beforeinput', 'input']) {
    el.addEventListener(ev, (e) => {
      window.__log.push(ev + '|' + (e.key || e.inputType || '') + '|' + el.value)
    }, true)
  }
  return 'on'
})()`)

async function show(tag) {
  console.log(`\n${tag}\n  value=${JSON.stringify(await val())}\n  事件=${await log()}`)
}

// ---- 方式 A：keyDown + keyUp（我原来用的）
await cdp.eval('window.__log = []')
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await sleep(700)
await show('方式 A：keyDown/keyUp Enter')

// ---- 方式 B：char 事件（原生输入换行的正路）
await cdp.eval('window.__log = []')
await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: '\n', unmodifiedText: '\n', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await sleep(700)
await show('方式 B：char "\\n"')

// ---- 方式 C：insertText 里带换行（等价粘贴一段含换行文本）
await cdp.eval('window.__log = []')
await cdp.send('Input.insertText', { text: '\n' })
await sleep(700)
await show('方式 C：insertText "\\n"')

cdp.close()
