// 抓「谁把 textarea.value 改回空」的调用栈
import { connectPage } from './ide-cdp.mjs'

const { cdp } = await connectPage(process.argv[2] || 'detail')
const idx = Number(process.argv[3] || 0)

await cdp.eval(`(() => {
  window.__stack = []
  const el = [...document.querySelectorAll('textarea')][${idx}]
  const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
  Object.defineProperty(el, 'value', {
    get() { return desc.get.call(this) },
    set(v) {
      const prev = desc.get.call(this)
      const st = new Error().stack
      window.__stack.push({ from: prev, to: v, stack: String(st).split('\\n').slice(1, 12).join('\\n') })
      return desc.set.call(this, v)
    },
    configurable: true,
  })
  return 'ok'
})()`)

const r = await cdp.eval(`(() => {
  const r = [...document.querySelectorAll('textarea')][${idx}].getBoundingClientRect()
  return JSON.stringify([r.x + r.width/2, r.y + 20])
})()`)
const [x, y] = JSON.parse(r)
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
await new Promise((r) => setTimeout(r, 250))

await cdp.send('Input.insertText', { text: 'abc' })
await new Promise((r) => setTimeout(r, 600))

const st = await cdp.eval('JSON.stringify(window.__stack, null, 1)')
console.log(st)

cdp.close()
