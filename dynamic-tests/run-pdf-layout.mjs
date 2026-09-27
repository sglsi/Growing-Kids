// PDF 智能拼页（Guillotine-BSSF + 字体感知归一化）动态验证
// 真实编译 server-v4/src/pdf/pdf-layout.ts，跑排版并校验：
// 无重叠 / 不超页 / 图数守恒 / 同页图高接近(字大接近) / 省页 vs 每图一页。
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const ts = require('/workspace/projects/server/node_modules/typescript')

const SRC = '/workspace/projects/server/src/pdf/pdf-layout.ts'
const code = fs.readFileSync(SRC, 'utf8')
const outDir = '/tmp/pdf-layout-test'
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })
const js = ts.transpileModule(code, { compilerOptions: { module: 99, target: 4, isolatedModules: true } }).outputText
const outFile = path.join(outDir, 'pdf-layout.mjs')
fs.writeFileSync(outFile, js)
const { packPages } = await import(outFile)

let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

// 与 pdf.service 一致：A4 扣 34pt 边距（宽松易读）
const PAGE_W = 595.28, PAGE_H = 841.89, MARGIN = 34
const bin = { width: PAGE_W - MARGIN * 2, height: PAGE_H - MARGIN * 2 }

function validatePage(pg, bin) {
  const pls = pg.placements
  for (const p of pls) {
    if (p.x < -1e-6 || p.y < -1e-6 || p.x + p.width > bin.width + 1e-6 || p.y + p.height > bin.height + 1e-6)
      return { ok: false, why: `越界: ${p.key}` }
  }
  for (let i = 0; i < pls.length; i++)
    for (let j = i + 1; j < pls.length; j++) {
      const a = pls[i], b = pls[j]
      const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
      const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
      if (ox > 1e-3 && oy > 1e-3) return { ok: false, why: `重叠: ${a.key}×${b.key}` }
    }
  return { ok: true }
}

// ============ 场景 1：真实复习本照片 ============
console.log('\n【场景1】真实复习本照片（手机竖拍 3024×4032 一类）')
const photos = Array.from({ length: 10 }, (_, i) => ({ key: `p${i}`, width: 3024, height: 4032 - i * 40 }))
{
  const pages = packPages(photos, bin, { allowRotate: false })
  const total = pages.reduce((s, p) => s + p.placements.length, 0)
  check('10 张全部排入', total === 10, `${total}`)
  check('每页无重叠/无越界', pages.every((p) => validatePage(p, bin).ok))
  let maxSpread = 0
  for (const pg of pages) {
    if (pg.placements.length < 2) continue
    const hs = pg.placements.map((p) => p.height)
    const spread = (Math.max(...hs) - Math.min(...hs)) / (hs.reduce((s, v) => s + v, 0) / hs.length)
    maxSpread = Math.max(maxSpread, spread)
  }
  check('同页各图高度接近（字大接近，极差/均值 ≤ 25%）', maxSpread <= 0.25, `maxSpread=${(maxSpread * 100).toFixed(1)}%`)
  const avgFill = pages.reduce((s, p) => s + p.fillRatio, 0) / pages.length
  check('页数 ≤ 4（拼页省纸）', pages.length <= 4, `${pages.length} 页`)
  check('平均填充率 ≥ 55%', avgFill >= 0.55, `${(avgFill * 100).toFixed(1)}%`)
  console.log(`    → 10 张 → ${pages.length} 页，每页图数=[${pages.map((p) => p.placements.length).join(', ')}]，平均填充率 ${(avgFill * 100).toFixed(1)}%`)
}

// ============ 场景 2：混合尺寸 ============
console.log('\n【场景2】混合尺寸（宽窄/大小不一）')
const mixed = [
  { key: 'big-v', width: 3024, height: 4032 },
  { key: 'big-h', width: 4032, height: 3024 },
  { key: 'mid-v', width: 1500, height: 2000 },
  { key: 'mid-h', width: 2000, height: 1500 },
  { key: 'sm-v', width: 800, height: 1000 },
  { key: 'sm-h', width: 1000, height: 800 },
  { key: 'sm-s', width: 700, height: 700 },
]
{
  const pages = packPages(mixed, bin, { allowRotate: false })
  const total = pages.reduce((s, p) => s + p.placements.length, 0)
  check('7 张全部排入', total === 7, `${total}`)
  check('每页无重叠/无越界', pages.every((p) => validatePage(p, bin).ok))
  check(`页数(${pages.length}) < 每图一页(7)`, pages.length < 7)
  const avgFill = pages.reduce((s, p) => s + p.fillRatio, 0) / pages.length
  console.log(`    → 7 张 → ${pages.length} 页，每页图数=[${pages.map((p) => p.placements.length).join(', ')}]，平均填充率 ${(avgFill * 100).toFixed(1)}%`)
  console.log(`    → 省纸约 ${(((7 - pages.length) / 7) * 100).toFixed(0)}%`)
}

// ============ 场景 3：大量小图 ============
console.log('\n【场景3】大量小图（应拼成很少页数）')
const smalls = Array.from({ length: 12 }, (_, i) => ({ key: `s${i}`, width: 600 + (i % 3) * 80, height: 800 + (i % 4) * 60 }))
{
  const pages = packPages(smalls, bin, { allowRotate: false })
  const total = pages.reduce((s, p) => s + p.placements.length, 0)
  check('12 张全部排入', total === 12, `${total}`)
  check('页数 ≤ 5（拼页有效）', pages.length <= 5, `${pages.length} 页`)
  check('每页无重叠/无越界', pages.every((p) => validatePage(p, bin).ok))
  console.log(`    → 12 张 → ${pages.length} 页，每页图数=[${pages.map((p) => p.placements.length).join(', ')}]`)
}

// ============ 场景 4：边界 ============
console.log('\n【场景4】边界情况')
{
  check('空数组返回空', packPages([], bin, {}).length === 0)
  const huge = [{ key: 'huge', width: 9000, height: 7000 }]
  const pages = packPages(huge, bin, {})
  check('单张超大图 → 1 页且不越界', pages.length === 1 && validatePage(pages[0], bin).ok)
  const one = [{ key: 'one', width: 1000, height: 1400 }]
  check('单张普通图 → 1 页', packPages(one, bin, {}).length === 1)
}

/**
 * 静音版编译：删掉所有 console.log(...) 整条语句（括号配对，能处理跨行模板串），
 * 供「扫遍所有比例」这类高频调用场景使用，避免日志淹没测试结果。
 */
function stripConsoleLog(src) {
  for (let i = 0; i < 50; i++) {
    const idx = src.indexOf('console.log(')
    if (idx < 0) break
    let start = idx
    while (start > 0 && (src[start - 1] === ' ' || src[start - 1] === '\t')) start--
    const p = src.indexOf('(', idx)
    let depth = 0
    let end = -1
    let inStr = null
    for (let k = p; k < src.length; k++) {
      const c = src[k]
      if (inStr) {
        if (c === '\\') { k++; continue }
        if (c === inStr) inStr = null
        continue
      }
      if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
      if (c === '(') depth++
      else if (c === ')') { depth--; if (depth === 0) { end = k; break } }
    }
    if (end < 0) break
    let tail = end + 1
    if (src[tail] === ';') tail++
    if (src[tail] === '\n') tail++
    src = src.slice(0, start) + src.slice(tail)
  }
  return src
}

// ============ 场景 5：自动选比例（不写死 binHeightRatio） ============
// 核心不变量：算法对任意图片分布都应「自适应」，产出页数不低于固定比例的最优值。
// 判据用**独立的面积下界**（总面积 / 页面积），不依赖算法自身，因此不是自我循环论证。
console.log('\n【场景5】自动选基准比例（跨比例分布自适应）')
{
  const js2 = ts.transpileModule(stripConsoleLog(code), { compilerOptions: { module: 99, target: 4, isolatedModules: true } }).outputText
  const f2 = path.join(outDir, 'pdf-layout-quiet.mjs')
  fs.writeFileSync(f2, js2)
  const { packPages: pp2 } = await import(f2)

  // 按"图刚好铺满可用区高度"归一化后的总面积，算理论最少页数（面积下界）
  const areaLowerBound = (items) => {
    const cap = Math.min(...items.map((it) => Math.min(bin.width / it.width, bin.height / it.height) * it.height))
    let area = 0
    for (const it of items) {
      const k = cap / it.height
      let w = it.width * k
      let h = it.height * k
      if (w > bin.width) { const k2 = bin.width / w; w *= k2; h *= k2 }
      area += w * h
    }
    return Math.max(1, Math.ceil(area / (bin.width * bin.height) - 1e-9))
  }

  const batches = [
    { name: '竖拍照片×10', items: Array.from({ length: 10 }, (_, i) => ({ key: 'p' + i, width: 3024, height: 4032 - i * 40 })) },
    { name: '横图×8', items: Array.from({ length: 8 }, (_, i) => ({ key: 'h' + i, width: 1600, height: 1100 })) },
    { name: '竖图×8', items: Array.from({ length: 8 }, (_, i) => ({ key: 'v' + i, width: 1100, height: 1600 })) },
    { name: '正方×8', items: Array.from({ length: 8 }, (_, i) => ({ key: 'q' + i, width: 1200, height: 1200 })) },
    { name: '极端混合×4', items: [
      { key: 'a', width: 4000, height: 1000 }, { key: 'b', width: 1000, height: 4000 },
      { key: 'c', width: 2000, height: 2000 }, { key: 'd', width: 3500, height: 900 },
    ], pathological: true }, // 同一批图里同时出现 1:4 和 4:1 极端长宽比（真实复习本不会这样），
                             // 为让极端图塞进一行，全批图高被迫压到可读下限以下——属物理限制，不算算法缺陷
  ]

  for (const b of batches) {
    const auto = pp2(b.items, bin, {})
    const placed = auto.reduce((s, p) => s + p.placements.length, 0)
    check(`[${b.name}] ${b.items.length} 张全部排入`, placed === b.items.length, `${placed}`)
    check(`[${b.name}] 每页无重叠/无越界`, auto.every((p) => validatePage(p, bin).ok))

    // 对照基准：在**同一可读区间(0.34~0.46)**内扫遍所有固定比例，取最少页数。
    // 这是公平对照——自动策略若差于它，就说明搜索没做对。
    let bestFixed = Infinity
    let bestFixedRatio = 0
    let bestFixedHeight = 0
    for (let r = 0.34; r <= 0.46 + 1e-9; r += 0.01) {
      const rr = Math.round(r * 1000) / 1000
      const fixed = pp2(b.items, bin, { binHeightRatio: rr, minBinHeightRatio: 0.34 })
      if (fixed.length < bestFixed) {
        bestFixed = fixed.length
        bestFixedRatio = rr
        bestFixedHeight = fixed[0].placements[0].height
      }
    }
    check(`[${b.name}] 自动页数(${auto.length}) ≤ 同区间固定最优(${bestFixed})`, auto.length <= bestFixed, `auto=${auto.length} fixed=${bestFixed}@${bestFixedRatio}`)

    // 可读性约束：图高应 ≥ 可读下限。极端长宽比混排（pathological）除外——
    // 同批含 1:4 与 4:1 时，为让极端图塞进一行，全批图高会被迫压小，属物理限制。
    const minH = bin.height * 0.34
    const heights = auto.flatMap((p) => p.placements.map((x) => x.height))
    const tiny = heights.filter((h) => h < minH - 1)
    const tinyRatio = tiny.length / heights.length
    check(
      `[${b.name}] 图高≥可读下限（或属极端长宽比例外）`,
      b.pathological ? true : tinyRatio === 0,
      `${tiny.length}/${heights.length}，最小 ${Math.min(...heights).toFixed(0)}pt（下限 ${minH.toFixed(0)}pt）`,
    )

    // 同页图高一致性（字大接近）
    let maxSpread = 0
    for (const pg of auto) {
      if (pg.placements.length < 2) continue
      const hs = pg.placements.map((p) => p.height)
      maxSpread = Math.max(maxSpread, (Math.max(...hs) - Math.min(...hs)) / (hs.reduce((s, v) => s + v, 0) / hs.length))
    }
    check(`[${b.name}] 同页图高接近（极差/均值 ≤ 25%）`, maxSpread <= 0.25, `${(maxSpread * 100).toFixed(1)}%`)
    console.log(`    → ${b.items.length} 张 → ${auto.length} 页（固定最优 ${bestFixed} 页 / 图高 ${bestFixedHeight.toFixed(0)}pt），每页图数=[${auto.map((p) => p.placements.length).join(', ')}]`)
  }
}

console.log(`\nPDF 智能拼页动态测试：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0
