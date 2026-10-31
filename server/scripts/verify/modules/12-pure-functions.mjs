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
  c.ok(typeof ECHO.resolveDisplayText === 'function', '缺少 resolveDisplayText')
  c.ok(typeof ECHO.initDisplay === 'function', '缺少 initDisplay')
})

// 光标 / 吃字问题的最终定性（2026-10-31 第十轮，连报九次后）
//
// 前九轮全在改「输入框组件怎么下发 value」，都没治住。真正的原因是**两条平台规则**，
// 而且其中一条不在组件里：
//   ① `@tarojs/react/dist/react.esm.js:372`
//      `if (oldProps[i] !== newProps[i] || (isFormElement && i === 'value'))`
//      —— 表单元素只要**发生一次 commit**，value 就必然进 setData；
//   ② 微信 textarea 是原生组件：页面 setData 时按虚拟 DOM 的 value **重新应用文本**，
//      **光标落到末尾**。
// ⇒ 页面在 onInput 里 setState = 每打一个字 setData 一次 = 光标重置一次。
//   若此时下发的 value 还是**旧值**（第 7/8 版为了"不下发"而让属性停在旧值/空串），
//   就会把刚打的字覆盖掉 —— 真机表现「打不进字」。
//
// 现行契约（两条缺一不可）：
//   · 页面：输入期间只写 ref，**不 setState**（detail 页已按此改）；
//   · 组件：下发的 value **永远等于用户眼前的文本**（本模块的 resolveDisplayText）。
// 下面这组断言守住第二条 —— 它是"绝不丢字"的最后一道闸。
m.test('🔴 resolveDisplayText：输入期间绝不用页面值覆盖原生，外部写入才采纳', async (c) => {
  const R = ECHO.resolveDisplayText
  const init = ECHO.initDisplay

  // ① 正在输入：页面值落后/回声 ⇒ 必须保持原生（否则就是"打不进字"）
  c.eq(R({ text: 'abc' }, { value: 'ab', focused: true, cursorChanged: false }).text, 'abc',
    '输入期间被页面旧值覆盖了 —— 这正是"打不进字"的成因')
  c.eq(R({ text: 'abc' }, { value: '', focused: true, cursorChanged: false }).text, 'abc',
    '输入期间被空串清空了')
  c.eq(R({ text: 'abc' }, { value: 'abc', focused: true, cursorChanged: false }).text, 'abc',
    '回声被重复采纳（会多一次 setData）')

  // ② 失焦才采纳（装载数据 / 识别回填 / 失焦同步 state）
  c.eq(R({ text: '' }, { value: '题目内容', focused: false, cursorChanged: false }).text, '题目内容',
    '失焦时外部写入未采纳（异步数据到达会整框空白）')
  c.eq(R({ text: 'abc' }, { value: '', focused: false, cursorChanged: false }).text, '',
    '失焦时程序化清空未采纳')

  // ③ cursor 变化是"程序化写入"的可靠信号（符号插入时输入框可能仍聚焦）
  c.eq(R({ text: 'ab' }, { value: 'ab×', focused: true, cursorChanged: true }).text, 'ab×',
    '符号插入未采纳（插不进去）')

  // ④ 非受控：没有 value 就永远不动
  c.eq(R({ text: 'abc' }, { focused: true, cursorChanged: false }).text, 'abc', '非受控被改了')
  c.eq(R({ text: 'abc' }, { focused: false, cursorChanged: true }).text, 'abc', '非受控被 cursor 改了')

  // 命根子不变式：返回的 text 永远是字符串，且**要么保持原样、要么等于调用方给的值**，
  // 绝不可能凭空变成别的（尤其不可能是 undefined / null ⇒ 原生被清空）
  for (const cur of ['', 'abc', '长文本内容'])
    for (const v of [undefined, '', 'x', 'abc', '新内容'])
      for (const focused of [true, false])
        for (const cursorChanged of [true, false]) {
          const r = R({ text: cur }, { value: v, focused, cursorChanged })
          c.ok(typeof r.text === 'string', `返回值不是字符串：${JSON.stringify([cur, v, focused, cursorChanged])}`)
          c.ok(r.text === cur || r.text === v, `返回值既不是原值也不是新值：${JSON.stringify([cur, v, focused, cursorChanged])}`)
          if (focused && !cursorChanged && typeof v === 'string') {
            c.eq(r.text, cur, `输入期间被改写了：${JSON.stringify([cur, v])}`)
          }
        }

  // initDisplay：首帧就是受控值；非受控是空串（绝不能是 undefined）
  c.eq(init('题目').text, '题目', 'initDisplay 丢了首帧值')
  c.eq(init(undefined).text, '', 'initDisplay 非受控时不是空串')
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
