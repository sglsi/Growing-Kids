// D-089 样张：真编译服务端 latex.ts + question-block-layout.ts，
// 造含 LaTeX 源码的题目/答案，出一份「含答案」PDF 样张，核对：
//   ① 符号转可读（√、分数、上下标）② 无「解答」标签 ③ 间隙一个换行 ④ 长解答跨两页 / 短题合并
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { pathToFileURL } from 'url'

const require = createRequire(import.meta.url)
const ROOT = process.cwd()
const ts = require(path.join(ROOT, 'server/node_modules/typescript'))
const sharp = require(path.join(ROOT, 'server/node_modules/sharp'))
const { PDFDocument } = require(path.join(ROOT, 'server/node_modules/pdf-lib'))

async function loadTs(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const js = ts.transpileModule(src, { compilerOptions: { module: 99, target: 4, isolatedModules: true } }).outputText
  const out = path.join(ROOT, '.tmp', `d089-${path.basename(rel, '.ts')}.mjs`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, js)
  return import(pathToFileURL(out).href + '?t=' + Date.now())
}
const { latexToReadable } = await loadTs('server/src/pdf/latex.ts')
const { layoutQuestionBlocks } = await loadTs('server/src/pdf/question-block-layout.ts')

const A4 = { width: 595.28, height: 841.89 }
const MARGIN = 34
const FOOTER_H = 26
const bin = { width: A4.width - MARGIN * 2, height: A4.height - MARGIN * 2 - FOOTER_H }
const contentTop = A4.height - MARGIN
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const FS = 34, LH = Math.round(FS * 1.6), PAD = 24, W = 1180
const charW = (ch) => (ch.charCodeAt(0) > 0x2e80 ? FS : Math.round(FS * 0.55))
function wrap(line) {
  const rows = []; let cur = '', w = 0
  for (const ch of line) {
    const cw = charW(ch)
    if (w + cw > W - PAD * 2 && cur) { rows.push(cur); cur = ''; w = 0 }
    cur += ch; w += cw
  }
  if (cur) rows.push(cur)
  return rows.length ? rows : [' ']
}
async function textPng(raw) {
  const lines = []
  latexToReadable(raw).split('\n').forEach((seg) => wrap(seg).forEach((t) => lines.push(t)))
  const H = PAD * 2 + lines.length * LH
  const body = lines.map((t, i) =>
    `<text x="${PAD}" y="${PAD + LH * i + Math.round(FS * 0.9)}" font-family="Microsoft YaHei, SimHei, sans-serif" font-size="${FS}" fill="#1a1a1a" xml:space="preserve">${esc(t)}</text>`).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="white"/>${body}</svg>`
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer()
  return { buffer, width: W, height: H }
}
async function imgPng(text, w, h, color = '#1A1A1A') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fffdf8" stroke="#d8d2c4"/><text x="30" y="${Math.round(h / 2)}" font-family="Microsoft YaHei, SimHei, sans-serif" font-size="34" fill="${color}">${esc(text)}</text></svg>`
  return { buffer: await sharp(Buffer.from(svg)).png().toBuffer(), width: w, height: h }
}
async function labelPng(text, size = 15) {
  const w = Math.min(500, Math.max(120, [...text].length * size + 44)), h = Math.round(size * 1.6)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="white"/><rect x="0" y="2" width="4" height="${h - 4}" fill="#1F2937" opacity="0.7"/><text x="16" y="${Math.round(h * 0.72)}" font-family="Microsoft YaHei, SimHei, sans-serif" font-size="${size}" font-weight="bold" fill="#1F2937">${esc(text)}</text></svg>`
  return { buffer: await sharp(Buffer.from(svg)).png().toBuffer(), width: w, height: h }
}

const pdf = await PDFDocument.create()
const imgs = new Map()
const embed = async (key, obj) => { const image = await pdf.embedPng(obj.buffer); imgs.set(key, { image, buffer: obj.buffer, width: obj.width, height: obj.height }) }

// 三道题：题1 长解答（跨两页），题2/3 短答案（合并同页）
const specs = [
  { key: 'q1', title: '第 5 题', stem: '如图，在 \\triangle ABC 中，AB=AC，\\angle BAC=120^\\circ，求 \\angle B 的度数。', stemImg: null, stemH: 260,
    ans: '$\\text{解：}\\because AB=AC, \\angle BAC=120^\\circ$\n$\\therefore \\angle B=\\angle C=\\frac{180^\\circ-120^\\circ}{2}=30^\\circ$\n' +
         '又 $D$ 为 $BC$ 中点，$AD\\perp BC$，故 $\\sin B=\\frac{AD}{AB}=\\frac{1}{2}$\n' +
         '由勾股定理 $AB^2=AD^2+BD^2$，得 $BD=\\sqrt{AB^2-AD^2}=\\frac{\\sqrt{3}}{2}AB$\n' +
         '因此 $\\tan B=\\frac{AD}{BD}=\\frac{1}{\\sqrt{3}}=\\frac{\\sqrt{3}}{3}$，即 $\\angle B=30^\\circ$\n' +
         '验算：$\\angle A+\\angle B+\\angle C=120^\\circ+30^\\circ+30^\\circ=180^\\circ$，符合三角形内角和。' },
  { key: 'q2', title: '第 6 题', stem: '计算 $\\frac{1}{2}+\\frac{1}{3}$ 的值。', stemImg: null, stemH: 150,
    ans: '$\\frac{1}{2}+\\frac{1}{3}=\\frac{3+2}{6}=\\frac{5}{6}$' },
  { key: 'q3', title: '第 7 题', stem: '化简 $\\sqrt{12}-\\sqrt{3}$。', stemImg: null, stemH: 150,
    ans: '$\\sqrt{12}-\\sqrt{3}=2\\sqrt{3}-\\sqrt{3}=\\sqrt{3}$' },
]

const blocks = []
for (const s of specs) {
  await embed(`label:${s.key}`, await labelPng(s.title))
  await embed(`${s.key}:stem`, await textPng(s.stem))
  await embed(`${s.key}:ans`, await textPng('答案：\n' + s.ans))
  blocks.push({ key: s.key, label: s.title, rows: [
    { key: `label:${s.key}`, width: imgs.get(`label:${s.key}`).width, height: imgs.get(`label:${s.key}`).height, kind: 'label' },
    { key: `${s.key}:stem`, width: W, height: imgs.get(`${s.key}:stem`).height, kind: 'question' },
    { key: `__space:${s.key}`, width: 1, height: 20, kind: 'space' },
    { key: `${s.key}:ans`, width: W, height: imgs.get(`${s.key}:ans`).height, kind: 'answer' },
  ] })
}

const pages = layoutQuestionBlocks(blocks, bin, { allowSplit: true })
for (let pi = 0; pi < pages.length; pi += 1) {
  const page = pdf.addPage([A4.width, A4.height])
  for (const b of pages[pi].blocks) for (const r of b.rows) {
    const obj = imgs.get(r.key)
    if (!obj) continue // space 行不绘制
    page.drawImage(obj.image, { x: MARGIN + r.x, y: contentTop - (r.y + r.height), width: r.width, height: r.height })
  }
  const foot = await labelPng(`${pi + 1} / ${pages.length}`, 20)
  page.drawImage(await pdf.embedPng(foot.buffer), { x: A4.width - MARGIN - foot.width, y: MARGIN / 2, width: foot.width, height: foot.height })
}
const out = path.join(ROOT, '.tmp', 'd089-preview.pdf')
fs.writeFileSync(out, Buffer.from(await pdf.save()))
console.log('样张页数:', pages.length, '| 各页题块:', pages.map((p) => p.blocks.map((b) => b.key).join('+')).join(' | '))
console.log('符号转换抽样:', latexToReadable('$\\frac{1}{2}+\\sqrt{3}$'))
console.log('样张:', out, fs.statSync(out).size, 'bytes')
