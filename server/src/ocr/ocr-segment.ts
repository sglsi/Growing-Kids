import type { LocalOcrTextRegion } from './ocr.types'

/**
 * OCR 文本分段（阅读顺序 + 行→段落合并）。
 *
 * ⭐ 设计原则：**能用引擎现成的，就绝不自己造**。
 *
 * 两条 OCR 通道的原生能力并不对等，分段策略因此分两条路：
 *  ① 精准（PaddleOCR PP-StructureV3）：引擎已自带完整版面分析——
 *     `parsing_res_list` 的**列表顺序即阅读顺序**，每个块 = 版面区域（label）
 *     + 区内行合并后的段落（content）。分段只是「取出来 + 按题号细分」，
 *     不重新发明轮子。
 *  ② 快速（RapidOCR）：只有行级结果（text/box/score），无版面与段落概念。
 *     这里才需要用行业成熟算法补上：Recursive XY-Cut（递归 XY 切分）定阅读序
 *     + 投影间隙做行聚类与行→段合并。
 *
 * 术语与算法出处：
 *  - Recursive XY-Cut：交替在 X / Y 投影的**最宽空白谷**处递归切分，
 *    先竖切分栏、再横切分段，天然还原「先读完左栏再读右栏」的阅读顺序。
 *    它是多栏文档阅读序的经典方法（XY-Cut++ 论文 arXiv:2504.10258，
 *    OpenDataLoader / pdf.oxide 等生产解析器均采用）。
 *  - 尺度无关的阈值：所有间隙阈值都取「行高中位数」的倍数，
 *    720p 与 4K 图、大字与小字得到一致结果（中位数抗标题/脚注等异常行高）。
 *
 * 关键阈值（经验值，来自 XY-Cut 工程实践 + 本项目中文字号实测）：
 *  - 同行判定：行 y 中心差 ≤ 0.6 × 行高中位数
 *  - 竖切（分栏）：空白列宽 > 1.5 × 行高中位数
 *  - 横切（分块）：空白行高 > 0.6 × 行高中位数（比 0.3 保守，中文行内字距不会被误判成段间）
 *  - 行→段：相邻行纵向间隙 > 1.5 × 行高中位数，或左边界跳变 > 2 × 行高中位数
 */

// ---------- 尺度无关阈值（倍率 × 行高中位数） ----------
/** 行合并（同一物理行被切成多段）判定的 y 中心差上限 */
const SAME_LINE_RATIO = 0.6
/**
 * 行合并的**水平相邻**上限（间隙 ≤ 此值才认作同一行的相邻碎片）。
 *
 * ⚠️ 没有这一条会出大错：y 相同但分处左右两栏的两行（两栏页最常见：
 *    左栏第 1 行与右栏第 1 行 y 完全对齐）会被并成「同一行」，
 *    于是 XY-Cut 还没切栏，行就先被跨栏粘死了（实测：左栏首行 + 右栏首行
 *    被合成一段，顺序直接崩）。
 */
const SAME_LINE_GAP_RATIO = 1.0
/** 竖切（分栏）所需的最小空白列宽 */
const XY_V_GAP_RATIO = 1.5
/** 横切（分段/分块）所需的最小空白行高 */
const XY_H_GAP_RATIO = 0.6
/** 行→段：相邻行纵向间隙超过此值即断段 */
const PARA_GAP_RATIO = 1.5
/** 行→段：左边界跳变超过此值即断段（缩进换段 / 右缩进结尾） */
const PARA_INDENT_RATIO = 2.0
/** XY-Cut 递归深度上限（防病态输入爆栈 / 死循环） */
const MAX_XY_DEPTH = 6
/** 少于此数量不再切分（切分毫无意义） */
const MIN_XY_ITEMS = 2

/**
 * **大题号**行首模式（只认大题，不认小题）。
 *
 * 试卷/作业场景下「一题一段」比「一页一段」有用得多：用户在错题提取里要的是
 * 「第 N 题」，不是整页流水账。覆盖：1. ／1、／1）／1: ／ 一、／十．
 *
 * ⚠️ 刻意**不认**括号内的题号（如「（1）25 × 4 ÷ 5」）：那是**小题**，
 *    属于上一道大题的内容；若一并当作新题切开，一道大题的小问会全被拆散成
 *    一堆碎段（实测：第 1 题的（1）（2）小问被切成独立段）。
 */
const Q_HEAD = /^\s*(?:\d{1,2}\s*[.、．)）:：]|[一二三四五六七八九十]{1,3}\s*[、．.])/

export type OcrSegmentKind = 'text' | 'title' | 'table' | 'formula' | 'other'
export type OcrSegmentSource = 'layout' | 'xycut'

export interface OcrSegment {
  text: string
  box: { x0: number; y0: number; x1: number; y1: number }
  /** 所属阅读栏（0 起；单栏页恒 0） */
  col: number
  kind: OcrSegmentKind
  /** 本段由几行合并而来（1 = 单行） */
  lines: number
  /** 分段来源：layout=引擎版面块（精准）｜xycut=行聚类+递归XY切分（快速） */
  source: OcrSegmentSource
}

/** 引擎版面块（PP-StructureV3 parsing_res_list 的契约子集） */
export interface SegmentLayoutBlock {
  label: string | null
  bbox: number[]
  order: string | number | null
  content: string
}

interface Line {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
  h: number
  cy: number
}

// ---------- 通用小工具 ----------

function median(values: number[]): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** OcrBox（[x0,y0,x1,y1]，可能逆序/旋转）→ 轴对齐归一包围盒 */
function normBox(box: number[] | null | undefined) {
  const a = Number(box?.[0] ?? 0)
  const b = Number(box?.[1] ?? 0)
  const c = Number(box?.[2] ?? 0)
  const d = Number(box?.[3] ?? 0)
  return {
    x0: Math.min(a, c),
    y0: Math.min(b, d),
    x1: Math.max(a, c),
    y1: Math.max(b, d),
  }
}

/** 取 bbox（可能是 [x0,y0,x1,y1] 或四点 [x,y]×4）*/
function normBBox(bbox: number[] | null | undefined) {
  const arr = Array.isArray(bbox) ? bbox : []
  if (arr.length >= 4 && typeof arr[0] === 'number') {
    // 四点形态：[[x,y]…] 会被拍平成 8 个数，这里按长度区分
    if (arr.length >= 8) {
      const xs: number[] = []
      const ys: number[] = []
      for (let i = 0; i + 1 < arr.length; i += 2) {
        xs.push(Number(arr[i] ?? 0))
        ys.push(Number(arr[i + 1] ?? 0))
      }
      return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
    }
  }
  return normBox(arr)
}

/**
 * 阅读栏归属：沿用「文本 x 区间聚类」的成熟做法（比图像投影可靠——
 * 版面分析在分栏页常漏检成单栏，而按实际文本位置聚类不会）。
 */
function columnsOf(items: { x0: number; x1: number }[]): Array<[number, number]> {
  const ivs = items
    .map((i) => [i.x0, i.x1] as [number, number])
    .sort((a, b) => a[0] - b[0])
  if (ivs.length < 2) return []
  const maxX = Math.max(...ivs.map((i) => i[1]))
  const gap = Math.max(20, maxX * 0.04)
  const spans: Array<[number, number]> = []
  let cs = ivs[0][0]
  let ce = ivs[0][1]
  for (let i = 1; i < ivs.length; i++) {
    const [x0, x1] = ivs[i]
    if (x0 <= ce + gap) ce = Math.max(ce, x1)
    else {
      spans.push([cs, ce])
      cs = x0
      ce = x1
    }
  }
  spans.push([cs, ce])
  return spans.length > 1 ? spans : []
}

function colIndexOf(cx: number, cols: Array<[number, number]>): number {
  if (!cols.length) return 0
  for (let i = 0; i < cols.length; i++) if (cx >= cols[i][0] && cx < cols[i][1]) return i
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < cols.length; i++) {
    const d = Math.min(Math.abs(cx - cols[i][0]), Math.abs(cx - cols[i][1]))
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

// ---------- 路径①：引擎版面块（PP-StructureV3） ----------

/** 版面 label → 分段语义类型 */
function kindOfLabel(label: string | null): OcrSegmentKind {
  const l = (label || '').toLowerCase()
  if (l === 'doc_title' || l === 'paragraph_title' || l === 'title') return 'title'
  if (l === 'table') return 'table'
  if (l === 'formula' || l === 'inline_formula') return 'formula'
  return 'text'
}

/** 非文本块（图/印章/图表）没有可用文字，排除 */
function isSkippableLabel(label: string | null): boolean {
  const l = (label || '').toLowerCase()
  return l === 'image' || l === 'seal' || l === 'chart' || l === 'figure' || l === 'background'
}

function blockOrder(b: SegmentLayoutBlock, i: number): number {
  if (b.order == null) return Number.POSITIVE_INFINITY
  const n = typeof b.order === 'number' ? b.order : Number(String(b.order).replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY
}

/**
 * 块内按题号细分：「1. … 2. …」被引擎合成一个 text 块时，
 * 用户在错题提取里勾不了单题——按题号行切开（仅当确有 ≥2 个题号行，否则不动）。
 */
function splitByQuestionHead(text: string): string[] {
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (lines.length < 2) return [text]
  const heads = lines.filter((l) => Q_HEAD.test(l)).length
  if (heads < 2) return [text]
  const out: string[] = []
  for (const ln of lines) {
    if (!out.length || Q_HEAD.test(ln)) out.push(ln)
    else out[out.length - 1] = `${out[out.length - 1]}\n${ln}`
  }
  return out
}

/** 路径①：把 PP-StructureV3 的版面块直接作为段落（引擎已完成阅读序与行→段合并） */
export function segmentsFromLayoutBlocks(
  blocks: SegmentLayoutBlock[],
  page?: { w: number; h: number },
): OcrSegment[] {
  const usable = (blocks || []).filter((b) => {
    const t = (b.content || '').trim()
    return t.length > 0 && !isSkippableLabel(b.label)
  })
  if (!usable.length) return []

  // 引擎给出的顺序即阅读序：有 order 字段按 order，缺失的按原始下标兜底
  const ordered = usable
    .map((b, i) => ({ b, i }))
    .sort((p, q) => blockOrder(p.b, p.i) - blockOrder(q.b, q.i) || p.i - q.i)

  const cols = columnsOf(ordered.map(({ b }) => normBBox(b.bbox)))
  const out: OcrSegment[] = []
  for (const { b } of ordered) {
    const box = normBBox(b.bbox)
    const parts = splitByQuestionHead(b.content.trim())
    for (const part of parts) {
      const lines = part.split(/\r?\n/).filter((s) => s.trim()).length
      out.push({
        text: part.trim(),
        box,
        col: colIndexOf((box.x0 + box.x1) / 2, cols),
        kind: kindOfLabel(b.label),
        lines: Math.max(1, lines),
        source: 'layout',
      })
    }
  }
  // 题号细分后顺序可能乱（块按首行切），按几何位置再归一一次
  return sortByReadingOrder(out, page)
}

// ---------- 路径②：行级 → 递归 XY-Cut + 行聚类（RapidOCR 等裸引擎） ----------

/**
 * 行级 regions → 物理行（被切成多段的同一行先合回来）。
 * 行高用中位数：个别超大标题/超小脚注不会把均值带偏。
 */
function toLines(regions: LocalOcrTextRegion[], medH: number): Line[] {
  const raw: Line[] = (regions || [])
    .filter((r) => (r.text || '').trim().length > 0)
    .map((r) => {
      const b = normBox(r.box as number[])
      return {
        text: r.text.trim(),
        x0: b.x0,
        y0: b.y0,
        x1: b.x1,
        y1: b.y1,
        h: Math.max(1, b.y1 - b.y0),
        cy: (b.y0 + b.y1) / 2,
      }
    })
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)

  const merged: Line[] = []
  for (const l of raw) {
    const last = merged[merged.length - 1]
    const tol = SAME_LINE_RATIO * Math.min(medH, l.h)
    // 水平间隙：两框之间左右方向的空档（重叠/紧邻时为负或 0）
    const gapX = last ? Math.max(l.x0 - last.x1, last.x0 - l.x1) : Infinity
    if (last && Math.abs(l.cy - last.cy) <= tol && gapX <= SAME_LINE_GAP_RATIO * medH) {
      // 同一物理行：按左右顺序拼（空格分隔）
      if (l.x0 < last.x0) {
        last.text = `${l.text} ${last.text}`
        last.x0 = Math.min(last.x0, l.x0)
      } else {
        last.text = `${last.text} ${l.text}`
        last.x1 = Math.max(last.x1, l.x1)
      }
      last.x1 = Math.max(last.x1, l.x1)
      last.y0 = Math.min(last.y0, l.y0)
      last.y1 = Math.max(last.y1, l.y1)
      last.cy = (last.y0 + last.y1) / 2
      continue
    }
    merged.push({ ...l })
  }
  return merged
}

/**
 * 在 X 投影上找最宽的「无人区」（连续空白列）——分栏的栏间沟。
 * 扫描线用所有 x 边界（O(n²)，n=行数，几十级别，开销可忽略）。
 */
function widestVerticalGap(items: Line[], minWidth: number): { width: number; at: number } | null {
  const xs = Array.from(new Set(items.flatMap((l) => [l.x0, l.x1]))).sort((a, b) => a - b)
  let best: { width: number; at: number } | null = null
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i]
    const b = xs[i + 1]
    const w = b - a
    if (w < minWidth || (best && w <= best.width)) continue
    // 区间内没有任何行横跨 → 真正的空白沟
    if (items.some((l) => l.x0 < b && l.x1 > a)) continue
    best = { width: w, at: a + w / 2 }
  }
  return best
}

/** 在 Y 投影上找最高的「无人区」——段与段、块与块之间的空行 */
function widestHorizontalGap(items: Line[], minHeight: number): { height: number; at: number } | null {
  const ys = Array.from(new Set(items.flatMap((l) => [l.y0, l.y1]))).sort((a, b) => a - b)
  let best: { height: number; at: number } | null = null
  for (let i = 0; i + 1 < ys.length; i++) {
    const a = ys[i]
    const b = ys[i + 1]
    const h = b - a
    if (h < minHeight || (best && h <= best.height)) continue
    if (items.some((l) => l.y0 < b && l.y1 > a)) continue
    best = { height: h, at: a + h / 2 }
  }
  return best
}

/**
 * 行级阅读序：**先聚"视觉行"，行内再按 x**。
 *
 * ⚠️ 不能直接用 `y0 升序 → x0 升序`：同一行里各 OCR 框的 y0 会有 1~3px 抖动，
 *    于是「A. 0.6  B. 2/3  C. 0.58」会按抖动排序，变成 B 在 A 前面——
 *    选项顺序一乱，答案就对错位（GT 数据集 choice-options 实测就是这条）。
 *    用**行中心 + 行高容差**聚簇，抖动就进不了比较式。
 */
function sortLinesByReadingOrder(items: Line[], medH: number): Line[] {
  const rows: Line[][] = []
  for (const l of [...items].sort((a, b) => a.cy - b.cy)) {
    const row = rows[rows.length - 1]
    const tol = SAME_LINE_RATIO * Math.min(medH, l.h)
    if (row && Math.abs(l.cy - row[0].cy) <= tol) row.push(l)
    else rows.push([l])
  }
  return rows.flatMap((r) => r.sort((a, b) => a.x0 - b.x0))
}

/**
 * 递归 XY-Cut：竖切分栏优先（多栏文档的首要矛盾），
 * 否则横切分段，切不动即为叶子（按阅读序排序）。
 * 返回「人在阅读时的行顺序」。
 */
function xyCutOrder(items: Line[], medH: number, depth = 0): Line[] {
  if (items.length < MIN_XY_ITEMS || depth >= MAX_XY_DEPTH) {
    return sortLinesByReadingOrder(items, medH)
  }
  // ① 竖切：栏间沟 → 先左栏后右栏
  const v = widestVerticalGap(items, XY_V_GAP_RATIO * medH)
  if (v) {
    const left = items.filter((l) => l.x1 <= v.at)
    const right = items.filter((l) => l.x0 >= v.at)
    if (left.length && right.length && left.length + right.length === items.length) {
      return [...xyCutOrder(left, medH, depth + 1), ...xyCutOrder(right, medH, depth + 1)]
    }
  }
  // ② 横切：段间空行 → 先上后下
  const h = widestHorizontalGap(items, XY_H_GAP_RATIO * medH)
  if (h) {
    const top = items.filter((l) => l.y1 <= h.at)
    const bottom = items.filter((l) => l.y0 >= h.at)
    if (top.length && bottom.length && top.length + bottom.length === items.length) {
      return [...xyCutOrder(top, medH, depth + 1), ...xyCutOrder(bottom, medH, depth + 1)]
    }
  }
  return sortLinesByReadingOrder(items, medH)
}

/**
 * 行序列 → 段落：
 *  - 纵向间隙突增（> 1.5×行高）→ 新段；
 *  - 左边界跳变（> 2×行高，缩进或右收尾）→ 新段；
 *  - 行首出现题号（「1.」「一、」）→ 强制新段（试卷场景一题一段）。
 */
function mergeLines(lines: Line[], medH: number): OcrSegment[] {
  if (!lines.length) return []
  const cols = columnsOf(lines)
  const out: OcrSegment[] = []
  let buf: Line[] = []
  const flush = () => {
    if (!buf.length) return
    const box = {
      x0: Math.min(...buf.map((l) => l.x0)),
      y0: Math.min(...buf.map((l) => l.y0)),
      x1: Math.max(...buf.map((l) => l.x1)),
      y1: Math.max(...buf.map((l) => l.y1)),
    }
    out.push({
      text: buf.map((l) => l.text).join('\n'),
      box,
      col: colIndexOf((box.x0 + box.x1) / 2, cols),
      kind: 'text',
      lines: buf.length,
      source: 'xycut',
    })
    buf = []
  }
  for (const l of lines) {
    const prev = buf[buf.length - 1]
    if (prev) {
      const gap = l.y0 - prev.y1
      const indent = Math.abs(l.x0 - prev.x0)
      if (
        gap > PARA_GAP_RATIO * medH ||
        indent > PARA_INDENT_RATIO * medH ||
        Q_HEAD.test(l.text)
      ) {
        flush()
      }
    }
    buf.push(l)
  }
  flush()
  return out
}

/** 路径②：行级 regions → 段落（递归 XY-Cut 定序 + 间隙/缩进/题号断段） */
export function segmentsFromTextRegions(regions: LocalOcrTextRegion[]): OcrSegment[] {
  const boxes = (regions || []).map((r) => normBox(r.box as number[]))
  if (!boxes.length) return []
  const medH = median(boxes.map((b) => Math.max(1, b.y1 - b.y0)))
  const lines = toLines(regions, medH)
  if (!lines.length) return []
  return mergeLines(xyCutOrder(lines, medH), medH)
}

/** 段内顺序的几何兜底：按栏 → 上 → 左（与阅读序一致） */
function sortByReadingOrder(segs: OcrSegment[], page?: { w: number; h: number }): OcrSegment[] {
  void page
  return [...segs].sort((a, b) => a.col - b.col || a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0)
}

/**
 * 统一入口：优先用引擎版面块（成熟分段），块缺失/无内容时退回行级分段。
 *
 * @param regions 行级文本区域（两引擎都有）
 * @param blocks  引擎版面块（仅 PP-StructureV3 有；RapidOCR 为空）
 */
export function buildSegments(input: {
  regions?: LocalOcrTextRegion[]
  blocks?: SegmentLayoutBlock[]
}): OcrSegment[] {
  const blocks = (input.blocks || []).filter((b) => (b.content || '').trim().length > 0)
  if (blocks.length) return segmentsFromLayoutBlocks(blocks)
  return segmentsFromTextRegions(input.regions || [])
}
