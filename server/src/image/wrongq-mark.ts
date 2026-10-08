/**
 * 错题区域提取 · ③ 批改标记检测（色域 mask → 连通域 → 形态分类）
 *
 * ⚠️ v6 实测两条硬性修正（都是踩出来的，别改回去）：
 *  1. chromaMin 默认 22 会把**细红笔对勾碎成离散红点后漏掉** → 降到 14 + 闭运算补连；
 *  2. **必须先排除红色页眉家具，再做闭运算**。反过来做会把顶部红色横幅、侧边红框与
 *     正文批改笔迹经 1px 膨胀连成整页巨型连通域（实测 page30/page31 单域 25577/68777px²、
 *     fill 仅 2%~5%）——典型误抓。
 *  家具判定：贴边(≤0.8×medH) / 横幅(宽>0.8×页宽且高<3×medH) / 竖条(高>0.8×页高且宽<3×medH)。
 */
import { maskFromColorThreshold } from './handwriting-mask'
import { connectedComponents } from './image-layout'
import { closeInk3x3, type LayoutContext } from './wrongq-layout'
import type { MarkKind, RedMark } from './wrongq.types'

export interface RedMarkResult {
  marks: RedMark[]
  /** 保留的批改标记掩膜（1=教师红笔，将被擦除/作为证据） */
  keptMask: Uint8Array
  /** 排除的红色页眉/边框掩膜（印刷，保留） */
  furnitureMask: Uint8Array
  furnitureCount: number
  coverage: number
}

/** 形态分类（规则，阈值来自 §6.3 实测初值，待金标准标定） */
export function classifyMark(
  box: { x0: number; y0: number; x1: number; y1: number },
  n: number,
  medH: number,
): { kind: MarkKind; fill: number; aspect: number } {
  const bw = box.x1 - box.x0 + 1
  const bh = box.y1 - box.y0 + 1
  const aspect = bw / Math.max(1, bh)
  const fill = n / Math.max(1, bw * bh)
  if (aspect > 6 && bh <= medH * 0.3) return { kind: 'underline', fill, aspect }
  if (n > 300) return { kind: 'correction', fill, aspect }
  if (aspect >= 0.7 && aspect <= 1.4 && fill >= 0.25 && fill <= 0.75) return { kind: 'circle', fill, aspect }
  if (aspect >= 0.7 && aspect <= 1.5 && fill >= 0.12 && fill <= 0.5) return { kind: 'cross', fill, aspect }
  if (aspect > 1.5 && aspect <= 5 && fill >= 0.12 && fill <= 0.7) return { kind: 'tick', fill, aspect }
  return { kind: 'unknown', fill, aspect }
}

export async function detectRedMarks(
  flatBuf: Buffer,
  ctx: LayoutContext,
  opts: { chromaMin?: number } = {},
): Promise<RedMarkResult> {
  const { w, h, medH, cols } = ctx
  const n = w * h
  const chromaMin = opts.chromaMin ?? 14

  const cm = await maskFromColorThreshold(flatBuf, { chromaMin })
  const rawInk = new Uint8Array(n)
  for (let i = 0; i < n; i++) rawInk[i] = cm.data[i] ? 1 : 0

  const edgeTol = Math.max(4, Math.round(medH * 0.8))
  const maxArea = Math.round((6 * medH) * (6 * medH))
  const isFurniture = (c: { x0: number; x1: number; y0: number; y1: number }) =>
    c.x0 <= edgeTol || c.x1 >= w - 1 - edgeTol || c.y0 <= edgeTol || c.y1 >= h - 1 - edgeTol ||
    (c.x1 - c.x0 + 1 > w * 0.8 && c.y1 - c.y0 + 1 < medH * 3) ||
    (c.y1 - c.y0 + 1 > h * 0.8 && c.x1 - c.x0 + 1 < medH * 3)

  const { comps: rawComps } = connectedComponents(rawInk, w, h, false)
  const interior = new Uint8Array(n)
  const furnitureMask = new Uint8Array(n)
  let furnitureCount = 0
  for (const c of rawComps) {
    if (isFurniture(c)) {
      furnitureCount++
      for (let y = c.y0; y <= c.y1; y++) { const b = y * w; for (let x = c.x0; x <= c.x1; x++) if (rawInk[b + x]) furnitureMask[b + x] = 1 }
      continue
    }
    if (c.n < 3) continue
    for (let y = c.y0; y <= c.y1; y++) { const b = y * w; for (let x = c.x0; x <= c.x1; x++) if (rawInk[b + x]) interior[b + x] = 1 }
  }

  const closed = closeInk3x3(interior, w, h)
  const cc = connectedComponents(closed, w, h, true)
  const comps = cc.comps
  const labels = cc.labels as Int32Array
  const keptMask = new Uint8Array(n)
  const marks: RedMark[] = []
  let covered = 0
  for (let p = 0; p < n; p++) {
    if (!closed[p] || labels[p] < 0) continue
    const c = comps[labels[p]]
    if (c.n < 3 || c.n > maxArea) continue
    keptMask[p] = 1
    covered++
  }
  for (let i = 0; i < comps.length; i++) {
    const c = comps[i]
    if (c.n < 3 || c.n > maxArea) continue
    const box = { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 }
    const { kind, fill, aspect } = classifyMark(box, c.n, medH)
    const cx = (c.x0 + c.x1) / 2
    let col = -1
    for (let i = 0; i < cols.length; i++) if (cx >= cols[i][0] && cx < cols[i][1]) { col = i; break }
    marks.push({ id: marks.length, box, n: c.n, fill, aspect, kind, col })
  }

  return { marks, keptMask, furnitureMask, furnitureCount, coverage: covered / n }
}
