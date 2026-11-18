// 模块 69：前端展示态 LaTeX 源码外泄修复（D-090）
//
// 静态契约：所有「只读展示」的题干/答案摘要必须先过 latexToReadable；
// 编辑态保留 LaTeX 源码是正确设计，不在本断言范围。
// 真编译断言：latexToReadable 对 [图N] 标记 / 纯文本 / 公式混排的行为。

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import { Module } from '../lib/harness.mjs'

const require = createRequire(import.meta.url)
const m = new Module('M69', '前端展示态 LaTeX 可读化（D-090）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

const CARD = 'src/components/review-item-card.tsx'
const DETAIL = 'src/pages/detail/index.tsx'
const LATEX = 'server/src/pdf/latex.ts'

async function loadTs(rel) {
  const ts = require(path.join(ROOT, 'server/node_modules/typescript'))
  const src = read(rel)
  const js = ts.transpileModule(src, {
    compilerOptions: { module: 99, target: 4, isolatedModules: true },
  }).outputText
  const out = path.join(ROOT, '.tmp', `verify-m69-${path.basename(rel, '.ts')}.mjs`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, js)
  return import(pathToFileURL(out).href + '?t=' + Date.now())
}

m.test('A1 题目卡：题干/答案摘要渲染前均过 latexToReadable', async (c) => {
  const card = read(CARD)
  c.ok(/import\s*\{\s*latexToReadable\s*\}\s*from\s*['"]@\/utils\/latex['"]/.test(card),
    '题目卡须 importlatexToReadable')
  c.ok(/const\s+stemText\s*=\s*latexToReadable\(c\.question\s*\|\|\s*''\)/.test(card),
    '题干摘要须先转可读（stemText）')
  c.ok(/truncate\(latexToReadable\(c\.answer\),\s*\d+\)/.test(card),
    '答案摘要须 truncate(latexToReadable(c.answer))')
  c.ok(/truncate\(stemText,\s*80\)/.test(card),
    '题干纯文本摘要与带图摘要都用 stemText，不许再直接 truncate(c.question)')
})

m.test('A2 详情页：题干预览与相似题题干转可读', async (c) => {
  const detail = read(DETAIL)
  c.ok(/questionRichHtml\(latexToReadable\(qContent\)/.test(detail),
    '题干预览 questionRichHtml 前须 latexToReadable(qContent)')
  c.ok(/truncate\(latexToReadable\(s\.question/.test(detail),
    '相似题题干摘要须 latexToReadable(s.question)')
})

m.test('A3 latexToReadable 对 [图N] 标记 / 纯文本 / 混排幂等（真编译）', async (c) => {
  const { latexToReadable } = await loadTs(LATEX)
  c.eq(latexToReadable('如图[图1]，求$\\frac{1}{2}+\\sqrt{3}$的值'), '如图[图1]，求1/2+√3的值',
    '[图N] 标记须原样保留，公式转可读')
  c.eq(latexToReadable('纯中文题干没有公式'), '纯中文题干没有公式', '纯文本须原样保留')
  c.eq(latexToReadable('\\sqrt{13}'), '√13', '裸 \\sqrt 须转 √')
  c.ok(latexToReadable('图[图2]和$\\dfrac{15\\sqrt{3}}{4}$').includes('[图2]'), '插图标记不能被吃掉')
  const once = latexToReadable('$\\frac{1}{2}+\\sqrt{3}$')
  c.eq(latexToReadable(once), once, '转换须幂等')
})

export default m
