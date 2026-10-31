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
  c.ok(typeof ECHO.reduceEcho === 'function', '缺少 reduceEcho')
  c.ok(typeof ECHO.initEcho === 'function', '缺少 initEcho')
})

// 光标问题连报七次的最终结论（2026-10-31 第八轮）：
//   微信 textarea 的 `value` 一被 setData 就重建文本、**光标落到末尾**；
//   而 `cursor` 是「**指定 focus 时的光标位置**」—— 输入过程中写它**无效**。
//   更要命的是 Taro 那层：`@tarojs/react/dist/react.esm.js:366`
//   `if (oldProps[i] !== newProps[i] || (isFormElement && i === 'value'))`
//   —— 表单元素的 value **无条件下发**，跟值变没变毫无关系。
//   ⇒ "受控"在 Taro 小程序端 = 每帧都重建原生文本 = 光标每帧落末尾，无解。
//   ⇒ 第七轮的"回声吸收"（下发一个不变的值）既救不了光标，还会把用户刚打的字
//     覆盖回旧值 —— 真机表现就是"打不进字"。已作废。
//
// 现行治法：**输入期间根本不让元素更新**（useMemo 缓存元素 ⇒ React bailout ⇒
// 没有 commitUpdate ⇒ 没有 setData）。下面这组断言守住这条命根子：
//   用户输入的每一步都必须 push=false，只有外部写入才 push 一次。
m.test('🔴 reduceEcho：用户输入零放行，只有外部写入才重建元素', async (c) => {
  const { reduceEcho, initEcho } = ECHO
  const native = (st, v) => reduceEcho(st, { kind: 'native', value: v })
  const prop = (st, v) => reduceEcho(st, { kind: 'prop', value: v })

  // 真实顺序：onInput 先把原生真相推进 → 页面 setState → 渲染（props.value 与之同值）
  let st = initEcho('')
  const typed = ['a', 'ab', 'abc', 'abc,', 'abc,d', 'abc,def']
  for (const t of typed) {
    const n = native(st, t)
    c.eq(n.push, false, `onInput 竟然放行了（${t}）`)
    st = n.state
    const p = prop(st, t)
    c.eq(p.push, false, `用户输入被当成外部写入放行了（${t}）—— 这正是光标跳末尾的成因`)
    st = p.state
  }
  c.eq(st.native, 'abc,def', '输入结束后原生真相与实际不符')

  // 中间删除：同样是回声，不许放行
  for (const t of ['abc,de', 'abc,d', 'abc,', 'abc']) {
    st = native(st, t).state
    c.eq(prop(st, t).push, false, `删除操作被放行了（${t}）—— 连续退格会跳末尾`)
  }

  // 外部写入（插入数学符号 / OCR 回填 / 清空 / 异步加载）⇒ 必须放行一次
  const insert = prop(st, 'ab×c')
  c.eq(insert.push, true, '外部写入未放行（符号插不进去）')
  c.eq(insert.state.native, 'ab×c', '放行后原生真相未推进（下次输入会被误判）')

  // 幂等：React 严格模式 / 并发重放会把同一次渲染跑两遍，第二遍不许再放行
  c.eq(prop(insert.state, 'ab×c').push, false, '同一外部写入被重复放行')

  // 一次放行后，用户接着打字必须立刻回到零放行
  const n2 = native(insert.state, 'ab×cd')
  c.eq(n2.push, false, 'onInput 放行了')
  c.eq(prop(n2.state, 'ab×cd').push, false, '放行后的首次输入未回到回声')

  // 清空与异步加载（首帧为空、数据后到）同样必须放行
  c.eq(prop(initEcho('abc'), '').push, true, '程序化清空未放行')
  c.eq(prop(initEcho(''), '题目内容').push, true, '异步数据到达未放行（会整框空白）')
  c.eq(prop(initEcho('abc'), 'abc').push, false, '挂载首帧被误判为外部写入')

  // 命根子不变式：凡是 push 的那一次，下发值必须**就是** incoming（绝不许是旧值）
  for (const from of ['', 'a', 'abc', '长文本内容'])
    for (const to of ['', 'x', 'ab×c', '新内容'])
      if (from !== to) {
        const r = prop(initEcho(from), to)
        c.ok(r.push, `外部写入未放行：${JSON.stringify([from, to])}`)
        c.eq(r.state.native, to, `放行时携带了旧值：${JSON.stringify([from, to])}`)
      }

  // native 步永远不放行（用户打的字原生已经有了，再下发只会甩光标）
  for (const a of ['', 'abc', '题目'])
    for (const b of ['', 'abcd', '题目，']) {
      const r = native(initEcho(a), b)
      c.eq(r.push, false, `onInput 放行了：${JSON.stringify([a, b])}`)
      c.eq(r.state.native, b, `onInput 未推进原生真相：${JSON.stringify([a, b])}`)
    }
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
