/**
 * 复习本多图 → A4 智能排版（Guillotine-BSSF + 按图高分档）。
 *
 * 归类领域：2D Bin Packing / Strip Packing（NP-hard），用启发式求"足够好"解。
 *
 * 设计（结合本项目真实需求，简洁可靠、无内部冲突）：
 *   诉求 = ①尽量省纸（多图拼到一页）②**同一页内**各图"字体大小"别差太多。
 *   图片内字高无法测得，但同一批题目照片「字高/图高」占比近似恒定
 *   ⇒ **同页各图『图高』接近 ⇔ 字大接近**。
 *
 *   因此采用 **「按图高归一化 + 分档拼页」**：
 *     1. 把所有图按等比缩放到统一基准（最大图放入页面），得到各自"归一化高度"；
 *     2. 按归一化高度分档（相邻高度归为一档），**只把相近高度的图放同页**；
 *     3. 每档内用 Guillotine-BSSF 装箱，尽量少页。
 *   效果：既省纸（同档能拼很多），又保证同页字大接近（不同高度档不混排）。
 *
 * 纯函数，不依赖 pdf-lib / 网络 / 框架。
 */

export interface Bin { width: number; height: number }
export interface PackInput { key: string; width: number; height: number }
export interface Placement {
  key: string
  x: number
  y: number
  width: number
  height: number
  scale: number
  rotated: boolean
}
export interface PackedPage { placements: Placement[]; fillRatio: number }
export interface PackOptions {
  allowRotate?: boolean
  /**
   * 高度分档的"档宽"：相邻图高相对差 ≤ 此值即归为同一档（默认 0.18 = 18%）。
   * 越小 → 同页字大越一致、但可拼的图越少（页数略多）；越大 → 越省纸、字大差异略大。
   */
  heightTolerance?: number
  /**
   * 拼页基准高占页面可用高的比例**上限**（默认 0.46）。
   * 越大 → 图越大、但一页能堆的张数越少。
   * 注意：这只是搜索上界。实际比例由自动搜索选出（见下），不会固定用它——
   * 因为"能拼几张"取决于图片比例分布，存在相变（如 0.46→5 页、0.44→3 页），
   * 单一常数在换一批图片时就会失效。
   */
  binHeightRatio?: number
  /**
   * 自动搜索的最低比例（默认 0.34）。
   * 这是**可读性硬下限**而不是随手取的数：0.34 × 可用高(774pt) ≈ 263pt ≈ 9.3cm，
   * 手机拍的一张 A4 复习题照片印到 9.3cm 高，正文小字约 6~8pt，刚好达到可辨认临界。
   * 再小就会为了"少一页"把图印成指甲盖大小、字看不清——这正是用户选择"宽松易读"时
   * 明确排斥的结果。若确需更省纸，调用方可以显式传更小的值自行承担可读性风险。
   */
  minBinHeightRatio?: number
}

interface FreeRect { x: number; y: number; width: number; height: number }
interface Candidate { frIndex: number; width: number; height: number; rotated: boolean; leftoverShort: number; leftoverLong: number }

const EPS = 1e-6

function findBssf(freeRects: FreeRect[], w: number, h: number, allowRotate: boolean): Candidate | null {
  let best: Candidate | null = null
  const consider = (iw: number, ih: number, rotated: boolean) => {
    for (let i = 0; i < freeRects.length; i++) {
      const fr = freeRects[i]
      if (iw <= fr.width + EPS && ih <= fr.height + EPS) {
        const leftoverShort = Math.min(fr.width - iw, fr.height - ih)
        const leftoverLong = Math.max(fr.width - iw, fr.height - ih)
        if (
          !best ||
          leftoverShort < best.leftoverShort - EPS ||
          (Math.abs(leftoverShort - best.leftoverShort) < EPS && leftoverLong < best.leftoverLong - EPS)
        ) {
          best = { frIndex: i, width: iw, height: ih, rotated, leftoverShort, leftoverLong }
        }
      }
    }
  }
  consider(w, h, false)
  if (allowRotate && Math.abs(w - h) > EPS) consider(h, w, true)
  return best
}

/**
 * Guillotine 分割：放入 (iw,ih) 后把空闲矩形切成至多两块剩余区。
 * 为「窄竖图并排」优化：当右、下都有剩余时，让**面积较大的一侧占满整边**，
 * 使剩余区更方正、后续能塞入更多同尺寸窄图（实测可显著提升填充率）。
 */
function splitFreeRect(fr: FreeRect, iw: number, ih: number): FreeRect[] {
  const rx = fr.width - iw
  const ry = fr.height - ih
  const out: FreeRect[] = []
  if (rx > EPS && ry > EPS) {
    const bottom: FreeRect = { x: fr.x, y: fr.y + ih, width: fr.width, height: ry }
    const right: FreeRect = { x: fr.x + iw, y: fr.y, width: rx, height: ih }
    // 剩余更高（竖长）→ 下方块占整宽；否则右侧块优先
    return ry >= rx ? [bottom, right] : [right, bottom]
  }
  if (rx > EPS) out.push({ x: fr.x + iw, y: fr.y, width: rx, height: fr.height })
  if (ry > EPS) out.push({ x: fr.x, y: fr.y + ih, width: fr.width, height: ry })
  return out
}

interface Norm { key: string; width: number; height: number; scale: number }

/** 用统一目标高归一化一组矩形（保持宽高比，宽度超页则二次缩小） */
function normalizeToHeight(items: PackInput[], bin: Bin, targetH: number): Norm[] {
  return items.map((it) => {
    let scale = targetH / it.height
    let w = it.width * scale
    let h = it.height * scale
    if (w > bin.width) {
      scale *= bin.width / w
      w = it.width * scale
      h = it.height * scale
    }
    return { key: it.key, width: w, height: h, scale }
  })
}

/**
 * 全局基准高：**不等于页高**。若把每张图都归一到页高，一页只能放一张，拼页失效。
 * 取「页高的一个比例」（默认 0.46）作为基准高，使一页通常能堆叠 2~4 张同高图，
 * 从而既拼页省纸、又让同页字大接近；单张图仍会各自放大到满意大小（见 packPages 单图处理）。
 * 同时保证不超过「最大图刚好放入页面」的高度上限。
 */
function globalTargetH(items: PackInput[], bin: Bin, binHeightRatio: number): number {
  let cap = bin.height
  for (const it of items) {
    const s = Math.min(bin.width / it.width, bin.height / it.height)
    cap = Math.min(cap, it.height * s)
  }
  return Math.max(1, Math.min(bin.height * binHeightRatio, cap))
}

/** 把一组已归一化矩形装箱成页 */
function packGroup(normalized: Norm[], bin: Bin, allowRotate: boolean): PackedPage[] {
  const sorted = [...normalized].sort((a, b) => b.height - a.height || b.width - a.width)
  const pages: PackedPage[] = []
  let freeRects: FreeRect[] = []
  let placements: Placement[] = []
  let usedArea = 0

  const flush = () => {
    if (placements.length) pages.push({ placements, fillRatio: usedArea / (bin.width * bin.height) })
    freeRects = [{ x: 0, y: 0, width: bin.width, height: bin.height }]
    placements = []
    usedArea = 0
  }
  const place = (it: Norm, cand: Candidate) => {
    const fr = freeRects[cand.frIndex]
    if (!fr) return false
    // 贴自由矩形左上角放置（标准 Guillotine/BSSF 行为）。
    // 注意：不要在此处再做"居中"，否则图会偏离该自由矩形、与相邻区块重叠。
    const remains = splitFreeRect(fr, cand.width, cand.height)
    freeRects.splice(cand.frIndex, 1)
    for (const r of remains) {
      if (r.width > EPS && r.height > EPS) freeRects.push(r)
    }
    placements.push({ key: it.key, x: fr.x, y: fr.y, width: cand.width, height: cand.height, scale: it.scale, rotated: cand.rotated })
    usedArea += cand.width * cand.height
    return true
  }

  flush()
  for (const it of sorted) {
    let cand = findBssf(freeRects, it.width, it.height, allowRotate)
    if (cand && place(it, cand)) continue
    flush()
    cand = findBssf(freeRects, it.width, it.height, allowRotate)
    if (cand) place(it, cand)
    else console.warn('[pdf-layout] 单图超出页面，已跳过', it.key)
  }
  flush()
  return pages
}

/** 按图高把归一化后的图分档（相邻高度相对差 ≤ tol 归为一档） */
function groupByHeight(norms: Norm[], tol: number): Norm[][] {
  const sorted = [...norms].sort((a, b) => b.height - a.height)
  const groups: Norm[][] = []
  let cur: Norm[] = []
  for (const n of sorted) {
    if (!cur.length) { cur.push(n); continue }
    const ref = cur[0].height
    if (Math.abs(ref - n.height) / ref <= tol) cur.push(n)
    else { groups.push(cur); cur = [n] }
  }
  if (cur.length) groups.push(cur)
  return groups
}

/**
 * 主入口：按图高分档 + Guillotine-BSSF 拼页 + **自动选基准比例**。
 *
 * 为什么必须自动选而不是写死常数：一页能拼几张取决于「这批图的宽高比例分布」，
 * 而且存在**相变**——同一批图换个比例就跳档。实测：
 *   · 10 张竖拍照片：比例 0.46→5 页、0.42→3 页（0.42~0.34 都是 3 页）；
 *   · 8 张横图：0.46~0.34 全是 4 页（受"一行只能放 1 张"限制）；
 *   · 6 张混合图：0.34→3 页、0.32→1 页（骤降）。
 * 任何常数换一批图都会失效：写大了浪费纸，写小了把图印成指甲盖。
 *
 * 因此采用「从大到小扫，取第一个页数降到**面积下界**的比例」：
 *   · 从大往小扫 ⇒ 取到的第一个达标解就是**该页数下图最大**的那个（兼顾可读）；
 *   · 面积下界 = ⌈图面积 / 页面积⌉，是数学上不可能突破的最少页数 ⇒ 达标即最优、可停；
 *   · 搜索下界受「可读性硬下限」保护 ⇒ 宁可多一页，也不把字印到看不清。
 * 这样"图尽量大"、"页数尽量少"、"字看得清"三者同时成立，且对任意图片分布自适应。
 */
export function packPages(items: PackInput[], bin: Bin, options: PackOptions = {}): PackedPage[] {
  const allowRotate = options.allowRotate ?? false
  const tol = options.heightTolerance ?? 0.18
  const ratioHi = options.binHeightRatio ?? 0.46
  const ratioLo = options.minBinHeightRatio ?? 0.34
  if (!items.length) return []

  // 单图：直接适度放大到页高的 ~90%，不走扫描（扫描对它没有意义）
  if (items.length === 1) {
    const one = normalizeToHeight(items, bin, Math.min(bin.height * 0.92, bin.height))
    return packGroup(one, bin, allowRotate)
  }

  // 面积下界：任何排法每页最多装一个可用区，故页数 ≥ ⌈图面积/页面积⌉。
  // 关键：图面积必须按**算法真正使用的缩放**来算，否则下界会失真：
  // 若按"图刚好铺满可用区"算，对宽图会高估面积（宽图铺满页高时会被二次缩小），
  // 导致下界虚高、在错误的比例上提前停下（实测会误判成 9 页、把 3 页的最优解丢掉）。
  const capH = (() => {
    let c = bin.height
    for (const it of items) c = Math.min(c, Math.min(bin.width / it.width, bin.height / it.height) * it.height)
    return c
  })()
  const tHAtHi = Math.min(bin.height * ratioHi, capH)
  let areaAtHi = 0
  for (const it of items) {
    const k = tHAtHi / it.height
    let w = it.width * k
    let h = it.height * k
    if (w > bin.width) {
      const k2 = bin.width / w
      w *= k2
      h *= k2
    }
    areaAtHi += w * h
  }
  const minPages = Math.max(1, Math.ceil(areaAtHi / (bin.width * bin.height) - 1e-9))

  console.log(
    `[pdf-layout] 可用区 ${bin.width.toFixed(0)}x${bin.height.toFixed(0)}，` +
      `面积下界 ${minPages} 页，扫描区间 ${ratioLo}~${ratioHi}`,
  )

  const run = (ratio: number): PackedPage[] => {
    const tH = globalTargetH(items, bin, ratio)
    const norms = normalizeToHeight(items, bin, tH)
    const groups = groupByHeight(norms, tol)
    const out: PackedPage[] = []
    for (const g of groups) {
      if (g.length === 1) {
        // 单图独占组：适度放大到页高的 ~92%，避免单图页过小
        const one = normalizeToHeight(
          [{ key: g[0].key, width: g[0].width / g[0].scale, height: g[0].height / g[0].scale }],
          bin,
          Math.min(bin.height * 0.92, bin.height),
        )
        out.push(...packGroup(one, bin, allowRotate))
      } else {
        out.push(...packGroup(g, bin, allowRotate))
      }
    }
    return out
  }

  /**
   * 主循环：从「图尽量大」往「图尽量小」扫基准比例，兼顾两个目标：
   *   ① 页数尽量少（省纸）② 图尽量大（可读，且同页字大接近）
   *
   * 从大往小扫，记录"迄今出现过的更少页数"；一旦页数降到**面积下界**（数学上不可能
   * 再少），当前比例就是该页数下"图最大"的解，立即返回。
   * 若扫到可读性下限仍未触及下界，则返回全程最少页数的那个解。
   */
  let best: PackedPage[] | null = null
  let bestRatio = ratioHi
  for (let r = ratioHi; r >= ratioLo - EPS; r -= 0.02) {
    const ratio = Math.round(r * 1000) / 1000
    const pages = run(ratio)
    if (!best || pages.length < best.length) {
      best = pages
      bestRatio = ratio
    }
    // 已达面积下界 ⇒ 页数理论最少；且继续往下扫只会把图缩小 ⇒ 此时即最优解
    if (pages.length <= minPages) {
      console.log(`[pdf-layout] 自动基准比例 ${ratio}（图尽量大，${pages.length} 页，面积下界 ${minPages} 页）`)
      return pages
    }
  }
  console.log(`[pdf-layout] 自动基准比例 ${bestRatio}（可读下限内最少 ${best ? best.length : 0} 页，面积下界 ${minPages} 页）`)
  return best ?? []
}
