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
  /** label 是题号/「解答」标签；space 是做题空白（无图，只占位） */
  kind?: 'label' | 'question' | 'answer' | 'space'
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
  kind: 'label' | 'question' | 'answer' | 'space'
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
  /**
   * D-089：允许跨页模式（仅含答案解析的复习资料开启）。
   * 关闭（默认）：一题一区块不跨页，超高整块等比压缩——练习卷每题独立可作答。
   * 开启：区块按行拆分跨页（长解答放两页），短题紧凑合并同页；题号标题只在
   *       区块首行出现，续页行仍保持原顺序，绝不重排、绝不拿邻题内容顶替。
   */
  allowSplit?: boolean
}

const EPS = 1e-6

function fitRow(row: RowInput, bin: Bin, maxH: number): { width: number; height: number } {
  // 标签与做题空白都按原尺寸放：标签不能被放大到页宽，空白不能被左右拉伸
  if (row.kind === 'label' || row.kind === 'space') {
    return { width: Math.min(row.width, bin.width), height: row.height }
  }
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

  // ── D-089 跨页模式（含答案解析的复习资料）────────────────────────────
  // 一题的多行按序流式排布：本页放得下就接着放（短题自然合并同页），
  // 放不下就换页续排（长解答占两页）。绝不分栏、绝不重排、绝不压缩题图。
  // 题号标题（label:…:title）只在该题第一次出现时放一次，续页不重复。
  if (options.allowSplit) {
    for (const b of blocks) {
      const rows = (b.rows || []).filter((r) => r && r.width > 0 && r.height > 0)
      if (!rows.length) continue
      const fitted = rows.map((r) => ({ row: r, ...fitRow(r, bin, maxH) }))
      let titlePlaced = false
      let seg: PlacedBlock | null = null // 当前页内本题的片段；换页时置空重建

      for (const f of fitted) {
        const isTitle = f.row.kind === 'label' && f.row.key.endsWith(':title')
        if (isTitle && titlePlaced) continue
        if (isTitle) titlePlaced = true

        const h = f.height
        const wantGap = y > 0 ? (seg ? rowGap : blockGap) : 0
        if (y > 0 && y + wantGap + h > bin.height + EPS) {
          pushPage()
          seg = null
          y = 0
        }
        const gap = y > 0 ? (seg ? rowGap : blockGap) : 0
        const rowY = y + gap
        if (!seg) {
          seg = { key: b.key, label: b.label, rows: [], y: rowY, height: 0 }
          page.blocks.push(seg)
        }
        seg.rows.push({
          key: f.row.key,
          x: 0,
          y: rowY,
          width: Math.min(f.width, bin.width),
          height: h,
          kind: f.row.kind || 'question',
        })
        y = rowY + h
        seg.height = y - seg.y
      }
    }
    pushPage()
    return pages
  }

  // ── 旧模式（练习卷，无答案）──────────────────────────────────────────
  // 一题一区块不跨页，超高整块等比压缩，保证每题独立可作答。
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
