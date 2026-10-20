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

/** 一个版面分区（连续 y 区间内一致的栏结构）。混合版面（上双栏/下单栏）会有多个。 */
export interface ColumnSection {
  /** 该 section 起止 y（与 ctx 坐标系一致） */
  y0: number
  y1: number
  /** 该 section 内的栏（[x0,x1]，满栏宽） */
  cols: Array<[number, number]>
}

export interface LayoutContext {
  w: number
  h: number
  medH: number
  /** 二值墨迹图（1=墨），已剔除图形 */
  ink: Uint8Array
  /** 朝向摆正实际施加的旋转角（0/90/180/270） */
  orientAngle?: 0 | 90 | 180 | 270
  /**
   * 兜底全局栏（保持旧行为：单 section 页面即最终答案；混合版面页面取覆盖行数最多的主导 section）。
   * 新代码应优先用 `colSections` + `colsAtY` 获得分区正确的栏。
   */
  cols: Array<[number, number]>
  /**
   * 按 y 分区的栏结构。单 section 页面长度为 1（栏 = 全局 cols）；
   * 混合版面（如上双栏/下单栏）会有多个 section，各自持有一套栏。
   */
  colSections?: ColumnSection[]
  /** 每栏的行（y0,y1）——按全局 cols 构建，供纵向对齐参考 */
  colRows: Array<Array<{ y0: number; y1: number }>>
  /** 归一化前的 luma（渲染/增强用） */
  luma: Float32Array
  /** 压平后的图像 buffer（供后续 mask/裁图复用，避免重复 straighten） */
  flatBuf: Buffer
  inkRatio: number
  /** 朝向未经 OCR 消歧确认（侧车不可用时静默回落几何）→ 本页可能整页倒置 */
  orientSuspect?: boolean
  orientMethod?: 'projection' | 'ocr' | 'none'
}

/** 给定 y，返回该 y 落入的 section 的栏数组（无 section 时回落全局 cols）。 */
export function colsAtY(ctx: LayoutContext, y: number): Array<[number, number]> {
  const secs = ctx.colSections
  if (!secs || !secs.length) return ctx.cols ?? [[0, ctx.w]]
  if (y < secs[0].y0) return secs[0].cols
  for (const s of secs) if (y <= s.y1) return s.cols
  return secs[secs.length - 1].cols
}

/** 给定 y，返回其所属 section 索引（无 section 时返回 0）。 */
export function sectionIndexAtY(ctx: LayoutContext, y: number): number {
  const secs = ctx.colSections
  if (!secs || !secs.length) return 0
  if (y < secs[0].y0) return 0
  for (let i = 0; i < secs.length; i++) if (y <= secs[i].y1) return i
  return secs.length - 1
}

/**
 * R2 修复（#R2 p3/p2 实测）：版面带的有效栏几何——带 region 分居实证的全局兜底。
 *
 * 为什么需要：colSections 的逐带栏缝判空对照片噪点脆弱。p3 实测：x∈[480,540]
 * 的 360 个采样行里 319 行有 1~3px 噪点墨（cover 判空全程失败）；且右栏题号区
 * （x≥511）每 ~130px 就侵入 ±12px 验证窗，最长净空 138px < 173px 持续门槛，
 * 三带全部回退单栏——而全局 cols（投影谷底 + 夹持校验）对噪点稳健、仍是双栏。
 * 后果：两栏题号按 y 交错 → 跨栏巨型单元、编号空间被另一栏污染、缺号窗口反转。
 *
 * 判据（避免把真单栏带误切）：本带内存在「整区落入全局栏 i」的 region 且各全局
 * 栏都有（高度 ≥0.55×medH，排除杂散标记）——真双栏带（p3/p2 作业页）满足；
 * 混合版面的真单栏带（通栏内容横跨全页）不落入任何单栏，保持原判。
 * 与 wrongq-structure 的 colAtPoint/hasMultiCol（#144）同一兜底口径。
 */
export function effectiveColsAtY(
  ctx: LayoutContext,
  regions: ReadonlyArray<{ box?: number[] | null }> | undefined,
  y: number,
): Array<[number, number]> {
  const colsY = colsAtY(ctx, y)
  const g = ctx.cols
  if (!regions || !regions.length || colsY.length > 1 || !g || g.length <= 1) return colsY
  // 仅当本带判为单栏（通栏几何）而全局多栏时，才查 region 分居证据
  if (!(colsY.length === 1 && colsY[0][0] <= 0 && colsY[0][1] >= ctx.w - 1)) return colsY
  const si = sectionIndexAtY(ctx, y)
  const sec = ctx.colSections?.[si]
  const by0 = si === 0 ? 0 : sec?.y0 ?? 0
  const by1 = sec?.y1 ?? ctx.h
  const hit = new Array<boolean>(g.length).fill(false)
  const minH = Math.round(ctx.medH * 0.55)
  for (const r of regions) {
    const b = r.box
    if (!b || b.length < 4) continue
    const x0 = Math.min(b[0] ?? 0, b[2] ?? 0)
    const x1 = Math.max(b[0] ?? 0, b[2] ?? 0)
    const ry0 = Math.min(b[1] ?? 0, b[3] ?? 0)
    const ry1 = Math.max(b[1] ?? 0, b[3] ?? 0)
    if (ry1 - ry0 < minH) continue // 杂散标记不当栏占据证据
    const cy = (ry0 + ry1) / 2
    if (cy < by0 || cy > by1) continue
    for (let i = 0; i < g.length; i++) {
      if (x0 >= g[i][0] && x1 <= g[i][1]) { hit[i] = true; break }
    }
  }
  return hit.every(Boolean) ? g : colsY
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

/** 由分隔符位置构造栏：按 seps 切分 [0,w] → 合并过窄假栏 → 兜底最多 4 栏。 */
function colsFromSeps(
  seps: number[],
  w: number,
  proj?: Int32Array,
  y0?: number,
  y1?: number,
): Array<[number, number]> {
  const sp = [...seps].sort((p, q) => p - q)
  const bounds = [0, ...sp, w]
  const cols: Array<[number, number]> = []
  for (let i = 0; i < bounds.length - 1; i++) cols.push([bounds[i], bounds[i + 1]])
  // 合并「空白栏」（墨迹密度极低，如右侧页边空白带）：先按密度剔除，再按宽度兜底。
  // 复用已算好的逐列投影 proj 做密度估计，O(栏数) 而非重扫全图。
  if (proj && y0 != null && y1 != null && y1 > y0) {
    const EMPTY = 0.004 // 墨迹面积占比低于 0.4% 视为空栏
    const pref = new Int32Array(w + 1)
    for (let x = 0; x < w; x++) pref[x + 1] = pref[x] + proj[x]
    const area = y1 - y0
    const colDensity = (a: number, b: number) => {
      // 栏约定为半开区间 [a,b)，墨迹量 = sum(proj[a..b-1]) = pref[b] - pref[a]
      const inkc = pref[b] - pref[a]
      return inkc / ((b - a) * area)
    }
    let merged = true
    while (merged && cols.length > 1) {
      merged = false
      let mi = -1, mfrac = Infinity
      for (let i = 0; i < cols.length; i++) {
        const frac = colDensity(cols[i][0], cols[i][1])
        if (frac < EMPTY && frac < mfrac) { mi = i; mfrac = frac }
      }
      if (mi < 0) break
      if (mi === 0) { cols[1] = [cols[0][0], cols[1][1]]; cols.splice(0, 1) }
      else if (mi === cols.length - 1) { cols[mi - 1] = [cols[mi - 1][0], cols[mi][1]]; cols.splice(mi, 1) }
      else {
        const lw = cols[mi - 1][1] - cols[mi - 1][0]
        const rw = cols[mi + 1][1] - cols[mi + 1][0]
        if (lw <= rw) { cols[mi - 1] = [cols[mi - 1][0], cols[mi][1]]; cols.splice(mi, 1) }
        else { cols[mi + 1] = [cols[mi][0], cols[mi + 1][1]]; cols.splice(mi, 1) }
      }
      merged = true
    }
  }
  // 合并过窄假栏（宽<页宽 10%，如页边距/被误判的 212px 假栏）：并入更窄一侧的邻居，避免吞正文。
  const minCol = Math.round(w * 0.1)
  let merged = true
  while (merged && cols.length > 1) {
    merged = false
    let mi = -1, mw = Infinity
    for (let i = 0; i < cols.length; i++) {
      const ww = cols[i][1] - cols[i][0]
      if (ww < minCol && ww < mw) { mi = i; mw = ww }
    }
    if (mi < 0) break
    if (mi === 0) { cols[1] = [cols[0][0], cols[1][1]]; cols.splice(0, 1) }
    else if (mi === cols.length - 1) { cols[mi - 1] = [cols[mi - 1][0], cols[mi][1]]; cols.splice(mi, 1) }
    else {
      const lw = cols[mi - 1][1] - cols[mi - 1][0]
      const rw = cols[mi + 1][1] - cols[mi + 1][0]
      if (lw <= rw) { cols[mi - 1] = [cols[mi - 1][0], cols[mi][1]]; cols.splice(mi, 1) }
      else { cols[mi + 1] = [cols[mi][0], cols[mi + 1][1]]; cols.splice(mi, 1) }
    }
    merged = true
  }
  // 兜底：极端情况下仍 >4 栏 → 约束式三栏回退（仅检测异常时触发）
  if (cols.length > 4) {
    const c1 = Math.round(w / 3), c2 = Math.round((2 * w) / 3)
    return [[0, c1], [c1, c2], [c2, w]]
  }
  if (!cols.length) return [[0, w]]
  return cols
}

/**
 * 自适应分栏（基于「文本块几何聚类」，支持混合版面：同一页上半部双栏、下半部单栏）。
 *
 * 与旧版（全页单一「逐像素墨迹投影」→ 一套栏）的核心区别：栏分隔符不再从逐列墨迹像素推出，
 * 而是从**文本块（连通域）的水平覆盖**推出。一个真正的栏间隙在纵向上没有任何文本块跨越，
 * 其覆盖近乎全 0；而同一栏内即便文字稀疏，块仍横跨该栏全宽——绝不会让栏缝被误判成"有空隙"。
 *
 * 这根治了此前正面图「探究案通栏」被像素投影误判出 x≈591 假分隔符、又被强切成两栏斩断右侧的问题
 * （稀疏墨迹把某列投影压低，却并非真正的栏缝）。微信 OCR 的版面分析同样是「检测文本块 →
 * 几何聚类合并」，而非依赖像素投影，本实现思路与其一致。
 *
 * 流程：
 *  1. 从 ink 取文本块（连通域，剔除跨页大块/超长残块）。
 *  2. 逐块做 x 区间覆盖（带小余量桥接词间 1~2px 缝隙）→ blockCover[y][x]（块覆盖处=1）。
 *  3. 对每列 x 计算「最长无块覆盖纵向连续段」gapRun[x]：候选分隔符须在某段连续纵向区域里
 *     长期无块跨越（gapRun ≥ 阈值）。这能捕捉「只在上半部成立的栏缝」（如 预习案 双栏缝），
 *     又不会把 探究案 通栏里偶发的局部稀疏当成分隔符。
 *  4. 每个候选分隔符做逐行「块跨越」校验（窗口内无块覆盖=真空隙）+ 多数平滑（抑制行级抖动）。
 *  5. 沿 y 扫描生效分隔符集合，连续相同合并为 section；每个 section 各自持有一套栏。
 *  单 section 页面（绝大多数）：无候选分隔符 → 单栏，与旧版一致；混合版面则上/下分区正确。
 */
export function findColumns(
  ink: Uint8Array,
  w: number,
  h: number,
  medH: number,
): { cols: Array<[number, number]>; sections: ColumnSection[] } {
  const y0 = Math.round(0.06 * h)
  const y1 = Math.round(0.94 * h)

  // ---- 1) 文本块（连通域）----
  const { comps } = connectedComponents(ink, w, h, false)
  const blocks: Array<{ x0: number; x1: number; y0: number; y1: number }> = []
  const maxBlockW = Math.round(w * 0.92)
  const maxBlockH = Math.round(h * 0.6)
  for (const c of comps) {
    const bw = c.x1 - c.x0 + 1
    const bh = c.y1 - c.y0 + 1
    // 跨页大块（插图/框线）已 stripGraphics 处理；此处再兜底排除超宽/超长残块，避免污染列判定
    if (bw <= maxBlockW && bh <= maxBlockH) blocks.push({ x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1 })
  }

  // ---- 2) 文本块水平覆盖（带小余量，桥接词间 1~2px 缝隙）----
  const cover = new Uint8Array(w * h)
  const m = Math.max(1, Math.round(medH * 0.15))
  for (const b of blocks) {
    const x0 = Math.max(0, b.x0 - m)
    const x1 = Math.min(w - 1, b.x1 + m)
    for (let y = b.y0; y <= b.y1; y++) {
      const base = y * w
      for (let x = x0; x <= x1; x++) cover[base + x] = 1
    }
  }

  // ---- 3) 纵向墨迹投影 + 局部极小值找栏缝（对稀疏文字稳健）----
  //   稀疏文字下「空行占比」在全文近乎均匀偏高（实测正图内容区 0.85~0.98 无明显峰），栏缝不突出；
  //   故改用纵向墨迹投影 proj[x]：栏缝处投影≈0、列内投影高，形成明显谷底；单栏页投影平直无深谷。
  //   候选 = inner 区内「局部极小值 + 投影远低于均值 + 相对邻域为显著谷底」；再做页边/夹持校验剔除页边空白。
  const marginX0 = Math.round(w * 0.05)
  const marginX1 = Math.round(w * 0.95)
  const proj = new Int32Array(w)
  for (let y = y0; y < y1; y++) {
    const base = y * w
    for (let x = 0; x < w; x++) proj[x] += ink[base + x]
  }
  // 5 点平滑，抑制单行噪声
  const sp = new Float32Array(w)
  for (let x = 0; x < w; x++) {
    let s = 0, n = 0
    for (let dx = -2; dx <= 2; dx++) { const xx = x + dx; if (xx >= 0 && xx < w) { s += proj[xx]; n++ } }
    sp[x] = n > 0 ? s / n : 0
  }
  // inner 区平均投影，作为「栏缝须远低于均值」的基准
  let sumP = 0, cntP = 0
  for (let x = marginX0; x <= marginX1; x++) { sumP += sp[x]; cntP++ }
  const avgP = cntP > 0 ? sumP / cntP : 0
  const gapThr = Math.max(3, avgP * 0.35) // 栏缝投影须远低于均值（≈0）
  const mWin = Math.max(2, Math.round(medH * 0.4))
  const flank = Math.round(w * 0.3)
  // 局部极小值候选：投影低于均值且显著低于 ±40px 邻域（相对谷深，避免单栏页的轻微起伏被误判）
  const valleys: number[] = []
  const nb = 40
  for (let x = marginX0 + 1; x < marginX1; x++) {
    if (sp[x] > sp[x - 1] || sp[x] > sp[x + 1]) continue // 非局部极小
    let ns = 0, nsum = 0
    for (let dx = -nb; dx <= nb; dx++) { const xx = x + dx; if (xx >= 0 && xx < w) { nsum += sp[xx]; ns++ } }
    const nbAvg = ns > 0 ? nsum / ns : 0
    if (sp[x] < gapThr && sp[x] < 0.6 * nbAvg) valleys.push(x)
  }
  // 非极大抑制：相邻（< 栏缝最小间距 12% 页宽）谷底合并为一组，取投影最低者为中心
  const minGapDist = Math.round(w * 0.12)
  const seps: number[] = []
  let vi = 0
  while (vi < valleys.length) {
    let vj = vi
    let best = valleys[vi], bestV = sp[valleys[vi]]
    while (vj + 1 < valleys.length && valleys[vj + 1] - valleys[vi] < minGapDist) {
      vj++
      if (sp[valleys[vj]] < bestV) { bestV = sp[valleys[vj]]; best = valleys[vj] }
    }
    const c = best
    // 夹持校验：左邻 [c-0.3w, c-mWin] 与右邻 [c+mWin, c+0.3w] 都必须存在墨迹，否则是页边空白
    const la = Math.max(0, c - flank), lb = Math.max(0, c - mWin)
    const ra = Math.min(w - 1, c + mWin), rb2 = Math.min(w - 1, c + flank)
    let leftInk = 0, rightInk = 0
    for (let y = y0; y < y1; y++) {
      const base = y * w
      for (let xx = la; xx < lb; xx++) leftInk += ink[base + xx]
      for (let xx = ra + 1; xx <= rb2; xx++) rightInk += ink[base + xx]
    }
    if (leftInk > 0 && rightInk > 0) seps.push(c)
    vi = vj + 1
  }

  // 兜底单栏（通栏页 / 无清晰栏缝）：整页无任何候选分隔符
  if (!seps.length) {
    return { cols: [[0, w]], sections: [{ y0, y1, cols: [[0, w]] }] }
  }

  // ---- 4) 每个候选分隔符的逐行「块跨越」校验 + 多数平滑（抑制行级抖动）----
  const win = Math.max(2, Math.round(medH * 0.4))
  const opensRaw: Uint8Array[] = seps.map((sx) => {
    const a = new Uint8Array(h)
    const x0 = Math.max(0, sx - win), x1 = Math.min(w - 1, sx + win)
    for (let y = y0; y < y1; y++) {
      const base = y * w
      let covered = 0
      for (let x = x0; x <= x1; x++) covered += cover[base + x]
      a[y] = covered === 0 ? 1 : 0 // 窗口内无块覆盖 = 此处确为纵向空隙
    }
    return a
  })
  // 多数平滑：某道栏缝须在一段较「高」的纵向窗口里大多数为「真空隙」才算生效，
  // 以抑制探究案「汉语行 / 英语行分两行排布」造成的左右交替假性留白（局部约 50–70% 开放）。
  // 真实双栏缝在整段里近 100% 开放 → 仍生效；交替留白约 50–70% → 低于 80% 阈值 → 失效（通栏不被误切）。
  const rWin = Math.max(1, Math.round(medH * 2))
  const opens: Uint8Array[] = opensRaw.map((arr) => {
    const out = new Uint8Array(h)
    for (let y = y0; y < y1; y++) {
      let cnt = 0, tot = 0
      for (let dy = -rWin; dy <= rWin; dy++) {
        const yy = y + dy
        if (yy < y0 || yy >= y1) continue
        tot++
        cnt += arr[yy]
      }
      out[y] = tot > 0 && cnt * 10 >= tot * 8 ? 1 : 0 // 开放占比需 ≥80%
    }
    return out
  })
  // 连续行程门槛：某栏缝要在纵向「持续连续」地开放才算真栏缝。
  // 真实双栏缝在整段区域里近 100% 连续开放（预习案两段整段空白）→ 通过；
  // 探究案汉英混排仅造成 1~2 行的零散留白 → 连续行程过短 → 失效（通栏不被误切）。
  const minSustain = Math.max(2 * medH, Math.round((y1 - y0) * 0.12))
  const opensSustained: Uint8Array[] = opens.map((arr) => {
    const out = new Uint8Array(h)
    let run = 0
    for (let y = y0; y < y1; y++) {
      run = arr[y] ? run + 1 : 0
      if (run >= minSustain) {
        for (let k = y - minSustain + 1; k <= y; k++) out[k] = 1
      }
    }
    return out
  })
  const keyAt = (y: number): string => {
    let k = ''
    for (let i = 0; i < seps.length; i++) k += opensSustained[i][y] ? '1' : '0'
    return k
  }

  // ---- 5) 沿 y 扫描，合并连续相同生效集合为 run；短促抖动并入邻居 ----
  const rows: number[] = []
  for (let y = y0; y < y1; y++) rows.push(y)
  const runs: Array<{ y0: number; y1: number; key: string }> = []
  let i = 0
  while (i < rows.length) {
    let j = i
    const k0 = keyAt(rows[i])
    while (j < rows.length && keyAt(rows[j]) === k0) j++
    runs.push({ y0: rows[i], y1: rows[j - 1], key: k0 })
    i = j
  }
  const minRun = Math.max(3, Math.round(medH * 1.0))
  // 短 run 吸收到相邻（取更长一侧的 key，再合并相邻同 key）
  for (let k = 0; k < runs.length; k++) {
    if (runs[k].y1 - runs[k].y0 + 1 < minRun) {
      const left = k > 0 ? runs[k - 1] : null
      const right = k < runs.length - 1 ? runs[k + 1] : null
      if (!left && !right) continue
      const leftLen = left ? left.y1 - left.y0 + 1 : -1
      const rightLen = right ? right.y1 - right.y0 + 1 : -1
      runs[k].key = leftLen >= rightLen && left ? left.key : (right as { key: string }).key
    }
  }
  // 合并相邻同 key
  const merged: Array<{ y0: number; y1: number; key: string }> = []
  for (const r of runs) {
    const last = merged[merged.length - 1]
    if (last && last.key === r.key) last.y1 = r.y1
    else merged.push({ ...r })
  }

  const sections: ColumnSection[] = merged.map((r) => {
    const active = seps.filter((_, idx) => r.key[idx] === '1')
    return { y0: r.y0, y1: r.y1, cols: colsFromSeps(active, w, proj, y0, y1) }
  })

  // 兜底全局栏 = 块覆盖推出的候选分隔符切出的栏（单 section 页即此答案；混合版面页面取主导 section）
  return { cols: colsFromSeps(seps, w, proj, y0, y1), sections }
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
  // ⭐ keepFullCanvas=true：OCR/版面分析要保留**整页**（含四周留白与边角文字），只做几何摆正、
  //    绝不按内容包络裁边——否则自动四角命中时会把页面空白整段裁掉、边角文字被切（问题④-A）。
  const st = await straightenImage(buf, { auto: true, curved: false, keepFullCanvas: true })
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
  const { cols, sections } = findColumns(ink2, w, h, medH)
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

  return {
    w, h, medH, ink: ink2, cols, colSections: sections, colRows, luma, flatBuf, inkRatio,
    // 朝向风险透传：true = 摆正未经 OCR 消歧，本页可能整页倒置，结果不可直接采信
    orientAngle: st.orientAngle ?? 0,
    orientSuspect: st.orientSuspect === true,
    orientMethod: st.orientMethod,
  }
}
