/**
 * 复习资料 PDF 的「逐题清晰」版式（D-087）。
 *
 * 为什么不再用 pdf-layout 的 Guillotine-BSSF：
 *   那套算法按「图高」分档 + FFD 重排，省纸但**故意打乱素材顺序**；题目裁剪图、
 *   答案裁剪图、图形被当成互不相关的矩形挤进同一条带，家长打印出来根本看不出
 *   哪张图属于哪道题——生产 2026-11-18 那份复习资料就是这么乱的。
 *
 * 本版式的硬约束（来自 GK-SRS-02 / 视觉美学设计方案 / 认知负荷与邻近原则）：
 *   1. 顺序 = 用户选题顺序，题面图 → 答案图 → 解析严格相邻，**绝不重排**；
 *   2. 一题一区块，区块带题号标题，答案另起「解答」标签，图文对应一眼可辨；
 *   3. 区块不跨页（超长才整体等比压缩），页内纵向流，统一左对齐起点；
 *   4. 行间留白 10pt、题间留白 22pt，单图高上限 60% 可用高（不缩成指甲盖）。
 *
 * 纯函数、零依赖：可离线跑断言，不碰 pdf-lib / 网络 / Nest。
 */

export interface RowInput {
  key: string
  width: number
  height: number
  /** label 是题号/「解答」标签，按生成尺寸放，不参与「放大到页宽」 */
  kind?: 'label' | 'question' | 'answer'
}

export interface BlockInput {
  key: string
  label: string
  rows: RowInput[]
}

export interface Bin { width: number; height: number }

export interface PlacedRow {
  key: string
  x: number
  y: number
  width: number
  height: number
  kind: 'label' | 'question' | 'answer'
}

export interface PlacedBlock {
  key: string
  label: string
  rows: PlacedRow[]
  /** 区块在页内 y（向下） */
  y: number
  height: number
}

export interface PlacedPage { blocks: PlacedBlock[] }

export interface LayoutOptions {
  /** 同一题内图片/文本之间的间距，默认 10pt */
  rowGap?: number
  /** 相邻题之间的间距，默认 22pt（8pt 栅格：≈24 减标签描边） */
  blockGap?: number
  /** 单张内容图的最大高度占可用高比例，默认 0.6（保证印出来字看得清） */
  maxRowHeightRatio?: number
}

const EPS = 1e-6

function fitRow(row: RowInput, bin: Bin, maxH: number): { width: number; height: number } {
  if (row.kind === 'label') return { width: Math.min(row.width, bin.width), height: row.height }
  let scale = 1
  if (row.width > bin.width) scale = bin.width / row.width
  if (row.height * scale > maxH) scale = maxH / row.height
  if (!Number.isFinite(scale) || scale <= 0) scale = 1
  return { width: row.width * scale, height: row.height * scale }
}

/**
 * 把「题目区块」顺序排进 A4 可用区。返回页数组，页内 blocks 顺序与入参完全一致。
 * 所有坐标为 y 向下、相对 bin 左上角（pdf.service 绘制时再翻成 pdf-lib 的 y 向上）。
 */
export function layoutQuestionBlocks(
  blocks: BlockInput[],
  bin: Bin,
  options: LayoutOptions = {},
): PlacedPage[] {
  if (!blocks.length || bin.width <= 0 || bin.height <= 0) return []
  const rowGap = options.rowGap ?? 10
  const blockGap = options.blockGap ?? 22
  const maxH = bin.height * (options.maxRowHeightRatio ?? 0.6)
  const pages: PlacedPage[] = []
  let page: PlacedPage = { blocks: [] }
  let y = 0

  const pushPage = () => {
    if (page.blocks.length) pages.push(page)
    page = { blocks: [] }
    y = 0
  }

  for (const b of blocks) {
    const rows = (b.rows || []).filter((r) => r && r.width > 0 && r.height > 0)
    if (!rows.length) continue
    const fitted = rows.map((r) => ({ row: r, ...fitRow(r, bin, maxH) }))
    let gap = rowGap
    let height = fitted.reduce((s, r) => s + r.height, 0) + gap * Math.max(0, fitted.length - 1)

    // 单题超高：整块等比压缩（含标签），宁可本题小一点也不把它拆到两页
    let compress = 1
    if (height > bin.height) {
      compress = bin.height / height
      height = bin.height
      gap *= compress
    }

    const need = y > 0 ? blockGap + height : height
    if (y > 0 && y + need > bin.height + EPS) pushPage()

    const placed: PlacedRow[] = []
    let cursor = y
    for (const f of fitted) {
      const w = f.width * compress
      const h = f.height * compress
      placed.push({
        key: f.row.key,
        x: 0,
        y: cursor,
        width: Math.min(w, bin.width),
        height: h,
        kind: f.row.kind || 'question',
      })
      cursor += h + gap
    }
    page.blocks.push({ key: b.key, label: b.label, rows: placed, y, height })
    y += height + blockGap
  }
  pushPage()
  return pages
}
