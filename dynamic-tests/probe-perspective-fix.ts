/**
 * 【问题二 · 自动调正】子问题 2 原型：满画面（无纸边）下的**透视残留**
 *
 * ── 症状 ──────────────────────────────────────────────────────────────────
 * 纸面占满画面时 detectCornersCV 恒不命中（没有纸边可找），只能走 deskew。
 * 而 deskew 是**旋转**模型：它看的是「整体歪了多少」，判据 |rotateDeg| < 0.3° 就放弃。
 * 真实拍照常常是：整体不歪（μ≈0）但**各行互不平行**（σ=1.3°、极差 4°）——
 * 这是**透视**（相机偏航）的指纹，旋转修不了，于是功能「点了没反应」。
 *
 * ── 领域依据 ──────────────────────────────────────────────────────────────
 * 综述明确：Projection Profile / Hough / Nearest-Neighbour 三类倾斜估计
 * **都是旋转模型，原理上无法处理透视**（透视破坏了文本行之间的平行性）。
 * 无文档边界（HDB）时的绕行方案里，Dance/Clark 的**双消失点**与 Kim 的
 * **文本行优化 dewarping** 都把「文本行本身」当作线索：行的方向给出水平消失点，
 * 行的左右端点包络给出垂直边界（VPM）。
 *
 * ── 本原型 ────────────────────────────────────────────────────────────────
 * 不追求完整的 metric rectification，只做工程上可控的一步：
 *   ① 连通分量 → 行聚类 → 每行取左右端点
 *   ② 左右端点各自对 y 做**线性回归**（透视下纸的左右边界在图像里仍是直线）
 *   ③ 由这两条边界 + 首末行位置 → 内容四角
 *   ④ 复用已修好的 dewarpBuffer 压平
 *
 * 运行：cd /workspace/projects/server && npx tsx /workspace/dynamic-tests/probe-perspective-fix.ts
 */
import sharp from 'sharp'
import { dewarpBuffer, type Corner } from '/workspace/projects/server/src/image/image-dewarp'
import { deskewImage } from '/workspace/projects/server/src/image/image-deskew'
import { measureRows, embedPerspective, sheetSvg, otsuThreshold } from './lib/img-measure'

const W = 900, H = 1200, ROWS = 8
const f2 = (n: number) => n.toFixed(2)

interface Row {
  xL: number
  xR: number
  yc: number
  /** 该行直线的斜率 k（y = k·x + b），由行内各块的质心回归得到 */
  k: number
  /** 截距 b */
  b: number
}

/** 连通分量（8-连通，BFS）→ 过滤噪点 → 按质心 y 聚类成行 */
async function detectRows(buf: Buffer): Promise<Row[]> {
  const { data, info } = await sharp(buf).grayscale().raw().toBuffer({ resolveWithObject: true })
  const w = info.width, h = info.height
  const hist = new Int32Array(256)
  for (let i = 0; i < data.length; i++) hist[data[i]]++
  const thr = otsuThreshold(hist, data.length)
  const ink = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) ink[i] = data[i] < thr ? 1 : 0

  // BFS 标记连通分量
  const lab = new Int32Array(w * h).fill(-1)
  const comps: { x0: number; x1: number; y0: number; y1: number; n: number }[] = []
  const stack: number[] = []
  for (let s = 0; s < w * h; s++) {
    if (!ink[s] || lab[s] >= 0) continue
    const id = comps.length
    stack.push(s); lab[s] = id
    let x0 = w, x1 = 0, y0 = h, y1 = 0, n = 0
    while (stack.length) {
      const p = stack.pop()!
      const x = p % w, y = (p / w) | 0
      n++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const q = ny * w + nx
        if (ink[q] && lab[q] < 0) { lab[q] = id; stack.push(q) }
      }
    }
    comps.push({ x0, x1, y0, y1, n })
  }
  // 过滤噪点 + 过大的块（整片阴影）
  const blocks = comps
    .map((c, i) => ({ i, ...c }))
    .filter((c) => c.n >= 8 && c.x1 - c.x0 < w * 0.9 && c.y1 - c.y0 < h * 0.3)
  if (blocks.length < 4) return []

  // 按质心 y 排序后按间隙切行
  blocks.sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2)
  const rows: Row[] = []
  let cur: typeof blocks = [blocks[0]]
  for (let k = 1; k < blocks.length; k++) {
    const prevY = (cur[cur.length - 1].y0 + cur[cur.length - 1].y1) / 2
    const y = (blocks[k].y0 + blocks[k].y1) / 2
    // 行内间隙阈值：用块自身高度的中位数作尺度，避免行距变化时串/断
    const heights = blocks.map((b) => b.y1 - b.y0).sort((a, b) => a - b)
    const medH = heights[heights.length >> 1] || 10
    if (y - prevY > medH * 1.2) { rows.push(pack(cur)); cur = [blocks[k]] }
    else cur.push(blocks[k])
  }
  if (cur.length) rows.push(pack(cur))
  return rows.filter((r) => r.xR - r.xL > w * 0.15)
}
const pack = (bs: { x0: number; x1: number; y0: number; y1: number }[]): Row => {
  // 行直线：对行内各块的质心 (x, y) 做最小二乘回归 —— 行在透视下仍是直线
  const pts = bs.map((b) => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2] as [number, number])
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length
  let num = 0, den = 0
  for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2 }
  const k = den < 1e-9 ? 0 : num / den
  return {
    xL: Math.min(...bs.map((b) => b.x0)),
    xR: Math.max(...bs.map((b) => b.x1)),
    yc: pts.reduce((s, p) => s + p[1], 0) / pts.length,
    k,
    b: my - k * mx,
  }
}

/** 线性回归 x = a·y + b */
function fitX(pts: [number, number][]): (y: number) => number {
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
 * ⚠️ 第一版踩的坑：把上下边当成**水平线**（取常数 yTop/yBot）。
 *    实测「左窄右宽侧拍」场景下左右边界其实是**垂直线**、真正斜的是上下边 →
 *    四角退化成矩形，测出的"侧向透视"只有 0.76px，于是误判为无需修正。
 *    透视里斜的可以是任意一对边，**不能预设方向**。
 * 正解：四条边各自由点集拟合直线再求交 ——
 *    左右边 = 各行左右端点（端点落在各自的行直线上，故 y 用行直线算）
 *    上下边 = 首行/末行的行直线沿法向平移半行高
 */
function cornersFromRows(rows: Row[], w: number, h: number): Corner[] | null {
  if (rows.length < 3) return null
  const at = (r: Row, x: number) => r.k * x + r.b
  // 左右边界：x = f(y) 的回归（端点 y 取该端在行直线上的值）
  const L = fitX(rows.map((r) => [r.xL, at(r, r.xL)] as [number, number]))
  const R = fitX(rows.map((r) => [r.xR, at(r, r.xR)] as [number, number]))
  // 上下边界：行直线沿法向平移 ±半行高（y 偏移量 = halfH·√(1+k²)）
  const gaps: number[] = []
  for (let i = 1; i < rows.length; i++) gaps.push(rows[i].yc - rows[i - 1].yc)
  gaps.sort((a, b) => a - b)
  const halfH = (gaps[gaps.length >> 1] || 80) * 0.5
  const topB = rows[0].b - halfH * Math.sqrt(1 + rows[0].k ** 2)
  const botB = rows[rows.length - 1].b + halfH * Math.sqrt(1 + rows[rows.length - 1].k ** 2)
  // 求「y = k·x + b」与「x = xOfY(y)」的交点：不动点迭代，几步即收敛
  const meet = (k: number, b: number, xOfY: (y: number) => number, y0: number): [number, number] => {
    let y = y0
    for (let i = 0; i < 12; i++) y = k * xOfY(y) + b
    return [xOfY(y), y]
  }
  const clampX = (v: number) => Math.max(0, Math.min(w - 1, v))
  const clampY = (v: number) => Math.max(0, Math.min(h - 1, v))
  const kT = rows[0].k, kB = rows[rows.length - 1].k
  const yT = rows[0].yc, yB = rows[rows.length - 1].yc
  const tl = meet(kT, topB, L, yT)
  const tr = meet(kT, topB, R, yT)
  const br = meet(kB, botB, R, yB)
  const bl = meet(kB, botB, L, yB)
  return [
    [clampX(tl[0]), clampY(tl[1])],
    [clampX(tr[0]), clampY(tr[1])],
    [clampX(br[0]), clampY(br[1])],
    [clampX(bl[0]), clampY(bl[1])],
  ]
}

const SCENES: { name: string; corners: number[][] }[] = [
  { name: '左窄右宽侧拍(强)', corners: [[10, 60], [W - 10, 5], [W - 10, H - 5], [10, H - 60]] },
  { name: '左窄右宽侧拍', corners: [[10, 40], [W - 10, 5], [W - 10, H - 5], [10, H - 40]] },
  { name: '四角各自偏移', corners: [[45, 25], [W - 20, 55], [W - 55, H - 30], [20, H - 60]] },
  { name: '上窄下宽(对照)', corners: [[70, 35], [W - 70, 35], [W - 5, H - 5], [5, H - 5]] },
]

async function main() {
  const clean = await sharp(sheetSvg(W, H, ROWS, { hand: false })).png().toBuffer()
  const base = await measureRows(clean, ROWS)
  console.log(`噪声地板 σ=${f2(base.std)}° 极差=${f2(base.range)}°\n`)
  console.log('场景                deskew后            行包络四角dewarp后     真四角(理论上限)')

  for (const s of SCENES) {
    // 满画面：offset=0，画面里没有纸边
    const q = await embedPerspective(clean, W, H, s.corners, 0)
    const pre = await measureRows(q, ROWS)

    // ① 现状：deskew
    const d = await deskewImage(q)
    const afterDeskew = await measureRows(d ? d.buffer : q, ROWS)

    // ② 原型：行包络 → 四角 → dewarp
    //    先 deskew 掉整体旋转（coarse-to-fine：旋转先走，剩下的才是透视）
    const rotSrc = d ? d.buffer : q
    const rows = await detectRows(rotSrc)
    let proto = afterDeskew
    let note = ''
    // ⭐ 触发条件用「行是否互相平行」，而不是「左右边界是否收敛」——
    //   后者会漏掉消失点在水平方向的透视（实测侧拍场景只测出 0.76px 就放过了）。
    //   σ 是透视畸变的直接指纹：旋转模型下 σ 恒≈0，只有透视才会让各行斜率不同。
    const PARALLEL_TOL = 0.4 // 度；噪声地板实测 0.02°，留 20× 余量
    if (rows.length >= 3 && proto.std > PARALLEL_TOL) {
      const c = cornersFromRows(rows, W, H)
      if (c) {
        const r = await dewarpBuffer(rotSrc, c)
        const st = await measureRows(r.buffer, ROWS)
        // 护栏：宁可不做，不可做错 —— 没改善就回退到 deskew 结果
        if (st.std < proto.std) { proto = st; note = `(修正 ${f2(afterDeskew.std)}→${f2(st.std)}°)` }
        else note = `(未改善 ${f2(afterDeskew.std)}→${f2(st.std)}°，回退)`
      } else note = '(四角估计失败)'
    } else note = `(σ=${f2(proto.std)}° ≤ ${PARALLEL_TOL}°，无需透视校正)`

    // ③ 理论上限：真四角
    const ideal = await measureRows((await dewarpBuffer(q, s.corners as Corner[])).buffer, ROWS)

    console.log(
      `${s.name.padEnd(18)} 前σ${f2(pre.std)} → ${d ? 'skew' : 'none'} σ${f2(afterDeskew.std)} R${f2(afterDeskew.range)}  ` +
        `σ${f2(proto.std)} R${f2(proto.range)} ${note.padEnd(24)} σ${f2(ideal.std)}`,
    )
  }

  /* ── 真实条件鲁棒性 ─────────────────────────────────────────────────────
   * 上面全是合成图。真实拍照会有手写混排、失焦模糊、光照不均——
   * 其中**模糊最危险**：笔画粘连会让连通分量把多行并成一块 → 行数不足 → 漏修。
   * 这里量化每种条件下的退化程度（宁可漏修，也不能误修）。
   */
  console.log('\n── 鲁棒性：侧拍(强) + 各种真实干扰 ──')
  console.log('条件              检测行数  beforeσ  afterσ  结果')
  const per = [[10, 60], [W - 10, 5], [W - 10, H - 5], [10, H - 60]]
  const variants: { name: string; src: () => Promise<Buffer> }[] = [
    { name: '清晰(对照)', src: () => sharp(sheetSvg(W, H, ROWS, { hand: false })).png().toBuffer() },
    { name: '+手写混排', src: () => sharp(sheetSvg(W, H, ROWS, { hand: true })).png().toBuffer() },
    { name: '+光照渐变', src: () => sharp(sheetSvg(W, H, ROWS, { hand: false, gradient: true })).png().toBuffer() },
    { name: '+模糊σ=0.8', src: async () => sharp(await sharp(sheetSvg(W, H, ROWS, { hand: false })).png().toBuffer()).blur(0.8).png().toBuffer() },
    { name: '+模糊σ=1.5', src: async () => sharp(await sharp(sheetSvg(W, H, ROWS, { hand: false })).png().toBuffer()).blur(1.5).png().toBuffer() },
    { name: '手写+模糊+渐变', src: async () => sharp(await sharp(sheetSvg(W, H, ROWS, { hand: true, gradient: true })).png().toBuffer()).blur(1.0).png().toBuffer() },
  ]
  for (const v of variants) {
    const src = await v.src()
    const q = await embedPerspective(src, W, H, per, 0)
    const det = await detectRows(q)
    let line = `${v.name.padEnd(16)} ${String(det.length).padStart(6)}  `
    if (det.length < 3) { console.log(line + '   —     —     行数不足，安全放弃'); continue }
    const before = stdOf(det)
    const c = cornersFromRows(det, W, H)
    if (!c) { console.log(line + '   —     —     四角估计失败'); continue }
    const r = await dewarpBuffer(q, c)
    const after = stdOf(await detectRows(r.buffer))
    const verdict = after < before ? `修正 ${f2(before)}→${f2(after)}°` : `未改善(${f2(after)}°)，回退`
    console.log(`${v.name.padEnd(16)} ${String(det.length).padStart(6)}  ${f2(before)}°  ${f2(after)}°   ${verdict}`)
  }
}

/** 各行倾角（度）的标准差 */
function stdOf(rows: Row[]): number {
  const a = rows.map((r) => (Math.atan(r.k) * 180) / Math.PI)
  if (a.length < 2) return 0
  const m = a.reduce((s, v) => s + v, 0) / a.length
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length)
}

main().catch((e) => { console.error(e); process.exit(1) })
