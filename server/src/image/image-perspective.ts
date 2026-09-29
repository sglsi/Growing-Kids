import sharp from 'sharp'
import { dewarpBuffer, type Corner } from './image-dewarp'
import { connectedComponents, otsuThreshold, metricsFromGray, type CharMetrics } from './image-layout'

/**
 * 【自动调正 · 透视残留校正（无纸边场景）】
 *
 * ── 为什么需要这一层 ──────────────────────────────────────────────────────
 * 手机拍试卷最常见的形态是**纸面占满整个画面**。此时画面里根本没有纸张轮廓，
 * `image-corners.detectCornersCV` 恒不命中（实测 5/5 未命中），只剩 deskew 兜底。
 *
 * 而 deskew 是**旋转模型**：它只问「整体歪了多少度」，判据 |rotateDeg| < 0.3° 就放弃。
 * 真实拍照却常常是——整体并不歪（μ≈0°）但**各行互不平行**（实测 σ=1.32°、极差 4.0°）。
 * 这是**透视**（相机偏航）的指纹，旋转原理上修不了 → 功能「点了没反应」。
 *
 * ── 领域依据 ──────────────────────────────────────────────────────────────
 * 倾斜估计的三大经典法（Projection Profile / Hough / Nearest-Neighbour）**都是旋转
 * 模型**，综述明确指出它们无法处理透视——透视破坏了文本行之间的平行性。
 * 无文档边界（HDB）时，领域的可行路线是把**文本行本身**当线索：
 *   · Dance / Clark：双消失点（水平来自文本行、垂直来自段落边距 VPM）
 *   · Kim et al.：把文本行编码为代价函数（行直度 / 行距），LM 求解
 * 本模块取它们的工程化核心：**行的方向给出水平消失点，行的左右端点给出垂直边界**，
 * 由四条边界直线求交得到内容四角，再复用已修好的 dewarpBuffer 压平。
 *
 * ── 设计要点（每一条都是实测换来的）────────────────────────────────────────
 * ① **触发条件只能是「行是否互相平行」，不能是「左右边界是否收敛」**。
 *    后者假设斜的一定是左右边，实测侧拍场景里左右边是垂直的、真正斜的是上下边，
 *    于是只测出 0.76px 收敛就误判为无需修正（σ 仍有 1.32°）。
 *    σ（各行倾角的标准差）才是透视的直接指纹：旋转模型下 σ 恒≈0。
 * ② **四条边都要拟合，不能预设哪条斜**（同上）。
 * ③ **必须做结果自检并回退**：估计出的四角来自内容包络，不等于真实纸角，
 *    宁可不做也不可做错 —— 校正后重新测 σ，没改善就原样返回。
 * ④ 旋转先行（coarse-to-fine）：调用方应先 deskew 掉整体旋转，
 *    剩下的 σ 才干净地代表透视。
 */

/** 行检测与估计的最大长边（限制 BFS 成本） */
const EST_MAX_SIDE = 800
/** 行不平行度阈值（度）：低于此值认为没有透视残留。噪声地板实测 0.02°，留 20× 余量 */
export const PERSPECTIVE_MIN_STD_DEG = 0.4
/** 至少需要的文本行数 */
const MIN_ROWS = 3

export interface TextRowInfo {
  /** 行直线的斜率（y = k·x + b） */
  k: number
  b: number
  /** 行在图像中的左右端点 x */
  xL: number
  xR: number
  /** 行中心的 y */
  yc: number
}

export interface PerspectiveFixResult {
  buffer: Buffer
  width: number
  height: number
  corners: Corner[]
  /** 校正前的行不平行度（度） */
  beforeStd: number
  /** 校正后的行不平行度（度） */
  afterStd: number
}

/** detectTextRows 的返回类型（v3：补充字符度量，供智能高清 / 去手写复用） */
export interface TextRowsResult {
  rows: TextRowInfo[]
  width: number
  height: number
  scale: number
  /**
   * 估计的字身高度（**原图尺度像素**）。
   *
   * ⭐ 方案 P0-前置改造：这个值此前在函数内部算出却没有导出，
   *    导致「字高」这个全项目唯一的自适应参数来源无从获取。
   *    现与 `image-layout.ts` 的共用基座对齐导出（同一张图在任何功能里量出的字高是同一个数）。
   *    为 0 表示版面度量失败，调用方应回退固定参数。
   */
  medH: number
  /** 完整字符度量（含笔画宽 / 行距 / 极性 / 置信度）。medH 即 metrics.medH */
  metrics: CharMetrics
}

/**
 * 连通分量（8-连通 BFS）→ 过滤噪点 → 按质心 y 聚类成文本行。
 * 返回每行的最小二乘直线（k,b）与左右端点，以及字符度量。
 *
 * ⚠️ 行切分的判据与阈值**保持原样不动**（自动调正刚修好"放大裁切一块"，
 *    这里只做「抽公共代码 + 把 medH 导出」，不改任何数值行为）。
 */
export async function detectTextRows(
  buf: Buffer,
  opts: { maxSide?: number } = {},
): Promise<TextRowsResult> {
  const meta = await sharp(buf).metadata()
  const W0 = meta.width || 0
  const H0 = meta.height || 0
  if (!W0 || !H0) {
    return {
      rows: [], width: 0, height: 0, scale: 1, medH: 0,
      metrics: {
        medH: 0, strokeWidth: 0, rowPitch: 0, inkIsDark: true,
        confidence: 0, scale: 1, charCount: 0, rowCount: 0,
      },
    }
  }
  const maxSide = opts.maxSide ?? EST_MAX_SIDE
  const scale = Math.min(1, maxSide / Math.max(W0, H0))
  const w = Math.max(1, Math.round(W0 * scale))
  const h = Math.max(1, Math.round(H0 * scale))
  const gray = await sharp(buf).resize(w, h, { fit: 'fill' }).grayscale().raw().toBuffer()
  const grayU8 = new Uint8Array(gray.buffer, gray.byteOffset, gray.length)

  // Otsu 二值化 + 8-连通分量：复用 image-layout 的共用实现（与旧代码等价）
  const thr = otsuThreshold(grayU8, w * h)
  const ink = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) ink[i] = grayU8[i] < thr ? 1 : 0
  const { comps } = connectedComponents(ink, w, h, false)

  // 过滤：噪点太小、横跨全图的横线/阴影、过高的块
  const heights = comps.map((c) => c.y1 - c.y0).sort((a, b) => a - b)
  const medH = heights[heights.length >> 1] || 10
  const blocks = comps.filter(
    (c) => c.n >= 8 && c.x1 - c.x0 < w * 0.9 && c.y1 - c.y0 < Math.max(medH * 3, h * 0.3),
  )
  const emptyMetrics: CharMetrics = {
    medH: 0, strokeWidth: 0, rowPitch: 0, inkIsDark: true,
    confidence: 0, scale, charCount: blocks.length, rowCount: 0,
  }
  if (blocks.length < 4) return { rows: [], width: w, height: h, scale, medH: 0, metrics: emptyMetrics }

  // 按质心 y 排序 → 按间隙切行（间隙尺度用块高中位数，抗行距变化）
  const sorted = blocks.slice().sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2)
  const groups: typeof sorted[] = [[sorted[0]]]
  for (let i = 1; i < sorted.length; i++) {
    const prev = groups[groups.length - 1]
    const prevY = (prev[prev.length - 1].y0 + prev[prev.length - 1].y1) / 2
    const y = (sorted[i].y0 + sorted[i].y1) / 2
    if (y - prevY > medH * 1.2) groups.push([sorted[i]])
    else prev.push(sorted[i])
  }

  const rows: TextRowInfo[] = []
  for (const g of groups) {
    const xL = Math.min(...g.map((b) => b.x0))
    const xR = Math.max(...g.map((b) => b.x1))
    if (xR - xL < w * 0.15) continue // 过短的行（孤立噪点/符号）不参与
    const pts = g.map((b) => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2] as [number, number])
    const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length
    const my = pts.reduce((s, p) => s + p[1], 0) / pts.length
    let num = 0, den = 0
    for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2 }
    const k = den < 1e-9 ? 0 : num / den
    rows.push({ k, b: my - k * mx, xL, xR, yc: my })
  }
  // 字符度量走**共用基座**的权威实现（含行距交叉校验，修正中文部件导致的系统性偏小）。
  // 注意：上面行切分用的仍是本地 medH（旧行为），刻意不改 —— 自动调正刚修好
  // "放大裁切一块"，此处只做「抽公共代码 + 导出度量」，不碰任何切分判据。
  const metrics = metricsFromGray(grayU8, w, h, scale)
  return { rows, width: w, height: h, scale, medH: metrics.medH, metrics }
}

/** 中位数 */
function median(a: number[]): number {
  if (!a.length) return 0
  const s = a.slice().sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** 最小二乘拟合 y = a·x + b */
function linreg(pts: [number, number][]): { a: number; b: number } {
  const n = pts.length
  if (!n) return { a: 0, b: 0 }
  const mx = pts.reduce((s, p) => s + p[0], 0) / n
  const my = pts.reduce((s, p) => s + p[1], 0) / n
  let num = 0, den = 0
  for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2 }
  const a = den < 1e-9 ? 0 : num / den
  return { a, b: my - a * mx }
}

/**
 * 行方向的**稳健**模型：k 随行位置 y 线性变化（透视下正是如此）。
 *
 * ⚠️ 为什么必须稳健（实测换来的）：手写笔画本身歪歪扭扭，混排时它会被切成
 *    独立"行"，其倾角是**手写的随机走向**而非纸的几何走向。
 *    若直接拿首末行当上下边界，四角就跟着手写的随机性跑 ——
 *    内部自检甚至会误报"已改善"（2.21°→0.95°），而独立测量显示实际恶化到 4.92°。
 *    这里用 MAD 迭代剔除离群行，只留下服从同一透视模型的行。
 */
function robustRowModel(rows: TextRowInfo[]): { a: number; b: number; used: TextRowInfo[] } {
  let used = rows
  let fit = linreg(rows.map((r) => [r.yc, r.k] as [number, number]))
  for (let iter = 0; iter < 3; iter++) {
    const res = used.map((r) => Math.abs(r.k - (fit.a * r.yc + fit.b)))
    const med = median(res)
    const mad = median(res.map((v) => Math.abs(v - med))) * 1.4826
    // 容差下限 0.0017 rad ≈ 0.1°，避免在行本来就平行时把正常抖动当离群
    const tol = med + Math.max(2.5 * mad, 0.0017)
    const next = used.filter((_, i) => res[i] <= tol)
    if (next.length < 3 || next.length === used.length) break
    used = next
    fit = linreg(used.map((r) => [r.yc, r.k] as [number, number]))
  }
  return { a: fit.a, b: fit.b, used }
}

/** 各行倾角（度）的标准差 —— 透视畸变的直接指纹。 */
export function rowParallelStd(rows: TextRowInfo[]): number {
  if (rows.length < 2) return 0
  const angles = rows.map((r) => (Math.atan(r.k) * 180) / Math.PI)
  const mean = angles.reduce((s, v) => s + v, 0) / angles.length
  return Math.sqrt(angles.reduce((s, v) => s + (v - mean) ** 2, 0) / angles.length)
}

/**
 * 稳健版行不平行度：先剔除离群行再统计。
 * 手写混排时直接统计全部行会被手写的随机走向污染，导致"看起来该修、修完更糟"。
 */
export function robustRowParallelStd(rows: TextRowInfo[]): number {
  return rowParallelStd(robustRowModel(rows).used)
}

/** 线性回归 x = f(y) */
function fitXOfY(pts: [number, number][]): (y: number) => number {
  const n = pts.length
  const my = pts.reduce((s, p) => s + p[1], 0) / n
  const mx = pts.reduce((s, p) => s + p[0], 0) / n
  let num = 0, den = 0
  for (const [x, y] of pts) { num += (y - my) * (x - mx); den += (y - my) ** 2 }
  const a = den < 1e-9 ? 0 : num / den
  return (y: number) => mx + a * (y - my)
}

/**
 * 由文本行包络估计内容四角 [tl,tr,br,bl]。
 *
 * 四条边**各自拟合**再求交：左右边来自各行端点，上下边来自首末行的行直线
 * 沿法向平移半行高。不预设哪条边是斜的（见文件头设计要点 ②）。
 */
/**
 * 剔除手写行，只保留印刷正文行。
 *
 * 依据（领域里的 VPM / 版面线索思想）：印刷正文**按栏排版、横跨页面**，
 * 手写批注则长短随性、明显更短。实测这一步是"手写混排时还能估准四角"的关键——
 * 少它的话，手写的随机走向会混进包络，四角偏掉，印刷行虽被摆平、整图却被拉歪
 * （外部独立测量 1.53° → 3.09°，而只统计印刷行的内部自检还误报"已改善"）。
 *
 * ⚠️ 关键修复（修复"自动调正放大并裁切一块"）：
 *    旧实现用「宽度 < 0.6×**最宽行**」做全局阈值。但**透视（keystone）下，离相机远的
 *    远端行本就更窄**——它们被误判为手写短行整批删除，导致 `used` 的首/末行从"页面
 *    顶/底边"塌缩到"内容中段"，`cornersFromTextRows` 据此估出的四角只覆盖内容内部一小块，
 *    `dewarpBuffer` 把这一小块放大铺满整图 → 用户看到"放大并裁切一块"。透视越强删得越多，
 *    恰好在最需要纠偏时出错。
 *    现改为：① 阈值锚定**中位数宽度**（抗单条超宽标题行的干扰）并放宽到 0.35；
 *            ② **强制保留最上、最下两行**——包络锚点绝不允许塌缩到内容内部。
 */
function filterPrintRows(rows: TextRowInfo[]): TextRowInfo[] {
  if (rows.length < MIN_ROWS) return rows
  const widths = rows.map((r) => r.xR - r.xL)
  const sorted = [...widths].sort((a, b) => a - b)
  const medW = sorted[sorted.length >> 1] || 1
  const minW = medW * 0.35
  // 按 yc 排序，强制保留真正的最上 / 最下两行（包络锚点）
  const idxByYc = rows.map((_, i) => i).sort((a, b) => rows[a].yc - rows[b].yc)
  const keepTop = idxByYc[0]
  const keepBot = idxByYc[idxByYc.length - 1]
  const keep = rows.filter(
    (r, i) => i === keepTop || i === keepBot || r.xR - r.xL >= minW,
  )
  return keep.length >= MIN_ROWS ? keep : rows
}

export function cornersFromTextRows(rows: TextRowInfo[], w: number, h: number): Corner[] | null {
  if (rows.length < MIN_ROWS) return null
  // ① 先按行宽剔掉手写行 ② 再用 MAD 剔掉剩余离群行
  const { a, b: kb, used } = robustRowModel(filterPrintRows(rows))
  if (used.length < MIN_ROWS) return null
  const at = (r: TextRowInfo, x: number) => r.k * x + r.b
  const L = fitXOfY(used.map((r) => [r.xL, at(r, r.xL)] as [number, number]))
  const R = fitXOfY(used.map((r) => [r.xR, at(r, r.xR)] as [number, number]))

  const gaps: number[] = []
  for (let i = 1; i < used.length; i++) gaps.push(used[i].yc - used[i - 1].yc)
  gaps.sort((x, y) => x - y)
  const halfH = (gaps[gaps.length >> 1] || 80) * 0.5
  // 上下边界的**方向**由稳健模型外推得到，不用首末行的实测 k
  const kTop = a * (used[0].yc - halfH) + kb
  const kBot = a * (used[used.length - 1].yc + halfH) + kb
  const topB = used[0].b - halfH * Math.sqrt(1 + kTop ** 2)
  const botB = used[used.length - 1].b + halfH * Math.sqrt(1 + kBot ** 2)

  // 求「y = k·x + b」与「x = xOfY(y)」的交点：不动点迭代，几步即收敛
  const meet = (k: number, b: number, xOfY: (y: number) => number, y0: number): [number, number] => {
    let y = y0
    for (let i = 0; i < 12; i++) y = k * xOfY(y) + b
    return [xOfY(y), y]
  }
  const clampX = (v: number) => Math.max(0, Math.min(w - 1, v))
  const clampY = (v: number) => Math.max(0, Math.min(h - 1, v))
  const yTop = used[0].yc
  const yBot = used[used.length - 1].yc
  const tl = meet(kTop, topB, L, yTop)
  const tr = meet(kTop, topB, R, yTop)
  const br = meet(kBot, botB, R, yBot)
  const bl = meet(kBot, botB, L, yBot)
  return [
    [clampX(tl[0]), clampY(tl[1])],
    [clampX(tr[0]), clampY(tr[1])],
    [clampX(br[0]), clampY(br[1])],
    [clampX(bl[0]), clampY(bl[1])],
  ]
}

/**
 * 顶层入口：检测透视残留并校正。
 *
 * @returns null 表示「没有可信的透视残留」或「校正后没有改善」——调用方应保持原样。
 */
export async function fixPerspectiveFromText(
  buf: Buffer,
  opts: { minStdDeg?: number } = {},
): Promise<PerspectiveFixResult | null> {
  const minStd = opts.minStdDeg ?? PERSPECTIVE_MIN_STD_DEG
  const first = await detectTextRows(buf)
  if (first.rows.length < MIN_ROWS) return null
  // 触发条件用**稳健**统计（剔掉手写行），否则手写的随机走向会虚报"有透视"
  const beforeStd = robustRowParallelStd(first.rows)
  if (beforeStd <= minStd) return null
  // 但自检基线用**全部行**：见下方说明，只看保留行会看不见"手写被拉歪"
  const beforeAll = rowParallelStd(first.rows)

  const quad = cornersFromTextRows(first.rows, first.width, first.height)
  if (!quad) return null
  // 四角在缩小图上得到，按比例还原到原图坐标
  const corners = quad.map(([x, y]) => [x / first.scale, y / first.scale] as Corner)

  // 几何护栏：内容包络估出的四角若过分畸形 / 塌缩成内容内部一小块，
  // 说明行检测不可信，此时宁可放弃——射影变换一旦搞错就是全图拉坏。
  // ⚠️ 用**缩小图坐标**的 quad 计算面积（与 imgArea 同尺度），修复旧实现
  //    用 original 坐标 quad 与 downsampled 的 imgArea 混比（尺度错配）的 bug。
  const quadArea = Math.abs(
    quad.reduce((s, p, i) => {
      const q = quad[(i + 1) % 4]
      return s + (p[0] * q[1] - q[0] * p[1])
    }, 0) / 2,
  )
  const imgArea = first.width * first.height
  // ① 面积过小的畸形四边形直接放弃
  if (quadArea < imgArea * 0.25) return null
  // ② 包络 bbox 必须覆盖画面足够比例：防止"四角塌缩到内容内部"被放大铺满
  //    （即用户反馈的"自动调正放大并裁切一块"）。正常满幅页面 bbox 占比≈0.6~0.95。
  const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1])
  const bx0 = Math.min(...xs), bx1 = Math.max(...xs)
  const by0 = Math.min(...ys), by1 = Math.max(...ys)
  const bboxArea = (bx1 - bx0) * (by1 - by0)
  if (bboxArea < imgArea * 0.5) return null

  let warped
  try {
    warped = await dewarpBuffer(buf, corners)
  } catch {
    return null
  }
  // 结果自检：没改善就回退（宁可不做，不可做错）
  //
  // ⚠️ 自检必须看**全部行**，不能只看稳健模型保留下来的那些行。
  //    实测事故：手写混排时，四角被手写的随机走向带偏 → 变换把印刷行摆平了
  //    （保留行 std 2.21°→1.02°，自检"通过"），整图却被拉歪
  //    （全部行独立测量 1.53°→3.09°，实际是修坏了）。
  //    只看保留行等于对"手写区域被拉坏"完全失明。
  const after = await detectTextRows(warped.buffer)
  const afterAll = after.rows.length >= MIN_ROWS ? rowParallelStd(after.rows) : beforeAll
  const afterStd = after.rows.length >= MIN_ROWS ? robustRowParallelStd(after.rows) : beforeStd
  if (afterAll >= beforeAll || afterStd >= beforeStd) return null

  return {
    buffer: warped.buffer,
    width: warped.width,
    height: warped.height,
    corners: warped.orderedCorners,
    beforeStd,
    afterStd,
  }
}
