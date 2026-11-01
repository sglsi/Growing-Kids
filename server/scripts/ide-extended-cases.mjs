// 扩展用例：长文本 / 换行 / maxlength 边界 / 粘贴 / 撤销重做
//
// 基础用例（ide-caret-stress.mjs）只覆盖短文本编辑。真实使用里用户会
// 贴一整段、写到接近字数上限、按回车、按 Ctrl+Z —— 这些才是受控输入框
// 最容易露馅的地方：
//   · 超 maxlength 时，微信截断原生文本，但页面 state 可能存了更长的值
//     ⇒ 下一次 commit 用它覆盖原生 ⇒ 文本突然变长或跳光标；
//   · 撤销走的是**原生 undo**，它改的是原生文本，页面 state 不知道
//     ⇒ 下一次 commit 用旧（新）值盖回去 ⇒ 撤销"失效"。
// 这两条必须实测确认，不能靠推理。
//
// 用法：node scripts/ide-extended-cases.mjs <页面> <序号>
import { connectPage } from './ide-cdp.mjs'

const pageName = process.argv[2] || 'detail'
const idx = Number(process.argv[3] || 0)
const { cdp, target } = await connectPage(pageName)
console.log(`页面：${target.url}  第 ${idx} 个输入框\n`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sel = `[...document.querySelectorAll('textarea')][${idx}]`

const state = async () =>
  JSON.parse(
    await cdp.eval(`(() => {
      const el = ${sel}
      return JSON.stringify({ value: el.value, len: el.value.length, sel: el.selectionStart,
                              max: el.getAttribute('maxlength'), focused: document.activeElement === el })
    })()`)
  )
const focus = async (at) => {
  const b = JSON.parse(
    await cdp.eval(`(() => { const b = ${sel}.getBoundingClientRect(); return JSON.stringify({x:b.x+b.width/2, y:b.y+20}) })()`)
  )
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 })
  await sleep(200)
  if (at !== undefined) await cdp.eval(`(() => { const el = ${sel}; el.focus(); el.setSelectionRange(${at}, ${at}) })()`)
}
const type = async (t, wait = 500) => {
  await cdp.send('Input.insertText', { text: t })
  await sleep(wait)
}
const key = async (name, code, vk, modifiers = 0, wait = 500) => {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers,
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers,
  })
  await sleep(wait)
}
const clearAll = async () => {
  await focus()
  await cdp.eval(`(() => { const el = ${sel}; el.focus(); el.setSelectionRange(0, el.value.length) })()`)
  await key('Backspace', 'Backspace', 8)
}

let fails = 0
let skips = 0
const check = (label, cond, detail) => {
  if (!cond) fails++
  console.log(`  ${cond ? '✓' : '🔴'} ${label.padEnd(22)} ${detail}`)
}
const skip = (label, why) => {
  skips++
  console.log(`  ⚪ ${label.padEnd(22)} 跳过：${why}`)
}

// ---------------------------------------------------------------- 准备
await clearAll()
let s = await state()
console.log(`起始：len=${s.len} maxlength=${s.max} focused=${s.focused}`)
check('聚焦成功', s.focused, `activeElement=${s.focused ? '是' : '否'}`)
check('清空成功', s.len === 0, `len=${s.len}`)

// ---------------------------------------------------------------- 1 长文本
console.log('\n【L1】一次插入 300 字长文本')
const long = '甲乙丙丁戊己庚辛壬癸'.repeat(30) // 300 字
await type(long, 900)
s = await state()
check('文本长度', s.len === 300, `len=${s.len}`)
check('光标在末尾', s.sel === 300, `sel=${s.sel}`)

// ---------------------------------------------------------------- 2 中间插字
console.log('\n【L2】长文本中间（第 100 字后）插 5 字')
await focus(100)
await type('XXXXX', 700)
s = await state()
check('总长度', s.len === 305, `len=${s.len}`)
check('光标=105', s.sel === 105, `sel=${s.sel}`)

// ---------------------------------------------------------------- 3 连续退格
console.log('\n【L3】中间连续退格 10 次')
for (let i = 0; i < 10; i++) await key('Backspace', 'Backspace', 8, 0, 120)
s = await state()
check('总长度=295', s.len === 295, `len=${s.len}`)
check('光标=95', s.sel === 95, `sel=${s.sel}`)

// ---------------------------------------------------------------- 4 换行
// ⚠️ 不能用 dispatchKeyEvent 敲 Enter：实测（ide-enter-diag.mjs）只有 keydown/keypress
//    到达元素，**不产生 beforeinput** ⇒ 文本不会变。这是 CDP 模拟按键的局限，不是组件问题。
//    真实回车走的路径是 beforeinput(inputType=insertLineBreak)，用 insertText('\n')
//    产出的正是同一条路径，因而是等价模拟。
console.log('\n【L4】中间插入换行（等价回车）')
await focus(95)
await type('\n', 700)
s = await state()
const nlCount = (s.value.match(/\n/g) || []).length
check('出现换行符', nlCount === 1, `换行数=${nlCount} len=${s.len}`)
check('光标=96', s.sel === 96, `sel=${s.sel}`)

// ---------------------------------------------------------------- 5 粘贴
console.log('\n【L5】粘贴一整段（剪贴板 → Ctrl+V）')
const paste = '粘贴进来的长句子，用于验证长文本一次性写入。'.repeat(5)
let pasted = false
try {
  await cdp.eval(`navigator.clipboard.writeText(${JSON.stringify(paste)})`)
  await focus(0)
  const before = (await state()).len
  await key('v', 'KeyV', 86, 2, 800) // modifiers=2 → Ctrl
  s = await state()
  pasted = s.len > before
  if (pasted) {
    check('粘贴后长度增加', s.len === before + paste.length, `len=${s.len}（+${s.len - before}，期望 +${paste.length}）`)
    check('光标落在粘贴内容之后', s.sel === paste.length, `sel=${s.sel}`)
  } else {
    skip('粘贴', '模拟器剪贴板不可用（原生未收到 Ctrl+V）')
  }
} catch (e) {
  skip('粘贴', 'clipboard API 不可用：' + String(e.message).slice(0, 40))
}

// ---------------------------------------------------------------- 6 maxlength 边界
console.log('\n【L6】maxlength 边界')
s = await state()
const max = Number(s.max)
if (max > 0) {
  await clearAll()
  await focus(0)
  await type('字'.repeat(max - 1), 1200)
  s = await state()
  check(`写到 ${max - 1} 字`, s.len === max - 1, `len=${s.len}`)
  await type('尾巴尾巴尾巴', 900)
  s = await state()
  check(`超限后被截断到 ${max}`, s.len === max, `len=${s.len}（期望 ${max}）`)
  check('光标停在末尾', s.sel === s.len, `sel=${s.sel} len=${s.len}`)
  // 超限后再做一次中间编辑，看页面 state 会不会把超长值灌回来
  await focus(10)
  await type('A', 700)
  s = await state()
  check(`中间插字仍是 ${max}`, s.len === max, `len=${s.len}`)
} else {
  skip('maxlength 边界', `该框 maxlength=${s.max}（未设上限，不能触发截断）`)
}

// ---------------------------------------------------------------- 7 撤销
console.log('\n【L7】撤销（Ctrl+Z）')
await clearAll()
await focus(0)
await type('ABC', 600)
await type('DEF', 700)
s = await state()
check('先打成 ABCDEF', s.len === 6, `len=${s.len} value=${JSON.stringify(s.value)}`)
await key('z', 'KeyZ', 90, 2, 900)
s = await state()
const undone = s.len === 3
check('撤销后回退到 ABC', undone, `len=${s.len} value=${JSON.stringify(s.value)}`)
if (!undone) console.log('    ⚠️ 原生撤销被页面 state 顶回 —— 受控输入框的已知取舍，需评估是否可接受')

// ---------------------------------------------------------------- 8 重做
console.log('\n【L8】重做（Ctrl+Y）')
await key('y', 'KeyY', 89, 2, 900)
s = await state()
check('重做后回到 ABCDEF', s.len === 6, `len=${s.len} value=${JSON.stringify(s.value)}`)

// ---------------------------------------------------------------- 收尾
await clearAll()
console.log(`\n${fails === 0 ? '✅ 全部通过' : `🔴 失败 ${fails} 处`}${skips ? `（跳过 ${skips} 项）` : ''}`)
cdp.close()
