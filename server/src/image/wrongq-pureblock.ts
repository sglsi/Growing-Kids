/**
 * 纯版面切块兜底（P1-12）+ 答案侧对称切块（P1-11 共用内核）
 * ------------------------------------------------------------------
 * 背景：原 P0 切块**必须以红笔批改痕迹为锚点**（`buildBlocks`）。真实场景里大量试卷
 * 是「空白卷 / 纯打印卷 / 电子版习题 / 答案图」——**没有红笔**，于是 `blocks` 为空，
 * 整条提取直接退化成无结果（技术文档 §2.7 局限 ④）。
 *
 * 本模块把切块依据从"红笔锚点"换成"**版面顺序 + 题号**"：
 *   OCR 行级结果（带 box 与 score）→ 按 y 聚行 → 按栏恢复阅读顺序 → 遇题号开新块 →
 *   块内连续行归并 → 纵向补白 + 最小高度约束。
 *
 * 设计要点（都是实测出来的，别改回去）：
 *  1. **必须分栏**。整页按单一 y 序排序会把左中右三栏的同一 y 段揉成一行
 *     （同 buildLayoutContext 里踩过的坑），必须先按 x 落栏、栏内按 y 排。
 *  2. **题号必须是"行首"**。用 `parseQuestionNumber` 只匹配开头，避免把题面中间的
 *     "（1）""①"误判为新题（该坑在 ocr-struct.isQuestionStart 里已修过）。
 *  3. **孤立编号不算题头**。只有"1."两个字不足成题，要求去题号后仍有实质长度。
 *  4. **纵向要有最小高度**。单行高的块不足以框住整道题，取 ≥2 行（同 buildBlocks）。
 *  5. **纯规则、零大模型**：本模块只做坐标与字符串计算，符合"切块引擎尽量不依赖大模型"。
 */
import type { LocalOcrTextRegion } from '../ocr/ocr.types'
import { parseQuestionNumber } from '../ocr/ocr-hierarchy'
import type { WrongqBlock } from './wrongq.types'

/** 切块所需的版面骨架（避免强依赖完整 LayoutContext，答案图/单栏图也能构造） */
export interface RowSplitContext {
  w: number
  h: number
  /** 字高中位数（用于容差与最小高度标定） */
  medH: number
  /** 栏区间；单栏图传 [[0, w]] */
  cols: Array<[number, number]>
}

export interface TextRow {
  x0: number
  y0: number
  x1: number
  y1: number
  /** 所属栏索引（0 起） */
  col: number
  text: string
  /** 行内区域平均置信度 */
  score: number
  regions: LocalOcrTextRegion[]
}

export interface SplitBlocksOptions {
  /** 行聚合 y 容差（默认 0.6×medH） */
  yTol?: number
  /** 块纵向补白（默认 0.3×medH） */
  pad?: number
  /** 块最小高度（默认 2×medH） */
  minH?: number
  /** 单个块最多容纳多少行（默认 40，防止整页无题号时糊成一坨） */
  maxRowsPerBlock?: number
}

const EMPTY: LocalOcrTextRegion[] = []

function regionBox(r: LocalOcrTextRegion) {
  const [a, b, c, d] = r.box || [0, 0, 0, 0]
  return {
    x0: Math.min(a, c),
    y0: Math.min(b, d),
    x1: Math.max(a, c),
    y1: Math.max(b, d),
  }
}

/** 行中心 x 落在哪一栏；越界取最近的一栏 */
function colOf(cx: number, cols: Array<[number, number]>): number {
  for (let i = 0; i < cols.length; i++) if (cx >= cols[i][0] && cx < cols[i][1]) return i
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < cols.length; i++) {
    const d = Math.min(Math.abs(cx - cols[i][0]), Math.abs(cx - cols[i][1]))
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}

/**
 * OCR 区域 → 文本行。
 *
 * 两趟完成：① 先按 y 中心排序并聚类成"物理行"（容忍行内基线抖动）；
 * ② 物理行若跨栏，按 x 拆到各自的栏——否则三栏试卷会把左中右三块文字拼成一行。
 */
export function regionsToRows(
  regions: LocalOcrTextRegion[],
  ctx: RowSplitContext,
  yTol = Math.max(6, Math.round(ctx.medH * 0.6)),
): TextRow[] {
  if (!regions || !regions.length) return []
  const items = regions
    .map((r) => ({ r, b: regionBox(r) }))
    .filter((o) => (o.r.text || '').trim().length > 0)
    .sort((a, b) => (a.b.y0 + a.b.y1) / 2 - (b.b.y0 + b.b.y1) / 2)

  const rows: TextRow[] = []
  let cur: { cy: number; parts: LocalOcrTextRegion[] } | null = null
  for (const o of items) {
    const cy = (o.b.y0 + o.b.y1) / 2
    if (cur && Math.abs(cy - cur.cy) <= yTol) {
      cur.parts.push(o.r)
      cur.cy = (cur.cy * (cur.parts.length - 1) + cy) / cur.parts.length
    } else {
      if (cur) rows.push(...flushRow(cur.parts, ctx))
      cur = { cy, parts: [o.r] }
    }
  }
  if (cur) rows.push(...flushRow(cur.parts, ctx))

  // 阅读顺序：栏 → 纵向（与 buildBlocks 保持一致）
  rows.sort((a, b) => (a.col - b.col) || (a.y0 - b.y0))
  return rows
}

/** 一个物理行 → 一或多条"栏内行"；栏内按 x 从左到右拼文本 */
function flushRow(parts: LocalOcrTextRegion[], ctx: RowSplitContext): TextRow[] {
  const byCol = new Map<number, LocalOcrTextRegion[]>()
  for (const r of parts) {
    const b = regionBox(r)
    const col = colOf((b.x0 + b.x1) / 2, ctx.cols)
    const arr = byCol.get(col)
    if (arr) arr.push(r)
    else byCol.set(col, [r])
  }
  const out: TextRow[] = []
  for (const [col, arr] of byCol) {
    arr.sort((a, b) => regionBox(a).x0 - regionBox(b).x0)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    let scoreSum = 0
    const texts: string[] = []
    for (const r of arr) {
      const b = regionBox(r)
      x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0)
      x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1)
      scoreSum += typeof r.score === 'number' ? r.score : 0
      texts.push((r.text || '').trim())
    }
    out.push({
      x0, y0, x1, y1,
      col,
      text: texts.filter(Boolean).join(' ').trim(),
      score: arr.length ? scoreSum / arr.length : 0,
      regions: arr,
    })
  }
  return out
}

/** 该行是否开启一道新题：行首带题号，且去掉题号后仍有实质内容 */
export function isRowQuestionStart(text: string): boolean {
  const p = parseQuestionNumber(text)
  if (p.kind === 'none') return false
  const rest = (text || '').replace(p.raw, '').trim()
  // 孤立编号（"1." 后面没东西）通常是题面换行残留，不足以作为题头
  return rest.length >= 2
}

/**
 * 按题号把有序行切成题块。
 *
 * - 行首出现题号 → 开新块（若已有块则先封块）；
 * - 非题头行 → 并入当前块（无当前块时作为页眉/引导语暂存，等第一道题出现后并入，避免丢上下文）；
 * - 整页一个题号都没有 → 退化为"按最大行数封块"或整页一块（至少能用，优于返回空）。
 */
export function splitRowsToBlocks(rows: TextRow[], ctx: RowSplitContext, opts: SplitBlocksOptions = {}): WrongqBlock[] {
  const pad = opts.pad ?? Math.round(ctx.medH * 0.3)
  const minH = opts.minH ?? Math.round(ctx.medH * 2)
  const maxRows = opts.maxRowsPerBlock ?? 40

  const groups: TextRow[][] = []
  let cur: TextRow[] | null = null
  let preamble: TextRow[] = []
  for (const r of rows) {
    if (isRowQuestionStart(r.text)) {
      const start: TextRow[] = preamble.length ? [...preamble] : []
      preamble = []
      cur = [...start, r]
      groups.push(cur)
    } else if (cur) {
      if (cur.length >= maxRows) {
        // 极端情况：某题后连续 40 行都没题号，强制封块，避免粘连
        cur = [...GroupsTail(cur), r]
        groups.push(cur)
      } else {
        cur.push(r)
      }
    } else {
      preamble.push(r)
    }
  }
  if (preamble.length && groups.length) {
    // 页眉/总标题：并到第一块，保住上下文（如"2024年六年级数学期末卷"）
    groups[0] = [...preamble, ...groups[0]]
  } else if (preamble.length && !groups.length) {
    groups.push(preamble)
  }

  const blocks: WrongqBlock[] = []
  for (const g of groups) {
    if (!g.length) continue
    // 块归属栏：取成员众数
    const counts = new Map<number, number>()
    for (const r of g) counts.set(r.col, (counts.get(r.col) ?? 0) + 1)
    let col = 0, best = -1
    for (const [k, v] of counts) if (v > best) { best = v; col = k }

    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const r of g) {
      x0 = Math.min(x0, r.x0); y0 = Math.min(y0, r.y0)
      x1 = Math.max(x1, r.x1); y1 = Math.max(y1, r.y1)
    }
    const [cx0, cx1] = ctx.cols[col] ?? [0, ctx.w]
    // 横向取满栏宽：一道题分多行且首行常缩进，按最小 x 取会把题干右边疆收窄，
    // 边缘字容易被切掉一半 → 直接以栏边界为准
    const bx0 = Math.max(0, Math.min(cx0, x0 - pad))
    const bx1 = Math.min(ctx.w - 1, Math.max(cx1, x1 + pad))
    let by0 = Math.max(0, y0 - pad)
    let by1 = Math.min(ctx.h - 1, y1 + pad)
    if (by1 - by0 + 1 < minH) {
      const cy = Math.round((by0 + by1) / 2)
      by0 = Math.max(0, cy - Math.round(minH / 2))
      by1 = Math.min(ctx.h - 1, by0 + minH - 1)
    }

    blocks.push({
      id: blocks.length,
      box: { x0: bx0, y0: by0, x1: bx1, y1: by1 },
      normBox: [
        +(bx0 / ctx.w).toFixed(4),
        +(by0 / ctx.h).toFixed(4),
        +((bx1 - bx0 + 1) / ctx.w).toFixed(4),
        +((by1 - by0 + 1) / ctx.h).toFixed(4),
      ],
      col,
      markIds: [],
      verdict: 'unknown',
      confidence: 0,
      evidence: ['pure-layout'],
      source: 'local',
    })
  }
  blocks.forEach((b, i) => { b.id = i })
  return blocks
}

/** 超长块封块时的尾部保留：只留最后 1 行做衔接，避免上下文断裂 */
function GroupsTail(cur: TextRow[]): TextRow[] {
  return cur.slice(-1)
}

/**
 * 一条龙：OCR 区域 → 行 → 题块。对应技术文档 P1-12（无红笔兜底）与 P1-11（答案侧对称化）。
 */
export function splitBlocksByNumber(
  regions: LocalOcrTextRegion[],
  ctx: RowSplitContext,
  opts: SplitBlocksOptions = {},
): { blocks: WrongqBlock[]; rows: TextRow[] } {
  const rows = regionsToRows(regions, ctx, opts.yTol)
  const blocks = splitRowsToBlocks(rows, ctx, opts)
  return { blocks, rows }
}

export { EMPTY as NO_REGIONS }
