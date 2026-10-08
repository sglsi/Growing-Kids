/**
 * 错题区域提取 · ① 预处理 + 版面结构（三栏切分 + 栏内行切分）
 *
 * 全部配方来自前期测试 v1~v6 实测（见《错题区域提取-前期测试报告.md》与 probe-wrongq6.ts）：
 *   · 必须先 straighten（拍照有倾斜/透视）；
 *   · 必须用 normalizeBackgroundLuma **除法归一化**再 Otsu——直接 Otsu 在报纸灰底上
 *     墨占比会飙到 12~20%（正常 5~10%），中间调大量误判，行/列投影被焊死；
 *   · 必须剔除图形大连通域（插图/框线）再做投影，否则字高与投影被污染；
 *   · 三栏必须约束式切分（c1/c2 联合搜索最空带 + 等宽偏置），否则栏隙(6~10px)被跨栏红笔堵死；
 *   · 行切分必须**按栏独立**做——不分栏时行界只在首栏贴合、中/右栏错位（用户反馈 1）。
 */
import sharp from 'sharp'
import { otsuThreshold, connectedComponents, estimateCharMetrics } from './image-layout'
import { normalizeBackgroundLuma } from './image-doc-enhance'
import { straightenImage } from './image-dewarp'

export interface LayoutContext {
  w: number
  h: number
  medH: number
  /** 二值墨迹图（1=墨），已剔除图形 */
  ink: Uint8Array
  /** 三栏 [x0,x1] */
  cols: Array<[number, number]>
  /** 每栏的行（y0,y1） */
  colRows: Array<Array<{ y0: number; y1: number }>>
  /** 归一化前的 luma（渲染/增强用） */
  luma: Float32Array
  /** 压平后的图像 buffer（供后续 mask/裁图复用，避免重复 straighten） */
  flatBuf: Buffer
  inkRatio: number
}

function lumaFrom(data: Buffer, w: number, h: number, ch: number): Float32Array {
  const n = w * h
  const luma = new Float32Array(n)
  for (let i = 0, p = 0; i < n; i++, p += ch) luma[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]
  return luma
}

// 3×3 闭运算复用 image-layout 的实现（此前此处有一份重复实现，已统一，避免两份逻辑漂移）
export { closeInk3x3 } from './image-layout'

/** 剔除图形大连通域（插图/框线），从文字 ink 中移除 */
export function stripGraphics(ink: Uint8Array, w: number, h: number, medH: number): { ink2: Uint8Array; stripped: number } {
  const { comps } = connectedComponents(ink, w, h, false)
  const out = new Uint8Array(ink)
  let stripped = 0
  for (const c of comps) {
    const bw = c.x1 - c.x0 + 1
    const bh = c.y1 - c.y0 + 1
    if ((bh > 4 * medH && bw > 2 * medH) || (bw > w * 0.85 && bh > 3 * medH)) {
      stripped++
      for (let y = c.y0; y <= c.y1; y++) {
        const base = y * w
        for (let x = c.x0; x <= c.x1; x++) out[base + x] = 0
      }
    }
  }
  return { ink2: out, stripped }
}

/** 约束式三栏切分：c1、c2 联合搜索最空带 + 等宽偏置 */
export function findThreeColumns(ink: Uint8Array, w: number, h: number, medH: number) {
  const y0 = Math.round(0.07 * h)
  const y1 = Math.round(0.93 * h)
  const prof = new Int32Array(w)
  for (let y = y0; y < y1; y++) {
    const base = y * w
    for (let x = 0; x < w; x++) if (ink[base + x]) prof[x]++
  }
  const bw = Math.max(6, Math.round(medH * 0.7))
  const pre = new Int32Array(w + 1)
  for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + prof[x]
  const bandInk = (cx: number) => {
    const a = Math.max(0, Math.round(cx - bw / 2))
    const b = Math.min(w - 1, Math.round(cx + bw / 2))
    return pre[b + 1] - pre[a]
  }
  const target = w / 3
  const biasScale = 6
  const c1Lo = Math.round(0.22 * w), c1Hi = Math.round(0.46 * w)
  const c2Lo = Math.round(0.54 * w), c2Hi = Math.round(0.80 * w)
  let bestC1 = Math.round(w / 3), bestC2 = Math.round((2 * w) / 3), bestScore = Infinity
  for (let c1 = c1Lo; c1 <= c1Hi; c1++) {
    for (let c2 = Math.max(c1 + Math.round(0.18 * w), c2Lo); c2 <= c2Hi; c2++) {
      const widths = [c1, c2 - c1, w - c2]
      const bias = (Math.abs(widths[0] - target) + Math.abs(widths[1] - target) + Math.abs(widths[2] - target)) * biasScale
      const score = bandInk(c1) + bandInk(c2) + bias
      if (score < bestScore) { bestScore = score; bestC1 = c1; bestC2 = c2 }
    }
  }
  const c1 = bestC1, c2 = bestC2
  return {
    c1, c2,
    cols: [[0, c1], [c1, c2], [c2, w]] as Array<[number, number]>,
    widths: [c1, c2 - c1, w - c2],
  }
}

/** 单栏行切分 */
export function colRowsIn(ink: Uint8Array, w: number, h: number, x0: number, x1: number, rowThRatio = 0.06) {
  const prof = new Int32Array(h)
  for (let y = 0; y < h; y++) {
    const base = y * w
    let c = 0
    for (let x = x0; x < x1; x++) if (ink[base + x]) c++
    prof[y] = c
  }
  const profMax = Math.max(...prof)
  const th = Math.max(1, Math.round(profMax * rowThRatio))
  const rows: Array<{ y0: number; y1: number }> = []
  let y = 0
  while (y < h) {
    if (prof[y] < th) { y++; continue }
    const y0 = y
    while (y < h && prof[y] >= th) y++
    rows.push({ y0, y1: y })
  }
  return rows
}

/** 构建版面上下文（全流程第①步 + 结构层） */
export async function buildLayoutContext(buf: Buffer): Promise<LayoutContext> {
  const st = await straightenImage(buf, { auto: true, curved: false })
  const flatBuf = st.buffer ?? buf
  const { data, info } = await sharp(flatBuf).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
  const w = info.width, h = info.height, ch = info.channels
  const n = w * h
  const luma = lumaFrom(data, w, h, ch)

  const flatMetrics = await estimateCharMetrics(flatBuf, {})
  const prior = w / 70 // 报纸正文字高先验 ≈ 页宽/70（v4 实测引入的双源钳位）
  const medH = Math.max(prior * 0.8, Math.min(prior * 2.0, flatMetrics.medH > 0 ? flatMetrics.medH : prior))

  const lumaN = await normalizeBackgroundLuma(luma, w, h, { medH, flatten: 1, inkIsDark: true })
  const g1 = new Uint8Array(n)
  for (let i = 0; i < n; i++) g1[i] = Math.max(0, Math.min(255, Math.round(lumaN[i])))
  const t1 = otsuThreshold(g1, n)
  const ink1 = new Uint8Array(n)
  for (let i = 0; i < n; i++) ink1[i] = g1[i] < t1 ? 1 : 0
  let inkRatio = 0
  for (let i = 0; i < n; i++) if (ink1[i]) inkRatio++
  inkRatio /= n

  const { ink2 } = stripGraphics(ink1, w, h, medH)
  const { cols } = findThreeColumns(ink2, w, h, medH)
  const colRows: Array<Array<{ y0: number; y1: number }>> = []
  for (const [a, b] of cols) {
    const rows = colRowsIn(ink2, w, h, a, b, 0.06)
    const merged: Array<{ y0: number; y1: number }> = []
    for (const r of rows) {
      const last = merged[merged.length - 1]
      if (last && r.y0 - last.y1 <= medH * 0.15) last.y1 = r.y1
      else merged.push({ ...r })
    }
    colRows.push(merged)
  }

  return { w, h, medH, ink: ink2, cols, colRows, luma, flatBuf, inkRatio }
}
