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
import type { MarkKind, RedMark, WritingCluster } from './wrongq.types'

export interface RedMarkResult {
  marks: RedMark[]
  /** 保留的批改标记掩膜（1=教师红笔，将被擦除/作为证据） */
  keptMask: Uint8Array
  /** 排除的红色页眉/边框掩膜（印刷，保留） */
  furnitureMask: Uint8Array
  furnitureCount: number
  coverage: number
}

function boxesNearT(
  a: { x0: number; y0: number; x1: number; y1: number },
  b: { x0: number; y0: number; x1: number; y1: number },
  t: number,
): boolean {
  return !(a.x1 + t < b.x0 || b.x1 + t < a.x0 || a.y1 + t < b.y0 || b.y1 + t < a.y0)
}

/**
 * 语义层：把空间邻近的红笔连通域聚成「书写簇」。
 *
 * 判据不是形状，而是**书写量**——教师订正必然留下成片笔画（多域 + 足墨），
 * 而对勾/叉是**孤立**的单符号。这一层与具体字形无关，因此不依赖大模型也不依赖
 * 手写 OCR 能否读准（实测红笔手写 OCR 基本读不出，但"这里有一串红笔"永远可靠）。
 *
 * 阈值实测依据（front medH=28.3 / back medH=24.2，真值 6 处 / 3 处）：
 *   r=0.5×medH（两侧各外扩 0.5×medH，即**中心间距 ≤1.0×medH 即并簇**）、
 *   parts≥3、ink≥0.8×medH² → front 6 簇、back 3 簇，**两页同时命中真值**；
 *   back 在 r∈{0.5,0.8,1.2}×{parts≥2,≥3} 全部组合下恒为 3 簇 → 参数稳健区很宽。
 *   r 收到 0.25×medH（间距 0.5×medH）时 front 只聚出 5 簇（一处订正被切碎）❌，故取 0.5。
 *
 * ⚠️ 易错点：判定必须**两侧都外扩**（等价间距 2r）。若只外扩一侧（间距 r），
 *   连笔订正会被切碎，实测 front 从 6 簇掉到 5 簇。
 */
export function groupWritingClusters(
  marks: RedMark[],
  medH: number,
  opts: { gapRatio?: number; minParts?: number; minInkRatio?: number } = {},
): WritingCluster[] {
  const gapRatio = opts.gapRatio ?? 0.5
  const minParts = opts.minParts ?? 3
  const minInkRatio = opts.minInkRatio ?? 0.8
  if (gapRatio <= 0) return []
  /** 每侧外扩半径；两框"外扩后相交"≤> 中心间距 ≤ 2r */
  const r = Math.max(1, Math.round(medH * gapRatio))
  const t = r * 2
  const minInk = Math.round(minInkRatio * medH * medH)

  // 下划线是排版横线（非书写内容），不参与书写簇
  const idx: number[] = []
  for (let i = 0; i < marks.length; i++) if (marks[i].kind !== 'underline') idx.push(i)
  const m = idx.length
  if (!m) return []

  const parent = new Int32Array(m)
  for (let i = 0; i < m; i++) parent[i] = i
  const find = (x: number): number => {
    let r = x
    while (parent[r] !== r) r = parent[r]
    while (parent[x] !== r) { const nx = parent[x]; parent[x] = r; x = nx }
    return r
  }
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      if (boxesNearT(marks[idx[i]].box, marks[idx[j]].box, t)) {
        const ra = find(i); const rb = find(j)
        if (ra !== rb) parent[ra] = rb
      }
    }
  }

  const groups = new Map<number, number[]>()
  for (let i = 0; i < m; i++) {
    const r = find(i)
    const g = groups.get(r)
    if (g) g.push(idx[i])
    else groups.set(r, [idx[i]])
  }

  const out: WritingCluster[] = []
  for (const [, g] of groups) {
    const parts = g.length
    let ink = 0
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const i of g) {
      ink += marks[i].n
      x0 = Math.min(x0, marks[i].box.x0); y0 = Math.min(y0, marks[i].box.y0)
      x1 = Math.max(x1, marks[i].box.x1); y1 = Math.max(y1, marks[i].box.y1)
    }
    if (parts < minParts || ink < minInk) continue
    out.push({ id: out.length, box: { x0, y0, x1, y1 }, markIds: g.slice(), parts, ink })
  }
  out.sort((a, b) => (a.box.y0 - b.box.y0) || (a.box.x0 - b.box.x0))
  out.forEach((c, i) => { c.id = i })
  return out
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
