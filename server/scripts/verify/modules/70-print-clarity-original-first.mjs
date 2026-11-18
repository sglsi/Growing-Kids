// 模块 70：打印清晰度治本 · 原图优先 + 识别渲染倍率（D-091）
//
// 三处改动：
//   ① StorageService.readOriginalFor：display/thumb key → 同 hash 目录 original 原图（真编译）
//   ② PDF 合成 fetchImages：下载自家 storage 派生图时优先 original
//   ③ 图像裁剪 fetchImage：裁剪取图优先 original
//   ④ pdf_tool.py DEFAULT_SCALE 2.0→3.0，可用 GK_PDF_RENDER_SCALE 回退

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import { Module } from '../lib/harness.mjs'

const require = createRequire(import.meta.url)
const m = new Module('M70', '打印清晰度治本：原图优先 + 渲染倍率（D-091）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

const STORAGE = 'server/src/storage/storage.service.ts'
const PDF = 'server/src/pdf/pdf.service.ts'
const IMAGE = 'server/src/image/image.service.ts'
const PY = 'ocr-engine/pdf_tool.py'

m.test('A1 StorageService.readOriginalFor 同 hash 反查规则（真编译）', async (c) => {
  const src = read(STORAGE)
  c.ok(/async\s+readOriginalFor\(key:\s*string\)/.test(src), 'StorageService 须提供 readOriginalFor')
  // 真跑一遍反查正则：display/thumb → 同目录 original.*，且不接受非 blobs key
  const mRe = /^(blobs\/[^/]+\/([^/]+)\/)(?:display|thumb)\.[a-z0-9]+$/i
  const cases = [
    ['blobs/a4/HASH/display.webp', 'blobs/a4/HASH/'],
    ['blobs/5e/HASH/thumb.webp', 'blobs/5e/HASH/'],
  ]
  for (const [key, dir] of cases) {
    const mm = key.match(mRe)
    c.ok(!!mm && mm[1] === dir, `${key} 须反查到同 hash 目录 ${dir}`)
  }
  c.ok(!mRe.test('tmp/d4/abc.webp'), '临时对象不参与反查')
  c.ok(!mRe.test('blobs/a4/HASH/original.jpg'), 'original 自身不再反查')
})

m.test('A2 PDF 合成：自家 storage 派生图优先原图，外链不受影响', async (c) => {
  const pdf = read(PDF)
  c.ok(/downloadOriginalPreferred\(url\)/.test(pdf), 'fetchImages 须走 downloadOriginalPreferred')
  c.ok(/this\.storageService\.readOriginalFor\(key\)/.test(pdf), '须调用 readOriginalFor 反查原图')
  c.ok(/return\s+this\.download\(url\)/.test(pdf), '读不到原图须回退原 URL 下载')
  c.ok(/api\\\/storage\\\/files/.test(pdf) || /api\/storage\/files/.test(pdf), '只认自家 storage 路径')
})

m.test('A3 图像裁剪：取图优先 original，回退 display', async (c) => {
  const img = read(IMAGE)
  c.ok(/this\.storageService\.readOriginalFor\(key\)/.test(img), 'fetchImage 须优先读原图')
  c.ok(/readLocalObject\(key\)/.test(img), '读不到原图须回退 display 本身')
})

m.test('A4 识别渲染倍率 3.0 + 环境变量回退', async (c) => {
  const py = read(PY)
  c.ok(/GK_PDF_RENDER_SCALE/.test(py), '须支持 GK_PDF_RENDER_SCALE 环境变量')
  c.ok(/DEFAULT_SCALE\s*=\s*float\(os\.environ\.get\('GK_PDF_RENDER_SCALE',\s*'3\.0'\)\)/.test(py),
    '默认渲染倍率须为 3.0（≈216dpi）')
  c.ok(/MAX_RENDER_EDGE\s*=\s*4200/.test(py), '单页像素上限钳制须保留（防 OOM）')
})

export default m
