import sharp from 'sharp'

/**
 * 【自动调正 · 文本行倾斜估计（deskew）】
 *
 * ── 为什么需要这一层（实测暴露的根本缺陷）─────────────────────────────────
 * `image-corners.detectCornersCV` 走的是「Canny 边缘 + 最大轮廓 + approxPolyDP」，
 * 依赖**文档四周存在可辨识的边界**（白纸压在深色桌面上那种对比）。
 *
 * 但真实场景绝大多数是：手机拍试卷时**纸面占满整个画面**——画面里根本没有
 * 纸张轮廓这条边，Canny 抓到的全是**文字笔画的细碎边缘**，最大轮廓面积远小于
 * MIN_AREA_RATIO(0.25)，于是 `detectCornersCV` 恒返回 null → `straightenImage`
 * 走 `needManual` → **原样返回原图**。
 *
 * 这就是用户反复反馈「自动调正点了没反应」的根因：不是功能坏了，而是**唯一
 * 依赖的检测路径在最常见场景下 100% 不命中**。
 *
 * ── 本模块的方案 ──────────────────────────────────────────────────────────
 * 不再找「纸张外框」，改为找「**文字行的走向**」——这是文档图像倾斜估计的
 * 经典做法（projection profile / 投影轮廓法），纸上只要有字就能算，与有没有
 * 纸张边界无关。
 *
 * 原理：把暗像素（墨迹）沿某个角度 θ 投影到一条轴上，得到直方图 hist。
 *   文字行越水平 → 同一行的墨迹越集中落在同一个 bin → 直方图**越尖锐**；
 *   角度偏了 → 一行的墨迹被摊到多个 bin → 直方图**越平坦**。
 * 于是「直方图平方和 Σhist²」最大化时的 θ 就是倾斜角。
 *
 * 只需扫 ±15°（拍照倾斜不会更大），粗扫 1° + 细化 0.1°，且**不真正旋转图像**
 * （只做坐标变换累加），因此很快：800px 长边 + 3 万墨迹点 ≈ 百毫秒级。
 *
 * ── #135 修复：边界饱和假峰 + 低置信度误转（p4 -16° 事故）──────────────────
 * A/B 试点实测（见根目录《侧车3.x-A_B试点与摆正估计器假峰溯源.md》§3）暴露：
 * 投影得分曲线在**真实密页面**（800px 下 18 万墨点、40+ 行、页缘竖边带，每行对齐
 * 收益被稀释到 2~5%）会**单调漂向搜索边界**，顶出 ±16° 假峰；且旧置信度（相对
 * θ=0 的绝对增益 ×10）与正确估计大面积重叠（假峰 0.09~0.52 vs 正确 0.04~0.8），
 * `minConfidence=0.05` 门形同虚设——p4 原图（真实仅 +1.8°）被 -16°（conf 0.19）
 * 照转，转歪约 14°。
 *
 * 修复（三层，按优先级）：
 * ① **边界拒绝（主修）**：粗扫范围加宽 ±3° 警戒带；最优角落到可用范围之外
 *    （警戒带内）＝曲线无内点峰、漂到量程边缘的饱和签名 → 判定无可靠估计。
 *    真实歪斜不会顶量程；实测顶边界的 100% 是假峰。此条即可防住 p4 事故。
 * ② **置信度门重设计**：绝对增益无判别力，改用**峰突出度**（best 与隔 ≥2° 的
 *    次优峰的相对差）——干净行结构 0.5+，平坦曲线 0.02~0.05，区分度显著。
 *    注意：突出度低不代表「没估计」，代表「峰不够尖，不值得信」。
 * ③ **多样裁切共识**：全幅 + 中心 70% 双估计，任一饱和或互相矛盾 → 拒动；
 *    一致才转（全幅为准，置信度取两者较小）。
 */

/** 倾斜角搜索范围（度）：拍照歪斜一般不超过 15° */
export const DESKEW_MAX_DEG = 15
/**
 * 警戒带（度）：粗扫范围比「可用范围」宽这么多。
 * 无可靠行结构时得分曲线单调漂向搜索边界（#135 实测假峰一律顶在量程边缘），
 * 最优角落进警戒带 = 边界饱和签名 → 拒估。加宽扫描只是给假峰一个越界暴露机会。
 */
const DESKEW_GUARD_DEG = 3
/** 粗扫步长（度） */
const COARSE_STEP = 1
/** 细化步长（度） */
const FINE_STEP = 0.1
/** 峰突出度计算：次优峰与最优峰的排除角（度），至少隔这么远才算「另一个峰」 */
const PEAK_EXCLUSION_DEG = 2
/** 多裁切共识容差（度）：全幅与中心裁切两个估计角差超过此值 → 矛盾 → 拒动 */
export const DESKEW_CONSENSUS_TOL_DEG = 2
/** 共识用的中心裁切比例（排除四周背景/页缘，与 probe-p4-skew2 口径一致） */
const CONSENSUS_CROP_RATIO = 0.7
/** 置信度门默认值（新语义＝峰突出度）：峰不够尖则不转 */
export const DESKEW_MIN_CONFIDENCE = 0.1
/** 估计用的最大长边（限制 CPU，坐标按比例还原） */
const EST_MAX_SIDE = 800
/** 低于该角度视为「本来就正」，不做旋转（避免无意义重采样损伤画质） */
export const DESKEW_MIN_APPLY_DEG = 0.3

export interface SkewEstimate {
  /** 需要施加的旋转角（度，sharp rotate 语义：正=顺时针）。已含符号修正。 */
  rotateDeg: number
  /** 置信度 0~1（#135 起＝峰突出度：best 与次优峰的相对差；旧语义为绝对增益） */
  confidence: number
  /** 参与估计的墨迹像素数（太少则不可信） */
  inkPixels: number
  /** #135：最优角顶到搜索量程边缘（边界饱和签名）→ 估计不可信，应拒动 */
  boundarySaturated?: boolean
  /** #135：多裁切共识下两估计互相矛盾 → 拒动 */
  contradiction?: boolean
  /** #135：峰突出度原始值（诊断用） */
  prominence?: number
  /** #135：相对 θ=0 的绝对增益（诊断用，已证明无判别力） */
  gain?: number
}

/** Otsu 阈值：把灰度直方图分成前景/背景两类，使类间方差最大。 */
function otsuThreshold(hist: Int32Array, total: number): number {
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0
  let wB = 0
  let maxVar = -1
  let thr = 127
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > maxVar) {
      maxVar = between
      thr = t
    }
  }
  return thr
}

/** 沿角度 θ（弧度）做投影，返回 Σhist²（未归一化）。bins 数量固定为对角线长度。 */
function projectionScore(
  xs: Float32Array, ys: Float32Array, n: number, theta: number, bins: number, binSize: number,
  hist: Int32Array,
): number {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  hist.fill(0)
  for (let i = 0; i < n; i++) {
    // 投影到与水平成 θ 的轴：r = y·cosθ − x·sinθ
    const r = ys[i] * c - xs[i] * s
    let b = (r / binSize) | 0
    // r 可能为负（旋转后的坐标原点），整体平移保证非负
    b += bins >> 1
    if (b < 0) b = 0
    else if (b >= bins) b = bins - 1
    hist[b]++
  }
  let acc = 0
  for (let b = 0; b < bins; b++) acc += hist[b] * hist[b]
  return acc
}

/**
 * 估计文档倾斜角。
 *
 * @returns 估计结果；墨迹太少或图不可解码时 `confidence=0, rotateDeg=0`（调用方应视为未命中）
 */
export async function estimateSkew(buf: Buffer): Promise<SkewEstimate> {
  const meta = await sharp(buf).metadata()
  const W0 = meta.width || 0
  const H0 = meta.height || 0
  if (!W0 || !H0) return { rotateDeg: 0, confidence: 0, inkPixels: 0 }

  const scale = Math.min(1, EST_MAX_SIDE / Math.max(W0, H0))
  const w = Math.max(1, Math.round(W0 * scale))
  const h = Math.max(1, Math.round(H0 * scale))
  const gray = await sharp(buf).resize(w, h, { fit: 'fill' }).grayscale().raw().toBuffer()

  // 灰度直方图 → Otsu
  const hist = new Int32Array(256)
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++
  const thr = otsuThreshold(hist, gray.length)

  // 收集暗像素坐标（居中坐标系，避免旋转时坐标爆炸；同时限制采样量保 CPU）
  const MAX_POINTS = 60000
  const cx = w / 2
  const cy = h / 2
  const xsAll: number[] = []
  const ysAll: number[] = []
  let ink = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (gray[y * w + x] < thr) ink++
    }
  }
  const step = ink > MAX_POINTS ? Math.ceil(ink / MAX_POINTS) : 1
  let k = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (gray[y * w + x] >= thr) continue
      if (k++ % step !== 0) continue
      xsAll.push(x - cx)
      ysAll.push(y - cy)
    }
  }
  const n = xsAll.length
  if (n < 200) return { rotateDeg: 0, confidence: 0, inkPixels: ink }

  const xs = Float32Array.from(xsAll)
  const ys = Float32Array.from(ysAll)

  const diag = Math.ceil(Math.hypot(w, h))
  const binSize = 2
  const bins = Math.ceil(diag / binSize) + 2
  const bufHist = new Int32Array(bins)

  // 粗扫：±(MAX+GUARD)，步长 1°；记录整条曲线供峰突出度计算
  const scanMax = DESKEW_MAX_DEG + DESKEW_GUARD_DEG
  const coarseCount = Math.round((scanMax * 2) / COARSE_STEP) + 1
  const coarseScores = new Float64Array(coarseCount)
  let bestDeg = 0
  let bestScore = -1
  let baseScore = 0
  for (let i = 0; i < coarseCount; i++) {
    const d = -scanMax + i * COARSE_STEP
    const sc = projectionScore(xs, ys, n, (d * Math.PI) / 180, bins, binSize, bufHist)
    coarseScores[i] = sc
    if (Math.abs(d) < 1e-6) baseScore = sc
    if (sc > bestScore) {
      bestScore = sc
      bestDeg = d
    }
  }

  // ⭐ 边界拒绝（#135 主修）：最优角顶出可用范围（落进警戒带）＝曲线无内点峰、
  //   单调漂向量程边缘的饱和签名。真实歪斜不会顶量程；实测顶边界 100% 是假峰
  //   （p1/p2/p4 矫正图与 p4 原图的 -16° 事故均出于此）。
  if (Math.abs(bestDeg) > DESKEW_MAX_DEG + 1e-6) {
    return { rotateDeg: 0, confidence: 0, inkPixels: ink, boundarySaturated: true, prominence: 0, gain: 0 }
  }

  // 细化：bestDeg ±1°，步长 0.1°
  let fineDeg = bestDeg
  let fineScore = bestScore
  for (let d = bestDeg - 1; d <= bestDeg + 1; d += FINE_STEP) {
    const sc = projectionScore(xs, ys, n, (d * Math.PI) / 180, bins, binSize, bufHist)
    if (sc > fineScore) {
      fineScore = sc
      fineDeg = d
    }
  }
  // 细化后仍越界（粗扫踩在可用边缘、细化漂出）同样按饱和拒绝
  if (Math.abs(fineDeg) > DESKEW_MAX_DEG + 0.05) {
    return { rotateDeg: 0, confidence: 0, inkPixels: ink, boundarySaturated: true, prominence: 0, gain: 0 }
  }

  // ⭐ 峰突出度（#135）：best 与「隔 ≥PEAK_EXCLUSION_DEG 的次优峰」的相对差。
  //   绝对增益无判别力（密页正确估计增益也只有 0.4%~8%，与假峰 0.09~0.52 重叠），
  //   突出度才有：干净行结构 0.5+，平坦/漂移曲线 0.02~0.05。
  let runnerUp = -1
  const bestIdx = Math.round((bestDeg + scanMax) / COARSE_STEP)
  for (let i = 0; i < coarseCount; i++) {
    if (Math.abs(i - bestIdx) * COARSE_STEP + 1e-6 < PEAK_EXCLUSION_DEG) continue
    if (coarseScores[i] > runnerUp) runnerUp = coarseScores[i]
  }
  const prominence =
    bestScore > 0 && runnerUp >= 0 ? Math.max(0, Math.min(1, (bestScore - runnerUp) / bestScore)) : 0
  const gain = baseScore > 0 ? (fineScore - baseScore) / baseScore : 0

  // ⚠️ 符号换算（实测校准，勿凭直觉改）：
  //   投影式 r = y·cosθ − x·sinθ 取到极大时的 θ，数值上**等于图像当前的倾斜角**
  //   （实测：真实倾斜 +5° → 估计 +4.8°；−7° → −7°）。
  //   要把它「转回正」，必须施加**反号**的旋转 −θ。
  //   早期版本误用 +θ，导致「自动调正」把 5° 的歪斜转成 9.8°（越调越歪）——
  //   这也是「点了自动调正反而更歪」类反馈的来源。回归用例见
  //   dynamic-tests/run-issue-deskew-sign.cjs。
  return {
    rotateDeg: Number((-fineDeg).toFixed(2)),
    confidence: prominence,
    inkPixels: ink,
    prominence,
    gain,
  }
}

/**
 * 多样裁切共识（#135 第③层）：全幅 + 中心 70% 各估一次。
 *
 * - 任一估计**边界饱和** → 拒动（`boundarySaturated`）；
 * - 两者角度**矛盾**（差 > DESKEW_CONSENSUS_TOL_DEG）→ 拒动（`contradiction`）；
 *   实测多裁切不一致是可靠信号（p1 原图全幅 -0.3° vs 中心 -16°）；
 * - 中心裁切墨迹太少 → 该证据缺席，只信全幅；
 * - 一致 → 以全幅估计为准，置信度/突出度取两者较小（保守）。
 */
export async function estimateSkewConsensus(
  buf: Buffer,
): Promise<SkewEstimate> {
  const full = await estimateSkew(buf)
  if (full.boundarySaturated || full.inkPixels < 200) return full

  const meta = await sharp(buf).metadata()
  const W = meta.width || 0
  const H = meta.height || 0
  if (!W || !H) return full
  const cw = Math.max(1, Math.round(W * CONSENSUS_CROP_RATIO))
  const ch = Math.max(1, Math.round(H * CONSENSUS_CROP_RATIO))
  const cropped = await sharp(buf)
    .extract({ left: Math.round((W - cw) / 2), top: Math.round((H - ch) / 2), width: cw, height: ch })
    .toBuffer()
  const crop = await estimateSkew(cropped)
  if (crop.boundarySaturated) {
    return { ...full, boundarySaturated: true, confidence: 0, prominence: 0 }
  }
  if (crop.inkPixels < 200) return full
  if (Math.abs(full.rotateDeg - crop.rotateDeg) > DESKEW_CONSENSUS_TOL_DEG) {
    return { ...full, contradiction: true, confidence: 0, prominence: 0 }
  }
  return {
    ...full,
    confidence: Math.min(full.confidence, crop.confidence),
    prominence: Math.min(full.prominence ?? 0, crop.prominence ?? 0),
  }
}

/**
 * 按估计角度旋转整图（输出为「转正」后的图像）。
 *
 * - 旋转后用**页面底色**填充三角空白（取四角像素均值），避免黑边/花屏；
 * - 输出画布会自动放大以容纳旋转后的整幅图（sharp 默认行为），不做裁切，
 *   保证不丢内容。
 */
export async function deskewBuffer(
  buf: Buffer,
  rotateDeg: number,
): Promise<{ buffer: Buffer; width: number; height: number }> {
  // 页面底色：取四角邻域均值，比硬编码白色更抗"米黄试卷/灰底照片"
  let bg = { r: 255, g: 255, b: 255 }
  try {
    const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const ch = info.channels
    const px = (x: number, y: number) => {
      const i = (y * info.width + x) * ch
      return [data[i], data[i + 1], data[i + 2]]
    }
    const corners = [
      px(2, 2), px(info.width - 3, 2), px(2, info.height - 3), px(info.width - 3, info.height - 3),
    ]
    const avg = [0, 0, 0]
    for (const c of corners) for (let i = 0; i < 3; i++) avg[i] += c[i] / corners.length
    bg = { r: Math.round(avg[0]), g: Math.round(avg[1]), b: Math.round(avg[2]) }
  } catch { /* 取色失败则用白 */ }

  const out = await sharp(buf)
    .rotate(rotateDeg, { background: bg })
    .png()
    .toBuffer()
  const m = await sharp(out).metadata()
  return { buffer: out, width: m.width || 0, height: m.height || 0 }
}

/**
 * 顶层入口：估计 + 转正。
 *
 * 三道拒动门（#135）：边界饱和 / 多裁切矛盾 / 突出度不足，任一命中即返回 null。
 * 保守取向：漏转可以（UVDoc 矫正才是治本路径），误转会把 +1.8° 的图转歪约 14°。
 *
 * @returns null 表示「没把握」（墨迹太少 / 角度过小 / 突出度不足 / 边界饱和 /
 *          多裁切矛盾），调用方应继续降级。
 */
export async function deskewImage(
  buf: Buffer,
  opts: { minDeg?: number; minConfidence?: number } = {},
): Promise<{ buffer: Buffer; width: number; height: number; rotateDeg: number; confidence: number } | null> {
  const minDeg = opts.minDeg ?? DESKEW_MIN_APPLY_DEG
  const minConf = opts.minConfidence ?? DESKEW_MIN_CONFIDENCE
  const est = await estimateSkewConsensus(buf)
  if (est.inkPixels < 200) return null
  if (est.boundarySaturated) return null
  if (est.contradiction) return null
  if (Math.abs(est.rotateDeg) < minDeg) return null
  if (est.confidence < minConf) return null
  const r = await deskewBuffer(buf, est.rotateDeg)
  return { buffer: r.buffer, width: r.width, height: r.height, rotateDeg: est.rotateDeg, confidence: est.confidence }
}
