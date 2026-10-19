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
import type { RedMark, WrongqBlock, WritingCluster } from './wrongq.types'
import type { QuestionUnit } from './wrongq-segment'
import { findUnitForY } from './wrongq-segment'

function boxesNear(
  a: { x0: number; y0: number; x1: number; y1: number },
  b: { x0: number; y0: number; x1: number; y1: number },
  t: number,
): boolean {
  return !(a.x1 + t < b.x0 || b.x1 + t < a.x0 || a.y1 + t < b.y0 || b.y1 + t < a.y0)
}

/** 两框 y 向交并比（只比纵向：同一列内块宽本来就相同） */
function yIoU(a: { y0: number; y1: number }, b: { y0: number; y1: number }): number {
  const inter = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 1
  if (inter <= 0) return 0
  const uni = Math.max(a.y1, b.y1) - Math.min(a.y0, b.y0) + 1
  return uni > 0 ? inter / uni : 0
}

/** 二维 IoU（面积交并比） */
function boxIoU(
  a: { x0: number; y0: number; x1: number; y1: number },
  b: { x0: number; y0: number; x1: number; y1: number },
): number {
  const ix0 = Math.max(a.x0, b.x0), iy0 = Math.max(a.y0, b.y0)
  const ix1 = Math.min(a.x1, b.x1), iy1 = Math.min(a.y1, b.y1)
  const iw = ix1 - ix0 + 1, ih = iy1 - iy0 + 1
  if (iw <= 0 || ih <= 0) return 0
  const inter = iw * ih
  const au = (a.x1 - a.x0 + 1) * (a.y1 - a.y0 + 1)
  const bu = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1)
  const uni = au + bu - inter
  return uni > 0 ? inter / uni : 0
}

/** 像素框 → 归一化 [x, y, w, h]（0~1，保留 4 位） */
function normBoxOf(box: { x0: number; y0: number; x1: number; y1: number }, w: number, h: number): [number, number, number, number] {
  return [
    +(box.x0 / w).toFixed(4),
    +(box.y0 / h).toFixed(4),
    +((box.x1 - box.x0 + 1) / w).toFixed(4),
    +((box.y1 - box.y0 + 1) / h).toFixed(4),
  ]
}

/**
 * 阶段 B：把红笔锚点块映射到题目单元，取整题满框。
 *
 * 对每个块，取其纵向中心 y 与所属栏，在题目单元里查找 y 落入的单元；命中则把裁图框替换为
 * 该单元**整题满框**（满栏宽 × 题号行到下一题号行），并打 `questionUnitId`。
 * 同一题的多处红笔 → 各自映射到同一单元 → 框相同 → 后续 mergeOverlappingBlocks 合并为一题。
 * 未命中（无 OCR / 该 y 不在任何题号定界的单元内）→ 保持原紧框（兜底，不劣化）。
 *
 * ⚠️ 两套栏坐标系（#124 正面 15 题标注错误的根因）：
 *   块的 col 来自页面级 `ctx.cols`（如正面双栏 [0,553]+[554,1462]），
 *   而题目单元的 col 来自 section 级 `colsAtY`（探究案等通栏 section 只有一栏 → col 全 0）。
 *   于是探究案里的红笔块（页面级 col=1）永远匹配不到通栏单元（section 级 col=0），
 *   题号关联全部落空（表现为错题标注无题号 "?"）。
 *   修复：严格 col 匹配未命中时，回落"块中心点几何包含"匹配（不限 col）——
 *   通栏单元的 box 本就覆盖块位置，几何命中即同一题。
 */
function applyUnits(
  blocks: WrongqBlock[],
  units: QuestionUnit[] | undefined,
  w: number,
  h: number,
  /** 吸附容差：块中心未直接落入单元时，归到同栏最近单元（桥接单元间空隙）。 */
  snapTol = 0,
): WrongqBlock[] {
  if (!units || !units.length) return blocks
  const out: WrongqBlock[] = []
  for (const b of blocks) {
    const cy = Math.round((b.box.y0 + b.box.y1) / 2)
    const cx = Math.round((b.box.x0 + b.box.x1) / 2)
    let u = findUnitForY(units, b.col, cy, snapTol)
    // 回落：块中心点 (cx, cy) 几何包含于某单元 box（跨栏坐标系错配时救命）
    if (!u) {
      for (const cand of units) {
        if (cx >= cand.box.x0 && cx <= cand.box.x1 && cy >= cand.box.y0 && cy <= cand.box.y1) { u = cand; break }
      }
    }
    if (u) {
      out.push({ ...b, box: { ...u.box }, normBox: normBoxOf(u.box, w, h), questionUnitId: u.id })
    } else {
      out.push(b)
    }
  }
  return out
}

/**
 * 收敛重叠块：把**同列内纵向高度重叠**的块合并为一个。
 *
 * 为什么需要它（实测根因）：
 *   同一道题内常有多处红笔批改（如音标旁一处、单词旁一处），它们落在**相邻行带**，
 *   聚类距离 t=0.5×medH 不足以并成一个簇，于是各生成一块——而这些块都被对齐到几乎
 *   相同的行带、且宽度都是整栏宽，裁出来的图内容高度雷同 → OCR 出成段重复文本。
 *
 * 阈值用实测扫描定（front 图，块高≈57px）：
 *   - 平移 ~4px（IoU≈0.87）→ 合并；~7px（IoU≈0.78）→ 视链合并；
 *     平移≈23px≈一行（IoU≈0.43）→ 不合并（保住行级粒度，避免吞并邻题）
 *   扫描结果 A/B（基线 100 块 / 重复率 0.098 / 题号 10 个）：
 *     0.7  → 75 块，重复率 0，但题号掉到 8（丢了 9、13）❌ 过度合并
 *     0.85 → 86 块，重复率 0，题号 10 个全保留 ✅ **重复归零且召回无损**
 *   故默认取 0.85：只吃"几乎完全重合"的真重复，不动相邻题。
 * 链式自限：合并后 cur 变高，与下一个块的 IoU 自然下降，不会失控级联成巨块。
 */
function mergeOverlappingBlocks(blocks: WrongqBlock[], iouTh: number, use2D = false): WrongqBlock[] {
  if (blocks.length <= 1 || iouTh <= 0) return blocks
  const byCol = new Map<number, WrongqBlock[]>()
  for (const b of blocks) {
    const arr = byCol.get(b.col)
    if (arr) arr.push(b)
    else byCol.set(b.col, [b])
  }
  const out: WrongqBlock[] = []
  for (const [, arr] of byCol) {
    arr.sort((a, b) => a.box.y0 - b.box.y0)
    let cur: WrongqBlock | null = null
    for (const b of arr) {
      if (!cur) {
        cur = { ...b, box: { ...b.box }, markIds: [...b.markIds] }
        continue
      }
      // use2D：簇驱动建块时用二维 IoU。横向收紧后不同簇的 y 范围可能趋同，
      // 仅比纵向会把**相邻两道题的订正**并成一块（实测 front 6 条掉到 5 条）❌；
      // 二维 IoU 只在"几乎完全重合"时才并，保住每题粒度。
      if ((use2D ? boxIoU(cur.box, b.box) : yIoU(cur.box, b.box)) >= iouTh) {
        cur.box.y0 = Math.min(cur.box.y0, b.box.y0)
        cur.box.y1 = Math.max(cur.box.y1, b.box.y1)
        cur.box.x0 = Math.min(cur.box.x0, b.box.x0)
        cur.box.x1 = Math.max(cur.box.x1, b.box.x1)
        for (const id of b.markIds) if (!cur.markIds.includes(id)) cur.markIds.push(id)
      } else {
        out.push(cur)
        cur = { ...b, box: { ...b.box }, markIds: [...b.markIds] }
      }
    }
    if (cur) out.push(cur)
  }
  return out
}

export function buildBlocks(
  marks: RedMark[],
  ctx: LayoutContext,
  /** 同列内块纵向 IoU ≥ 该值则合并（去重复块）。默认 0.85（实测最优）；传 0 关闭收敛。 */
  mergeIoU: number = 0.85,
  /**
   * 语义书写簇：非空时**只由书写簇建块**（每簇一块 = 一道被批改的题）。
   *
   * 为什么：全部标记建块会把 109 个误判"勾"、59 个"圈"也各建一块（front 实测 86 块
   * 而真值只有 6 处订正），裁出来的条目绝大多数是噪声。书写簇已按"成片书写"筛过，
   * 用它建块 → front 6 块 / back 3 块，**与真值一致**。
   * 为空（如无红笔版面、或簇被阈值滤光）时回退到全标记建块，保持 P1-12 兜底能力。
   */
  clusters?: WritingCluster[],
  /**
   * 阶段 A 题目单元（本地题号定界的整题框）。非空时进入阶段 B：
   * 每个红笔簇的 (col, y) 落入某题目单元 → 该块裁图框取**整题满框**（满栏宽 × 题号行到下一题号行），
   * 不再用红笔重心定边界。OCR 不可用 / 无题号时为 undefined，回落到行对齐紧框兜底（旧行为）。
   */
  units?: QuestionUnit[],
): WrongqBlock[] {
  const { w, h, medH, cols, colRows } = ctx
  const m = marks.length
  if (!m) return []

  // ===== 书写簇优先：每簇直接成块，跳过全标记聚类 =====
  if (clusters && clusters.length) {
    const cBlocks: WrongqBlock[] = []
    for (const c of clusters) {
      const cxMid = (c.box.x0 + c.box.x1) / 2
      let col = -1
      for (let i = 0; i < cols.length; i++) if (cxMid >= cols[i][0] && cxMid < cols[i][1]) { col = i; break }
      const cm: RedMark[] = c.markIds.map((i) => marks[i]).filter(Boolean)
      if (cm.length) {
        const cc = new Map<number, number>()
        for (const mk of cm) cc.set(mk.col, (cc.get(mk.col) ?? 0) + 1)
        let best = -1
        for (const [k, v] of cc) if (v > best) { best = v; col = k }
      }
      if (col < 0 || col >= cols.length) col = 0
      const [cx0, cx1] = cols[col]

      // ===== 横向：只取"簇 x 外扩 1×medH"，不再取满栏宽 =====
      // 为什么改：满栏宽是为报纸密排设计的；作业本（词汇表/句子列表）同栏内
      // 横向并列着多个词条，取满栏宽会把**同列其它题一并框进来**——实测一条
      // 错题块里同时出现 "5.灭火 7.警告他人 9.拒绝放弃 11.… 13.… 15.… 17.…"
      // 七个词条，用户根本认不出到底错的是哪题。
      const padX = Math.round(medH * 1.0)
      const bx0 = Math.max(cx0, c.box.x0 - padX)
      const bx1 = Math.min(cx1 - 1, c.box.x1 + padX)

      // ===== 纵向：以红墨重心为中心，限高 maxH =====
      // 个别簇会因红笔密集而连成一大片（实测 front 一簇高 435px ≈ 15 行），
      // 整片裁出来同样无法定位到题。故按墨量加权取重心，最多保留 maxH。
      const cmk = c.markIds.map((i) => marks[i]).filter(Boolean)
      let cySum = 0, nSum = 0
      for (const mk of cmk) {
        const wsum = (mk.box.y0 + mk.box.y1) / 2
        cySum += wsum * Math.max(1, mk.n)
        nSum += Math.max(1, mk.n)
      }
      const cy = nSum > 0 ? cySum / nSum : (c.box.y0 + c.box.y1) / 2
      const maxH = Math.round(medH * 4)
      let y0 = c.box.y0, y1 = c.box.y1
      if (y1 - y0 + 1 > maxH) {
        y0 = Math.round(cy - maxH / 2)
        y1 = y0 + maxH - 1
      }
      // 对齐到整行：取与 [y0,y1] 交叠的行的完整上下边界
      const rows = colRows[col] ?? []
      let ry0 = y0, ry1 = y1, hit = false
      for (const r of rows) {
        if (r.y1 < y0 || r.y0 > y1) continue
        hit = true
        ry0 = Math.min(ry0, r.y0); ry1 = Math.max(ry1, r.y1)
      }
      if (hit) { y0 = ry0; y1 = ry1 }
      const pad = Math.round(medH * 0.3)
      const minH = Math.round(medH * 2)
      let by0 = Math.max(0, y0 - pad)
      let by1 = Math.min(h - 1, y1 + pad)
      if (by1 - by0 + 1 < minH) {
        const cy = Math.round((by0 + by1) / 2)
        by0 = Math.max(0, cy - Math.round(minH / 2))
        by1 = Math.min(h - 1, by0 + minH - 1)
      }

      // 阶段 A/B：题号定界的整题框由外层 applyUnits 统一处理（命中单元→取满框），
      // 此处不再构造 titleBox 回溯条带——整题框内已含题号行，无需额外补号。

      cBlocks.push({
        id: cBlocks.length,
        box: { x0: bx0, y0: by0, x1: bx1, y1: by1 },
        normBox: [+(bx0 / w).toFixed(4), +(by0 / h).toFixed(4), +((bx1 - bx0 + 1) / w).toFixed(4), +((by1 - by0 + 1) / h).toFixed(4)],
        col,
        markIds: c.markIds.slice(),
        verdict: 'unknown',
        confidence: 0,
        evidence: [],
        source: 'local',
        clusterId: c.id,
      })
    }
    let mergedC = cBlocks
    // 阶段 B：先映射到题目单元满框，再合并去重（同单元多红笔→一题）
    if (units && units.length) mergedC = applyUnits(mergedC, units, w, h, Math.round(ctx.medH * 1.5))
    mergedC = mergeOverlappingBlocks(mergedC, mergeIoU, true)
    for (const b of mergedC) {
      b.normBox = normBoxOf(b.box, w, h)
    }
    mergedC.sort((a, b) => (a.col - b.col) || (a.box.y0 - b.box.y0))
    mergedC.forEach((b, i) => { b.id = i })
    return mergedC
  }

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

  // 收敛：同列内纵向高度重叠的块合并（消除同一题多处批改造成的重复块）
  let merged = blocks
  // 阶段 B：先映射到题目单元满框，再合并去重
  if (units && units.length) merged = applyUnits(merged, units, w, h, Math.round(ctx.medH * 1.5))
  merged = mergeOverlappingBlocks(merged, mergeIoU)

  // 合并后 x/y 可能变化 → 重算归一化框
  for (const b of merged) {
    b.normBox = normBoxOf(b.box, w, h)
  }

  // 按阅读顺序（栏 → 纵向）排序
  merged.sort((a, b) => (a.col - b.col) || (a.box.y0 - b.box.y0))
  merged.forEach((b, i) => { b.id = i })
  return merged
}
