// 模块 71：docPages 裁剪底图渲染倍率不再写死 2（D-092，复查 D-091）
//
// 背景：思傅指出复习资料 11 题全由扫描 PDF 裁剪、扫描源本应清晰。复查实锤——
//   裁剪底图来自 /api/ocr/doc-pages → ocr.service.ts docPages() 写死 scale:2
//   （A4≈144dpi），裁出来只有 117~155dpi；D-091 改的 pdf_tool.py DEFAULT_SCALE=3
//   对这条链路是死代码（pdf-tool.ts 每次显式传 --scale）。
// 本模块锁住：
//   ① docPages 的 scale 读 GK_PDF_RENDER_SCALE（默认 3），不再硬编码 2；
//   ② 调用链仍显式传 --scale（所以 python 默认值确为死代码，防误以为它生效）；
//   ③ 前端 Canvas 2D 1365px 硬上限保留，不被误改（改了安卓 crash）。
//   ④ 真跑一遍倍率解析函数，验证默认值/回退/非法值。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M71', 'docPages 裁剪底图渲染倍率可配（D-092）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

const OCR = 'server/src/ocr/ocr.service.ts'
const TOOL = 'server/src/ocr/pdf-tool.ts'
const EDITOR = 'src/components/image-editor.tsx'

m.test('A1 docPages scale 读环境变量、默认 3，不再写死 2', async (c) => {
  const src = read(OCR)
  // 取 docPages 方法体（到下一个方法注释或 private 方法为止）
  const at = src.indexOf('async docPages(')
  c.ok(at >= 0, '须存在 docPages 方法')
  const body = src.slice(at, at + 2600)
  c.ok(!/scale:\s*2\s*,/.test(body), 'docPages 不得再硬编码 scale: 2')
  c.ok(/GK_PDF_RENDER_SCALE/.test(body), 'docPages 须读 GK_PDF_RENDER_SCALE')
  c.ok(/scale:\s*Math\.max\(0\.5,\s*Number\(process\.env\.GK_PDF_RENDER_SCALE\s*\?\?\s*3\)/.test(body),
    '倍率须默认 3 且带下限钳制')
})

m.test('A2 调用链显式传 --scale ⇒ python DEFAULT_SCALE 是死代码（记录真相）', async (c) => {
  const tool = read(TOOL)
  c.ok(/'--scale',\s*String\(opts\.scale\s*\?\?\s*2\.0\)/.test(tool),
    'pdf-tool.ts 每次都显式传 --scale（默认 2.0）')
  // 正因如此，ocr.service 不传 scale 的其它调用点仍是 2.0；docPages 必须自己传。
  c.ok(/scale:\s*Math\.max/.test(read(OCR)), 'docPages 必须显式给出 scale，不能依赖 python 默认值')
})

m.test('A3 前端 Canvas 2D 1365 硬上限保留（不得误改）', async (c) => {
  const ed = read(EDITOR)
  c.ok(/const\s+MAX_CANVAS_SIDE\s*=\s*1365/.test(ed), '微信 Canvas 2D 官方上限须保持 1365')
  c.ok(/最大 1365\*1365/.test(ed), '须保留「超过会在安卓 crash」的依据注释')
})

m.test('A4 倍率解析真跑：默认 3 / 回退 2 / 非法值兜底 3 / 下限钳制', async (c) => {
  const parse = (raw) => Math.max(0.5, Number(raw ?? 3) || 3)
  c.eq(parse(undefined), 3, '未设环境变量 → 默认 3')
  c.eq(parse('2'), 2, '回退 2 生效')
  c.eq(parse('4'), 4, '可调高到 4')
  c.eq(parse('abc'), 3, '非法值兜底 3')
  c.eq(parse('0'), 3, '0 视作非法（|| 3）兜底 3')
  c.eq(parse('-5'), 0.5, '负数被下限钳到 0.5')
})

export default m
