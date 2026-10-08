import sharp from 'sharp'

/**
 * 【版面度量基座 · 全项目共用】
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────────────────
 * 「字符有多大」是文档图像一切**自适应参数**的唯一数据来源：
 *   · 智能高清 P0-1  背景归一化结构元 ≈ 1.5~3 × 字高
 *   · 智能高清 P0-2  局部对比（Sauvola）窗口 ≈ 2~3 × 字高
 *   · 智能高清 P0.5  锐化 sigma ≈ 笔画宽 / 2
 *   · 智能高清 P0-5  版面感知（判别图形/插图区）需要以字高为尺度基准
 *   · 去手写   P0-7  手写/印刷判别同样依赖字高与笔画宽
 *   · 自动调正        行切分间隙阈值已经是字高的函数
 *
 * 此前 `detectTextRows`（image-perspective.ts）**内部已经算出了 medH 却没有导出**，
 * 于是每个新功能都要各做一遍度量 —— 这正是方案里标记为「全项目级一次改造」的阻塞项。
 * 本文件把 Otsu / 连通域 / 字符度量抽出为**单一实现**，perspective 与新功能共同引用，
 * 保证「同一张图在任何功能里量出的字高是同一个数」。
 *
 * ── 设计取舍 ──────────────────────────────────────────────────────────────
 * ① **一切度量都在降采样工作图上进行**（默认长边 800）。字高是**尺度量**，
 *    不需要全分辨率；工作图上跑连通域比原图快一个数量级，结果按比例还原即可。
 *    这与方案 §7.1 的「低频/统计量可降采样，笔画级高频必须原尺度」一致 ——
 *    度量属于前者，增强属于后者。
 * ② **medH 用连通域高度中位数，但要用行距交叉校验**。中文是方块字，笔画不连，
 *    连通域常常是**偏旁部件**而非整字 → 中位数会系统性偏小（实测约 0.6~0.8 字高）。
 *    行距则几乎不受粘连影响（行距 = 行中心 y 差），故取
 *    `medH = max(高度中位数, 行距 × 0.55)` 兜住这个系统性偏差。
 * ③ **笔画宽用水平游程的中段分位数**，不用均值：粘连笔画会产生极长游程，
 *    均值会被拉垮；取 p40~p60 段对粘连不敏感。
 * ④ **极性要自动判定**（暗字亮底 vs 亮字暗底）。形态学背景估计的算子极性
 *    完全取决于此，判反了会把字当背景一起削掉 —— 这是方案 v2 修正过的硬伤。
 */

/** 度量工作图长边（与 detectTextRows 的 EST_MAX_SIDE 对齐，保证两处尺度一致） */
export const LAYOUT_MAX_SIDE = 800

/** 连通域（8-连通）的包络与像素数 */
export interface Comp {
  x0: number
  x1: number
  y0: number
  y1: number
  n: number
}

/** 字符度量结果（**单位统一为原图像素**） */
export interface CharMetrics {
  /** 估计的字身高度（原图像素）。为 0 表示版面估计失败，调用方应回退固定参数 */
  medH: number
  /** 估计的笔画宽度（原图像素）。为 0 同上 */
  strokeWidth: number
  /** 估计的行距（相邻行中心 y 差，原图像素）。为 0 表示未检出行结构 */
  rowPitch: number
  /** 前景（字）是否比背景暗 —— 绝大多数文档为 true；false 表示白字黑底 */
  inkIsDark: boolean
  /** 置信度 0..1：块数、行结构是否合理。低于 0.3 时建议按"不可信"处理 */
  confidence: number
  /** 工作图相对原图的缩放（工作图 1 像素 = 原图 1/scale 像素） */
  scale: number
  /** 参与统计的字符块数（诊断用） */
  charCount: number
  /** 检出的文本行数（诊断用） */
  rowCount: number
  /** P0-5 审计：修正**前**的 medH（原图像素）。仅 CHARH_FIX≠off 时有值 */
  charHLegacy?: number
  /** P0-5 审计：块高直方图峰值口径字高（原图像素）。仅 CHARH_FIX≠off 时有值 */
  charHPeak?: number
  /** P0-5 审计：行 bbox 高度口径字高（原图像素）。仅 CHARH_FIX≠off 时有值 */
  charHRow?: number
  /** P0-5 审计：投影分带口径字高 = 带高×KBAND（原图像素）。仅 CHARH_FIX=on 时有值 */
  charHBand?: number
  /** P0-5 审计：投影分带检出的行带数（诊断用）。仅 CHARH_FIX=on 时有值 */
  bandCount?: number
  /** P0-5 审计：不闭合 CC 高度众数（原图像素，审计②同款口径）。仅 CHARH_FIX=on 时有值 */
  charHUMode?: number
}

export function median(a: number[]): number {
  if (!a.length) return 0
  const s = a.slice().sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** 分位数（要求已排序数组） */
export function quantileSorted(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))
  return sorted[i]
}

/**
 * Otsu 全局阈值（0..255）。
 *
 * 文档图像的前景占比小、双峰明显，Otsu 在这里是**最稳**的二值化起点；
 * 它只用于「度量」与「版面粗判」，最终增强走局部自适应（Sauvola），不依赖它。
 */
export function otsuThreshold(gray: ArrayLike<number>, len = (gray as unknown as { length: number }).length): number {
  const hist = new Int32Array(256)
  for (let i = 0; i < len; i++) {
    const v = gray[i] & 255
    hist[v]++
  }
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let wB = 0
  let sumB = 0
  let maxVar = -1
  let tLow = 0
  let tHigh = 0
  let set = false
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = len - wB
    if (!wF) break
    sumB += t * hist[t]
    // 平台中点：最大方差常落在一段平台上，取首个 t 会得到平台低端
    // （二值图上=0、普通扫描件上恒=127）。改为取平台 [tLow,tHigh] 中点。
    // 与 adaptive-stats.ts otsuPlatform 同义，本函数无循环依赖故内联。
    const v = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2
    if (v > maxVar) { maxVar = v; tLow = tHigh = t; set = true }
    else if (v === maxVar) { tHigh = t }
  }
  return set ? Math.round((tLow + tHigh) / 2) : 127
}

/**
 * 8-连通连通域标记（显式栈 DFS，避免递归爆栈）。
 *
 * @param withLabels 是否需要回传 label 图（不需要时置 false 可省一份 Int32Array 内存）
 */
export function connectedComponents(
  ink: Uint8Array,
  w: number,
  h: number,
  withLabels = false,
): { comps: Comp[]; labels: Int32Array | null } {
  const n = w * h
  const lab = new Int32Array(n).fill(-1)
  const comps: Comp[] = []
  const stack: number[] = []
  for (let s = 0; s < n; s++) {
    if (!ink[s] || lab[s] >= 0) continue
    const id = comps.length
    stack.push(s)
    lab[s] = id
    let x0 = w
    let x1 = 0
    let y0 = h
    let y1 = 0
    let cnt = 0
    while (stack.length) {
      const p = stack.pop()!
      const px = p % w
      const py = (p / w) | 0
      cnt++
      if (px < x0) x0 = px
      if (px > x1) x1 = px
      if (py < y0) y0 = py
      if (py > y1) y1 = py
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx
          const ny = py + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const q = ny * w + nx
          if (ink[q] && lab[q] < 0) {
            lab[q] = id
            stack.push(q)
          }
        }
      }
    }
    comps.push({ x0, x1, y0, y1, n: cnt })
  }
  return { comps, labels: withLabels ? lab : null }
}

/**
 * 水平 ink 游程的中段分位数 ≈ 笔画宽度。
 *
 * 为什么取中段而不是均值：横排文本里，相邻笔画一旦粘连（扫描/拍照糊了很常见）
 * 游程会长达数十字宽，均值会被这些离群值带跑；取 p40~p60 段对粘连天然免疫。
 * 小于 2 的游程是噪点，超过 `cap` 的是横线/表格线/阴影边，两者都剔除。
 */
function strokeWidthFromRuns(ink: Uint8Array, w: number, h: number, cap: number): number {
  const runs: number[] = []
  for (let y = 0; y < h; y++) {
    let run = 0
    const base = y * w
    for (let x = 0; x < w; x++) {
      if (ink[base + x]) {
        run++
      } else {
        if (run >= 2 && run <= cap) runs.push(run)
        run = 0
      }
    }
    if (run >= 2 && run <= cap) runs.push(run)
  }
  if (runs.length < 24) return 0
  runs.sort((a, b) => a - b)
  const p40 = quantileSorted(runs, 0.4)
  const p60 = quantileSorted(runs, 0.6)
  return (p40 + p60) / 2
}

/**
 * 3×3 闭运算（Boolean）：先膨胀后腐蚀。
 *
 * 为什么连通域分析前必须做这一步：细笔画文字（SVG 小字 / 远景拍照 / 低分辨率）
 * 经反锯齿与重采样后，笔画会**断裂成 3~10px 的碎片**，碎片数量远多于完整部件，
 * 把"块高直方图峰值"整个拖到碎片区 —— 实测 SVG 试卷 medH 被拉低一半。
 * 1px 闭合把断裂笔画重新连上，是文档版面分析（CC analysis）的标准前置。
 * ⚠️ 只用于连通域；笔画宽游程统计必须用**原始** ink（闭合会改变游程宽度）。
 */
export function closeInk3x3(ink: Uint8Array, w: number, h: number): Uint8Array {
  const dil = new Uint8Array(ink.length)
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : 0
    const y1 = y < h - 1 ? y + 1 : h - 1
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0
      const x1 = x < w - 1 ? x + 1 : w - 1
      let v = 0
      for (let yy = y0; yy <= y1 && !v; yy++) {
        const base = yy * w
        for (let xx = x0; xx <= x1; xx++) {
          if (ink[base + xx]) {
            v = 1
            break
          }
        }
      }
      dil[y * w + x] = v
    }
  }
  const ero = new Uint8Array(ink.length)
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : 0
    const y1 = y < h - 1 ? y + 1 : h - 1
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0
      const x1 = x < w - 1 ? x + 1 : w - 1
      let v = 1
      for (let yy = y0; yy <= y1 && v; yy++) {
        const base = yy * w
        for (let xx = x0; xx <= x1; xx++) {
          if (!dil[base + xx]) {
            v = 0
            break
          }
        }
      }
      ero[y * w + x] = v
    }
  }
  return ero
}

/**
 * 核心：由**工作尺度灰度图**提取字符度量。
 *
 * @param scale 工作图相对原图的缩放（<1）
 * @returns 所有长度量已还原为**原图像素**
 */
/**
 * P0-5a · 投影分带行查找（v21.5，仅 CHARH_FIX=on 时被 metricsFromGray 调用）
 * =====================================================================
 * 为什么质心聚类必须被替换（合成标定集 probe-charh-calib + page28 内部量实证）：
 *   质心聚类假设「行内质心间隙 ≪ 行间质心间隙」，但密排文档（报纸 600px 工作尺度
 *   实测：字高 p25=6px、行内间隙 p50=0.5/p90=2.5、行距≈8~10px）中字高≈0.7×行距，
 *   块内质心随字形上下浮动 ±3px，两类间隙分布**重叠**，任何单阈值都无法同时切开
 *   —— page28 实测 757 块只聚出 11 组（行高中位 72.5，虚大 8 倍）。
 * 水平投影把「行」从质心点问题变成**波形周期问题**：行内占据密度高、行间出现谷，
 * 谷的位置就是行界 —— 对块内位置噪声天然免疫，也不依赖任何阈值恰好落在两类间隙之间。
 *
 * 桥块剔除：高于 ~2.5×p25 块高的连通域大概率跨行（手写连笔/插图桥接相邻行），
 * 让它参与投影会把行间谷填平 → 带粘连（合成集 V1 的故障机理）。剔除只影响
 * 「行查找投票」，块本身不变、仍参与块高直方图（其数量少，p25/众数对少数大块免疫）。
 *
 * 返回 null = 块太少或剖面无周期结构（调用方退回质心聚类结果，行为同旧路径）。
 */
function findInkBands(
  blocks: Comp[], h: number, hInit: number,
): { y0: number; y1: number }[] | null {
  // L1 · 桥块判据：hInit = 块高 p25 ≈ 字面高（对少数大块免疫，见上方 hInit 注释）。
  //   2.5× = 单行字形（≈1.0×hInit）与跨两行桥块（≥2.6×hInit）之间的中点，合成集
  //   96 图（V0~V3 × 4 档字号）实测该值同时保住"字符不误剔"与"桥块全剔除"。
  const cut = Math.max(4, hInit * 2.5)
  const rb = blocks.filter((c) => c.y1 - c.y0 + 1 <= cut)
  if (rb.length < 8) return null // L1 · 全页皆大块（特写/海报）时投影无意义 → 退回旧行为
  // 行占据剖面：每行被多少个"单行可信"块覆盖
  const P = new Int32Array(h)
  for (const c of rb) {
    const yE = Math.min(h - 1, c.y1)
    for (let y = c.y0; y <= yE; y++) P[y]++
  }
  // 平滑：滑窗宽 ≈ 1×hInit（半个字高各取一侧）。作用是抹平笔画级锯齿；
  //   窗宽远小于行距（≈1.7×hInit），不会把相邻行的谷抹掉。
  const r = Math.max(1, Math.round(hInit / 2))
  const pre = new Int32Array(h + 1)
  for (let y = 0; y < h; y++) pre[y + 1] = pre[y] + P[y]
  const S = new Int32Array(h)
  for (let y = 0; y < h; y++) {
    const a = Math.max(0, y - r)
    const b = Math.min(h, y + r + 1)
    S[y] = pre[b] - pre[a]
  }
  // 行界阈值：剖面 p90 的 25%。p90 由正文行占据数主导（正文行数量优势），
  //   行间谷即使被少量残留桥块抬高，也难越过 25%×p90（合成集实测余量 ≥4×）。
  const sSorted = Array.from(S).sort((a, b) => a - b)
  const p90 = sSorted[Math.min(sSorted.length - 1, Math.floor(sSorted.length * 0.9))] ?? 0
  const T = Math.max(1, Math.round(p90 * 0.25))
  // 带最短高度/合并间隙：半字高。小于它的"带"是噪点，间隙小于它的两带是同行的断裂。
  const minH = Math.max(2, Math.round(hInit * 0.5))
  const mergeGap = minH
  type Band = { y0: number; y1: number }
  const raw: Band[] = []
  let cur: Band | null = null
  for (let y = 0; y < h; y++) {
    if (S[y] > T) {
      if (cur) cur.y1 = y
      else cur = { y0: y, y1: y }
    } else if (cur) {
      if (cur.y1 - cur.y0 + 1 >= minH) raw.push(cur)
      cur = null
    }
  }
  if (cur && cur.y1 - cur.y0 + 1 >= minH) raw.push(cur)
  // 近邻带合并（同行的笔画间隙被阈值切碎时缝合）
  const bands: Band[] = []
  for (const b of raw) {
    const last = bands[bands.length - 1]
    if (last && b.y0 - last.y1 <= mergeGap) last.y1 = b.y1
    else bands.push({ ...b })
  }
  const out = bands.filter((b) => b.y1 - b.y0 + 1 >= minH)
  return out.length >= 3 ? out : null // L1 · 少于 3 带说明无周期行结构 → 退回旧行为
}

export function metricsFromGray(gray: Uint8Array, w: number, h: number, scale: number): CharMetrics {
  const empty: CharMetrics = {
    medH: 0,
    strokeWidth: 0,
    rowPitch: 0,
    inkIsDark: true,
    confidence: 0,
    scale,
    charCount: 0,
    rowCount: 0,
  }
  if (w < 16 || h < 16) return empty

  const n = w * h
  const thr = otsuThreshold(gray, n)
  const ink = new Uint8Array(n)
  let inkSum = 0
  let inkCnt = 0
  let bgSum = 0
  let bgCnt = 0
  for (let i = 0; i < n; i++) {
    const v = gray[i]
    if (v < thr) {
      ink[i] = 1
      inkSum += v
      inkCnt++
    } else {
      bgSum += v
      bgCnt++
    }
  }
  // 极性：前景均值低于背景均值 → 暗字亮底（绝大多数文档）
  const inkIsDark = inkCnt > 0 && bgCnt > 0 ? inkSum / inkCnt < bgSum / bgCnt : true

  // 连通域走**闭合后**的 ink（重连断裂笔画）；游程统计用原始 ink
  const inkC = closeInk3x3(ink, w, h)
  const { comps } = connectedComponents(inkC, w, h, false)

  // 过滤：噪点太小、横跨全图的横线/阴影、纵向大块（插图/照片）
  const blocks = comps.filter(
    (c) => c.n >= 4 && c.x1 - c.x0 < w * 0.9 && c.y1 - c.y0 < h * 0.3,
  )
  if (blocks.length < 8) return { ...empty, inkIsDark }

  const heights = blocks.map((c) => c.y1 - c.y0 + 1).sort((a, b) => a - b)

  // ── 行切分初始尺度：p25 而不是中位数 ──
  // ⚠️ 实测教训（试卷含大片手写时）：手写笔画连成大块会把高度**中位数**拉高数倍，
  //    行切分间隙（1.2×）随之变大 → 相邻正文行被并成一组 → rowPitch 虚大数倍 →
  //    又被行距交叉校验放大回 medH —— 正反馈，最终 medH 虚大 10 倍、窗口/结构元全部失配。
  //    p25 对"少数大块"免疫：印刷文字（数量优势）永远在低分位里。
  const hInit = Math.max(3, quantileSorted(heights, 0.25))

  // —— 行结构：按质心 y 排序，间隙 > 1.2×hInit 切行 ——
  const sorted = blocks.slice().sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2)
  const groups: Comp[][] = [[sorted[0]]]
  for (let i = 1; i < sorted.length; i++) {
    const prev = groups[groups.length - 1]
    const last = prev[prev.length - 1]
    const prevY = (last.y0 + last.y1) / 2
    const y = (sorted[i].y0 + sorted[i].y1) / 2
    if (y - prevY > Math.max(2, hInit * 1.2)) groups.push([sorted[i]])
    else prev.push(sorted[i])
  }
  // 只保留"像正文行"的组：横跨一定宽度（排除页码、孤立符号）
  const rows = groups.filter((g) => {
    const xL = Math.min(...g.map((b) => b.x0))
    const xR = Math.max(...g.map((b) => b.x1))
    return xR - xL >= w * 0.12 || g.length >= 3
  })
  // 行 bbox 高度 = 行内全部块的 y 包络 ≈ 字高（含上下伸部）。
  // 它是比"块高直方图峰值"**更可靠**的字高锚点：不依赖任何单块，
  // 只要行聚类对，行高就对 —— 断裂碎片、部件拆分都影响不了它。
  let rowHMed = 0
  if (rows.length) {
    rowHMed = median(
      rows.map((g) => Math.max(...g.map((b) => b.y1)) - Math.min(...g.map((b) => b.y0)) + 1),
    )
  }
  let rowPitch = 0
  if (rows.length >= 3) {
    const centers = rows.map((g) => {
      let s = 0
      for (const b of g) s += (b.y0 + b.y1) / 2
      return s / g.length
    })
    const gaps: number[] = []
    for (let i = 1; i < centers.length; i++) gaps.push(centers[i] - centers[i - 1])
    rowPitch = median(gaps)
  }

  // ── 字高 = 块高直方图峰值 × 行 bbox 高度 的交叉验证 ──
  // 峰值给出"最常见块"的高度：中文部件 ≈ 0.6~0.8 字高 → ×1.2 修正。
  // ⚠️ 但峰值可能被**断裂笔画碎片**占据（细笔画 + 反锯齿场景实测碎片高度只有
  //    字高的 1/3，且数量占多数）——判据：峰值 < 行高 × 0.45 即认定碎片峰，
  //    此时完全信行高（碎片连行聚类都污染不了）。
  const binW = Math.max(2, Math.round(hInit))
  const maxHh = heights[heights.length - 1]
  const bins = new Int32Array(Math.floor(maxHh / binW) + 1)
  for (const hh of heights) bins[Math.min(bins.length - 1, Math.floor(hh / binW))]++
  let peakIdx = 0
  let peakCnt = -1
  for (let i = 0; i < bins.length; i++) {
    const c = (i > 0 ? bins[i - 1] : 0) + bins[i] + (i < bins.length - 1 ? bins[i + 1] : 0)
    if (c > peakCnt) {
      peakCnt = c
      peakIdx = i
    }
  }
  const inPeak = heights.filter((hh) => Math.floor(hh / binW) === peakIdx)
  const peakMed = inPeak.length ? median(inPeak) : quantileSorted(heights, 0.3)
  // ⭐ P0-5b 交叉验证方向修正（v21.5）
  //   原逻辑：`rowHMed > peakMed×2.2` 时**完全信行高**（medH = rowHMed×0.85），
  //   理由是"峰值可能只是断裂笔画碎片"。
  //   实证反例（probe-charh-audit · 9 图三方审计）：进入本分支的图**全部是行聚类失效**
  //   —— 相邻正文行被并成一组 → rowHMed 整倍虚大（实测 2.3×~11.7×），
  //   没有一例是"峰值为碎片"。原判据把「峰值太低」与「行高虚大」两种相反故障
  //   混在同一个条件下，且处置方向恰好选了错的那个，于是把错误值当可信值放大。
  //   修正：本分支改为**信块高峰值**（对少数大块免疫，与三方审计的 ②CC众数 同向），
  //   行高降级为**上限约束**（排版事实：一行不可能高于行距，行高只能在上限方向起作用）。
  //   开关：CHARH_FIX=off（**默认**：遗留通道与 17 个消费方沿用稳定旧口径，G13 门禁不倒退）
  //         /shadow（两种口径都算出并记录，但不生效，供审计）
  //         /on（修正生效：生产 word 路径经 buildDocContext({charHFix:true}) 内部启用）
  //   ⚠️ 为何默认 off 而非全局 on：v21.5 验证，全局 on 会使 A/B 两通道（结构判别器 / hybrid，
  //      均不进生产路径）的 Sauvola 窗口从"被 WIN_MAX 钳死的 64"落到正确 ≈44，
  //      在其"错误标尺上被调出来"的 G13 基线面前倒退（structural 17→14、hybrid 12→7）。
  //      故采用作用域隔离：仅生产 word 路径拿修正标尺（G14 审计即测此标尺），全局保持稳定。
  const CHARH_FIX = process.env.CHARH_FIX ?? 'off'
  // ⭐ P0-5a 反碎片保护：进入上面分支还有一种**相反**成因 —— 峰值本身锁在断裂笔画碎片上
  //   （annot3 实测：peakMed≈5.4 而真字高 13、CC 众数 13），此时行高才是相对可信的一侧。
  //   判据：峰值 < 高度中位数 × 0.5 → 认定碎片峰 → 改用高度中位数。
  //   中位数会被"少数手写大块"抬高，故仍由下面的行高上限兜底（一行不可能高于行距）。
  const hMed = median(heights)
  const peakUsed = hMed > 0 && peakMed < hMed * 0.5 ? hMed : peakMed
  // ⭐ P0-5a 投影分带（仅 CHARH_FIX=on 计算并生效）：独立于块高直方图与质心聚类的
  //   第三条字高路径 —— 行墨迹带高 × KBAND。三条路径的故障模式互不相同：
  //   块峰怕碎片峰/墨粘连、质心行高怕间隙重叠、投影带怕桥块填谷（已剔除），
  //   取小值即让"虚大方向"互相抑制，"低估方向"由其余两路兜底。
  let bandHMed = 0
  let bandPitch = 0
  let bandCount = 0
  if (CHARH_FIX === 'on') {
    const bands = findInkBands(blocks, h, hInit)
    if (bands) {
      bandHMed = median(bands.map((b) => b.y1 - b.y0 + 1))
      const cs = bands.map((b) => (b.y0 + b.y1) / 2)
      const gaps: number[] = []
      for (let i = 1; i < cs.length; i++) gaps.push(cs[i] - cs[i - 1])
      bandPitch = median(gaps)
      bandCount = bands.length
    }
  }
  // L1 · KBAND：带高→字身换算系数。带高是"行内墨迹纵向覆盖"≈字面（CJK 字面≈0.88em、
  //   拉丁含上下伸部≈1.0em），KBAND=1.1 由合成标定集 96 图（gen-charh-calib.py，
  //   真值=渲染字号）实测中位比例标定，probe-charh-calib.ts 可复验。
  const KBAND = 1.1
  // ⭐ P0-5a 第四路径：**不闭合** CC 高度众数（probe-charh-audit.ts ②同款口径）。
  //   闭合（closeInk3x3）本意是重连断裂笔画，但也会把手写墨迹与相邻字符粘连成
  //   更高的块 —— 合成集 V1 实测闭合峰被抬到 1.03~2.25×真值。不闭合 CC + 尺寸
  //   过滤 + 众数则对两者都免疫：桥块被面积/长宽比/高度上限滤掉，碎片被众数淹没
  //   （9 张真实图 + 合成难题上实测 uMode ≈ 0.9~0.95×字面，跨分辨率稳定）。
  let uMode = 0
  if (CHARH_FIX === 'on') {
    const { comps: uComps } = connectedComponents(ink, w, h, false)
    const uHist = new Map<number, number>()
    for (const c of uComps) {
      const cw = c.x1 - c.x0 + 1
      const chh = c.y1 - c.y0 + 1
      // 过滤判据（与三方审计②一致，逐项来源）：
      //   chh≥5   —— L0/采样极限：工作尺度低于 5px 的块无法区分字/噪点（抗锯齿噪声底）
      //   chh≤120 —— L1/版面：字高工作尺度正常 5~40px，120 为跨行大块保险丝
      //   n<2%N  —— L1/物理：单字符面积不可能超过全图 2%（插图/照片块）
      //   0.05<cw/chh<20 —— L1/几何：字符长宽比经验界（剔除横线/竖线）
      if (chh >= 5 && chh <= 120 && c.n < w * h * 0.02 && cw / chh > 0.05 && cw / chh < 20)
        uHist.set(chh, (uHist.get(chh) ?? 0) + 1)
    }
    let bestC = 0
    for (const [v, c] of uHist) {
      // ±1 平滑：吸收抗锯齿导致的高度抖动（同一字号实测高度差 ±1px）
      let s = 0
      for (let d = -1; d <= 1; d++) s += uHist.get(v + d) ?? 0
      if (s > bestC) { bestC = s; uMode = v }
    }
  }
  // L1 · KU：不闭合 CC 众数→字身换算系数，与 KBAND 同源同值（CC 高≈字面≈0.88em）。
  const KU = 1.1
  // ⭐ P0-5a 统一口径（v21.5 根因修复）
  //   旧逻辑用 `rowHMed > peakMed×2.2` 判据在"信行高"与"信块峰"之间二选一 ——
  //   但这个判据本身的两个量都可能已经被污染（合成集实测 V1 页 peakMed 被手写
  //   墨迹粘连抬到 2.25×真值，判据因而不成立，转而落在同样用污染量的 else 分支，
  //   结果 1.89×虚大）。**用被污染的量判断是否被污染，是这一段的历史病根。**
  //   修正：不再二选一，改为四条独立路径（各故障模式互不相同）统一取小：
  //     ① 不闭合 CC 众数×KU   —— 怕全页特写（此时 n≈全图被过滤 → 该路缺席）
  //     ② 投影带高×KBAND      —— 怕手势墨迹把行间谷填平
  //     ③ 闭合块峰×1.2        —— 怕手写墨迹粘连 / 断裂碎片
  //     ④ 行 bbox 高×0.9      —— 怕密排页质心间隙重叠（page28 实测虚大 8 倍）
  //   min 只抑制"虚大方向"；低估方向由缺席机制处理（任一路失效就不参与）。
  let medHWork: number
  let medHLegacy = 0
  if (rowHMed > peakMed * 2.2) {
    medHLegacy = rowHMed * 0.85
    medHWork = CHARH_FIX === 'on' ? 0 : medHLegacy
  } else {
    medHWork = (peakMed * 1.2 + rowHMed * 0.9) / 2
    medHLegacy = medHWork
  }
  if (CHARH_FIX === 'on') {
    const cands: number[] = [peakUsed * 1.2, rowHMed > 0 ? rowHMed * 0.9 : Infinity]
    if (uMode > 0) cands.push(uMode * KU)
    if (bandHMed > 0) cands.push(bandHMed * KBAND)
    medHWork = Math.min(...cands)
  }
  // 字高不可能超过页高的 8%（正常文档 1.5%~4%，特写也不该过半行）——硬上限兜底
  medHWork = Math.max(4, Math.min(h * 0.08, medHWork))

  const inv = scale > 0 ? 1 / scale : 1
  const medH = medHWork * inv

  const swWork = strokeWidthFromRuns(ink, w, h, Math.max(6, Math.round(medHWork * 1.2)))
  const strokeWidth = swWork > 0 ? Math.max(1, swWork * inv) : Math.max(1, medH / 8)

  // 置信度：块数量 + 行结构 + 度量是否落在合理区间
  // （保持旧口径：行结构证据用质心聚类行数。不用分带带数 —— 分带在密排页会少算
  //  行（page28 实测 7 带 vs ~50 行），拿它打分会让置信度忽高忽低，得不偿失。）
  let confidence = 0
  if (blocks.length >= 8) confidence += 0.3
  if (blocks.length >= 40) confidence += 0.2
  if (rows.length >= 3) confidence += 0.3
  if (rows.length >= 8) confidence += 0.1
  if (medH >= 6 && medH <= h * inv * 0.08) confidence += 0.1

  return {
    medH,
    strokeWidth,
    // rowPitch / rowCount 保持质心聚类口径不变：分带在密排页会把相邻行并成巨带
    // （page28 实测 7 带 → 带距 190px vs 真行距 ≈17px），把它输出给下游是**用更糟的
    // 值替换已知值**。medH 已由四路 min 独立修正，不必牵连这两个诊断字段。
    rowPitch: rowPitch * inv,
    inkIsDark,
    confidence: Math.min(1, confidence),
    scale,
    charCount: blocks.length,
    rowCount: rows.length,
    // P0-5 审计字段：仅在 CHARH_FIX≠off 时附带，默认路径不产出（保持旧返回形态）
    ...(CHARH_FIX !== 'off'
      ? {
          charHLegacy: medHLegacy * inv,
          charHPeak: peakMed * inv,
          charHRow: rowHMed * inv,
          ...(CHARH_FIX === 'on' ? { charHBand: bandHMed * inv, bandCount, charHUMode: uMode * inv } : {}),
        }
      : {}),
  }
}

/** 由图片 Buffer 估计字符度量（读图 → 灰度 → 度量）。供去手写等以 Buffer 为入口的模块使用。 */
export async function estimateCharMetrics(
  buf: Buffer,
  opts: { maxSide?: number } = {},
): Promise<CharMetrics> {
  const meta = await sharp(buf).metadata()
  const W0 = meta.width || 0
  const H0 = meta.height || 0
  const scale0 = Math.min(1, (opts.maxSide ?? LAYOUT_MAX_SIDE) / Math.max(1, Math.max(W0, H0)))
  if (!W0 || !H0) {
    return {
      medH: 0,
      strokeWidth: 0,
      rowPitch: 0,
      inkIsDark: true,
      confidence: 0,
      scale: scale0,
      charCount: 0,
      rowCount: 0,
    }
  }
  const w = Math.max(1, Math.round(W0 * scale0))
  const h = Math.max(1, Math.round(H0 * scale0))
  const raw = await sharp(buf).resize(w, h, { fit: 'fill' }).grayscale().raw().toBuffer()
  return metricsFromGray(new Uint8Array(raw.buffer, raw.byteOffset, raw.length), w, h, scale0)
}

/**
 * 由**已在内存中的亮度数组**估计字符度量（省一次图片解码）。
 * 智能高清管线里 luma 已在手上，直接复用；大图先做 box 降采样到工作尺度。
 */
export function estimateCharMetricsFromLuma(
  luma: Float32Array,
  W: number,
  H: number,
  maxSide = LAYOUT_MAX_SIDE,
): CharMetrics {
  const scale = Math.min(1, maxSide / Math.max(1, Math.max(W, H)))
  if (scale >= 1) {
    const g = new Uint8Array(W * H)
    for (let i = 0; i < g.length; i++) {
      const v = luma[i]
      g[i] = v < 0 ? 0 : v > 255 ? 255 : v
    }
    return metricsFromGray(g, W, H, 1)
  }
  const w = Math.max(1, Math.round(W * scale))
  const h = Math.max(1, Math.round(H * scale))
  // box 平均降采样（比步长采样稳，抗锯齿噪点）
  const g = new Uint8Array(w * h)
  const xr = W / w
  const yr = H / h
  for (let y = 0; y < h; y++) {
    const ya = Math.floor(y * yr)
    const yb = Math.min(H, Math.max(ya + 1, Math.floor((y + 1) * yr)))
    for (let x = 0; x < w; x++) {
      const xa = Math.floor(x * xr)
      const xb = Math.min(W, Math.max(xa + 1, Math.floor((x + 1) * xr)))
      let s = 0
      let c = 0
      for (let yy = ya; yy < yb; yy++) {
        const base = yy * W
        for (let xx = xa; xx < xb; xx++) {
          s += luma[base + xx]
          c++
        }
      }
      g[y * w + x] = s / Math.max(1, c)
    }
  }
  return metricsFromGray(g, w, h, scale)
}
