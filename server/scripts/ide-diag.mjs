// 诊断：往模拟器 textarea 里送字，到底卡在哪一层
import { connectPage } from './ide-cdp.mjs'

const { cdp } = await connectPage(process.argv[2] || 'detail')
const idx = Number(process.argv[3] || 0)

// 安装探针：记录 input / beforeinput / keydown / 属性变化
await cdp.eval(`(() => {
  window.__probe = []
  const el = [...document.querySelectorAll('textarea')][${idx}]
  if (!el) return 'no el'
  for (const t of ['beforeinput','input','change','keydown','compositionstart','compositionend']) {
    el.addEventListener(t, (e) => {
      window.__probe.push({ t, value: el.value, sel: el.selectionStart, data: e.data || null, inputType: e.inputType || null })
    }, true)
  }
  // 监视 value 属性被改写（IDE 每次 setData 会写它）
  const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
  Object.defineProperty(el, 'value', {
    get() { return desc.get.call(this) },
    set(v) {
      window.__probe.push({ t: 'SET_VALUE', from: desc.get.call(this), to: v })
      return desc.set.call(this, v)
    },
    configurable: true,
  })
  return 'probe installed'
})()`)

const dump = async (label) => {
  const p = await cdp.eval('JSON.stringify(window.__probe)')
  const st = await cdp.eval(`(() => { const el=[...document.querySelectorAll('textarea')][${idx}]; return JSON.stringify({value:el.value, sel:el.selectionStart, active: document.activeElement===el}) })()`)
  console.log(`\n[${label}] 状态=${st}`)
  console.log(`  事件=${p}`)
  await cdp.eval('window.__probe = []')
}

const r = await cdp.eval(`(() => {
  const r = [...document.querySelectorAll('textarea')][${idx}].getBoundingClientRect()
  return JSON.stringify([r.x + r.width/2, r.y + 20])
})()`)
const [x, y] = JSON.parse(r)
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
await new Promise((r) => setTimeout(r, 300))
await dump('点击后')

console.log('\n>>> 方式A：Input.insertText("abc")')
await cdp.send('Input.insertText', { text: 'abc' })
await new Promise((r) => setTimeout(r, 400))
await dump('insertText')

console.log('\n>>> 方式B：dispatchKeyEvent 逐字（keyDown+char+keyUp）')
for (const ch of 'xyz') {
  const code = ch.toUpperCase().charCodeAt(0)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
  await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch, key: ch })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
  await new Promise((r) => setTimeout(r, 200))
}
await dump('dispatchKeyEvent')

console.log('\n>>> 方式C：页面内 execCommand("insertText")')
const c = await cdp.eval(`(() => {
  const el = [...document.querySelectorAll('textarea')][${idx}]
  el.focus()
  const ok = document.execCommand('insertText', false, 'QQ')
  return JSON.stringify({ ok, value: el.value, sel: el.selectionStart })
})()`)
console.log('  execCommand:', c)
await new Promise((r) => setTimeout(r, 400))
await dump('execCommand')

cdp.close()
