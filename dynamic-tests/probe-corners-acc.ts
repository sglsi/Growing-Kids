/**
 * 【问题二 · 自动调正】四角检测精度诊断 + 修复方案原型验证
 *
 * 上一轮（probe-deskew-diag 实验 F）暴露的致命现象：
 *   纸放在深色桌面上时 detectCornersCV **命中了**，但 dewarp 输出的行倾角 σ 从
 *   0.06° 恶化到 3.3°（≈50 倍）——「命中」比「不命中」更糟。
 *
 * 本探针回答两件事：
 *   ① 根因是不是「角点精度」（把真四角喂进去能否回到基线水平）
 *   ② 修复方案「先直线拟合、再求交点」能否把角点误差压到可用范围
 *
 * ── 领域依据 ────────────────────────────────────────────────────────────────
 * 文档扫描的标准管线（OpenCV 官方 tutorial / CamScanner 一类产品）里
 * `approxPolyDP` 的作用是**筛选**（判断这个轮廓像不像四边形），
 * **不是**用来定角点 —— 它的参数是「允许的逼近误差」，用 0.02×周长（≈84px）
 * 去逼近一个梯形，等于主动把四个角抹掉、退化成外接矩形。
 * 精确定位的正解是：取每条边上的点拟合直线，再求相邻直线交点。
 *
 * 运行：cd /workspace/projects/server && npx tsx /workspace/dynamic-tests/probe-corners-acc.ts
 */
import sharp from 'sharp'
import { getCV } from '/workspace/projects/server/src/image/image-cv'
import { dewarpBuffer, orderCorners, type Corner } from '/workspace/projects/server/src/image/image-dewarp'

/* eslint-disable @typescript-eslint/no-explicit-any */
type CV = any

const W = 900
const H = 1200
const DESK = 60 // 四周深色桌面宽度

function sheetSvg(): Buffer {
  let layers = ''
  // 行距 150 = 图高 1200 / 条带数 8，保证「一个条带恰好一行」——
  // 条带里混入第二行会污染测量（这是上一版基线噪声大到 σ=2.2° 的原因）。
  for (let i = 0; i < 8; i++) {
    const y = 75 + i * 150
    layers += `<text x="80" y="${y}" font-family="serif" font-size="22" fill="#111">第 ${i + 1} 题：请根据题意作答。</text>`
  }
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fdfdfa"/>${layers}</svg>`,
  )
}

function solveH(src: number[][], dst: number[][]): number[] {
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
const applyH = (H: number[], x: number, y: number): [number, number] => {
  const d = H[6] * x + H[7] * y + 1
  return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d]
}
async function embed(srcBuf: Buffer, corners: number[][]): Promise<Buffer> {
  const { data, info } = await sharp(srcBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const k = info.channels
  const Hinv = solveH(corners, [[0, 0], [W, 0], [W, H], [0, H]])
  const cw = W + DESK * 2, ch = H + DESK * 2
  // 先把纸贴到 (DESK,DESK) 偏移后的四角
  const shifted = corners.map(([x, y]) => [x + DESK, y + DESK])
  const Hinv2 = solveH(shifted, [[0, 0], [W, 0], [W, H], [0, H]])
  const out = Buffer.alloc(cw * ch * k, 58) // 58 ≈ #3a3a3a 桌面
  for (let Y = 0; Y < ch; Y++) for (let X = 0; X < cw; X++) {
    const [x, y] = applyH(Hinv2, X, Y)
    if (x < 0 || y < 0 || x > W - 1 || y > H - 1) continue
    const x0 = Math.floor(x), y0 = Math.floor(y)
    const x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1)
    const fx = x - x0, fy = y - y0
    const o = (Y * cw + X) * k
    for (let c = 0; c < k; c++) {
      const v00 = data[(y0 * W + x0) * k + c], v10 = data[(y0 * W + x1) * k + c]
      const v01 = data[(y1 * W + x0) * k + c], v11 = data[(y1 * W + x1) * k + c]
      out[o + c] = Math.round((v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy)
    }
  }
  void Hinv
  return sharp(out, { raw: { width: cw, height: ch, channels: k } }).png().toBuffer()
}

/**
 * 独立测量仪：**列质心回归**（文档分析里的 baseline tracking）。
 *
 * 比「条带 PCA」稳健得多：PCA 测的是墨迹点云的主轴，会被条带内混入的**第二行**、
 * 以及字符自身的横向分布带偏（实测基线噪声地板 σ=2.2°，大到掩盖真实信号）。
 * 列质心回归直接测「行的中心随 x 的漂移」—— 这正是"行歪不歪"的定义。
 *
 * 做法：条带内，对每个 x 求墨迹的 y 质心 → (x, ȳ) 点列 → 最小二乘直线 → 斜率即倾角。
 */
async function rowSlopes(buf: Buffer, bands = 8): Promise<number[]> {
  const { data, info } = await sharp(buf).grayscale().raw().toBuffer({ resolveWithObject: true })
  const w = info.width, h = info.height
  const hist = new Int32Array(256)
  for (let i = 0; i < data.length; i++) hist[data[i]]++
  let thr = 127, sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let wB = 0, sumB = 0, maxVar = -1
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; const wF = data.length - wB
    if (!wB || !wF) break
    sumB += t * hist[t]
    const v = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2
    if (v > maxVar) { maxVar = v; thr = t }
  }
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
const stats = (a: number[]) => {
  const mean = a.reduce((s, v) => s + v, 0) / a.length
  return {
    mean,
    std: Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / a.length),
    range: Math.max(...a) - Math.min(...a),
  }
}

/* ───────────────── 方案原型：直线拟合 + 求交点 ───────────────── */
/** 用 opencv 拿最大轮廓，返回其点集（像素坐标） */
function biggestContourPoints(cv: CV, grayBuf: Buffer, w: number, h: number): [number, number][] | null {
  const src = cv.matFromArray(h, w, cv.CV_8UC1, Array.from(grayBuf))
  const gray = new cv.Mat()
  cv.GaussianBlur(src, gray, new cv.Size(3, 3), 0)
  const edges = new cv.Mat()
  cv.Canny(gray, edges, 50, 150)
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5))
  cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel)
  const contours = new cv.MatVector()
  const hier = new cv.Mat()
  cv.findContours(edges, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
  let bi = -1, ba = 0
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i)
    const a = cv.contourArea(c)
    if (a > ba) { ba = a; bi = i }
    c.delete()
  }
  if (bi < 0) { src.delete(); gray.delete(); edges.delete(); contours.delete(); hier.delete(); kernel.delete(); return null }
  const biggest = contours.get(bi)
  const n = biggest.rows
  const pts: [number, number][] = []
  for (let i = 0; i < n; i++) pts.push([biggest.data32S[i * 2], biggest.data32S[i * 2 + 1]])
  src.delete(); gray.delete(); edges.delete(); biggest.delete(); contours.delete(); hier.delete(); kernel.delete()
  return pts
}

function approx4(cv: CV, pts: [number, number][], epsRatio: number): [number, number][] | null {
  const mat = cv.matFromArray(pts.length, 1, cv.CV_32SC2, pts.flat())
  const out = new cv.Mat()
  let peri = 0
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    peri += Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1])
  }
  cv.approxPolyDP(mat, out, epsRatio * peri, true)
  mat.delete()
  const r: [number, number][] = []
  if (out.rows === 4) for (let i = 0; i < 4; i++) r.push([out.data32S[i * 2], out.data32S[i * 2 + 1]])
  out.delete()
  return r.length === 4 ? r : null
}

/** 最小二乘拟合直线（ax+by+c=0），用点集二阶矩 */
function fitLine(pts: [number, number][]): [number, number, number] {
  let sx = 0, sy = 0
  for (const [x, y] of pts) { sx += x; sy += y }
  const mx = sx / pts.length, my = sy / pts.length
  let cxx = 0, cxy = 0, cyy = 0
  for (const [x, y] of pts) { const dx = x - mx, dy = y - my; cxx += dx * dx; cxy += dx * dy; cyy += dy * dy }
  // 法向量 = 最小特征向量
  const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy)
  const a = -Math.sin(ang), b = Math.cos(ang)
  return [a, b, -(a * mx + b * my)]
}
const lineXline = (l1: number[], l2: number[]): [number, number] => {
  const [a1, b1, c1] = l1, [a2, b2, c2] = l2
  const d = a1 * b2 - a2 * b1
  if (Math.abs(d) < 1e-9) return [NaN, NaN]
  return [(b1 * c2 - b2 * c1) / d, (c1 * a2 - c2 * a1) / d]
}

/** 原型：粗顶点分组 → 每组点拟合直线 → 相邻直线求交点 */
function refineCorners(pts: [number, number][], rough: [number, number][]): [number, number][] | null {
  const groups: [number, number][][] = [[], [], [], []]
  for (const p of pts) {
    let bi = 0, bd = Infinity
    for (let i = 0; i < 4; i++) {
      const d = Math.hypot(p[0] - rough[i][0], p[1] - rough[i][1])
      if (d < bd) { bd = d; bi = i }
    }
    groups[bi].push(p)
  }
  if (groups.some((g) => g.length < 5)) return null
  // ⚠️ 不能用 orderCorners 再 indexOf 回查：orderCorners 返回的是**拷贝**，
  //    indexOf 永远得 -1 → groups[-1] undefined。改为按极角做环形排序、直接留索引。
  const cx = rough.reduce((s, p) => s + p[0], 0) / 4
  const cy = rough.reduce((s, p) => s + p[1], 0) / 4
  const ring = [0, 1, 2, 3].sort(
    (a, b) => Math.atan2(rough[a][1] - cy, rough[a][0] - cx) - Math.atan2(rough[b][1] - cy, rough[b][0] - cx),
  )
  // 第 i 条边连接 ring[i] 与 ring[(i+1)%4]，其上的点 = 这两组的并集
  const lines: number[][] = []
  for (let i = 0; i < 4; i++) {
    lines.push(fitLine([...groups[ring[i]], ...groups[ring[(i + 1) % 4]]]))
  }
  const corners: [number, number][] = []
  for (let i = 0; i < 4; i++) {
    // 第 i 个角 = 边 (i-1) 与 边 (i) 的交点
    const p = lineXline(lines[(i + 3) % 4], lines[i])
    if (!isFinite(p[0]) || !isFinite(p[1])) return null
    corners.push(p)
  }
  return corners as [number, number][]
}

const cornerErr = (got: number[][], truth: number[][]): number => {
  // 按最近邻配对后取最大误差（顺序可能不同）
  let worst = 0
  for (const t of truth) {
    let best = Infinity
    for (const g of got) best = Math.min(best, Math.hypot(g[0] - t[0], g[1] - t[1]))
    worst = Math.max(worst, best)
  }
  return worst
}

async function main() {
  const cv = await getCV()
  if (!cv) { console.error('OpenCV 不可用'); return }
  const clean = await sharp(sheetSvg()).png().toBuffer()
  const base = stats(await rowSlopes(clean))
  console.log(`基线（无畸变原图）           σ=${base.std.toFixed(2)}°  R=${base.range.toFixed(2)}°   ← 噪声地板`)

  const scenes: { name: string; corners: number[][] }[] = [
    { name: '轻微上窄下宽', corners: [[30, 15], [W - 30, 15], [W - 5, H - 5], [5, H - 5]] },
    { name: '中度上窄下宽', corners: [[70, 35], [W - 70, 35], [W - 5, H - 5], [5, H - 5]] },
    { name: '左窄右宽侧拍', corners: [[10, 40], [W - 10, 5], [W - 10, H - 5], [10, H - 40]] },
    { name: '四角各自偏移', corners: [[45, 25], [W - 20, 55], [W - 55, H - 30], [20, H - 60]] },
  ]

  console.log('\n场景           真四角dewarp   检测四角dewarp   直线拟合角点误差(pred)')
  for (const s of scenes) {
    const truth = s.corners.map(([x, y]) => [x + DESK, y + DESK])
    const q = await embed(clean, s.corners)

    // ① 真四角 dewarp（理论上限）
    const ideal = await dewarpBuffer(q, truth as Corner[])
    const sIdeal = stats(await rowSlopes(ideal.buffer))

    // ② 当前检测四角（approxPolyDP 直接当角点）
    const { data, info } = await sharp(q).grayscale().raw().toBuffer({ resolveWithObject: true })
    const pts = biggestContourPoints(cv, data, info.width, info.height)
    if (!pts) { console.log(`${s.name} 轮廓未取到`); continue }
    const rough = approx4(cv, pts, 0.02)
    if (!rough) { console.log(`${s.name} approxPolyDP 未得 4 点`); continue }
    const sCur = stats(await rowSlopes((await dewarpBuffer(q, orderCorners(rough as Corner[]))).buffer))

    // ③ 原型：直线拟合求交点
    const refined = refineCorners(pts, rough)
    let refinedTxt = '拟合失败'
    if (refined) {
      const err = cornerErr(refined as number[][], truth)
      const sRef = stats(await rowSlopes((await dewarpBuffer(q, orderCorners(refined as Corner[]))).buffer))
      refinedTxt = `误差 ${err.toFixed(1)}px → σ=${sRef.std.toFixed(2)}°`
    }
    const curErr = cornerErr(orderCorners(rough as Corner[]) as number[][], truth)
    console.log(
      `${s.name.padEnd(14)} σ=${sIdeal.std.toFixed(2)}° R=${sIdeal.range.toFixed(2)}   ` +
        `σ=${sCur.std.toFixed(2)}°(角点误差${curErr.toFixed(0)}px)   ${refinedTxt}`,
    )
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
