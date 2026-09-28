/**
 * 【共享测量工具】「图里的文字行到底正不正」的独立观测。
 *
 * 为什么要独立：被测算法 `estimateSkew` 优化的目标是投影直方图的平方和 Σhist²，
 * 用那个量评价自己＝循环论证。这里改用**与被测代码零共用的几何观测**。
 *
 * 为什么用「列质心回归」而不是「条带 PCA」（踩过的坑，务必记录）：
 *   PCA 测的是墨迹点云的**主轴**，会被两件事带偏——
 *     ① 条带里混进了第二行文字（条带高度 ≠ 行距时必然发生）
 *     ② 字符自身的横向分布（汉字方块 vs 英文窄字，主轴方向天然不同）
 *   实测噪声地板 σ=2.20°，与真实畸变同量级 → 测量完全失去分辨力。
 *   列质心回归直接测「行中心 y 随 x 的漂移」，正是"行歪不歪"的定义，
 *   同一批图上噪声地板降到 σ=0.02°（100 倍改善）。
 *
 * 使用约定：fixture 的行距应 = 图高 / bands，保证「一个条带恰好一行」。
 */
import sharp from 'sharp'

/** Otsu 阈值：把灰度直方图分成前景/背景两类，使类间方差最大。 */
export function otsuThreshold(hist: Int32Array, total: number): number {
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let wB = 0, sumB = 0, maxVar = -1, thr = 127
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    const wF = total - wB
    if (!wB || !wF) break
    sumB += t * hist[t]
    const v = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2
    if (v > maxVar) { maxVar = v; thr = t }
  }
  return thr
}

/**
 * 把图切成 `bands` 个水平条带，每条带内对每个 x 求墨迹的 y 质心，
 * 再对 (x, ȳ) 做最小二乘回归 —— 斜率即该处文本行的倾角（度）。
 */
export async function rowSlopes(buf: Buffer, bands = 8): Promise<number[]> {
  const { data, info } = await sharp(buf).grayscale().raw().toBuffer({ resolveWithObject: true })
  const w = info.width, h = info.height
  const hist = new Int32Array(256)
  for (let i = 0; i < data.length; i++) hist[data[i]]++
  const thr = otsuThreshold(hist, data.length)
  const bandH = Math.floor(h / bands)
  const out: number[] = []
  for (let b = 0; b < bands; b++) {
    const y0 = b * bandH, y1 = b === bands - 1 ? h : (b + 1) * bandH
    const cols: [number, number][] = []
    for (let x = 0; x < w; x++) {
      let sy = 0, n = 0
      for (let y = y0; y < y1; y++) if (data[y * w + x] < thr) { sy += y; n++ }
      if (n >= 2) cols.push([x, sy / n])
    }
    if (cols.length < 40) continue
    const mx = cols.reduce((s, p) => s + p[0], 0) / cols.length
    const my = cols.reduce((s, p) => s + p[1], 0) / cols.length
    let num = 0, den = 0
    for (const [x, y] of cols) { num += (x - mx) * (y - my); den += (x - mx) ** 2 }
    if (den < 1e-9) continue
    out.push((Math.atan(num / den) * 180) / Math.PI)
  }
  return out
}

export interface SlopeStats {
  /** 平均倾角：整体歪了多少 */
  mean: number
  /** 倾角的离散度：各行**互不平行**的程度 —— 透视畸变的指纹 */
  std: number
  /** 极差：最歪与最正之差 */
  range: number
}

export function slopeStats(a: number[]): SlopeStats {
  if (!a.length) return { mean: 0, std: 0, range: 0 }
  const mean = a.reduce((s, v) => s + v, 0) / a.length
  const std = Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / a.length)
  return { mean, std, range: Math.max(...a) - Math.min(...a) }
}

/** 一次量完：行倾角 + 统计量。 */
export async function measureRows(buf: Buffer, bands = 8): Promise<SlopeStats> {
  return slopeStats(await rowSlopes(buf, bands))
}

/* ───────────────────────── 单应矩阵（独立实现） ─────────────────────────
 * 刻意不复用 image-dewarp.solveHomography：诊断/回归要用被测代码之外的实现
 * 去生成 ground truth，否则就是用被测实现验证被测实现。
 */
export function solveH(src: number[][], dst: number[][]): number[] {
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]; const [X, Y] = dst[i]
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X)
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y)
  }
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < 8; col++) {
    let piv = col
    for (let r = col + 1; r < 8; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    ;[M[col], M[piv]] = [M[piv], M[col]]
    // ⚠️ 必须先存 d：写成 `M[col][c] /= M[col][col]` 会在 c=col 时把 pivot 自己改成 1，
    //    后续元素就全除以 1（等于没除）→ 解直接爆到 1e39。踩过一次，勿复原。
    const d = M[col][col]
    for (let c = col; c <= 8; c++) M[col][c] /= d
    for (let r = 0; r < 8; r++) {
      if (r === col) continue
      const f = M[r][col]
      for (let c = col; c <= 8; c++) M[r][c] -= f * M[col][c]
    }
  }
  return M.map((row) => row[8])
}

export const applyH = (H: number[], x: number, y: number): [number, number] => {
  const d = H[6] * x + H[7] * y + 1
  return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d]
}

/**
 * 把正面矩形图"贴"到目标四角上 → 得到一张模拟斜拍/透视的照片（ground-truth 生成器）。
 *
 * @param offset 纸在画布中的偏移（留出四周"桌面"背景）；0 = 纸面占满画面
 */
export async function embedPerspective(
  srcBuf: Buffer, sw: number, sh: number, corners: number[][],
  offset = 0, bgGray = 253,
): Promise<Buffer> {
  const { data, info } = await sharp(srcBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const k = info.channels
  const shifted = corners.map(([x, y]) => [x + offset, y + offset])
  const Hinv = solveH(shifted, [[0, 0], [sw, 0], [sw, sh], [0, sh]])
  const cw = sw + offset * 2, ch = sh + offset * 2
  const out = Buffer.alloc(cw * ch * k, bgGray)
  for (let Y = 0; Y < ch; Y++) {
    for (let X = 0; X < cw; X++) {
      const [x, y] = applyH(Hinv, X, Y)
      if (x < 0 || y < 0 || x > sw - 1 || y > sh - 1) continue
      const x0 = Math.floor(x), y0 = Math.floor(y)
      const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1)
      const fx = x - x0, fy = y - y0
      const o = (Y * cw + X) * k
      for (let c = 0; c < k; c++) {
        const v00 = data[(y0 * sw + x0) * k + c], v10 = data[(y0 * sw + x1) * k + c]
        const v01 = data[(y1 * sw + x0) * k + c], v11 = data[(y1 * sw + x1) * k + c]
        out[o + c] = Math.round((v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy)
      }
    }
  }
  return sharp(out, { raw: { width: cw, height: ch, channels: k } }).png().toBuffer()
}

/**
 * 生成标准测试试卷（正面、无畸变）。
 *
 * 行距 = height/rows，保证测量条带与文本行一一对齐（见文件头说明）。
 */
export function sheetSvg(
  width: number, height: number, rows: number,
  opts: { hand?: boolean; gradient?: boolean } = {},
): Buffer {
  const { hand = true, gradient = false } = opts
  const rowH = height / rows
  let layers = ''
  for (let i = 0; i < rows; i++) {
    const y = rowH * 0.5 + i * rowH
    layers +=
      `<text x="80" y="${y}" font-family="serif" font-size="22" fill="#111">` +
      `第 ${i + 1} 题 (page ${i + 1})：请根据题意作答，good luck.</text>`
    if (hand) {
      layers += `<text x="150" y="${y + rowH * 0.5}" font-family="serif" font-size="30" fill="#2b4a9b">解答：${36 + i} 厘米</text>`
    }
  }
  const grad = gradient
    ? '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">' +
      '<stop offset="0" stop-color="#000" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="#000" stop-opacity="0.22"/></linearGradient></defs>' +
      `<rect width="${width}" height="${height}" fill="url(#g)"/>`
    : ''
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="${width}" height="${height}" fill="#fdfdfa"/>${layers}${grad}</svg>`,
  )
}
