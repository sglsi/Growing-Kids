// D-087：复习资料「逐题清晰」版式动态验证 + 可视化样张。
// 真编译 question-block-layout.ts → 真造中文题图 → 真出 A4 PDF（.tmp/qblock-preview.pdf）。
// 断言：题目保序 / 题答同块相邻 / 区块不跨页 / 无重叠无越界 / 单图不被缩成指甲盖。
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { pathToFileURL } from 'url'

const require = createRequire(import.meta.url)
const ROOT = process.cwd()
const ts = require(path.join(ROOT, 'server/node_modules/typescript'))
const sharp = require(path.join(ROOT, 'server/node_modules/sharp'))
const { PDFDocument } = require(path.join(ROOT, 'server/node_modules/pdf-lib'))

const src = fs.readFileSync(path.join(ROOT, 'server/src/pdf/question-block-layout.ts'), 'utf8')
const js = ts.transpileModule(src, { compilerOptions: { module: 99, target: 4, isolatedModules: true } }).outputText
const tmp = path.join(ROOT, '.tmp', 'qblock')
fs.mkdirSync(tmp, { recursive: true })
const layoutFile = path.join(tmp, 'layout.mjs')
fs.writeFileSync(layoutFile, js)
const { layoutQuestionBlocks } = await import(pathToFileURL(layoutFile).href + '?t=' + Date.now())

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? `  [${extra}]` : '')) }
}

const A4 = { width: 595.28, height: 841.89 }
const MARGIN = 34
const HEADER_H = 0 // D-088：不要顶部「复习资料」页头
const FOOTER_H = 26
const bin = { width: A4.width - MARGIN * 2, height: A4.height - MARGIN * 2 - HEADER_H - FOOTER_H }
const contentTop = A4.height - MARGIN - HEADER_H

/** 仿 pdf.service.renderTextPng / renderLabelPng：中文走 sharp SVG 位图 */
async function png(text, { w, h, size = 36, color = '#1F2937', bg = '#FFFFFF', accent = false } = {}) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${bg}"/>${accent ? `<rect x="0" y="2" width="4" height="${h - 4}" fill="${color}" opacity="0.7"/>` : ''}<text x="24" y="${Math.round(h * 0.45)}" font-family="Microsoft YaHei, SimHei, sans-serif" font-size="${size}" fill="${color}" xml:space="preserve">${esc(text)}</text></svg>`
  return { buffer: await sharp(Buffer.from(svg)).png().toBuffer(), width: w, height: h }
}

// 3 道题：宽题、竖题带图、普通题带答案；尺寸刻意差异大（旧 BSSF 会打乱顺序）
const specs = [
  { key: 'q1', label: '预习案·Ⅱ 16', w: 1100, h: 620, text: '16. 如图，在菱形 ABCD 中，求∠CFE 的度数。' },
  { key: 'q1a', label: '', w: 900, h: 480, text: '解：连接 AC，由菱形性质可得……', color: '#2E6F4E' },
  { key: 'q2', label: '第 14 题', w: 700, h: 1180, text: '14. 已知二次函数 y=ax²+bx+c，图象如图。' },
  { key: 'q2a', label: '', w: 820, h: 560, text: '解：由图象对称轴 x=1 可得……', color: '#2E6F4E' },
  { key: 'q3', label: '练习册 23', w: 980, h: 900, text: '23. 计算：(-2)³ + |−5| − √9' },
]
const pdf = await PDFDocument.create()
const byKey = new Map()
for (const s of specs) {
  const im = await png(s.text, { w: s.w, h: s.h, size: 38, color: s.color || '#1A1A1A' })
  byKey.set(s.key, { image: await pdf.embedPng(im.buffer), width: im.width, height: im.height })
  // D-088：题号字号 30 → 15（半大），标签高度同步 48 → 24
  const labelW = Math.min(500, Math.max(120, [...(s.label || '题目')].length * 15 + 44))
  const lb = await png(s.label || '题目', { w: labelW, h: 24, size: 15, accent: true })
  byKey.set(`label:${s.key}`, { image: await pdf.embedPng(lb.buffer), width: lb.width, height: lb.height })
}
const answerLb = await png('解答（思路与过程）', { w: 400, h: 42, size: 26, color: '#2E6F4E', accent: true })
const answerLabel = { image: await pdf.embedPng(answerLb.buffer), width: answerLb.width, height: answerLb.height }

const blocks = [
  { key: 'q1', label: '预习案·Ⅱ 16', rows: [
    { key: 'label:q1', width: byKey.get('label:q1').width, height: byKey.get('label:q1').height, kind: 'label' },
    { key: 'q1', width: byKey.get('q1').width, height: byKey.get('q1').height, kind: 'question' },
    { key: '__space:q1', width: 1, height: 96, kind: 'space' },
    { key: '__ans:q1', width: answerLabel.width, height: answerLabel.height, kind: 'label' },
    { key: 'q1a', width: byKey.get('q1a').width, height: byKey.get('q1a').height, kind: 'answer' },
  ] },
  { key: 'q2', label: '第 14 题', rows: [
    { key: 'label:q2', width: byKey.get('label:q2').width, height: byKey.get('label:q2').height, kind: 'label' },
    { key: 'q2', width: byKey.get('q2').width, height: byKey.get('q2').height, kind: 'question' },
    { key: '__space:q2', width: 1, height: 96, kind: 'space' },
    { key: '__ans:q2', width: answerLabel.width, height: answerLabel.height, kind: 'label' },
    { key: 'q2a', width: byKey.get('q2a').width, height: byKey.get('q2a').height, kind: 'answer' },
  ] },
  { key: 'q3', label: '练习册 23', rows: [
    { key: 'label:q3', width: byKey.get('label:q3').width, height: byKey.get('label:q3').height, kind: 'label' },
    { key: 'q3', width: byKey.get('q3').width, height: byKey.get('q3').height, kind: 'question' },
    { key: '__space:q3', width: 1, height: 24, kind: 'space' },
  ] },
]

const pages = layoutQuestionBlocks(blocks, bin)
const order = pages.flatMap((p) => p.blocks.map((b) => b.key))
check('题目顺序 = 输入顺序（BSSF 重排不再出现）', order.join(',') === 'q1,q2,q3', order.join(','))
const allRows = pages.flatMap((p) => p.blocks.flatMap((b) => b.rows.map((r) => ({ ...r, block: b.key }))))
check('所有素材都排入', allRows.length === blocks.reduce((s, b) => s + b.rows.length, 0), `${allRows.length}`)
const keyOrder = allRows.map((r) => r.key)
check('题面图与答案图在同一题内相邻', keyOrder.indexOf('q1') < keyOrder.indexOf('__ans:q1') && keyOrder.indexOf('__ans:q1') < keyOrder.indexOf('q1a'))
const spaces = allRows.filter((r) => r.kind === 'space')
check('每题都有做题空白，且应用题 > 填空（整块超高时按比例压缩）',
  spaces.length === 3 && spaces[0].height > spaces[2].height * 2 && Math.abs(spaces[2].height - 24) < 1,
  spaces.map((r) => `${r.key}:${r.height.toFixed(1)}`).join(','))
check('空白插在题面之后、解答之前', keyOrder.indexOf('q1') < keyOrder.indexOf('__space:q1') && keyOrder.indexOf('__space:q1') < keyOrder.indexOf('__ans:q1'))
check('区块不跨页', pages.every((p) => new Set(p.blocks.map((b) => b.key)).size === p.blocks.length))
let overlap = false
let outside = false
for (const p of pages) {
  const rows = p.blocks.flatMap((b) => b.rows)
  for (const r of rows) {
    if (r.x < -0.01 || r.y < -0.01 || r.x + r.width > bin.width + 0.01 || r.y + r.height > bin.height + 0.01) outside = true
  }
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i]; const b = rows[j]
      const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
      const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
      if (ox > 0.1 && oy > 0.1) overlap = true
    }
  }
}
check('页内无重叠、无越界', !overlap && !outside, `overlap=${overlap} outside=${outside}`)
const tiny = allRows.filter((r) => r.kind !== 'label' && r.kind !== 'space' && r.height < bin.height * 0.05)
check('没有把题图缩成指甲盖（高 ≥ 5% 可用高）', tiny.length === 0, tiny.map((r) => `${r.key}:${r.height.toFixed(1)}`).join(','))

// 真出 PDF 样张
for (let pi = 0; pi < pages.length; pi += 1) {
  const page = pdf.addPage([A4.width, A4.height])
  for (const b of pages[pi].blocks) {
    for (const r of b.rows) {
      const im = byKey.get(r.key)?.image || (r.key === '__ans:q1' || r.key === '__ans:q2' ? answerLabel.image : null)
      if (!im) continue
      page.drawImage(im, { x: MARGIN + r.x, y: contentTop - (r.y + r.height), width: r.width, height: r.height })
    }
  }
  const foot = await png(`${pi + 1} / ${pages.length}`, { w: 160, h: 32, size: 20, color: '#8A7F72' })
  page.drawImage(await pdf.embedPng(foot.buffer), {
    x: A4.width - MARGIN - foot.width, y: MARGIN / 2, width: foot.width, height: foot.height,
  })
}
const outPdf = path.join(ROOT, '.tmp', 'qblock-preview.pdf')
fs.writeFileSync(outPdf, Buffer.from(await pdf.save()))
check('样张 PDF 已生成', fs.statSync(outPdf).size > 1000, `${fs.statSync(outPdf).size} bytes`)

console.log(`\n${pass} 通过 / ${fail} 失败；样张：${outPdf}`)
process.exit(fail ? 1 : 0)
