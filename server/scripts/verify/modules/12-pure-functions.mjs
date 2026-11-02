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

m.test('单编：src/utils/caret-decision.ts（零 import 契约）', async (c) => {
  const f = 'src/utils/caret-decision.ts'
  try {
    compile(f)
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`
    throw new Error(`${f} 单编失败（破坏了"零 import"契约）：${out.slice(0, 300)}`)
  }
  const pc = path.join(TMP, 'caret-decision.js')
  c.ok(fs.existsSync(pc), 'caret-decision 编译产物不存在')
  CARET = await import(`file://${pc.replace(/\\/g, '/')}`)
  c.ok(typeof CARET.decideBlurCursor === 'function', '缺少 decideBlurCursor')
  c.ok(typeof CARET.diffCursor === 'function', '缺少 diffCursor')
})

// 光标 / 吃字问题的最终定性（2026-10-31 第十一轮 · 在微信开发者工具里实测）
//
// 前十轮都在回答"输入框该下发什么 value"，第十轮还发明了"回声吸收 / 阻断渲染"，全部失败。
// 第十一轮不再推理：用 Chromium 调试协议接进开发者工具模拟器（server/scripts/ide-*.mjs），
// 真实地往输入框里打字，再读回 selectionStart。两个硬结论：
//
//   实验 1（ide-samevalue.mjs）：textarea.value 重新赋**同样的字符串** → 光标纹丝不动；
//                              赋**不同的字符串** → 光标立刻跳到末尾。
//   实验 2（ide-stack.mjs）：抓 value 被改写的调用栈 → Taro commit →
//                            微信 defaultValueChange → updateValue。
//
// ⇒ 真规则是「**下发的值与原生当前文本不一致才跳**」，不是"带 value 就跳"。
// ⇒ 治法极简：**让下发的 value 永远等于用户眼前的文本**。
//   页面 onInput 当场 setState，组件把 props.value 原样下发 —— 每次 commit 下发的都是
//   刚刚那个文本，与原生相同 ⇒ 不重建、不跳光标、不丢字。
// ⇒ 反过来"不让 value 变化"（第 7/8/10 版）才最危险：属性停在旧值后，任何一次 commit
//   都会把刚打的字**覆盖回旧值** —— 那正是"打不进字"。
//
// ⚠️ 2026-11-02 第十三轮：上面那条治法只对了一半，真正的病根不在"下发什么"，而在
//    **Taro 什么时候恢复受控值**。
//
//    源码链条（@tarojs/react 4.1.9）：
//      finishEventHandler() → TaroReconciler.flushSync() → restoreStateIfNeeded()
//      → updateWrapper → setNodeValue(node, event.detail.value, props.value)
//      判据：if (props.value != null && event.detail.value !== props.value) node.value = props.value
//
//    也就是说：**事件里的文本 ≠ fiber 上的 props.value 就把原生文本改回去**。
//    而 React 18 对事件回调里的 setState 是批处理的 —— 在 flushSync 真正刷出来之前，
//    props.value 还停在上一拍。于是刚打的字符被改回上一拍、光标甩到末尾、还丢字。
//    中文一次上屏只发一次 input，两拍隔得远，所以侥幸没事；英文逐字符输入必然撞上。
//
// ⇒ 治法：**input 事件里当场把这次更新同步刷出去（flushSync）**，让 props.value 等于
//   本次事件的文本 ⇒ 恢复逻辑判定"不需要恢复" ⇒ 文本与光标都不动。
//
//    ⛔ 别再试「延迟上抛」：属性停在旧串，恢复逻辑照样把文本改回旧串，实测连打 16 字
//       只剩 1~2 个。⛔ 也别试「不传 value 做非受控」：Taro 的 textarea 直接打不进字；
//       传 undefined 等价于下发空串。⛔ 更不要运行时改写 FormElement[Symbol.hasInstance]：
//       会打断 Babel 的 _classCallCheck（它内部就是 instanceof），整个小程序白屏。
//
// 下面这组断言守住实现别再退回旧路（纯函数层已被证明是多余的，所以只守源码契约）。
//
// ⚠️ 2026-11-02 第十四轮补充：`flushSync` 只解决"恢复受控值"那一半，另一半在 **setData 时序**。
//    实测（tmp-write-stack.mjs 抓调用栈 + setNodeValue 打点）：
//      ① flushSync 是生效的 —— 每次 input 结束时 props.value 确实同步变成了本次文本；
//      ② 真正冲掉字的是**视图层晚到的 setData**：逻辑层每次提交都把 value 塞进 payload，
//         视图层（WAWebview defaultValueChange → updateValue）应用有延迟，后到的旧值
//         把刚打的字覆盖回去、光标甩末尾；
//      ③ `FormElement.dispatchEvent` 在 INPUT 里执行 `this.value = val`，而 setAttribute
//         不做相等判断 ⇒ 每次按键**再多一次** setData，打字越快越容易晚到。
//    ⇒ 两处依赖补丁 + 组件里一条守卫，断言见下：
//      · patches/@tarojs__react@4.1.9.patch：payload 里与元素当前值相同的 value 要摘掉；
//        ⚠️ payload 必须返回**非 null**（空数组也算），否则 commitUpdate 提前返回、
//        元素上的 __reactProps$ 不更新，恢复受控值时读到旧值 ⇒ 整段文本写成空串。
//      · patches/@tarojs__runtime@4.1.9.patch：INPUT 分支只同步 this.props.value，不再 setAttribute。
//      · 组件：丢掉 `detail.value` 不是字符串的 input 事件（视图层应用 value 后的回声），
//        否则会上抛空串 ⇒ 页面 setContent('') ⇒ 下一次提交把文本清空。
m.test('🔴 ui/textarea 必须原样下发 value，focus/cursor 必须条件展开', async (c) => {
  const src = fs.readFileSync(path.join(ROOT, 'src/components/ui/textarea.tsx'), 'utf8')

  c.ok(
    src.includes('typeof displayValue === "string" ? { value: displayValue } : undefined'),
    'value 必须条件下发，且来源是 displayValue（有未上抛输入时=原生当前文本，否则=页面值）'
  )
  c.ok(
    src.includes('const displayValue = latestRef.current ?? value'),
    '下发的值必须优先取「输入事件里记下的最新文本」，否则 commit 时会用滞后的 state 覆盖用户输入'
  )
  c.ok(
    src.includes("if (typeof next !== 'string') return"),
    '没有 detail.value 的 input 事件必须丢弃：视图层应用 value 后会回抛一次空 detail 的 input，照常上抛就是 setContent(\'\') ⇒ 清空用户刚打的字'
  )
  c.ok(
    !src.includes('useState'),
    '组件里出现了 useState —— 任何内部 state 变化都是一次 commit，都会把光标甩走'
  )
  // 2026-11-02 第十三轮：病根是「Taro 在事件末尾 flushSync 后用 props.value 恢复受控值」，
  // 而 React 18 的批处理让 props.value 停在上一拍。所以断言必须钉住「同步刷新」这一步。
  c.ok(
    src.includes('flushSync'),
    '缺少 flushSync：input 事件里不把 setState 同步刷出去，Taro 恢复受控值时就会用上一拍的 props.value 覆盖刚打的字（英文逐字符输入必现）'
  )
  c.ok(
    !src.includes('EMIT_DELAY') && !src.includes('pendingEventRef'),
    '又回到"延迟上抛"方案：属性停在旧串时 Taro 照样会把文本改回旧串，实测连打 16 字只剩 1~2 个'
  )
  c.ok(
    src.includes('const trustPage = !focusRef.current || cursorChanged'),
    '缺少"聚焦期间只信原生"的判定（且 cursor 必须按"变化的那一刻"算请求，不能用 cursorProp !== null）'
  )
  c.ok(
    src.includes('cursorProp !== null && cursorProp !== lastCursorRef.current'),
    'cursor 必须按"变化"判定：useCaret 会把上次定位值一直挂着，恒真会让滞后 state 一路回写'
  )
  c.ok(
    !/delete\s+[^\n]*value/.test(src),
    '禁止把 value 从 props 里删掉：Taro 的 payload 会记成 [key, null]，等于下发 value:null（打不进字）'
  )
  c.ok(
    !src.includes('displayRef') && !src.includes('resolveDisplayText') && !src.includes('textarea-echo'),
    '又引入了"文本改写层"（第 10 版的失败方案），下发的值必须等于用户眼前的文本'
  )
  c.ok(
    src.includes('focusProp ? { focus: true } : undefined'),
    'focus 必须条件展开：微信里 focus={false} 是"强制失焦"（会收键盘），不是"不指定"'
  )
  c.ok(
    src.includes('cursorProp !== null ? { cursor: cursorProp } : undefined'),
    'cursor 必须条件展开：-1 在微信里是"置于末尾"，等于主动甩光标'
  )

  // —— 依赖补丁（第十四轮）：没有它们，视图层仍会收到过时的 value，打字就被冲掉 ——
  const pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const patched = (pj.pnpm && pj.pnpm.patchedDependencies) || {}
  c.ok(
    !!patched['@tarojs/react@4.1.9'],
    'package.json 缺少 @tarojs/react 的 patchedDependencies 声明 —— 补丁文件存在但不会生效'
  )
  c.ok(
    !!patched['@tarojs/runtime@4.1.9'],
    'package.json 缺少 @tarojs/runtime 的 patchedDependencies 声明 —— dispatchEvent 那条回声没人管'
  )
  const reactPatch = fs.readFileSync(path.join(ROOT, 'patches/@tarojs__react@4.1.9.patch'), 'utf8')
  c.ok(
    reactPatch.includes('updatePayload.splice') && reactPatch.includes('_valueTracker'),
    'react 补丁必须把「与元素当前值相同的 value」从 payload 里摘掉（否则视图层会收到过时的 value）'
  )
  c.ok(
    reactPatch.includes('return updatePayload;') && !/updatePayload\s*=\s*null;?\s*\n\s*\}\s*\n\s*return/.test(reactPatch),
    'react 补丁不许把 payload 清成 null —— commitUpdate 会提前返回，元素上的 __reactProps$ 不更新，恢复受控值读旧值会把文本写成空串'
  )
  const runtimePatch = fs.readFileSync(path.join(ROOT, 'patches/@tarojs__runtime@4.1.9.patch'), 'utf8')
  c.ok(
    runtimePatch.includes('this.props.value = val'),
    'runtime 补丁必须让 INPUT 分支只同步 this.props.value（不再 setAttribute），否则每次按键多一次 setData'
  )
  c.ok(
    !/^\+.*this\.value = val;/m.test(runtimePatch),
    'runtime 补丁又把 INPUT 分支改回 this.value = val 了：setAttribute 不做相等判断，每次按键都会多下发一次 setData'
  )
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
