// 端到端验证：真实生成图片 → 真实排版 → 真实 pdf-lib 出 PDF → 回读校验
// 验证 pdf.service.ts 的排版链路（Guillotine-BSSF）在真实 pdf-lib 下产出正确的 A4 多页 PDF。
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const ROOT = '/workspace/projects/server'
const ts = require(path.join(ROOT, 'node_modules/typescript'))
const sharp = require(path.join(ROOT, 'node_modules/sharp'))
const { PDFDocument } = require(path.join(ROOT, 'node_modules/pdf-lib'))

// 编译 pdf-layout.ts
const code = fs.readFileSync(path.join(ROOT, 'src/pdf/pdf-layout.ts'), 'utf8')
const js = ts.transpileModule(code, { compilerOptions: { module: 99, target: 4, isolatedModules: true } }).outputText
const tmp = '/tmp/pdf-e2e'
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })
fs.writeFileSync(path.join(tmp, 'layout.mjs'), js)
const { packPages } = await import(path.join(tmp, 'layout.mjs'))

let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

const A4 = { width: 595.28, height: 841.89 }
const MARGIN = 34, GAP = 12
const bin = { width: A4.width - MARGIN * 2, height: A4.height - MARGIN * 2 }

// 1) 造 6 张不同尺寸的真实 JPEG（模拟复习本：有横有竖、有大有小）
const specs = [
  { w: 900, h: 1200, color: { r: 220, g: 120, b: 120 } },
  { w: 1200, h: 900, color: { r: 120, g: 200, b: 140 } },
  { w: 700, h: 1000, color: { r: 120, g: 140, b: 220 } },
  { w: 1000, h: 700, color: { r: 230, g: 200, b: 120 } },
  { w: 800, h: 800, color: { r: 200, g: 140, b: 220 } },
  { w: 1100, h: 1500, color: { r: 140, g: 220, b: 220 } },
]
const imgs = []
for (let i = 0; i < specs.length; i++) {
  const s = specs[i]
  const p = path.join(tmp, `img${i}.jpg`)
  await sharp({ create: { width: s.w, height: s.h, channels: 3, background: s.color } }).jpeg({ quality: 85 }).toFile(p)
  imgs.push({ key: `k${i}`, path: p, width: s.w, height: s.h })
}
check('生成 6 张真实 JPEG', imgs.every((im) => fs.existsSync(im.path) && fs.statSync(im.path).size > 0))

// 2) 真实排版
const pages = packPages(
  imgs.map((im) => ({ key: im.key, width: im.width, height: im.height })),
  bin,
  { allowRotate: false },
)
const totalPlaced = pages.reduce((s, p) => s + p.placements.length, 0)
check('全部图片被排入（6/6）', totalPlaced === 6, `${totalPlaced}`)
check('页面数 < 图片数（确实拼页）', pages.length < 6, `${pages.length} 页`)

// 3) 用 pdf-lib 真实出 PDF（复刻 pdf.service 的绘制逻辑）
const pdf = await PDFDocument.create()
const bufByKey = new Map()
for (const im of imgs) bufByKey.set(im.key, new Uint8Array(fs.readFileSync(im.path)))
// 校验 JPEG 魔数（SOI = FF D8）
for (const im of imgs) {
  const b = bufByKey.get(im.key)
  if (!(b[0] === 0xff && b[1] === 0xd8)) throw new Error(`非 JPEG: ${im.path} first=${b[0].toString(16)},${b[1].toString(16)}`)
}
check('所有图片 JPEG 魔数正确 (FF D8)', true)

for (const pg of pages) {
  const page = pdf.addPage([A4.width, A4.height])
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const pl of pg.placements) {
    minX = Math.min(minX, pl.x)
    maxX = Math.max(maxX, pl.x + pl.width)
    minY = Math.min(minY, pl.y)
    maxY = Math.max(maxY, pl.y + pl.height)
  }
  const hasContent = isFinite(minX) && isFinite(minY)
  const contentW = hasContent && maxX > minX ? maxX - minX : 0
  const contentH = hasContent && maxY > minY ? maxY - minY : 0
  const centerShiftX = (bin.width - contentW) / 2 - (hasContent ? minX : 0)
  const centerShiftY = (bin.height - contentH) / 2 - (hasContent ? minY : 0)
  for (const pl of pg.placements) {
    const buf = bufByKey.get(pl.key)
    const embedded = await pdf.embedJpg(buf)
    const inset = GAP / 2
    const drawW = Math.max(1, pl.width - GAP)
    const drawH = Math.max(1, pl.height - GAP)
    const drawX = MARGIN + pl.x + centerShiftX + inset
    const drawY = A4.height - MARGIN - (pl.y + centerShiftY + pl.height) + inset
    page.drawImage(embedded, { x: drawX, y: drawY, width: drawW, height: drawH })
  }
}
const out = path.join(tmp, '复习资料.pdf')
const bytes = await pdf.save()
fs.writeFileSync(out, bytes)
check('PDF 文件已生成且非空', fs.existsSync(out) && bytes.length > 1000, `${bytes.length} bytes`)

// 4) 回读校验：页数、每页尺寸 = A4
const reloaded = await PDFDocument.load(fs.readFileSync(out))
const rp = reloaded.getPages()
check(`回读页数 == 排版页数(${pages.length})`, rp.length === pages.length, `${rp.length}`)
const a4ok = rp.every((p) => {
  const w = p.getWidth(), h = p.getHeight()
  return Math.abs(w - A4.width) < 0.5 && Math.abs(h - A4.height) < 0.5
})
check('每页尺寸均为 A4 (595.28×841.89)', a4ok)
check('PDF 大小合理（<5MB）', bytes.length < 5 * 1024 * 1024, `${(bytes.length / 1024).toFixed(0)} KB`)

console.log(`\nPDF 端到端测试：${pass} 通过 / ${fail} 失败`)
console.log(`产物：${out}`)
process.exitCode = fail ? 1 : 0
