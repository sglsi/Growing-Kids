/** 诊断：CDP 输入到底落在哪个元素上 */
import { connectPage } from './ide-cdp.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { cdp } = await connectPage('memory/edit')

const before = await cdp.eval(`(() => {
  const tas = [...document.querySelectorAll('textarea')]
  return JSON.stringify({
    count: tas.length,
    active: document.activeElement ? document.activeElement.tagName + '.' + String(document.activeElement.className || '').slice(0, 24) : null,
    vals: tas.map((t) => t.value.length),
    rect: tas.map((t) => { const r = t.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }),
  })
})()`)
console.log('初始:', before)

// 安装记录器
await cdp.eval(`(() => {
  window.__ev = []
  const ta = document.querySelector('textarea')
  for (const t of ['input', 'compositionstart', 'compositionupdate', 'compositionend', 'keydown']) {
    ta.addEventListener(t, (e) => window.__ev.push(t + (e.isComposing ? ':comp' : '') + ':' + JSON.stringify((ta.value || '').slice(0, 8))), true)
  }
  const d = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
  window.__writes = []
  Object.defineProperty(ta, 'value', {
    configurable: true,
    get() { return d.get.call(ta) },
    set(v) {
      const b = d.get.call(ta)
      const s0 = ta.selectionStart
      d.set.call(ta, v)
      window.__writes.push({ same: String(v) === b, b: b.slice(-6), v: String(v).slice(-6), s0, s1: ta.selectionStart, end: ta.value.length })
    },
  })
  return 'ok'
})()`)

// 用真实点击聚焦（不用 ta.focus()）
const rect = JSON.parse(before).rect[0]
const x = rect.x + rect.w / 2
const y = rect.y + rect.h / 2
for (const type of ['mousePressed', 'mouseReleased']) {
  await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: 1, clickCount: 1 })
}
await sleep(400)
console.log('点击后 active:', await cdp.eval(`document.activeElement.tagName + '.' + String(document.activeElement.className || '').slice(0, 24)`))

for (const ch of ['甲', '乙', '丙']) {
  await cdp.send('Input.insertText', { text: ch })
  await sleep(120)
}
await sleep(300)

console.log('输入后:', await cdp.eval(`JSON.stringify({ val: document.querySelector('textarea').value, len: document.querySelector('textarea').value.length, sel: document.querySelector('textarea').selectionStart })`))
console.log('事件:', await cdp.eval('JSON.stringify(window.__ev)'))
console.log('DOM 写入:', await cdp.eval('JSON.stringify(window.__writes)'))

cdp.close()
