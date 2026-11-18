// 模块 67：复习资料页头 / 题号字号 / 按题型留做题空间（D-088）
//
// 静态契约 + 真编译纯函数断言；样张视觉核对由 dynamic-tests/run-question-blocks.mjs 承担。

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import { Module } from '../lib/harness.mjs'

const require = createRequire(import.meta.url)
const m = new Module('M67', '复习资料页头 / 题号字号 / 做题空间（D-088）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

const PDF = 'server/src/pdf/pdf.service.ts'
const LAYOUT = 'server/src/pdf/question-block-layout.ts'
const SPACE = 'server/src/pdf/question-space.ts'

/** 用服务端自带 typescript 真编译纯函数，再动态 import 跑断言 */
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

m.test('A1 题型判定：选择 / 填空少留，应用题多留，纯图题默认多留', async (c) => {
  const { detectPracticeKind, practiceSpacePoints, PRACTICE_SPACE_PT } = await loadTs(SPACE)
  c.eq(detectPracticeKind('选择题 3', '下列说法正确的是'), 'choice', '题号标签中的「选择题」须优先')
  c.eq(detectPracticeKind('一、填空题 7', '把下列数填在横线上'), 'fill', '题号标签中的「填空题」须识别')
  c.eq(detectPracticeKind('', '下列正确的是（ ） A.1 B.2 C.3 D.4'), 'choice', '多选项标记须判为选择题')
  c.eq(detectPracticeKind('', '1 + 1 = ______'), 'fill', '下划线槽位须判为填空题')
  c.eq(detectPracticeKind('应用题 12', '小明买了 3 支铅笔，一共多少钱？'), 'application', '应用题须多留')
  c.eq(detectPracticeKind('第 4 题', ''), 'application', '纯图片题无文字信号时默认留空间')
  c.ok(PRACTICE_SPACE_PT.application === 96 && PRACTICE_SPACE_PT.fill === 24 && PRACTICE_SPACE_PT.choice === 24,
    '留白高度须为应用题 96pt / 填空选择 24pt')
  c.eq(practiceSpacePoints('选择题 2', ''), 24, '对外接口须返回实际 pt')
})

m.test('A2 PDF 合成：无顶部页头、题号缩半、插入按题型留白', (c) => {
  const pdf = read(PDF)
  c.ok(!/headerPng|headerImage/.test(pdf), '不许再画顶部「复习资料」页头')
  c.ok(/const HEADER_H = 0/.test(pdf), '页头高度归零，内容区从页顶开始')
  c.ok(/`\$\{g\}:title`, title, '#1F2937', 15/.test(pdf), '题号字号须由 30 缩到 15')
  c.ok(/`__space:\$\{g\}`/.test(pdf) && /kind: 'space'/.test(pdf), '须插入无图的做题空白行')
  c.ok(/u\.role === 'question'\)\?\.spacePt/.test(pdf) && /practiceSpacePoints\(label, stemForType\)/.test(pdf),
    '留白高度须来自题型判定，不是一刀切')
  c.ok(/layout: 'question-blocks-v[23]'/.test(pdf), '版式版本须为 v2 或更高（D-089 为 v3）便于回溯')
  c.ok(!/复习资料 · \$\{day\}/.test(pdf), '页眉文案不许再出现')
})

m.test('A3 版式纯函数：空白行占位有效，题答仍相邻且不跨页', async (c) => {
  const { layoutQuestionBlocks } = await loadTs(LAYOUT)
  const blocks = [
    { key: 'q1', label: '应用题 1', rows: [
      { key: 'l1', width: 120, height: 24, kind: 'label' },
      { key: 'q1img', width: 400, height: 300, kind: 'question' },
      { key: '__space:q1', width: 1, height: 96, kind: 'space' },
      { key: 'a1', width: 400, height: 120, kind: 'answer' },
    ] },
    { key: 'q2', label: '选择题 2', rows: [
      { key: 'l2', width: 120, height: 24, kind: 'label' },
      { key: 'q2img', width: 400, height: 300, kind: 'question' },
      { key: '__space:q2', width: 1, height: 24, kind: 'space' },
    ] },
  ]
  const pages = layoutQuestionBlocks(blocks, { width: 520, height: 560 })
  const rows = pages.flatMap((p) => p.blocks.flatMap((b) => b.rows))
  c.ok(rows.some((r) => r.kind === 'space' && Math.abs(r.height - 96) < 2), '应用题 96pt 空白须真正占位（整块压缩时按比例）')
  c.ok(rows.some((r) => r.kind === 'space' && Math.abs(r.height - 24) < 2), '选择题 24pt 空白须真正占位')
  const k = rows.map((r) => r.key)
  c.ok(k.indexOf('q1img') < k.indexOf('__space:q1') && k.indexOf('__space:q1') < k.indexOf('a1'),
    '空白须位于题面与答案之间')
  c.ok(pages.every((p) => new Set(p.blocks.map((b) => b.key)).size === p.blocks.length), '区块不跨页')
  let overlap = false
  for (const p of pages) {
    const rs = p.blocks.flatMap((b) => b.rows)
    for (let i = 0; i < rs.length; i += 1) for (let j = i + 1; j < rs.length; j += 1) {
      const a = rs[i]; const b = rs[j]
      const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
      const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
      if (ox > 0.1 && oy > 0.1) overlap = true
    }
  }
  c.ok(!overlap, '空白行不得与图文重叠')
})

export default m
