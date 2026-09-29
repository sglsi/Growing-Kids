import sharp from 'sharp'
import {
  connectedComponents,
  estimateCharMetricsFromLuma,
  otsuThreshold,
  quantileSorted,
  type CharMetrics,
} from './image-layout'

/**
 * 【智能高清 · 文档图像增强核心】
 *
 * ── 这个文件解决什么问题 ──────────────────────────────────────────────────
 * 用户反馈「① 文字/背景对比度提升不明显，和原图差别不大；② 文字模糊」。
 * 方案 §1.2 的根因判断是：
 *
 *   > 扫描类 App 的"清晰"，视觉上主要来自**背景拉平 + 局部对比**，
 *   > 而不是分辨率提升。我们把一张 180/210 灰阶的糊字通过局部自适应阈值
 *   > 拉成 20/250，人眼会立刻判定"清晰、修过"——即使像素总数没变。
 *
 * 旧管线（image-superres.enhanceImage）只有「插值升采样 + 固定 sigma=1.4 锐化」，
 * 缺的正是这两步。本文件补齐 **P0-1 ~ P0-5 + P0.5 + P1**：
 *
 *   P0-1 背景归一化    形态学 closing 估计背景 → 减掉 → 拉平（消除阴影/渐变）
 *   P0-2 局部对比增强  Sauvola 风格**软映射**（默认不硬二值化，保留灰阶）
 *   P0-3 积分图加速    局部均值/方差 O(1) 查询，避免逐像素 O(win²) 滑窗
 *   P0-4 自适应窗口    窗口 = 2~3 × 字高（来自 image-layout 的共用度量）
 *   P0-5 版面感知      只在文字区增强，**图形/插图/照片/表格线**保持原样
 *   P0.5 自适应锐化    sigma ≈ 笔画宽/2 + 局部梯度软门控 + 限幅防光晕
 *   P1   多模式        原图 / 增强（默认）/ 黑白（硬二值化）+ 弱/中/强 档位
 *
 * ── 每一条关键工程约束（都有出处，别随手改）────────────────────────────────
 * ① **算子极性**：暗字亮底必须用 **closing**（膨胀→腐蚀）估背景。
 *    用反了（opening）会把字一起削掉 —— 这是方案 v2 修正过的硬伤。
 * ② **结构元尺寸基准是字高不是笔画宽**：SE ≈ 1.5~3 × 字高。
 *    按笔画宽取会让 SE 钻进字内部，背景估计被字污染。
 * ③ **频率差异化降采样**（方案 §7.1）：背景归一化是**低频** → 降采样做、再升采样相减；
 *    对比增强/锐化是**笔画级高频** → 必须原尺度，一分块就必须带 halo ≥ 窗口半径。
 * ④ **保护优先于效果**（P0-5）：宁可少增强一块，也不能把试卷里的几何图形压成黑白块。
 *    这是与去手写"图形被误擦"**同一类根因**（不认识图片区）在高清侧的对应护栏。
 * ⑤ **默认软映射**：硬二值化只在 'bw' 模式启用。整图硬二值化对连续色调是破坏性的。
 */

/* ============================ 类型与档位 ============================ */

/** P1 输出模式 */
export type EnhancePreset = 'original' | 'enhance' | 'bw'
/** P1 强度档位 */
export type EnhanceStrength = 'weak' | 'medium' | 'strong'

export interface EnhanceTuning {
  /** 背景拉平强度 0..1（0 = 不动） */
  flatten: number
  /** 自动色阶（把灰度 p2/p98 拉到 0/255）混合比 0..1 */
  levelStretch: number
  /** Sauvola k：越大越"去背景"，过大伤笔画 */
  k: number
  /** 局部对比增强与原图的混合比 0..1（保留灰阶的旋钮） */
  blend: number
  /** 锐化总量 */
  sharpenAmount: number
}

/** 三档强度。数值起点参照方案 §五「关键参数建议」 */
const TUNING: Record<EnhanceStrength, EnhanceTuning> = {
  weak:   { flatten: 0.55, levelStretch: 0.30, k: 0.15, blend: 0.50, sharpenAmount: 0.50 },
  medium: { flatten: 0.80, levelStretch: 0.55, k: 0.22, blend: 0.72, sharpenAmount: 0.85 },
  strong: { flatten: 1.00, levelStretch: 0.80, k: 0.30, blend: 0.90, sharpenAmount: 1.20 },
}

export function tuningFor(strength: EnhanceStrength): EnhanceTuning {
  return TUNING[strength] ?? TUNING.medium
}

export interface DocEnhanceOptions {
  preset?: EnhancePreset
  strength?: EnhanceStrength
  /** 字符度量（**必须是当前工作尺度**的，即超分后再量） */
  metrics?: CharMetrics
  /**
   * 调用方是否**已经**在超分前做过背景归一化。
   * 置 true 时本函数跳过 ①（避免同一低频操作做两遍，也避免第二次在工作尺度上
   * 把已经拉平的背景再拉一次）。
   */
  preNormalized?: boolean
  /** 诊断信息回填 */
  debug?: Record<string, unknown>
}

/** 把度量按倍率换算到新尺度（超分后不必重新跑一次连通域） */
export function scaleMetrics(m: CharMetrics, s: number): CharMetrics {
  if (s === 1) return m
  return {
    medH: m.medH * s,
    strokeWidth: m.strokeWidth * s,
    rowPitch: m.rowPitch * s,
    inkIsDark: m.inkIsDark,
    confidence: m.confidence,
    scale: m.scale,
    charCount: m.charCount,
    rowCount: m.rowCount,
  }
}

export interface DocEnhanceResult {
  luma: Float32Array
  width: number
  height: number
  metrics: CharMetrics
  debug: Record<string, unknown>
}

/* ============================ 小工具 ============================ */

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

function toGrayBytes(src: Float32Array, n = src.length): Uint8Array {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const v = src[i]
    b[i] = v < 0 ? 0 : v > 255 ? 255 : v + 0.5
  }
  return b
}

/** 采样灰度直方图取分位（不必全量遍历，大图足够精确） */
function grayPercentile(src: Float32Array, n: number, p: number): number {
  const hist = new Int32Array(256)
  const step = Math.max(1, Math.floor(n / 200000))
  let cnt = 0
  for (let i = 0; i < n; i += step) {
    const v = src[i]
    hist[v < 0 ? 0 : v > 255 ? 255 : v | 0]++
    cnt++
  }
  let acc = 0
  const target = cnt * p
  for (let t = 0; t < 256; t++) {
    acc += hist[t]
    if (acc >= target) return t
  }
  return 255
}

/** box 平均降采样（Float32 → Float32），用于一切低频/统计量 */
function boxDownsample(src: Float32Array, W: number, H: number, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(1, Math.max(W, H)))
  const w = Math.max(1, Math.round(W * scale))
  const h = Math.max(1, Math.round(H * scale))
  const out = new Float32Array(w * h)
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
          s += src[base + xx]
          c++
        }
      }
      out[y * w + x] = s / Math.max(1, c)
    }
  }
  return { gray: out, w, h, scale }
}

/** 用 sharp（libvips 原生）把单通道数组放大到指定尺寸，返回 Float32 */
async function upscaleGray(
  bytes: Uint8Array, w: number, h: number, tw: number, th: number,
): Promise<Float32Array> {
  // ⚠️ 必须 toColourspace('b-w')：libvips 会把单通道 b-w 图提升为 sRGB 三通道后再运算，
  //    直接 .raw() 会拿到 3 通道缓冲，按单通道索引取值会错位 3 倍（旧代码踩过，表现为整体偏色）。
  const buf = await sharp(bytes, { raw: { width: w, height: h, channels: 1 } })
    .toColourspace('b-w')
    .resize(tw, th, { kernel: 'cubic' })
    .raw()
    .toBuffer()
  const ch = (buf.length / (tw * th)) | 0 || 1
  const out = new Float32Array(tw * th)
  for (let i = 0; i < tw * th; i++) out[i] = buf[i * ch]
  return out
}

/* ==================== 形态学：可分离膨胀 / 腐蚀（O(n)） ==================== */

/**
 * 一维滑动窗口极值（单调队列，O(n)，与 r 无关）。
 *
 * ⚠️ `a` 与 `out` 必须是不同数组：写 `out[oi]` 时 oi < i，而队列里还持有
 *    ≤ i 的索引，同一数组会读到已被覆盖的值。
 * 窗口右端按「收缩窗口」处理（边缘处窗口变窄），形态学背景估计在边缘影响可忽略。
 */
function slideExtreme(a: Float32Array, len: number, r: number, out: Float32Array, isMax: boolean): void {
  if (r <= 0) {
    out.set(a.subarray(0, len))
    return
  }
  const dq = new Int32Array(len)
  let head = 0
  let tail = 0
  for (let i = 0; i < len; i++) {
    if (isMax) {
      while (tail > head && a[i] >= a[dq[tail - 1]]) tail--
    } else {
      while (tail > head && a[i] <= a[dq[tail - 1]]) tail--
    }
    dq[tail++] = i
    const oi = i - r
    if (oi >= 0) {
      const leftLim = oi - r
      while (dq[head] < leftLim) head++
      out[oi] = a[dq[head]]
    }
  }
  // 尾部：右端已到边界，窗口收缩
  for (let oi = Math.max(0, len - r); oi < len; oi++) {
    const leftLim = oi - r
    while (dq[head] < leftLim) head++
    out[oi] = a[dq[head]]
  }
}

/** 2D 可分离膨胀 / 腐蚀（矩形结构元，半径 r） */
function morphRect(src: Float32Array, w: number, h: number, r: number, isMax: boolean): Float32Array {
  const n1 = Math.max(w, h)
  const bufA = new Float32Array(n1)
  const bufB = new Float32Array(n1)
  const tmp = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const base = y * w
    for (let x = 0; x < w; x++) bufA[x] = src[base + x]
    slideExtreme(bufA, w, r, bufB, isMax)
    for (let x = 0; x < w; x++) tmp[base + x] = bufB[x]
  }
  const out = new Float32Array(w * h)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) bufA[y] = tmp[y * w + x]
    slideExtreme(bufA, h, r, bufB, isMax)
    for (let y = 0; y < h; y++) out[y * w + x] = bufB[y]
  }
  return out
}

/**
 * 闭运算 closing（膨胀 → 腐蚀）：填掉比结构元小的**暗**区域。
 *
 * 暗字亮底场景下，closing 把黑字填平 → 得到"无字背景"。
 * 若用 opening（min 在前）填掉的是亮区，会把字保留、把背景削掉 —— 正好做反。
 */
export function closing(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const dilated = morphRect(src, w, h, r, true)
  return morphRect(dilated, w, h, r, false)
}

/** 开运算 opening（腐蚀 → 膨胀）：填掉比结构元小的**亮**区域（白字黑底用） */
export function opening(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const eroded = morphRect(src, w, h, r, false)
  return morphRect(eroded, w, h, r, true)
}

/* ============================ P0-1 背景归一化 ============================ */

/** 背景估计工作图长边：光照梯度是低频，降采样做完全够（方案 §7.1） */
const BG_MAX_SIDE = 768
/** 结构元直径 / 字高。方案建议 1.5~3，取 2.5 兼顾"填得掉字"与"跟得上渐变" */
const SE_SCALE = 2.5

/**
 * 光照 / 背景归一化（Top-Hat 思路）。
 *
 *   bg   = closing(gray)            暗字亮底（或 opening，白字黑底）
 *   out  = gray − bg + targetLevel   背景被拉平到常数 targetLevel
 *
 * `flatten` 控制拉平程度：0 → 完全不动（out === 原图），1 → 完全拉平。
 *
 * @param medH 当前尺度下的字高（结构元尺寸的唯一依据）
 */
export async function normalizeBackgroundLuma(
  luma: Float32Array,
  W: number,
  H: number,
  opts: { medH: number; flatten: number; inkIsDark: boolean; levelStretch?: number },
): Promise<Float32Array> {
  const n = W * H
  const out = new Float32Array(n)
  if (opts.flatten <= 0 || !n) {
    out.set(luma)
    return out
  }

  // 极性统一：白字黑底先反相，走与暗字亮底完全同一条路，最后反相回来。
  // （比"两套算子"少一处出错机会，也保证 flatten 语义一致。）
  const invert = opts.inkIsDark === false
  const src = new Float32Array(n)
  if (invert) for (let i = 0; i < n; i++) src[i] = 255 - luma[i]
  else src.set(luma)

  const { gray, w, h, scale } = boxDownsample(src, W, H, BG_MAX_SIDE)
  const medHw = Math.max(4, opts.medH * scale)
  // SE 半径 = 直径/2；下限 3 防止极小字号退化成无操作
  const r = Math.round(clamp((SE_SCALE * medHw) / 2, 3, Math.min(w, h) / 4))
  const bg = closing(gray, w, h, r)

  // targetLevel：背景的"干净纸张白"。用高分位而非均值 —— 均值会被阴影拉低，
  // 拉平到均值等于把整页压暗，反而更"没修过"。
  const targetLevel = clamp(grayPercentile(bg, bg.length, 0.9), 190, 252)

  // 背景是低频 → 在工作尺度估好，升采样回原尺度（方案 §7.1）。
  // ⚠️ 升采样 **bg 本身**而不是 (targetLevel − bg) 的残差：残差可正可负且幅值
  //    可达 ±252，走 8bit 字节通道必须加偏移缩放，会引入截断误差；bg 本身恒在
  //    0..255，直接走字节通道无损。
  const bgUp = await upscaleGray(toGrayBytes(bg, w * h), w, h, W, H)
  for (let i = 0; i < n; i++) {
    // flatten=1 → out = src − bg + targetLevel（完全拉平到纸张白）
    // flatten=0 → out = src − bg + bg = src（完全不动）
    out[i] = clamp(src[i] + (targetLevel - bgUp[i]) * opts.flatten, 0, 255)
  }

  // 自动色阶：把灰度 p2/p98 拉到 0/255。背景拉平后仍可能整体发灰
  // （曝光不足 / 纸色偏黄），这一步是"和原图差别不大"的第二道解药。
  const ls = opts.levelStretch ?? 0
  if (ls > 0) {
    const lo = grayPercentile(out, n, 0.02)
    const hi = grayPercentile(out, n, 0.98)
    if (hi - lo > 24) {
      const a = 255 / (hi - lo)
      for (let i = 0; i < n; i++) {
        const stretched = clamp((out[i] - lo) * a, 0, 255)
        out[i] = clamp(out[i] + (stretched - out[i]) * ls, 0, 255)
      }
    }
  }

  if (invert) for (let i = 0; i < n; i++) out[i] = 255 - out[i]
  return out
}

/* ============================ P0-5 版面感知 ============================ */

/** 版面感知工作图长边 */
const LAYOUT_SIDE = 800

export interface ProtectMaskResult {
  /** 0..1 软掩膜，1 = 完全保护（不做局部对比增强/二值化） */
  mask: Float32Array | null
  /** 被判为非文字区的块数（诊断用） */
  blocks: number
}

/**
 * 判别「不是文字」的区域：插图 / 照片 / 几何图形 / 表格线。
 *
 * ── 为什么必须有这一步 ────────────────────────────────────────────────────
 * Sauvola / 二值化对**连续色调区域是破坏性的**：一张灰度几何图被局部阈值后会
 * 变成纯黑白块，中间调全部丢失；这与去手写"图形被当手写擦掉"是**同一类根因** ——
 * 算法不认识图片区。方案 P0-5 要求先做区域判别，只在文字区增强。
 *
 * ── P0 阶段的无模型判据（四条，任一命中即保护）─────────────────────────────
 *   ① 大块：bbox 宽高都 > 1.8×字高 且 面积 > (2.2×字高)²      → 插图 / 照片 / 大图形
 *   ② 实心：填充率 > 0.55 且 面积 > (1.5×字高)²                → 照片 / 色块 / 粗黑图
 *   ③ 长横线：宽 > 6×字高 且 高 < 0.5×字高                     → 表格线 / 边框
 *   ④ 长竖线：高 > 6×字高 且 宽 < 0.5×字高                     → 分栏线 / 边框
 *
 * 判据刻意**偏保守**（宁可多保护一块文字，也不能漏掉一张图），因为
 * 漏保护的代价是永久破坏，多保护的代价只是那一小块没被增强。
 *
 * @returns null 表示「没检出任何可疑区域」→ 调用方按全图文字处理
 */
export async function buildProtectMask(
  luma: Float32Array,
  W: number,
  H: number,
  metrics: CharMetrics,
): Promise<ProtectMaskResult> {
  const medH = metrics.medH
  if (!medH || medH <= 0) return { mask: null, blocks: 0 }
  const { gray, w, h, scale } = boxDownsample(luma, W, H, LAYOUT_SIDE)
  const n = w * h
  const bytes = toGrayBytes(gray, n)
  const thr = otsuThreshold(bytes, n)
  const ink = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    // 极性：暗字亮底取 <thr，白字黑底取 >thr
    ink[i] = metrics.inkIsDark ? (bytes[i] < thr ? 1 : 0) : (bytes[i] > thr ? 1 : 0)
  }
  const { comps } = connectedComponents(ink, w, h, false)

  const mh = Math.max(4, medH * scale)
  const bigArea = (2.2 * mh) ** 2
  const solidArea = (1.5 * mh) ** 2
  const maskLow = new Float32Array(n)
  let hits = 0
  const pad = Math.max(2, Math.round(mh * 0.6))

  // 中间调像素：不是 ink、但也明显比纸白暗 —— 灰色实心填充 / 照片 / 浅色插图。
  // ⚠️ 实测教训：灰色三角形填充（灰度 125~178）在 Otsu 后落在**背景**侧，
  //    几何图只剩细边线连通块，按 ink 像素数 n 判"大块"永远够不着门槛 → 漏保护。
  //    灰填充必须用"中间调密集度"单独捕捉。纸白参考取背景侧的 p85。
  const whiteRef = metrics.inkIsDark
    ? (() => {
        const hist = new Int32Array(256)
        const step = Math.max(1, Math.floor(n / 100000))
        let cnt = 0
        for (let i = 0; i < n; i += step) {
          if (bytes[i] > thr) {
            hist[bytes[i]]++
            cnt++
          }
        }
        let acc = 0
        for (let t = 0; t < 256; t++) {
          acc += hist[t]
          if (acc >= cnt * 0.85) return t
        }
        return 240
      })()
    : 255 - 60
  const midInk = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const v = bytes[i]
    if (metrics.inkIsDark) midInk[i] = v > thr && v < whiteRef - 28 ? 1 : 0
    else midInk[i] = v < thr && v > whiteRef + 28 ? 1 : 0
  }

  for (const c of comps) {
    const bw = c.x1 - c.x0 + 1
    const bh = c.y1 - c.y0 + 1
    const fill = c.n / (bw * bh)
    // 判据①（修正）：看 **bbox 面积**而不是 ink 像素数。细线几何图（三角形/圆）
    // 的 ink 像素少（周长×线宽），按 n 判永远漏检；但其**包络**一定是"宽高都远超
    // 字高的方块"。宽高双重条件保证不会误伤"宽而扁的一行字"。
    const big = bw > 1.8 * mh && bh > 1.8 * mh && bw * bh > bigArea
    const solid = fill > 0.55 && c.n > solidArea
    const hLine = bw > 6 * mh && bh < 0.5 * mh
    const vLine = bh > 6 * mh && bw < 0.5 * mh
    // 判据⑤：bbox 内中间调像素密集（≥35%）→ 连续色调区（灰填充/照片/渐变图）
    let midCnt = 0
    if (bh > 1.8 * mh && bw > 1.8 * mh) {
      for (let y = c.y0; y <= c.y1; y++) {
        const base = y * w
        for (let x = c.x0; x <= c.x1; x++) midCnt += midInk[base + x]
      }
    }
    const midtone = midCnt > bw * bh * 0.35
    if (!(big || solid || hLine || vLine || midtone)) continue
    hits++
    const x0 = Math.max(0, c.x0 - pad)
    const x1 = Math.min(w - 1, c.x1 + pad)
    const y0 = Math.max(0, c.y0 - pad)
    const y1 = Math.min(h - 1, c.y1 + pad)
    for (let y = y0; y <= y1; y++) {
      const base = y * w
      for (let x = x0; x <= x1; x++) maskLow[base + x] = 1
    }
  }
  if (!hits) return { mask: null, blocks: 0 }

  // 羽化：靠放大插值天然获得 0..1 过渡，避免增强区与保护区出现硬边接缝
  const bytes2 = new Uint8Array(n)
  for (let i = 0; i < n; i++) bytes2[i] = maskLow[i] > 0 ? 255 : 0
  const buf = await sharp(bytes2, { raw: { width: w, height: h, channels: 1 } })
    .toColourspace('b-w')
    .resize(W, H, { kernel: 'cubic' })
    .raw()
    .toBuffer()
  const chn = (buf.length / (W * H)) | 0 || 1
  const mask = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) {
    const v = buf[i * chn] / 255
    mask[i] = v > 0.02 ? v : 0
  }
  return { mask, blocks: hits }
}

/* ==================== P0-3 积分图 + P0-2/P1 局部统计 ==================== */

/** 每块积分图允许的像素上限（两条 Float64 积分图 → 约 24MB 峰值） */
const TILE_MAX_PIXELS = 1_500_000

/**
 * 对每个像素调用 fn(v, mean, sigma, i)，写入 out。
 *
 * 局部均值/方差走**双积分图 O(1) 查询**（P0-3）：逐像素 O(win²) 在窗口 50~80 时
 * 是 2500~6400 次乘加/像素，Node 单线程下完全不可用；积分图降到常数次。
 *
 * 分块（tile）**必须带 halo ≥ 窗口半径**（方案 §7.1）：否则块边界的局部统计
 * 会突然截断，在增强图上表现为一条明显的横向接缝。
 */
function mapLocalStats(
  src: Float32Array,
  W: number,
  H: number,
  win: number,
  fn: (v: number, mean: number, sigma: number, i: number) => number,
  out?: Float32Array,
): Float32Array {
  const dst = out ?? new Float32Array(W * H)
  const r = win >> 1
  const tileH = Math.max(win * 2, Math.min(H, Math.ceil(TILE_MAX_PIXELS / Math.max(1, W))))
  const stride = W + 1
  for (let y0 = 0; y0 < H; y0 += tileH) {
    const ya = Math.max(0, y0 - r)
    const yb = Math.min(H, y0 + tileH + r)
    const hh = yb - ya
    if (hh <= 0) continue
    const sum = new Float64Array((hh + 1) * stride)
    const sumSq = new Float64Array((hh + 1) * stride)
    for (let ly = 0; ly < hh; ly++) {
      const srcBase = (ya + ly) * W
      const oCur = (ly + 1) * stride
      const oPrev = ly * stride
      let rowSum = 0
      let rowSq = 0
      for (let x = 0; x < W; x++) {
        const v = src[srcBase + x]
        rowSum += v
        rowSq += v * v
        sum[oCur + x + 1] = sum[oPrev + x + 1] + rowSum
        sumSq[oCur + x + 1] = sumSq[oPrev + x + 1] + rowSq
      }
    }
    const yEnd = Math.min(H, y0 + tileH)
    for (let y = y0; y < yEnd; y++) {
      const ly = y - ya
      const ty0 = Math.max(0, ly - r)
      const ty1 = Math.min(hh - 1, ly + r)
      const o0 = ty0 * stride
      const o1 = (ty1 + 1) * stride
      const cntY = ty1 - ty0 + 1
      for (let x = 0; x < W; x++) {
        const tx0 = x - r > 0 ? x - r : 0
        const tx1 = x + r < W - 1 ? x + r : W - 1
        const a = sum[o1 + tx1 + 1]
        const b = sum[o0 + tx1 + 1]
        const c = sum[o1 + tx0]
        const d = sum[o0 + tx0]
        const cnt = (tx1 - tx0 + 1) * cntY
        const mean = (a - b - c + d) / cnt
        const sa = sumSq[o1 + tx1 + 1]
        const sb = sumSq[o0 + tx1 + 1]
        const sc = sumSq[o1 + tx0]
        const sd = sumSq[o0 + tx0]
        const sqMean = (sa - sb - sc + sd) / cnt
        const varr = sqMean - mean * mean
        const sigma = varr > 0 ? Math.sqrt(varr) : 0
        const i = y * W + x
        dst[i] = fn(src[i], mean, sigma, i)
      }
    }
  }
  return dst
}

/** Sauvola 阈值：T = μ·(1 + k·(σ/R − 1))。R=128（8bit 标准） */
function sauvolaT(mean: number, sigma: number, k: number, R = 128): number {
  return mean * (1 + k * (sigma / R - 1))
}

/**
 * P0-2 局部对比**软**增强（默认模式）。
 *
 * 为什么是软映射而不是硬二值化：
 *   硬二值化（0/255）对比最强，但**丢失全部灰阶** —— 对照片、图表、彩色插图是破坏性的。
 *   软映射用 smoothstep 在阈值附近构造过渡带：文字端推向黑、背景端推向白，
 *   过渡带宽度随局部 σ 自适应 → 观感接近二值化，却保留中间调。
 *
 * 过渡带半宽 `softWidth = max(softMin, σ × softK)`：
 *   σ 大（笔画密集区）→ 过渡带宽 → 保留笔画内部的灰度层次；
 *   σ 小（平坦背景）  → 过渡带窄 → 快速推到白，正是"背景拉白"要的效果。
 *
 * `blend` 是与原图的混合比，也是**保留灰阶的旋钮**：blend=1 接近二值化，0 = 不动。
 */
export function localContrastEnhance(
  luma: Float32Array,
  W: number,
  H: number,
  opts: {
    win: number
    k: number
    blend: number
    protect?: Float32Array | null
    lo?: number
    hi?: number
    softMin?: number
    softK?: number
  },
): Float32Array {
  const { win, k, blend, protect } = opts
  const lo = opts.lo ?? 6
  const hi = opts.hi ?? 249
  const softMin = opts.softMin ?? 16
  const softK = opts.softK ?? 1.6
  const span = hi - lo
  return mapLocalStats(luma, W, H, win, (v, mean, sigma, i) => {
    const p = protect ? protect[i] : 0
    const b = p > 0 ? blend * (1 - p) : blend
    if (b <= 0) return v
    const T = sauvolaT(mean, sigma, k)
    const sw = Math.max(softMin, sigma * softK)
    let u = (v - T) / (2 * sw) + 0.5
    if (u < 0) u = 0
    else if (u > 1) u = 1
    // smoothstep：一阶导连续，避免过渡带边界出现可见条带
    const s = u * u * (3 - 2 * u)
    const target = lo + span * s
    const out = v + (target - v) * b
    return out < 0 ? 0 : out > 255 ? 255 : out
  })
}

/**
 * P1「黑白」模式：Sauvola **硬**二值化。
 *
 * 只在用户显式选择时启用；保护区内保持原灰阶（不破坏插图/照片）。
 */
export function binarizeSauvola(
  luma: Float32Array,
  W: number,
  H: number,
  opts: { win: number; k: number; protect?: Float32Array | null; lo?: number; hi?: number },
): Float32Array {
  const { win, k, protect } = opts
  const lo = opts.lo ?? 0
  const hi = opts.hi ?? 255
  return mapLocalStats(luma, W, H, win, (v, mean, sigma, i) => {
    const p = protect ? protect[i] : 0
    if (p > 0.5) return v
    return v < sauvolaT(mean, sigma, k) ? lo : hi
  })
}

/* ============================ P0.5 自适应锐化 ============================ */

/**
 * 自适应非锐化掩膜。
 *
 * 与旧实现（`sharpen({sigma: 1.4, ...})` 固定参数）的三点区别：
 *   ① **sigma 自适应**：`sigma ≈ 笔画宽 / 2`。sigma 过小只锐噪声，过大产生光晕；
 *      笔画宽来自共用度量，字号一变就跟着变（旧实现对小字号过度锐化、对大字号几乎无效）。
 *   ② **局部梯度软门控**：只在真正有梯度的地方加锐化，平坦区（背景/纸纹）不动，
 *      避免"把纸纹和噪点一起锐出来"。用软门控而非 Canny —— 更廉价且不引入双阈值调参。
 *   ③ **限幅防光晕**：`|v − blur|` 被 clamp 到 haloLimit，杜绝白边过冲。
 *
 * ⚠️ 顺序说明：方案 §四 管线把锐化写在对比增强**之前**，但 P0.5 拆分理由里又说
 *    "锐化参数需匹配对比增强之后的图像"。这里统一为 **对比增强 → 锐化**，理由：
 *    增强后的边缘更陡峭，梯度门控因此更准；且锐化产生的小过冲不会被随后的
 *    对比拉伸再放大一次。二值化（bw）永远在最后。
 */
export async function adaptiveSharpen(
  luma: Float32Array,
  W: number,
  H: number,
  opts: { sigma: number; amount: number; haloLimit?: number },
): Promise<Float32Array> {
  const n = W * H
  if (opts.amount <= 0 || n === 0) return Float32Array.from(luma)
  const sigma = clamp(opts.sigma, 0.4, 4)
  const halo = opts.haloLimit ?? 36

  // 高斯模糊走 libvips 原生（方案 §7.1：重算子交给原生扩展，不要纯 JS 循环）
  const bytes = toGrayBytes(luma, n)
  const buf = await sharp(bytes, { raw: { width: W, height: H, channels: 1 } })
    .toColourspace('b-w')
    .blur(sigma)
    .raw()
    .toBuffer()
  const ch = (buf.length / n) | 0 || 1

  // 先扫一遍梯度，取 p90 作门控参考（自适应：不同清晰度/对比度的图自动定标）
  const grad = new Float32Array(n)
  let gmax = 0
  for (let y = 0; y < H; y++) {
    const base = y * W
    const up = y > 0 ? base - W : base
    const dn = y < H - 1 ? base + W : base
    for (let x = 0; x < W; x++) {
      const xl = x > 0 ? x - 1 : x
      const xr = x < W - 1 ? x + 1 : x
      const gx = luma[base + xr] - luma[base + xl]
      const gy = luma[dn + x] - luma[up + x]
      const g = Math.abs(gx) + Math.abs(gy)
      grad[base + x] = g
      if (g > gmax) gmax = g
    }
  }
  const sample: number[] = []
  const step = Math.max(1, Math.floor(n / 100000))
  for (let i = 0; i < n; i += step) sample.push(grad[i])
  sample.sort((a, b) => a - b)
  const gRef = Math.max(8, quantileSorted(sample, 0.9))

  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const v = luma[i]
    let d = v - buf[i * ch]
    if (d > halo) d = halo
    else if (d < -halo) d = -halo
    let gate = grad[i] / gRef
    if (gate > 1) gate = 1
    let o = v + opts.amount * gate * d
    if (o < 0) o = 0
    else if (o > 255) o = 255
    out[i] = o
  }
  return out
}

/* ============================ 顶层编排 ============================ */

/**
 * 文档增强主入口：在**亮度通道**上完成 P0 → P0.5 → P1。
 *
 * 调用方（image-superres.enhanceImage）负责 YCbCr 分离与重组；
 * 这里只处理亮度，色度不受影响 —— 与 ESPCN「人眼对亮度最敏感」的设计一致，
 * 也保证增强不会引入色偏。
 */
export async function enhanceDocumentLuma(
  luma: Float32Array,
  W: number,
  H: number,
  opts: DocEnhanceOptions = {},
): Promise<DocEnhanceResult> {
  const preset = opts.preset === 'original' || opts.preset === 'bw' ? opts.preset : 'enhance'
  const strengthIn =
    opts.strength === 'weak' || opts.strength === 'strong' ? opts.strength : 'medium'
  const tuning = tuningFor(strengthIn)
  const debug: Record<string, unknown> = opts.debug ?? {}
  const t0 = Date.now()

  // —— P0-4 自适应参数：全部由字符度量驱动 ——
  // metrics 未提供时在位估计（调用方应在超分后的尺度上量，窗口才是笔画级的）
  const metrics =
    opts.metrics && opts.metrics.medH > 0
      ? opts.metrics
      : estimateCharMetricsFromLuma(luma, W, H)
  debug.metrics = {
    medH: +metrics.medH.toFixed(2),
    strokeWidth: +metrics.strokeWidth.toFixed(2),
    rowPitch: +metrics.rowPitch.toFixed(2),
    inkIsDark: metrics.inkIsDark,
    confidence: +metrics.confidence.toFixed(2),
    charCount: metrics.charCount,
    rowCount: metrics.rowCount,
  }
  debug.preset = preset
  debug.strength = strengthIn

  // 度量不可信时回退固定参数：窗口取文献常用值 31，SE 半径随之中等
  const medH = metrics.medH > 0 ? metrics.medH : 14
  // 窗口 = 2.5 × 字高（方案 §五：窗口 ≈ 2~3× 字高）
  //
  // ⚠️ 上限为什么不能是常数（实测换来的）：x2 超分后字高 56，理想窗口 141；
  //    但 x4 超分后字高 111，理想窗口 277 —— 若沿用固定上限 121，窗口/字高会掉到
  //    1.09×，**直接失守 2~3× 字高的设计要求**（窗口相对太小 → 局部方差不稳、
  //    笔画内部被误判成背景）。故上限改为随图幅走：min(W,H)/6，
  //    既保证大图放得开，也不会让 halo 吃掉整块 tile（见 mapLocalStats 的分块策略）。
  const winMax = Math.max(11, Math.min(321, Math.min(W, H) / 6))
  const win = (Math.round(clamp(medH * 2.5, 11, winMax)) | 1) as number
  debug.win = win

  if (preset === 'original') {
    debug.stage = 'original'
    return { luma: Float32Array.from(luma), width: W, height: H, metrics, debug }
  }

  // ① 背景归一化（低频 → 降采样做，方案 §7.1）
  const t1 = Date.now()
  let cur = luma
  if (opts.preNormalized !== true) {
    cur = await normalizeBackgroundLuma(luma, W, H, {
      medH,
      flatten: tuning.flatten,
      inkIsDark: metrics.inkIsDark,
      levelStretch: tuning.levelStretch,
    })
  }
  debug.msNormalize = Date.now() - t1

  // ② P0-5 版面感知：先判区域，再决定"哪里能增强"
  const t2 = Date.now()
  const pm = await buildProtectMask(cur, W, H, { ...metrics, medH })
  const protect = pm.mask
  debug.protectBlocks = pm.blocks
  debug.msLayout = Date.now() - t2

  // ③ P0-2 局部对比软增强（高频 → 原尺度 + 积分图）
  const t3 = Date.now()
  cur = localContrastEnhance(cur, W, H, {
    win,
    k: tuning.k,
    blend: tuning.blend,
    protect,
  })
  debug.msContrast = Date.now() - t3

  // ④ P0.5 自适应锐化（sigma ≈ 笔画宽/2）
  const t4 = Date.now()
  const sigma = clamp((metrics.strokeWidth > 0 ? metrics.strokeWidth : medH / 8) / 2, 0.5, 3)
  debug.sharpenSigma = +sigma.toFixed(2)
  cur = await adaptiveSharpen(cur, W, H, { sigma, amount: tuning.sharpenAmount })
  debug.msSharpen = Date.now() - t4

  // ⑤ P1 黑白模式：硬二值化（永远最后）
  if (preset === 'bw') {
    const t5 = Date.now()
    cur = binarizeSauvola(cur, W, H, { win, k: 0.2, protect })
    debug.msBinarize = Date.now() - t5
  }

  debug.msTotal = Date.now() - t0
  return { luma: cur, width: W, height: H, metrics, debug }
}
