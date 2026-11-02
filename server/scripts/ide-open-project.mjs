/** 在开发者工具启动窗口里点开项目（一次性辅助脚本） */
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const t = list.find((x) => x.url.includes('entrance.html'))
if (!t) {
  console.log('没有启动窗口')
  process.exit(0)
}
const ws = new WebSocket(t.webSocketDebuggerUrl)
let id = 0
const pend = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
}
await new Promise((r) => { ws.onopen = r })
const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })

const expr = `(() => {
  const h = [...document.querySelectorAll('h4')].find(function (e) { return /Growing-Kids/.test(e.textContent || '') })
  if (!h) return 'no h4'
  var el = h, out = []
  for (var i = 0; i < 5 && el; i++) {
    var b = el.getBoundingClientRect()
    out.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 40), x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) })
    el = el.parentElement
  }
  return JSON.stringify(out)
})()`
const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
const boxes = JSON.parse(r.result.result.value)
console.log(JSON.stringify(boxes, null, 1))

// 用最外层可点击卡片（第 3 层祖先）的中心双击
const box = boxes[Math.min(3, boxes.length - 1)]
const x = box.x + box.w / 2
const y = box.y + box.h / 2
for (let n = 1; n <= 2; n++) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: n })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 1, clickCount: n })
  await new Promise((res) => setTimeout(res, 60))
}
console.log(`双击 (${Math.round(x)}, ${Math.round(y)})`)
ws.close()
