/**
 * 抓「谁把 textarea.value 改回旧值」的调用栈（2026-11-02 第十四轮，靠它定的性）
 *
 * 为什么有用：`value 下发 N 次 / 不一致 M 次`只说明"有坏写入"，不说明**谁**写的。
 * 这里在原生 textarea 的 value setter 里记调用栈，一眼能分清两条路：
 *   · 逻辑层提交 → setData → WAWebview `defaultValueChange` → `updateValue`（视图层覆盖）
 *   · 逻辑层 restore（setNodeValue）→ setAttribute → 同样的 setData 出口
 * 第十四轮就是靠它发现"晚到的 setData 把刚打的字冲掉"，进而定位到 payload 里的 value。
 *
 * 用法：node scripts/ide-write-stack.mjs [页面名]
 *   页面须已打开（先 `node scripts/ide-cdp.mjs nav /pages/memory/edit`）。
 */
import { connectPage } from './ide-cdp.mjs'

const PAGE = process.argv[2] || 'memory/edit'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { cdp } = await connectPage(PAGE)

// 聚焦
const rect = JSON.parse(
  await cdp.eval(`(() => { const el = document.querySelector('textarea'); const b = el.getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + 20 }) })()`),
)
for (const type of ['mousePressed', 'mouseReleased']) {
  await cdp.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 })
}
await sleep(300)

// 清空
await cdp.eval(`(() => { const el = document.querySelector('textarea'); el.focus(); el.setSelectionRange(0, el.value.length); return 1 })()`)
for (let i = 0; i < 60; i++) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
  await sleep(8)
  if ((await cdp.eval(`document.querySelector('textarea').value.length`)) === 0) break
}
await sleep(400)

// 打桩：抓调用栈
await cdp.eval(`(() => {
  const ta = document.querySelector('textarea')
  if (window.__stackProbe) { delete ta.value }
  window.__stackProbe = true
  window.__w = []
  const d = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
  Object.defineProperty(ta, 'value', {
    configurable: true,
    get() { return d.get.call(ta) },
    set(v) {
      const before = d.get.call(ta)
      const stack = (new Error('w')).stack.split('\\n').slice(1, 12).map((s) => s.trim().replace(/https?:\\/\\/[^)]*\\//, '')).join(' <- ')
      d.set.call(ta, v)
      window.__w.push({ same: String(v) === before, want: String(v), have: before, stack })
    },
  })
  return 'ok'
})()`)

for (const ch of 'abcdefgh') {
  await cdp.send('Input.insertText', { text: ch })
  await sleep(20)
}
await sleep(700)

const w = JSON.parse(await cdp.eval('JSON.stringify(window.__w)'))
console.log('写入序列（same=true 表示与原生一致）：')
for (const x of w) console.log(`  ${x.same ? '✓' : '✗'} 想写「${x.want}」 原生「${x.have}」`)
const stale = w.filter((x) => !x.same)
console.log(`下发 ${w.length} 次，不一致 ${stale.length} 次`)
const uniq = new Map()
for (const s of stale) if (!uniq.has(s.stack)) uniq.set(s.stack, [])
for (const s of stale) uniq.get(s.stack).push(`want=${s.want} have=${s.have}`)
for (const [stack, cases] of uniq) {
  console.log('\n【滞后写入来源】' + cases.length + ' 次，例：' + cases.slice(0, 2).join(' / '))
  console.log('  ' + stack.replace(/ <- /g, '\n  <- '))
}
cdp.close()
