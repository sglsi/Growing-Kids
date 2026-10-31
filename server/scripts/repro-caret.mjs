// 光标跳末尾问题的**行为复现器**（2026-10-31 第六轮后新建，第八轮按 Taro 源码纠正模型）
//
// 为什么需要它：这个 bug 连报七次，前六轮全是"改一版 → 真机试 → 换一处猜"，
// 每次都能修好被报告的那一种触发条件，下一种照跳。缺的不是补丁，是**可复现的模型**。
//
// 本脚本做三件事：
//   1. 把「Taro 受控更新链路 + 微信 textarea 的平台规则」显式建模（下面 Platform 类）；
//   2. 用**真实的** caret-decision.ts / textarea-echo.ts（tsc 单编后 import）跑真实输入序列；
//   3. 三代方案放在同一个模型下对比：受控、回声吸收（已作废）、阻断渲染（现行）。
//
// 用法：node scripts/repro-caret.mjs
//
// ⚠️ 模型参数来自官方文档 **和框架源码**，不是常识推断。
//    第七轮就是拿"框架会 diff，值不变就不更新"这个常识当规则，结果模型和现实一起错，
//    方案（回声吸收）在模型里全绿、在真机上把字打没了。

import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'

const ROOT = path.resolve(process.cwd(), '..')
const TMP = path.join(ROOT, '.tmp', 'repro-caret')
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

function compile(entry) {
  fs.mkdirSync(TMP, { recursive: true })
  execFileSync(
    process.execPath,
    [TSC, entry, '--outDir', TMP, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck', '--lib', 'es2019,dom'],
    { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' },
  )
}

compile('src/utils/caret-decision.ts')
compile('src/utils/textarea-echo.ts')
const CARET = await import(`file://${path.join(TMP, 'caret-decision.js').replace(/\\/g, '/')}`)
const ECHO = await import(`file://${path.join(TMP, 'textarea-echo.js').replace(/\\/g, '/')}`)

/**
 * 微信 textarea + Taro 渲染链的平台规则模型。
 *
 * 依据官方文档与框架源码——三处定义本身就是规则：
 *   · `value`  ：文本内容。被 setData 就按它重建原生文本。
 *   · `cursor` ：**「指定 focus 时的光标位置」**。原文如此，不是"任意时刻的光标"。
 *   · Taro 的 props diff（`@tarojs/react/dist/react.esm.js:366`）：
 *     `if (oldProps[i] !== newProps[i] || (isFormElement && i === 'value'))`
 *     —— 表单元素的 `value` **无条件进 setData**，跟值变没变毫无关系。
 *
 * 由此推出三条：
 *   R1  只要这次渲染的 props 里**有 value 键**，文本就按它重建、光标落到末尾。
 *       **"值没变"不构成豁免** —— 这是第七轮判错的地方。
 *   R2  `cursor` 只在 **focus 边沿**被采纳（本次渲染把 focus 置 true，
 *       或输入框正处于聚焦建立的那一拍）；普通输入过程中写 cursor **不生效**。
 *   R3  唯一能让 R1 不发生的办法是**这一帧不要 render**（React 元素引用不变 ⇒ bailout
 *       ⇒ 没有 commitUpdate ⇒ 没有 setData）。见方案 C。
 *
 * R2 是全案最容易被忽略的一条，也是前五轮的盲点：
 *   —— 为什么"程序化插入数学符号"从第一轮起就正常？因为那条路径调了 `refocus()`，
 *      凭空造出了一个 focus 边沿，cursor 于是被采纳。
 *   —— 为什么普通输入写多少 cursor 都没用？因为输入过程中没有 focus 边沿。
 */
class Platform {
  constructor(text = '', opts = {}) {
    this.text = text
    this.caret = text.length
    // ⚠️ 初始 focus = true：用户已经在框里打字了。
    //    这一点是复现的关键 —— 如果初始 focus=false，第一帧渲染就成了 focus 边沿，
    //    cursor 会被采纳一次，症状表现为"第一步对、后面才错"。
    this.props = { value: text, cursor: -1, focus: true }
    /** false = 按官方定义（cursor 只在 focus 边沿生效）；true = 乐观假设（同批即生效） */
    this.cursorAnyTime = !!opts.cursorAnyTime
  }

  /**
   * 走一帧渲染：React 给出新 props → Taro diff 出变化的属性 → setData → 平台应用。
   * @returns 本帧真正被下发的属性名
   */
  render(next) {
    const changed = []
    for (const k of Object.keys(next)) {
      if (!Object.is(this.props[k], next[k])) changed.push(k)
    }
    this.props = { ...next }

    // R1：**只要 props 里有 value 键，本帧就下发**（Taro 对 FormElement 无条件处理）。
    //
    // ⚠️ 第七轮的模型在这里写的是"value 变了才下发"，于是回声吸收（下发不变的旧值）
    //    在模型里全绿。真实规则是"键存在就下发"—— 于是同样的方案在真机上
    //    每帧都把用户刚打的字覆盖回旧值，表现为"输不进任何内容"。
    //    这是"拿常识当规则"的代价：模型跟着一起错，跑得再绿也没有意义。
    if (Object.prototype.hasOwnProperty.call(next, 'value') && typeof next.value === 'string') {
      this.text = next.value
      this.caret = this.text.length
    }
    // R2：cursor 是否被采纳
    const focusEdge = changed.includes('focus') && next.focus === true
    const cursorUsable = this.cursorAnyTime
      ? changed.includes('cursor')
      : focusEdge
    if (cursorUsable && typeof next.cursor === 'number' && next.cursor >= 0) {
      this.caret = Math.min(next.cursor, this.text.length)
    }
    return changed
  }

  /** 输入法把编辑结果直接写进原生（这一步不经过 React） */
  type(nextText, caretAfter) {
    this.text = nextText
    this.caret = typeof caretAfter === 'number' ? caretAfter : nextText.length
  }
}

/**
 * 方案 A：现状（标准受控 + 每次输入把 diffCursor 算出的位置写进 cursor）
 * 每一帧都下发 value（因为页面 state 变了，props.value 必然变）。
 */
function runControlled(platform, steps) {
  let pageText = platform.text
  let prevValue = pageText
  let live = platform.caret
  const log = []

  for (const step of steps) {
    // —— 输入法作用于原生
    platform.type(step.next, step.caret)
    // —— onInput：页面 setState + useCaret.track（同一回调 ⇒ 同批渲染）
    // 这里是第 4~6 版的算法：用 diffCursor 算出"正确位置"并下发（不采信 detail.cursor）
    const cur = CARET.diffCursor(prevValue, step.next, live)
    prevValue = step.next
    pageText = step.next
    if (cur !== null) live = cur
    // —— 渲染：value 一定是新文本（受控），cursor 是本拍算出的值
    const sent = platform.render({ value: pageText, cursor: live, focus: true })
    log.push({ step: step.label, want: step.caret, got: platform.caret, text: platform.text, sent: sent.join('+') })
  }
  return log
}

/**
 * 方案 B：回声吸收（**第七版，已作废，保留作对照**）
 *
 * 当时的想法：用户输入期间下发"上一次的值"，指望 Taro 的 diff 认为属性没变而跳过。
 * 真实规则是 R1（键存在就下发）⇒ 每帧都把刚打的字覆盖回旧值 ⇒ 文本丢失。
 * 这里用一份本地复刻（原函数已随方案作废删除）跑给后人看。
 */
const LEGACY_ECHO = {
  record: (st, v) => (st.native === v ? st : { native: v, last: st.last }),
  resolve: (st, incoming) =>
    incoming === st.native
      ? { value: st.last, state: st }
      : { value: incoming, state: { native: incoming, last: incoming } },
}

function runEcho(platform, steps) {
  let st = { native: platform.text, last: platform.text }
  const log = []

  for (const step of steps) {
    // —— 输入法作用于原生
    platform.type(step.next, step.caret)
    // —— onInput：先记录原生真相
    st = LEGACY_ECHO.record(st, step.next)
    // —— 渲染：页面回声回来的同值被"吸收" ⇒ 下发值仍是上一次的 last（属性不变）
    const r = LEGACY_ECHO.resolve(st, step.next)
    st = r.state
    const sent = platform.render({ value: r.value, cursor: -1, focus: true })
    log.push({ step: step.label, want: step.caret, got: platform.caret, text: platform.text, sent: sent.join('+') })
  }
  return log
}

/**
 * 方案 C：阻断渲染（**现行实现**，见 src/components/ui/textarea.tsx）
 *
 * 输入期间**根本不让这一帧发生**：元素引用不变 ⇒ React bailout ⇒ 没有 commitUpdate
 * ⇒ 没有 setData ⇒ 平台连 value 都收不到 ⇒ 光标一次都不会被动。
 * 只有外部写入（`push=true`）才渲染一次，且那一次下发的永远是当下最新值。
 */
function runBlocked(platform, steps) {
  let st = ECHO.initEcho(platform.text)
  const log = []

  for (const step of steps) {
    // —— 输入法作用于原生
    platform.type(step.next, step.caret)
    // —— onInput：记录原生真相
    st = ECHO.reduceEcho(st, { kind: 'native', value: step.next }).state
    // —— 渲染：判定要不要重建元素
    const r = ECHO.reduceEcho(st, { kind: 'prop', value: step.next })
    st = r.state
    const sent = r.push ? platform.render({ value: step.next, focus: true }) : []
    log.push({
      step: step.label,
      want: step.caret,
      got: platform.caret,
      text: platform.text,
      sent: sent.join('+') || '(未渲染)',
    })
  }
  return log
}

/** 在 "hello world" 的第 5 个字符后（hello| world）做各种编辑 */
const mid = (label, from, to, caretAfter, extra = {}) => ({ label, next: to, caret: caretAfter, eventCursor: 99, ...extra })

const CASES = [
  {
    name: '在句子中间打英文标点（思傅报的场景）',
    init: 'hello world',
    steps: [mid('打逗号', 'hello world', 'hello, world', 6)],
  },
  {
    name: '在句子中间打英文空格',
    init: 'helloworld',
    steps: [mid('打空格', 'helloworld', 'hello world', 6)],
  },
  {
    name: '英文单词后打句号，再继续打字',
    init: 'abcdef',
    steps: [
      mid('打句号', 'abcdef', 'abc.def', 4),
      mid('再打字母', 'abc.def', 'abc.dXef', 5),
    ],
  },
  {
    name: '快速连续删除（**中间**位置 —— 思傅说的"有时好有时坏"就是这里）',
    init: 'abcdefgh',
    steps: [
      mid('删中间那个', 'abcdefgh', 'abcefgh', 3),
      mid('再删一个', 'abcefgh', 'abcfgh', 3),
      mid('继续删', 'abcfgh', 'abfgh', 2),
    ],
  },
  {
    name: '从末尾往前删（对照：期望位置恰好也是末尾，所以看不出问题）',
    init: 'abcdefgh',
    steps: [mid('末尾删', 'abcdefgh', 'abcdefg', 7)],
  },
  {
    name: '末尾正常追加（对照，看不出问题）',
    init: 'abc',
    steps: [mid('末尾打标点', 'abc', 'abc.', 4)],
  },
]

const pad = (s, n) => {
  const w = [...String(s)].reduce((a, ch) => a + (ch.charCodeAt(0) > 127 ? 2 : 1), 0)
  return String(s) + ' '.repeat(Math.max(0, n - w))
}

console.log('')
console.log('='.repeat(92))
console.log('光标跳末尾 · 行为复现器')
console.log('='.repeat(92))
console.log('平台模型 R1：props 里出现 value 键就下发 ⇒ 文本按它重建、光标置末尾（与"变没变"无关）')
console.log('平台模型 R2：cursor 只在 focus 边沿被采纳（官方定义："指定 focus 时的光标位置"）')
console.log('平台模型 R3：不 render ⇒ 没有 setData ⇒ 平台完全不知情（这才是解法）')
console.log('')

let badA = 0
let badB = 0
let badC = 0
let lostB = 0

for (const cs of CASES) {
  const a = runControlled(new Platform(cs.init), cs.steps)
  const b = runEcho(new Platform(cs.init), cs.steps)
  const c = runBlocked(new Platform(cs.init), cs.steps)
  console.log('▸ ' + cs.name)
  console.log(
    '  ' + pad('步骤', 14) + pad('期望', 6) +
    pad('受控+钉cursor', 18) + pad('回声吸收(作废)', 20) + '阻断渲染(现行)',
  )
  cs.steps.forEach((s, i) => {
    const ra = a[i]
    const rb = b[i]
    const rc = c[i]
    const okA = ra.got === ra.want ? '✓' : '✗ 跳末尾'
    const rbLost = rb.text !== s.next
    const okB = rbLost ? '✗ 丢字' : rb.got === rb.want ? '✓' : '✗ 跳末尾'
    const okC = rc.got === rc.want && rc.text === s.next ? '✓' : '✗'
    if (ra.got !== ra.want) badA++
    if (rbLost) lostB++
    if (rb.got !== rb.want) badB++
    if (rc.got !== rc.want || rc.text !== s.next) badC++
    console.log(
      '  ' + pad(s.label, 14) + pad(s.caret, 6) +
      pad(`${ra.got} ${okA}`, 18) + pad(`${rb.got} ${okB}`, 20) + `${rc.got} ${okC}`,
    )
  })
  console.log('')
}

console.log('='.repeat(92))
console.log(`受控 + 钉 cursor：        光标失败 ${badA} 处`)
console.log(`回声吸收（第七版，作废）：光标失败 ${badB} 处，其中**丢字 ${lostB} 处** ← 真机上就是"打不进字"`)
console.log(`阻断渲染（现行）：        失败 ${badC} 处`)
console.log('='.repeat(92))

// 反证一：如果平台真的采纳同批 cursor（乐观模型），受控方案就该是对的 ——
// 这解释了前几轮为什么"看起来可行"，也说明必须靠 R2 这个平台事实来判。
console.log('')
console.log('【反证一】把模型换成"cursor 同批即生效"（乐观假设）：')
const optimistic = runControlled(new Platform('hello world', { cursorAnyTime: true }), CASES[0].steps)
console.log(`  中间打标点 → 光标 ${optimistic[0].got}（期望 ${optimistic[0].want}）`)
console.log('  ⇒ 乐观假设下受控方案成立，这正是前几轮反复"以为修好了"的原因。')
console.log('  ⇒ 真实规则是 R2，所以只要 value 还在下发，光标就必然被重置。')

// 反证二：这是第七轮翻车的现场 —— 把 R1 写成"值变了才下发"，
// 回声吸收立刻变成"全绿"，而真机上它每帧都在覆盖用户刚打的字。
console.log('')
console.log('【反证二】把 R1 写成"value 变了才下发"（第七轮的错模型）：回声吸收会显示为 0 失败')
console.log('  ⇒ 同一份代码、同一个方案，模型里全绿、真机上丢字。')
console.log('  ⇒ 平台规则必须从源码/文档抠出来，不能拿常识推断。')

// 反证三：现行方案为什么安全 —— 它的唯一"放行口"下发的都是最新值。
console.log('')
console.log('【反证三】阻断渲染的外部写入路径（插入符号 / OCR 回填）：')
const ins = new Platform('hello world')
const pre = ECHO.reduceEcho(ECHO.initEcho('hello world'), { kind: 'prop', value: 'hello × world' })
console.log(`  push=${pre.push}（应为 true）⇒ 放行一次，下发值 = ${JSON.stringify('hello × world')}`)
ins.render({ value: 'hello × world', focus: true })
console.log(`  文本=${JSON.stringify(ins.text)} 光标=${ins.caret}（外部写入后落到末尾，随后由 refocus 定位）`)
console.log('  ⇒ 放行时携带的永远是当下最新值，最坏也只是光标落末尾，不可能丢字。')
console.log('')
