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
  let thr = 127
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    const wF = len - wB
    if (!wB || !wF) break
    sumB += t * hist[t]
    const v = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2
    if (v > maxVar) {
      maxVar = v
      thr = t
    }
  }
  return thr
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
function closeInk3x3(ink: Uint8Array, w: number, h: number): Uint8Array {
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
  let medHWork: number
  if (rowHMed > peakMed * 2.2) {
    medHWork = rowHMed * 0.85
  } else {
    medHWork = (peakMed * 1.2 + rowHMed * 0.9) / 2
  }
  // 字高不可能超过页高的 8%（正常文档 1.5%~4%，特写也不该过半行）——硬上限兜底
  medHWork = Math.max(4, Math.min(h * 0.08, medHWork))

  const inv = scale > 0 ? 1 / scale : 1
  const medH = medHWork * inv

  const swWork = strokeWidthFromRuns(ink, w, h, Math.max(6, Math.round(medHWork * 1.2)))
  const strokeWidth = swWork > 0 ? Math.max(1, swWork * inv) : Math.max(1, medH / 8)

  // 置信度：块数量 + 行结构 + 度量是否落在合理区间
  let confidence = 0
  if (blocks.length >= 8) confidence += 0.3
  if (blocks.length >= 40) confidence += 0.2
  if (rows.length >= 3) confidence += 0.3
  if (rows.length >= 8) confidence += 0.1
  if (medH >= 6 && medH <= h * inv * 0.08) confidence += 0.1

  return {
    medH,
    strokeWidth,
    rowPitch: rowPitch * inv,
    inkIsDark,
    confidence: Math.min(1, confidence),
    scale,
    charCount: blocks.length,
    rowCount: rows.length,
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
