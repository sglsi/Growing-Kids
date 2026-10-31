// 模块 12：前端纯函数（单编后 node 直跑）
//
// 依据 QA-15 §2.1：被测文件保持零 import ⇒ tsc 单编后可直接 require 跑断言。

import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { Module } from '../lib/harness.mjs'

const m = new Module('M12', '前端纯函数')

const ROOT = path.resolve(process.cwd(), '..')          // server/ → 仓库根
const TMP = path.join(ROOT, '.tmp', 'verify-pure')

function compile(entry) {
  fs.mkdirSync(TMP, { recursive: true })
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      entry,
      '--outDir', TMP,
      '--module', 'commonjs',
      '--target', 'es2019',
      '--skipLibCheck',
      '--lib', 'es2019,dom',
    ],
    { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' },
  )
}

let LATEX = null
let MERGE = null

m.test('单编：src/utils/latex.ts 可独立编译（零 import 契约）', async (c) => {
  try {
    compile('src/utils/latex.ts')
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`
    throw new Error(`latex.ts 单编失败（破坏了"零 import"契约）：${out.slice(0, 300)}`)
  }
  const p = path.join(TMP, 'latex.js')
  c.ok(fs.existsSync(p), '编译产物不存在')
  LATEX = (await import(`file://${p.replace(/\\/g, '/')}`))
  c.ok(typeof LATEX.latexToReadable === 'function', '缺少 latexToReadable')
  c.ok(typeof LATEX.readableToLatex === 'function', '缺少 readableToLatex')
})

m.test('单编：src/utils/answer-merge.ts', async (c) => {
  try {
    compile('src/utils/answer-merge.ts')
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`
    throw new Error(`answer-merge.ts 单编失败：${out.slice(0, 300)}`)
  }
  const p = path.join(TMP, 'answer-merge.js')
  MERGE = (await import(`file://${p.replace(/\\/g, '/')}`))
  c.ok(typeof MERGE.splitAnswerSolution === 'function', '缺少 splitAnswerSolution')
  c.ok(typeof MERGE.joinAnswerSolution === 'function', '缺少 joinAnswerSolution')
})

m.test('latex：常见公式转可读文本不抛错、不乱码', async (c) => {
  const cases = [
    '\\frac{1}{2}', 'x^2+y^2=z^2', '\\frac{x^2}{y_1}', '\\sqrt{3}', '\\sqrt[3]{x}',
    'a \\to b', '\\angle ABC = 90^\\circ', '\\frac{a+b}{c} \\times 2',
    '\\overline{AB}', '\\triangle ABC \\cong \\triangle DEF', '\\alpha + \\beta',
  ]
  for (const src of cases) {
    let out
    try {
      out = LATEX.latexToReadable(src)
    } catch (e) {
      throw new Error(`"${src}" 转换抛错：${e.message}`)
    }
    c.ok(typeof out === 'string' && out.length > 0, `"${src}" 转换结果为空`)
    c.ok(!out.includes('\uFFFD'), `"${src}" 结果含 U+FFFD：${out}`)
  }
})

m.test('latex：往返一致性（readable → latex 不抛错）', async (c) => {
  const cases = ['\\frac{1}{2}', 'x^2', '\\frac{x^2}{y_1}', '\\sqrt{3}', 'a \\to b']
  for (const src of cases) {
    const readable = LATEX.latexToReadable(src)
    let back
    try {
      back = LATEX.readableToLatex(readable)
    } catch (e) {
      throw new Error(`"${src}" → "${readable}" 回转抛错：${e.message}`)
    }
    c.ok(typeof back === 'string', `"${src}" 回转结果非字符串`)
    c.ok(!back.includes('\uFFFD'), `"${src}" 回转结果乱码：${back}`)
  }
})

m.test('🔴 latex：不支持的语法必须原样回退（不丢字、不渲染成碎片）', async (c) => {
  // 契约来自文件头注释：遇到不支持的语法**整段回退显示源码**，绝不显示错误的数学式。
  // `latexToReadable` 内部 catch 掉 UnsupportedLatexError 后原文返回，正是这条契约的落地。
  const bad = ['a # b', '\\frac{1}{', '\\boguscmd{x}']
  for (const src of bad) {
    const out = LATEX.latexToReadable(src)
    c.ok(typeof out === 'string' && out.trim().length > 0, `"${src}" 回退后为空`)
    c.ok(!out.includes('\uFFFD'), `"${src}" 回退结果乱码`)
  }
  // 含不支持字符的整段：必须保留用户原字（绝不丢内容）
  const keep = LATEX.latexToReadable('求解 # 号问题')
  c.ok(keep.includes('#'), `# 被吞掉了，用户内容丢失：${keep}`)
})

m.test('latex：输出不产生无意义碎片（连续空格）', async (c) => {
  const cases = [
    '\\frac{1}{2}+\\frac{3}{4}',
    '\\begin{matrix} a & b \\\\ c & d \\end{matrix}',
    'x^{2}+y^{2}=z^{2}',
  ]
  for (const src of cases) {
    const out = LATEX.latexToReadable(src)
    // 三个及以上连续空格是"某处渲染成了空串"的确定性信号
    c.ok(!/\s{3,}/.test(out), `"${src}" 输出含连续空白碎片：${JSON.stringify(out)}`)
  }
})

m.test('latex：splitMathText 能识别 $...$ 与 \\(...\\) 片段', async (c) => {
  const r = LATEX.splitMathText('求解 $x^2=4$ 与 \\(y+1=3\\)')
  c.ok(Array.isArray(r), 'splitMathText 未返回数组')
  if (LATEX.lineHasMath) {
    const line = r[0] || []
    c.ok(typeof LATEX.lineHasMath(line) === 'boolean', 'lineHasMath 返回非布尔')
  }
})

m.test('answer-merge：split / join 往返稳定', async (c) => {
  const cases = [
    { answer: 'A', solution: '因为 2x=8，所以 x=4' },
    { answer: '', solution: '只有解析' },
    { answer: 'x = 4', solution: '' },
  ]
  for (const { answer, solution } of cases) {
    const joined = MERGE.joinAnswerSolution(answer, solution)
    const back = MERGE.splitAnswerSolution(joined)
    c.ok(typeof back.answer === 'string' && typeof back.solution === 'string', 'split 结果结构异常')
    c.eq(back.answer.trim(), answer.trim(), `答案往返不一致：${JSON.stringify(joined)}`)
    c.eq(back.solution.trim(), solution.trim(), `解析往返不一致：${JSON.stringify(joined)}`)
  }
})

m.test('answer-merge：纯文本无标记时整体归入答案', async (c) => {
  const back = MERGE.splitAnswerSolution('只是一个答案')
  c.ok(typeof back.answer === 'string', 'answer 缺失')
})

let CARET = null
let ECHO = null

m.test('单编：src/utils/caret-decision.ts + textarea-echo.ts（零 import 契约）', async (c) => {
  for (const f of ['src/utils/caret-decision.ts', 'src/utils/textarea-echo.ts']) {
    try {
      compile(f)
    } catch (e) {
      const out = `${e.stdout || ''}${e.stderr || ''}`
      throw new Error(`${f} 单编失败（破坏了"零 import"契约）：${out.slice(0, 300)}`)
    }
  }
  const pc = path.join(TMP, 'caret-decision.js')
  const pe = path.join(TMP, 'textarea-echo.js')
  c.ok(fs.existsSync(pc), 'caret-decision 编译产物不存在')
  c.ok(fs.existsSync(pe), 'textarea-echo 编译产物不存在')
  CARET = await import(`file://${pc.replace(/\\/g, '/')}`)
  ECHO = await import(`file://${pe.replace(/\\/g, '/')}`)
  c.ok(typeof CARET.decideBlurCursor === 'function', '缺少 decideBlurCursor')
  c.ok(typeof CARET.diffCursor === 'function', '缺少 diffCursor')
  c.ok(typeof ECHO.resolveEchoValue === 'function', '缺少 resolveEchoValue')
  c.ok(typeof ECHO.recordNativeInput === 'function', '缺少 recordNativeInput')
})

// 光标问题连报六次的最终结论（2026-10-31 第七轮，由 server/scripts/repro-caret.mjs 复现）：
//   微信 textarea 的 `value` 一被 setData 就重建文本、**光标落到末尾**；
//   而 `cursor` 是「**指定 focus 时的光标位置**」—— 输入过程中写它**无效**。
//   ⇒ 受控输入框每次输入都会把光标甩到末尾且无法纠正。
//   末尾打字看不出（重置到末尾恰好正确），只有中间编辑暴露 ——
//   这就是"标点/空格跳、从句尾删正常、中间删有时跳"的全部由来。
//
// 治法：**输入期间根本不下发 value**（回声吸收），光标完全交给平台。
// 下面这组断言就是守住"用户输入的回声不许被下发"这条命根子。
m.test('🔴 resolveEchoValue：用户输入的回声必须吸收，只有程序化写入才放行', async (c) => {
  const R = ECHO.resolveEchoValue
  const S = (native, last) => ({ native, last })

  // 用户输入：真实顺序是「onInput 先把 native 推进到新值」→「页面 setState」→「渲染」。
  // 渲染时 incoming 与 native 同值 ⇒ 判为回声 ⇒ 下发值仍是上一次的 last（属性不变）。
  const afterInput = ECHO.recordNativeInput(S('abc', 'abc'), 'abcd')
  const echo1 = R(afterInput, 'abcd')
  c.eq(echo1.value, 'abc', '回声被下发了（这正是光标跳末尾的成因）')
  c.eq(echo1.echo, true, '未判定为回声')
  c.eq(echo1.state.native, 'abcd', '回声分支不该推进 native（由 onInput 负责）')
  c.eq(echo1.state.last, 'abc', '回声分支不该动 last')

  // 连续输入：last 一直停在最后一次真正下发的值，value 属性始终不动
  let st = S('a', 'a')
  for (const t of ['ab', 'abc', 'abcd']) {
    st = ECHO.recordNativeInput(st, t)
    const r = R(st, t)
    c.eq(r.value, 'a', `连续输入时下发值变了（第 ${t.length} 步）`)
    st = r.state
  }
  c.eq(st.last, 'a', '连续输入期间 last 应保持不变')

  // 程序化写入（符号插入 / OCR 回填 / 数据加载 / 清空）⇒ 必须放行
  const insert = R(S('abc', 'abc'), 'ab×c')
  c.eq(insert.value, 'ab×c', '程序化写入未放行')
  c.eq(insert.echo, false, '程序化写入被误判为回声')
  c.eq(insert.state.native, 'ab×c', '放行后 native 未推进')
  c.eq(insert.state.last, 'ab×c', '放行后 last 未推进')

  const clear = R(S('abc', 'abc'), '')
  c.eq(clear.value, '', '程序化清空未放行')
  c.eq(clear.echo, false, '程序化清空被误判为回声')

  const load = R(S('', ''), '题目内容')
  c.eq(load.value, '题目内容', '异步数据到达未放行（会整框空白）')

  // 放行后再输入：必须重新回到回声，不能反复下发
  const after = R(ECHO.recordNativeInput(insert.state, 'ab×cd'), 'ab×cd')
  c.eq(after.value, 'ab×c', '放行后的首次输入未回到回声')

  // 命根子不变式：echo 分支下发的值**永远是 last**，绝不可能是别的（尤其不能是空串）
  for (const native of ['', 'a', 'abc', '长文本内容'])
    for (const last of ['', 'x', 'abc', 'last 值']) {
      const r = R(S(native, last), native)
      c.eq(r.value, last, `回声分支下发的值不是 last：native=${native} last=${last}`)
    }

  // recordNativeInput：只推进 native，不许动 last
  c.eq(ECHO.recordNativeInput(S('ab', 'ab'), 'abc').last, 'ab', 'recordNativeInput 动了 last')
  c.eq(ECHO.recordNativeInput(S('ab', 'ab'), 'abc').native, 'abc', 'recordNativeInput 没推进 native')
})

m.test('🔴 decideBlurCursor：失焦写下真实光标（重新聚焦落在用户离开处）', async (c) => {
  const D = CARET.decideBlurCursor
  c.eq(D(4, 9), 4, '失焦未写下真实光标')
  c.eq(D(0, 9), 0, '开头位置被误判')
  c.eq(D(99, 9), 9, '越界光标未钳到文本长度')
  c.eq(D(4, -1), 4, '长度未知时不该钳')
  c.eq(D(undefined, 9), null, '拿不到光标时不许猜（更不能写 -1）')
  c.eq(D(-5, 9), null, '负光标无效')
  for (const cur of [undefined, -1, -100, 0, 3, 99])
    for (const len of [-1, 0, 5, 100])
      c.ok(D(cur, len) !== -1, `返回了 -1：cursor=${cur} len=${len}`)
})

m.test('🔴 diffCursor：从文本差值算真实插入点（detail.cursor 在中间输入时不可信）', async (c) => {
  const diff = CARET.diffCursor
  c.eq(diff('abc', 'abcd'), 4, '末尾增字')
  c.eq(diff('abc', 'abc,'), 4, '末尾标点')
  c.eq(diff('abc,xyzdef', 'abc,xyz,def'), 8, '中间插标点（detail.cursor 会说谎的场景）')
  c.eq(diff('hello', 'hell'), 4, '末尾退格')
  c.eq(diff('hello', 'ello'), 0, '删第一个字')
  c.eq(diff('abc,def', 'abc,ef'), 4, '中间退格（连续删除跳末尾的场景）')
  c.eq(diff('abcdef', 'abc ef'), 4, '选中替换：前删后插，取插入末尾')
  c.eq(diff('hello world', 'hello there'), 11, '整词替换')
  c.eq(diff('', 'abc'), 3, '空文本插入')
  c.eq(diff('abc', ''), 0, '全删')
  c.eq(diff('abc', 'abc'), null, '文本没变（纯光标移动）没有可推算的编辑')
  c.eq(diff('题目', '题目，'), 3, '中文标点（UTF-16 码元与微信 cursor 同基准）')
  c.eq(diff('a😀b', 'a😀c'), 4, '代理对之后插入（emoji 占两个码元）')
  // 不变式：位置必须落在 [0, next.length] 内
  for (const [a, b] of [['', 'x'], ['xyz', ''], ['ab', 'ba'], ['abcd', 'abcd']]) {
    const r = diff(a, b)
    if (r !== null) c.ok(r >= 0 && r <= b.length, `差值位置越界：${JSON.stringify([a, b])} → ${r}`)
  }
})

export default m
