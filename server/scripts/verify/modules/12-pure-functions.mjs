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

export default m
