// 模块 68：复习资料 LaTeX 可读化 / 去解答标签 / 缩间隙 / 长题跨页（D-089）
//
// 静态契约 + 真编译纯函数断言；样张视觉核对由 dynamic-tests/run-question-blocks.mjs 承担。

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import { Module } from '../lib/harness.mjs'

const require = createRequire(import.meta.url)
const m = new Module('M68', 'LaTeX 可读化 / 去标签 / 缩间隙 / 长题跨页（D-089）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

const PDF = 'server/src/pdf/pdf.service.ts'
const LAYOUT = 'server/src/pdf/question-block-layout.ts'
const LATEX = 'server/src/pdf/latex.ts'

async function loadTs(rel) {
  const ts = require(path.join(ROOT, 'server/node_modules/typescript'))
  const src = read(rel)
  const js = ts.transpileModule(src, {
    compilerOptions: { module: 99, target: 4, isolatedModules: true },
  }).outputText
  const out = path.join(ROOT, '.tmp', `verify-${path.basename(rel, '.ts')}.mjs`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, js)
  return import(pathToFileURL(out).href + '?t=' + Date.now())
}

m.test('A1 LaTeX → 可读符号：分数 / 根号 / 上下标 / 希腊字母 / 幂等', async (c) => {
  const { latexToReadable } = await loadTs(LATEX)
  c.eq(latexToReadable('$\\frac{1}{2}$'), '1/2', '分数须转成 1/2')
  c.eq(latexToReadable('$\\sqrt{3}$'), '√3', '根号须转成 √3')
  c.ok(/√/.test(latexToReadable('$\\sqrt{a^2+b^2}$')), '复合根号须含 √')
  c.ok(latexToReadable('$x^{2}$').includes('²'), '上标 2 须转成 ²')
  c.ok(/π/.test(latexToReadable('$\\pi$')), '希腊字母须转成 π')
  c.eq(latexToReadable('普通文字不含命令'), '普通文字不含命令', '纯文字原样保留')
  const once = latexToReadable('$\\frac{1}{2}$')
  c.eq(latexToReadable(once), once, '转换须幂等（可读形式不再含反斜杠命令）')
})

m.test('A2 静态契约：去解答标签 / 正确答案改答案 / 间隙压换行 / 启用跨页', (c) => {
  const pdf = read(PDF)
  c.ok(!/specs\.push\(\[`\$\{g\}:answer`/.test(pdf), '不许再生成 answer 标签（原「解答（思路与过程）」）')
  c.ok(!/heading: '正确答案：'/.test(pdf), 'PDF 里「正确答案」须改成「答案」')
  c.ok(/heading: '答案：'/.test(pdf), '须出现「答案：」heading')
  c.ok(/includeAnswers \? Math\.min\(rawSpacePt, 20\)/.test(pdf), '含答案模式间隙须压到一个换行(20pt)')
  c.ok(/allowSplit: includeAnswers/.test(pdf), '含答案模式须启用跨页版式')
  c.ok(/latexToReadable/.test(pdf) && /from '\.\/latex'/.test(pdf), '文本块渲染前须过 LaTeX 可读化')
  c.ok(/answer_attachments \|\| \[\]\)\.filter/.test(pdf) && /a\?\.type === 'image' && a\?\.url/.test(pdf),
    '图片类答案附件须纳入合成（否则文件形式存的图片答案漏显示）')
})

m.test('A3 版式纯函数：跨页模式下长题拆两页、短题合并、顺序不乱、题号不重复', async (c) => {
  const { layoutQuestionBlocks } = await loadTs(LAYOUT)
  const bin = { width: 520, height: 400 }
  const blocks = [
    { key: 'q1', label: '题1', rows: [
      { key: 'l1', width: 100, height: 20, kind: 'label' },
      { key: 'q1stem', width: 400, height: 120, kind: 'question' },
      { key: 'q1a1', width: 400, height: 150, kind: 'answer' },
    ] },
    { key: 'q2', label: '题2', rows: [
      { key: 'l2', width: 100, height: 20, kind: 'label' },
      { key: 'q2stem', width: 400, height: 100, kind: 'question' },
      { key: 'q2a1', width: 400, height: 120, kind: 'answer' },
    ] },
    { key: 'q3', label: '题3', rows: [
      { key: 'l3', width: 100, height: 20, kind: 'label' },
      { key: 'q3stem', width: 400, height: 80, kind: 'question' },
    ] },
  ]
  const pages = layoutQuestionBlocks(blocks, bin, { allowSplit: true })
  const keys = pages.flatMap((p) => p.blocks.flatMap((b) => b.rows.map((r) => r.key)))
  // 顺序：q1 三行 → q2 三行 → q3 两行，拆页后仍须严格保持
  const seq = ['l1', 'q1stem', 'q1a1', 'l2', 'q2stem', 'q2a1', 'l3', 'q3stem']
  c.eq(keys.join(','), seq.join(','), '跨页后行顺序须与输入完全一致')
  // 无重叠、无越界
  let overlap = false
  let outside = false
  for (const p of pages) {
    const rs = p.blocks.flatMap((b) => b.rows)
    for (const r of rs) {
      if (r.y < -0.01 || r.y + r.height > bin.height + 0.01) outside = true
    }
    for (let i = 0; i < rs.length; i += 1) for (let j = i + 1; j < rs.length; j += 1) {
      const a = rs[i]; const b = rs[j]
      const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
      const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
      if (ox > 0.1 && oy > 0.1) overlap = true
    }
  }
  c.ok(!overlap && !outside, '跨页排布不得重叠、不得越界')
  c.eq(keys.filter((k) => k === 'l1').length, 1, '题号标题只出现一次')
  c.eq(keys.filter((k) => k === 'l2').length, 1, '第二题题号只出现一次')
})

m.test('A4 旧模式不变：练习卷仍一题一区块不跨页', async (c) => {
  const { layoutQuestionBlocks } = await loadTs(LAYOUT)
  const bin = { width: 520, height: 300 }
  const blocks = [
    { key: 'q1', label: '题1', rows: [
      { key: 'l1', width: 100, height: 20, kind: 'label' },
      { key: 'q1stem', width: 400, height: 260, kind: 'question' },
    ] },
    { key: 'q2', label: '题2', rows: [
      { key: 'l2', width: 100, height: 20, kind: 'label' },
      { key: 'q2stem', width: 400, height: 260, kind: 'question' },
    ] },
  ]
  const pages = layoutQuestionBlocks(blocks, bin) // 默认 allowSplit=false
  c.ok(pages.every((p) => new Set(p.blocks.map((b) => b.key)).size === p.blocks.length),
    '练习卷每题不得跨页')
  c.eq(pages.length, 2, '两道整页题须分成两页')
})

export default m
