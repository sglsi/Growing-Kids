// 决定性实验：给 textarea.value 赋「相同值」，光标会不会被重置？
//
// 这个结论决定治法：
//   · 相同值不重置光标 ⇒ 只要每帧下发"当前真实文本"，既不丢字也不跳光标；
//   · 相同值也重置光标   ⇒ 必须彻底不下发 value，另想办法。
import { connectPage } from './ide-cdp.mjs'

const { cdp } = await connectPage(process.argv[2] || 'detail')
const idx = Number(process.argv[3] || 0)

const r = await cdp.eval(`(() => {
  const el = [...document.querySelectorAll('textarea')][${idx}]
  if (!el) return 'no el'

  const out = []
  const log = (name, extra) => out.push({ name, value: el.value, sel: el.selectionStart, ...extra })

  // 准备文本（不走小程序逻辑，直接设 DOM）
  el.focus()
  el.value = 'abcdefgh'
  el.setSelectionRange(4, 4)
  log('初始（光标放 4）')

  // 实验 1：赋相同值
  el.value = 'abcdefgh'
  log('赋相同值后')

  // 实验 2：赋相同值但走 IDE 的 defaultValueChange 路径（直接调用 updateValue 更接近真实）
  const cs = getComputedStyle(el)
  out.push({ name: 'computed', display: cs.display, textLength: el.textLength })

  // 实验 3：用 setAttribute 模拟属性下发
  el.setSelectionRange(4, 4)
  el.setAttribute('value', 'abcdefgh')
  log('setAttribute 相同值后')

  // 实验 4：不同值
  el.setSelectionRange(4, 4)
  el.value = 'abcdefghX'
  log('赋不同值后')

  return JSON.stringify(out, null, 1)
})()`)

console.log(r)
cdp.close()
