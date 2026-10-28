#!/usr/bin/env node
// ============================================================
// GT 数据集图片生成器（确定性）
//
//   node scripts/ocr-gt/gen.mjs            # 生成缺的图（已存在则跳过）
//   node scripts/ocr-gt/gen.mjs --force    # 全部重生成
//
// 为什么"生成"而不是"找照片"：
//   真实照片是更好的评测，但它有一个致命缺点——**不可复现**。照片换个角度、
//   换盏灯，CER 就变了，于是"这轮 CER 涨了"到底是代码退步还是照片不一样，
//   永远说不清。合成图把变量摁死：图由 JSON 生成，期望文本也是 JSON，
//   两者同源 ⇒ 任何指标变化都只能归因到识别链路本身。
//
// 真实照片不是不测，而是单独一层：把照片丢进 cases/ 并配同名 .txt，
// run.mjs 会自动收录（见 README「三层数据」）。
//
// 依赖：sharp（服务端已有），不额外装包。
// ============================================================

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CASES_DIR = path.join(HERE, 'cases')
const SPEC = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'))

const FORCE = process.argv.includes('--force')

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** 由行定义合成 SVG。mono=true 的行走等宽字体（竖式靠空格对齐，等宽才不歪） */
function buildSvg(c) {
  const d = SPEC.defaults
  const width = c.width || d.width
  const pad = d.padding
  const lines = c.lines || []
  let y = pad + (lines[0]?.size || 28)

  const parts = []
  for (const ln of lines) {
    const size = ln.size || 26
    const family = ln.mono ? "'Consolas', 'Courier New', monospace" : d.font
    const weight = ln.weight === 'bold' ? 'bold' : 'normal'
    parts.push(
      `<text x="${pad}" y="${y}" font-family="${esc(family)}" font-size="${size}" font-weight="${weight}" fill="${d.ink}" xml:space="preserve">${esc(ln.text)}</text>`,
    )
    y += size + (ln.gap ?? d.lineGap)
  }
  const height = Math.ceil(y + pad)
  return {
    width,
    height,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<rect width="100%" height="100%" fill="${d.bg}"/>
${parts.join('\n')}
</svg>`,
  }
}

/** 退化：旋转 / 模糊 / 压对比度。参数固定 ⇒ 输出固定 */
async function degrade(pngBuf, deg) {
  let img = sharp(pngBuf)
  const meta = await sharp(pngBuf).metadata()
  if (deg.rotate) {
    img = sharp(await img.toBuffer()).rotate(deg.rotate, {
      background: '#ffffff',
      // 旋转后按内容扩边，避免把角上的字切掉（少切一个字 CER 就多一截噪声）
      expand: true,
    })
  }
  let buf = await img.toBuffer()
  if (deg.blur) buf = await sharp(buf).blur(deg.blur).toBuffer()
  if (deg.contrast) {
    buf = await sharp(buf).linear(deg.contrast, 40).toBuffer()
  }
  return { buf, width: meta.width, height: meta.height }
}

async function main() {
  fs.mkdirSync(CASES_DIR, { recursive: true })
  const made = []
  const skipped = []

  const byId = new Map(SPEC.cases.map((c) => [c.id, c]))

  for (const c of SPEC.cases) {
    const out = path.join(CASES_DIR, `${c.id}.png`)
    if (fs.existsSync(out) && !FORCE) {
      skipped.push(c.id)
      continue
    }
    const base = c.of ? byId.get(c.of) : c
    if (!base) throw new Error(`案例 ${c.id} 引用了不存在的 base：${c.of}`)

    const { svg } = buildSvg(base)
    let buf = await sharp(Buffer.from(svg)).png().toBuffer()
    if (c.degrade) buf = (await degrade(buf, c.degrade)).buf
    fs.writeFileSync(out, buf)
    made.push(`${c.id} (${(buf.length / 1024).toFixed(1)} KB)`)
  }

  console.log(`GT 图片生成完成：新增 ${made.length}，跳过（已存在）${skipped.length}`)
  if (made.length) console.log('  ' + made.join('\n  '))
  if (skipped.length && !FORCE) console.log(`  提示：--force 可全部重生成`)
}

main().catch((e) => {
  console.error('[ocr-gt/gen] 失败：', e)
  process.exit(1)
})
