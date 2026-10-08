/**
 * 错题区域提取 · ②④ 标记↔题块关联（以红笔标记簇为锚点构建候选题块）
 *
 * 为什么以红笔簇为锚点而不是题号（对报纸版式）：
 *  报纸密排三栏、题号形如 `( )26.` 且缩进层级复杂，前期测试已证伪本地题号锚点路径（判断一 v2）。
 *  而"哪里有红笔批改"是本地最硬的一层（v6 红笔检测 4/4 可靠）。所以反过来——
 *  **先找红笔，再由红笔反推它批改的是哪一段**：标记按邻近聚成簇 → 归属栏 →
 *  在该栏内按行投影把簇的上下边界对齐到整行 → 横向取满栏宽。
 *
 * 这是路径 B 的**本地锚点**；VLM 不可用时它就是主输出，VLM 可用时用来校验/收紧 VLM 粗框。
 */
import type { LayoutContext } from './wrongq-layout'
import type { RedMark, WrongqBlock } from './wrongq.types'

function boxesNear(
  a: { x0: number; y0: number; x1: number; y1: number },
  b: { x0: number; y0: number; x1: number; y1: number },
  t: number,
): boolean {
  return !(a.x1 + t < b.x0 || b.x1 + t < a.x0 || a.y1 + t < b.y0 || b.y1 + t < a.y0)
}

export function buildBlocks(marks: RedMark[], ctx: LayoutContext): WrongqBlock[] {
  const { w, h, medH, cols, colRows } = ctx
  const m = marks.length
  if (!m) return []

  // 单链接聚类：包围盒外扩 t 后相交即合并。
  // ⚠️ t 不能取 medH（≈30px）——报纸行距 30~60px，会把相邻题目的标记合并成一块
  //    （实测 page28：30 标记被并成 12 块）。取 0.5×medH 保住每题粒度，
  //    符合 §9.1「宁可多报、误检显式可删」策略：过合并会丢粒度且难拆。
  const t = Math.round(medH * 0.5)
  const parent = new Int32Array(m)
  for (let i = 0; i < m; i++) parent[i] = i
  const find = (x: number): number => {
    let r = x
    while (parent[r] !== r) r = parent[r]
    while (parent[x] !== r) { const nx = parent[x]; parent[x] = r; x = nx }
    return r
  }
  const union = (a: number, b: number) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb }
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      if (boxesNear(marks[i].box, marks[j].box, t)) union(i, j)
    }
  }

  const groups = new Map<number, RedMark[]>()
  for (let i = 0; i < m; i++) {
    const r = find(i)
    const g = groups.get(r)
    if (g) g.push(marks[i])
    else groups.set(r, [marks[i]])
  }

  const blocks: WrongqBlock[] = []
  for (const [, g] of groups) {
    let y0 = Infinity, y1 = -Infinity
    for (const mk of g) { y0 = Math.min(y0, mk.box.y0); y1 = Math.max(y1, mk.box.y1) }

    // 归属栏：取成员众数；全为 -1 时按中心 x 落栏
    const colCount = new Map<number, number>()
    for (const mk of g) colCount.set(mk.col, (colCount.get(mk.col) ?? 0) + 1)
    let col = -1, best = -1
    for (const [k, v] of colCount) if (v > best) { best = v; col = k }
    if (col < 0) {
      const cx = (g.reduce((s, mk) => s + (mk.box.x0 + mk.box.x1) / 2, 0) / g.length)
      for (let i = 0; i < cols.length; i++) if (cx >= cols[i][0] && cx < cols[i][1]) { col = i; break }
    }
    if (col < 0 || col >= cols.length) col = 0

    const [cx0, cx1] = cols[col]

    // 纵向对齐到整行：包含与该簇有交叠的所有行，并取其完整上下边界
    const rows = colRows[col] ?? []
    let ry0 = y0, ry1 = y1
    let hit = false
    for (const r of rows) {
      if (r.y1 < y0 || r.y0 > y1) continue
      hit = true
      ry0 = Math.min(ry0, r.y0)
      ry1 = Math.max(ry1, r.y1)
    }
    if (!hit) { ry0 = y0; ry1 = y1 }

    // 纵向缓冲：块至少要覆盖 2 行，否则单行高的块不足以框住整道题（实测单行块仅 22px）
    const pad = Math.round(medH * 0.3)
    const minH = Math.round(medH * 2)
    const bx0 = Math.max(0, cx0)
    const bx1 = Math.min(w - 1, cx1 - 1)
    let by0 = Math.max(0, ry0 - pad)
    let by1 = Math.min(h - 1, ry1 + pad)
    if (by1 - by0 + 1 < minH) {
      const cy = Math.round((by0 + by1) / 2)
      by0 = Math.max(0, cy - Math.round(minH / 2))
      by1 = Math.min(h - 1, by0 + minH - 1)
    }

    blocks.push({
      id: blocks.length,
      box: { x0: bx0, y0: by0, x1: bx1, y1: by1 },
      normBox: [+(bx0 / w).toFixed(4), +(by0 / h).toFixed(4), +((bx1 - bx0 + 1) / w).toFixed(4), +((by1 - by0 + 1) / h).toFixed(4)],
      col,
      markIds: g.map((mk) => mk.id),
      verdict: 'unknown',
      confidence: 0,
      evidence: [],
      source: 'local',
    })
  }

  // 按阅读顺序（栏 → 纵向）排序
  blocks.sort((a, b) => (a.col - b.col) || (a.box.y0 - b.box.y0))
  blocks.forEach((b, i) => { b.id = i })
  return blocks
}
