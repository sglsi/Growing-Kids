// 光标跳末尾问题的**行为复现器**（2026-10-31 第六轮后新建）
//
// 为什么需要它：这个 bug 连报六次，前五轮全是"改一版 → 真机试 → 换一处猜"，
// 每次都能修好被报告的那一种触发条件，下一种照跳。缺的不是补丁，是**可复现的模型**。
//
// 本脚本做三件事：
//   1. 把「Taro 受控更新链路 + 微信 textarea 的平台规则」显式建模（下面 Platform 类）；
//   2. 用**真实的** caret-decision.ts（tsc 单编后 import）算光标，跑真实输入序列；
//   3. 把"现状方案"和"回声吸收方案"放在同一个模型下对比，看光标落到哪。
//
// 用法：node scripts/repro-caret.mjs
//
// ⚠️ 模型参数来自官方文档而非猜测，见 Platform 类顶部注释。

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
 * 微信 textarea 的平台规则模型。
 *
 * 依据官方文档——两个属性的定义本身就是规则：
 *   · `value`  ：文本内容。受控时每次被 setData 且文本不同，原生文本重建。
 *   · `cursor` ：**「指定 focus 时的光标位置」**。原文如此，不是"任意时刻的光标"。
 *
 * 由此推出两条：
 *   R1  文本被重建 ⇒ 光标落到末尾。（这就是"跳末尾"本身）
 *   R2  `cursor` 只在 **focus 边沿**被采纳（本次渲染把 focus 置 true，
 *       或输入框正处于聚焦建立的那一拍）；普通输入过程中写 cursor **不生效**。
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
    if (changed.length === 0) return changed

    // R1：`value` 属性被下发 ⇒ 渲染层按新值重建文本、光标落到末尾。
    //
    // ⚠️ 判断依据是 **props 层面的变化**（这次渲染的 value 与上次 props 不同），
    //    不是"与原生当前文本不同"。这是本模型的关键，也是我前几轮一直想错的地方：
    //    受控输入框里页面 state 跟着用户输入走 ⇒ **每次输入 props.value 都会变** ⇒
    //    每次都会下发 ⇒ 每次都重置光标。哪怕页面 state 恰好等于原生文本也一样 ——
    //    因为 Taro 比的是上一帧的 props，不是原生。
    if (changed.includes('value') && typeof next.value === 'string') {
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
    log.push({ step: step.label, want: step.caret, got: platform.caret, sent: sent.join('+') })
  }
  return log
}

/**
 * 方案 B：回声吸收（页面 state 照常更新，但页面回声的值不下发）
 * 关键：`value` 属性在用户输入期间**保持不变** ⇒ R1 不触发 ⇒ 光标零干预。
 */
function runEcho(platform, steps) {
  // 直接用**真实实现**（src/utils/textarea-echo.ts），不在这里重写一遍逻辑
  let st = { native: platform.text, last: platform.text }
  const log = []

  for (const step of steps) {
    // —— 输入法作用于原生
    platform.type(step.next, step.caret)
    // —— onInput：先记录原生真相
    st = ECHO.recordNativeInput(st, step.next)
    // —— 渲染：页面回声回来的同值被吸收 ⇒ 下发值仍是上一次的 last（属性不变）
    const r = ECHO.resolveEchoValue(st, step.next)
    st = r.state
    const sent = platform.render({ value: r.value, cursor: -1, focus: true })
    log.push({ step: step.label, want: step.caret, got: platform.caret, sent: sent.join('+') || '(空)' })
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
console.log('='.repeat(78))
console.log('光标跳末尾 · 行为复现器')
console.log('='.repeat(78))
console.log('平台模型 R1：value 被下发且文本变化 ⇒ 光标置到末尾')
console.log('平台模型 R2：cursor 只在 focus 边沿被采纳（官方定义："指定 focus 时的光标位置"）')
console.log('')

let badA = 0
let badB = 0

for (const cs of CASES) {
  const a = runControlled(new Platform(cs.init), cs.steps)
  const b = runEcho(new Platform(cs.init), cs.steps)
  console.log('▸ ' + cs.name)
  console.log('  ' + pad('步骤', 16) + pad('期望光标', 10) + pad('现状(受控+cursor)', 20) + '回声吸收')
  cs.steps.forEach((s, i) => {
    const ra = a[i]
    const rb = b[i]
    const okA = ra.got === ra.want ? '✓' : '✗ 跳末尾'
    const okB = rb.got === rb.want ? '✓' : '✗'
    if (ra.got !== ra.want) badA++
    if (rb.got !== rb.want) badB++
    console.log(
      '  ' + pad(s.label, 16) + pad(s.caret, 10) +
      pad(`${ra.got} ${okA}`, 20) + `${rb.got} ${okB}`,
    )
  })
  console.log('')
}

console.log('='.repeat(78))
console.log(`现状方案（受控 + cursor）：失败 ${badA} 处`)
console.log(`回声吸收方案（value 不下发）：失败 ${badB} 处`)
console.log('='.repeat(78))

// 反证：如果平台真的采纳同批 cursor（乐观模型），现状方案就该是对的 ——
// 这解释了前几轮为什么"看起来可行"，也说明必须靠 R2 这个平台事实来判。
console.log('')
console.log('【反证】把模型换成"cursor 同批即生效"（乐观假设）：')
const optimistic = runControlled(new Platform('hello world', { cursorAnyTime: true }), CASES[0].steps)
console.log(`  中间打标点 → 光标 ${optimistic[0].got}（期望 ${optimistic[0].want}）`)
console.log('  ⇒ 乐观假设下现状方案成立，这正是前五轮反复"以为修好了"的原因。')
console.log('  ⇒ 平台的真实规则是 R2，所以只要 value 还在下发，光标就必然被重置。')
console.log('')
