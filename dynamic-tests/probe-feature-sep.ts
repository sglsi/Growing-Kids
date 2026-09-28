/**
 * 【特征可分性实验】找一个能真正区分「手写行」与「大号印刷标题行」的特征。
 *
 * 已被实测否决的两个特征（务必记录，避免重复踩）：
 *   ① 行高：二者都大 → **本质上不可分**（已知边界）
 *   ② 墨迹密度：手写 0.276~0.334、标题 0.295~0.346 → **严重重叠**；
 *      且拍照模糊会让密度整体上升 20~50%，绝对阈值必然误杀手写
 *      （实测黑笔 blur=1.0 时 7 个手写行全被拦 → 覆盖率归零）
 *
 * 本轮试两个**对模糊更鲁棒**的候选（都源于"印刷体字形规整、手写不规则"这一本质差异）：
 *   A. 梯度方向规整度：印刷体笔画横平竖直 → 边缘梯度集中在 0°/90° 附近
 *   B. 基线抖动：印刷体字符的上下边界严格对齐 → 按列切分字符后 top/bottom 的 IQR 极小
 *
 * 运行：cd /workspace/projects/server && npx tsx /workspace/dynamic-tests/probe-feature-sep.ts
 */
import sharp from 'sharp'
import { segmentTextRows, rowInkDensity } from '/workspace/projects/server/src/image/handwriting-mask'

const W = 900, H = 1200, GROUPS = 7, ROW_H = 140, PRINT_FS = 22
const HAND_BASE = (i: number) => 178 + i * ROW_H

function printedLayer(): string {
  return Array.from({ length: GROUPS }, (_, i) =>
    `<text x="80" y="${100 + i * ROW_H}" font-family="serif" font-size="${PRINT_FS}" fill="#111">一、填空题 第 ${i + 1} 题：请根据题意把答案写在下面的横线上。</text>` +
    `<line x1="80" y1="${118.5 + i * ROW_H}" x2="820" y2="${118.5 + i * ROW_H}" stroke="#bbb" stroke-width="1"/>`).join('')
}
function sheetHand(color: string, fs2: number): Buffer {
  const hand = Array.from({ length: GROUPS }, (_, i) =>
    `<text x="150" y="${HAND_BASE(i)}" font-family="serif" font-size="${fs2}" fill="${color}">解答：36 厘米 ${i + 1}</text>`).join('')
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fdfdfa"/>${printedLayer()}${hand}</svg>`)
}
/**
 * ⚠️ 底边判据的最大风险样本：英文印刷体有**下伸字母**（g/y/p/j/q），
 * 它们的底边明显低于基线 → 若底边 IQR 因此变大，印刷标题就会被误判成手写。
 */
function sheetLatinTitle(fs2: number): Buffer {
  const titles = Array.from({ length: 4 }, (_, i) =>
    `<text x="70" y="${120 + i * 260}" font-family="serif" font-size="${fs2}" fill="#111">Chapter ${i + 1} — Physics, Geometry &amp; Psychology</text>`).join('')
  const body = Array.from({ length: 4 }, (_, i) =>
    Array.from({ length: 5 }, (_, k) =>
      `<text x="80" y="${170 + i * 260 + k * 34}" font-family="serif" font-size="${PRINT_FS}" fill="#111">这里是正常的印刷正文内容第 ${i * 5 + k + 1} 行，用于提供正文基准密度。</text>`).join('')).join('')
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fdfdfa"/>${titles}${body}</svg>`)
}
function sheetMixedTitle(fs2: number): Buffer {
  const titles = Array.from({ length: 4 }, (_, i) =>
    `<text x="70" y="${120 + i * 260}" font-family="serif" font-size="${fs2}" fill="#111">第 ${i + 1} 章 Physics 几何 &amp; English</text>`).join('')
  const body = Array.from({ length: 4 }, (_, i) =>
    Array.from({ length: 5 }, (_, k) =>
      `<text x="80" y="${170 + i * 260 + k * 34}" font-family="serif" font-size="${PRINT_FS}" fill="#111">这里是正常的印刷正文内容第 ${i * 5 + k + 1} 行，用于提供正文基准密度。</text>`).join('')).join('')
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fdfdfa"/>${titles}${body}</svg>`)
}
function sheetBigTitle(fs2: number): Buffer {
  const titles = Array.from({ length: 4 }, (_, i) =>
    `<text x="80" y="${120 + i * 260}" font-family="serif" font-size="${fs2}" fill="#111">第三章 综合运算 ${i + 1}</text>`).join('')
  const body = Array.from({ length: 4 }, (_, i) =>
    Array.from({ length: 5 }, (_, k) =>
      `<text x="80" y="${170 + i * 260 + k * 34}" font-family="serif" font-size="${PRINT_FS}" fill="#111">这里是正常的印刷正文内容第 ${i * 5 + k + 1} 行，用于提供正文基准密度。</text>`).join('')).join('')
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fdfdfa"/>${titles}${body}</svg>`)
}

/** Otsu 二值化（与生产代码同法） */
function otsu(gray: Buffer): { ink: Uint8Array; thr: number } {
  const n = gray.length
  const hist = new Int32Array(256)
  for (let i = 0; i < n; i++) hist[gray[i]]++
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0, wB = 0, maxVar = -1, thr = 127
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = n - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > maxVar) { maxVar = between; thr = t }
  }
  const ink = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (gray[i] < thr) ink[i] = 1
  return { ink, thr }
}

const quantile = (arr: number[], q: number) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * q)))]
}

type Feat = { density: number; axisRatio: number; topIqr: number; botIqr: number; baseMode: number }

function features(gray: Buffer, ink: Uint8Array, w: number, h: number, r: { y0: number; y1: number }): Feat {
  const rh = r.y1 - r.y0
  const { density, xmin, xmax } = rowInkDensity(ink, w, r)

  // ── A. 梯度方向规整度：统计"边缘像素中梯度接近水平/垂直"的比例 ──────────
  let edge = 0, axis = 0
  for (let y = Math.max(1, r.y0); y < Math.min(h - 1, r.y1); y++) {
    for (let x = Math.max(1, xmin); x < Math.min(w - 1, xmax + 1); x++) {
      const i = y * w + x
      if (!ink[i]) continue
      const gx = gray[i + 1] - gray[i - 1]
      const gy = gray[i + w] - gray[i - w]
      const mag = Math.sqrt(gx * gx + gy * gy)
      if (mag < 25) continue // 平坦区/笔画内部，梯度无意义
      edge++
      const a = Math.abs(gx), b = Math.abs(gy)
      const lo = Math.min(a, b), hi = Math.max(a, b)
      if (hi > 0 && lo / hi < 0.27) axis++ // 方向落在 ±15° 内（轴对齐）
    }
  }

  // ── B. 基线抖动：按列投影切分字符，取各字符 top/bottom 的 IQR（归一化到行高）──
  const tops: number[] = []
  const bots: number[] = []
  let x = xmin
  while (x <= xmax) {
    // 找下一个含墨迹的列
    let c = 0
    for (let y = r.y0; y < r.y1; y++) if (ink[y * w + x]) c++
    if (c === 0) { x++; continue }
    const x0 = x
    while (x <= xmax) {
      let cc = 0
      for (let y = r.y0; y < r.y1; y++) if (ink[y * w + x]) cc++
      if (cc === 0) break
      x++
    }
    let top = r.y1, bot = r.y0 - 1
    for (let y = r.y0; y < r.y1; y++)
      for (let xx = x0; xx < x; xx++)
        if (ink[y * w + xx]) { if (y < top) top = y; if (y > bot) bot = y }
    tops.push(top); bots.push(bot)
  }
  const iqr = (arr: number[]) => quantile(arr, 0.75) - quantile(arr, 0.25)

  // ── B-2. 基线众数占比：字符底边落在"最密集的那条基线 ±1px"内的比例 ────────
  //    为什么需要它：IQR 会被**多集群**坑 —— 中英混排的中文底边与英文基线不在同一 y，
  //    形成两个集群，IQR 立刻变大（实测 0.146~0.167，与手写的 0.158 直接重叠）。
  //    而"多数字符是否落在同一条基线上"对这种情况是稳健的：
  //      印刷中文：几乎全部字符底边共线 → 占比≈1
  //      印刷英文：下伸字母(g/y/p)只是少数 → 占比仍高
  //      中英混排：中文占多数 → 占比仍高
  //      手写：底边上下浮动 → 占比低
  let baseMode = 0
  if (bots.length) {
    let best = 0
    for (const b of bots) {
      let c = 0
      for (const o of bots) if (Math.abs(o - b) <= 1) c++
      if (c > best) best = c
    }
    baseMode = best / bots.length
  }

  return {
    density,
    axisRatio: edge ? axis / edge : 0,
    topIqr: rh ? iqr(tops) / rh : 0,
    botIqr: rh ? iqr(bots) / rh : 0,
    baseMode,
  }
}

async function measure(svg: Buffer, blur: number) {
  const p = sharp(svg)
  const img = await (blur > 0 ? p.blur(blur) : p).jpeg({ quality: 93 }).toBuffer()
  const gray = await sharp(img).resize(W, H, { fit: 'fill' }).grayscale().raw().toBuffer()
  const { ink } = otsu(gray)
  const { rows, glyphH } = segmentTextRows(ink, W, H)
  const rowLimit = glyphH * 1.5
  const tall = rows.filter((r) => r.y1 - r.y0 >= rowLimit)
  return tall.map((r) => features(gray, ink, W, H, r))
}

const fmt = (v: number) => v.toFixed(3)
const range = (vs: number[]) => `${fmt(Math.min(...vs))}~${fmt(Math.max(...vs))}`

async function main() {
  console.log('=== 特征可分性：手写行 vs 大号印刷标题行 ===\n')
  console.log('样本'.padEnd(18) + '密度'.padEnd(18) + '梯度轴对齐率'.padEnd(16) + '顶边IQR'.padEnd(14) + '底边IQR'.padEnd(14) + '基线众数占比')

  const row = async (label: string, svg: Buffer, blur: number) => {
    const fs2 = await measure(svg, blur)
    if (!fs2.length) { console.log(`${label.padEnd(18)}(无候选行)`); return }
    console.log(
      label.padEnd(18) +
      range(fs2.map((f) => f.density)).padEnd(18) +
      range(fs2.map((f) => f.axisRatio)).padEnd(16) +
      range(fs2.map((f) => f.topIqr)).padEnd(14) +
      range(fs2.map((f) => f.botIqr)).padEnd(14) +
      range(fs2.map((f) => f.baseMode)),
    )
  }

  console.log('--- 手写（应放行）---')
  for (const blur of [0, 0.6, 1.0]) await row(`黑笔 blur=${blur}`, sheetHand('#222222', 42), blur)
  for (const blur of [0, 0.6, 1.0]) await row(`铅笔 blur=${blur}`, sheetHand('#5a5a5a', 42), blur)
  console.log('--- 大号印刷标题（应拦住）---')
  for (const f of [40, 46, 52]) {
    for (const blur of [0, 0.6]) await row(`标题${f} blur=${blur}`, sheetBigTitle(f), blur)
  }
  console.log('--- ⚠️ 含下伸字母(g/y/p/j)的印刷标题：底边判据的最大风险 ---')
  for (const blur of [0, 0.6]) await row(`英文标题 blur=${blur}`, sheetLatinTitle(42), blur)
  for (const blur of [0, 0.6]) await row(`中英混排 blur=${blur}`, sheetMixedTitle(42), blur)
  console.log('\n可分判据：某一列上，两组取值的区间必须**不重叠**（或至少留出明显间隙）')
}
main().catch((e) => { console.error(e); process.exit(1) })
