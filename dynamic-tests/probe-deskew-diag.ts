/**
 * 【问题二 · 自动调正】诊断探针
 *
 * 目的：用**可解析的 ground truth** 量化当前 `estimateSkew`（投影轮廓法）的真实能力边界，
 *       而不是拿被测算法自己的目标函数自证好坏（Σhist² 是它自己优化的量，不能当指标）。
 *
 * ── 指标设计（关键）──────────────────────────────────────────────────────────
 * 「自动调正」的成败最终体现在**文本行是否水平**。所以我预先在正面图上定义 N 条
 * 水平文本行，把它们当作**已知几何**；我亲手施加变换 T（旋转 / 透视 / 组合），
 * 于是每条行在畸变图里的方向向量可以**解析算出**（不经过任何图像分析）。
 * 算法输出 rotateDeg=φ 后，把该行方向再旋转 φ，得到**残留倾角**。
 *
 *   - 纯旋转族：真理只有一个角 θ，指标 = |θ_est + θ|（度）
 *   - 含透视族：透视让**不同行有不同斜率**（都收敛到消失点），单一旋转不可能
 *     同时摆平所有行 → 指标 = 残留倾角的 **极差(range)** 与 **std**
 *     （这正是领域共识："透视破坏文本行之间的平行性，PP/HT/NN 的旋转假设失效"）
 *
 * ── 为什么不用「投影轮廓尖锐度」当指标 ──────────────────────────────────────
 * 那个量正是 estimateSkew 的置信度来源，用它评价自己等于循环论证。
 *
 * 运行：cd /workspace/projects/server && npx tsx /workspace/dynamic-tests/probe-deskew-diag.ts
 */
import sharp from 'sharp'
import { estimateSkew, deskewImage } from '/workspace/projects/server/src/image/image-deskew'
import { detectCornersCV } from '/workspace/projects/server/src/image/image-corners'
import { straightenImage } from '/workspace/projects/server/src/image/image-dewarp'

const W = 900
const H = 1200
const ROWS = 8
// 行距 = 图高/条带数 → 保证「一个测量条带恰好一行」。
// 曾经用 130（与条带 150 不对齐）→ 条带里混入第二行，基线噪声地板 σ=2.2°，
// 大到和真实畸变同量级，测量完全失去分辨力。
const ROW_H = 150
const ROW_X0 = 80
const ROW_X1 = 820

/** 正面试卷：印刷题干 + 手写作答 + 横线（三者混排，接近真实试卷） */
function sheetSvg(opts: { gradient?: boolean; hand?: boolean } = {}): Buffer {
  const { gradient = false, hand = true } = opts
  let layers = ''
  // 印刷题干行（含中文 + 数字 + 英文下伸字母）
  for (let i = 0; i < ROWS; i++) {
    const y = 75 + i * ROW_H
    layers +=
      `<text x="${ROW_X0}" y="${y}" font-family="serif" font-size="22" fill="#111">` +
      `第 ${i + 1} 题 (page ${i + 1})：请根据题意作答，good luck.</text>` +
      `<line x1="${ROW_X0}" y1="${y + 18.5}" x2="${ROW_X1}" y2="${y + 18.5}" stroke="#bbb" stroke-width="1"/>`
  }
  // 手写作答（蓝色圆珠笔色，字号略大、位置在横线上）
  if (hand) {
    for (let i = 0; i < ROWS; i++) {
      layers +=
        `<text x="150" y="${153 + i * ROW_H}" font-family="serif" font-size="30" fill="#2b4a9b">` +
        `解答：${36 + i} 厘米</text>`
    }
  }
  // 光照不均：从左到右的明暗渐变（手机拍照最常见的干扰）
  const grad =
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">' +
    '<stop offset="0" stop-color="#000" stop-opacity="0"/>' +
    '<stop offset="1" stop-color="#000" stop-opacity="0.22"/></linearGradient></defs>' +
    `<rect width="${W}" height="${H}" fill="url(#g)"/>`
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<rect width="${W}" height="${H}" fill="#fdfdfa"/>${layers}${gradient ? grad : ''}</svg>`,
  )
}

/* ────────────────────────── 独立的 ground-truth 生成器 ──────────────────────────
 * 刻意**不复用**被测代码（image-dewarp 的 solveHomography/warpRaw），
 * 否则就是用被测实现去验证被测实现。
 */
function solveH(src: number[][], dst: number[][]): number[] {
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]
    const [X, Y] = dst[i]
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
const applyH = (H: number[], x: number, y: number): [number, number] => {
  const d = H[6] * x + H[7] * y + 1
  return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d]
}

/** 把正面矩形图"贴"到目标四角上 → 得到一张模拟斜拍/透视的照片 */
async function embedPerspective(
  srcBuf: Buffer, sw: number, sh: number, corners: number[][], cw: number, ch: number,
): Promise<Buffer> {
  const { data, info } = await sharp(srcBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const k = info.channels
  // Q -> P 的反向映射（对输出像素求源坐标）
  const Hinv = solveH(corners, [[0, 0], [sw, 0], [sw, sh], [0, sh]])
  const out = Buffer.alloc(cw * ch * k, 253)
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
        const top = v00 * (1 - fx) + v10 * fx
        const bot = v01 * (1 - fx) + v11 * fx
        out[o + c] = Math.round(top * (1 - fy) + bot * fy)
      }
    }
  }
  return sharp(out, { raw: { width: cw, height: ch, channels: k } }).png().toBuffer()
}

/** 把一条水平行的方向向量 (1,0) 依次经过：透视 H → 旋转 θ → 算法旋转 φ，返回最终倾角(度) */
function residualDeg(H: number[] | null, y: number, theta: number, phi: number): number {
  let dx = 1, dy = 0
  if (H) {
    const [ax, ay] = applyH(H, 0, y) // 行左端（透视下坐标原点已平移，但方向只取差分）
    const [bx, by] = applyH(H, W, y)
    dx = bx - ax; dy = by - ay
  }
  const rot = (a: number) => {
    const r = (a * Math.PI) / 180
    const nx = dx * Math.cos(r) - dy * Math.sin(r)
    const ny = dx * Math.sin(r) + dy * Math.cos(r)
    dx = nx; dy = ny
  }
  rot(theta)
  rot(phi)
  return (Math.atan2(dy, dx) * 180) / Math.PI
}

const stats = (a: number[]) => {
  const mean = a.reduce((s, v) => s + v, 0) / a.length
  const std = Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / a.length)
  return { mean, std, min: Math.min(...a), max: Math.max(...a), range: Math.max(...a) - Math.min(...a) }
}
const f2 = (n: number) => n.toFixed(2).padStart(7)

/**
 * 独立测量仪：把图切成 `bands` 个水平条带，每条带内墨迹点求协方差矩阵的**主轴方向**，
 * 即该条带处文本行的走向。返回各行倾角（度）。
 *
 * 与被测算法零共用代码 —— 用它评价 estimateSkew 才不是循环论证。
 */
async function rowSlopesByBand(buf: Buffer, bands: number): Promise<number[]> {
  const { data, info } = await sharp(buf).grayscale().raw().toBuffer({ resolveWithObject: true })
  const w = info.width, h = info.height
  const hist = new Int32Array(256)
  for (let i = 0; i < data.length; i++) hist[data[i]]++
  let thr = 127, sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let wB = 0, sumB = 0, maxVar = -1
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    const wF = data.length - wB
    if (!wB || !wF) break
    sumB += t * hist[t]
    const v = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2
    if (v > maxVar) { maxVar = v; thr = t }
  }
  const bandH = Math.floor(h / bands)
  const out: number[] = []
  for (let b = 0; b < bands; b++) {
    const y0 = b * bandH, y1 = b === bands - 1 ? h : (b + 1) * bandH
    // 对每个 x 求条带内墨迹的 y 质心 → (x, ȳ) 点列 → 最小二乘直线。
    // 比「条带 PCA」稳健：PCA 测的是点云主轴，会被条带内混入的第二行和字符
    // 自身的横向分布带偏（实测噪声地板 σ=2.2°，掩盖真实信号）；
    // 列质心回归直接测「行中心随 x 的漂移」，正是"行歪不歪"的定义。
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

/* ────────────────────────────────── 主流程 ────────────────────────────────── */
async function main() {
  const basePng = await sharp(sheetSvg()).png().toBuffer()
  // 正面图里每条文本行的 y（印刷题干基线）
  const rowYs = Array.from({ length: ROWS }, (_, i) => 100 + i * ROW_H)

  console.log('\n══════ 实验 A：纯旋转（无透视）—— 检验 PP 法本身的精度 ══════')
  console.log('真实θ   估计φ   误差=|φ+θ|  置信度  deskewImage是否出手')
  for (const theta of [-12, -7, -3, -1, 1, 3, 7, 12]) {
    const q = await sharp(basePng).rotate(theta, { background: '#fdfdfa' }).png().toBuffer()
    const est = await estimateSkew(q)
    const d = await deskewImage(q)
    const err = Math.abs(est.rotateDeg + theta)
    console.log(
      `${String(theta).padStart(5)}° ${f2(est.rotateDeg)}° ${f2(err)}° ${est.confidence.toFixed(3).padStart(7)}   ` +
        `${d ? `是 (${d.rotateDeg}°)` : '否 ← 点了没反应'}${err > 1 ? '  ⚠️' : ''}`,
    )
  }

  console.log('\n══════ 实验 B：纯透视（纸面占满画面，无旋转）—— 旋转假设是否失效 ══════')
  console.log('（真理：每行斜率各不相同、收敛于消失点，单一旋转不可能同时摆平）')
  console.log('场景                     估计φ   置信度  残留倾角: 均值    std    极差')
  const perspScenes: { name: string; corners: number[][] }[] = [
    { name: '无畸变(对照)', corners: [[0, 0], [W, 0], [W, H], [0, H]] },
    { name: '轻微上窄下宽', corners: [[30, 15], [W - 30, 15], [W - 5, H - 5], [5, H - 5]] },
    { name: '中度上窄下宽', corners: [[70, 35], [W - 70, 35], [W - 5, H - 5], [5, H - 5]] },
    { name: '左窄右宽(侧拍)', corners: [[10, 40], [W - 10, 5], [W - 10, H - 5], [10, H - 40]] },
    { name: '四角各自偏移', corners: [[45, 25], [W - 20, 55], [W - 55, H - 30], [20, H - 60]] },
  ]
  for (const s of perspScenes) {
    const q = await embedPerspective(basePng, W, H, s.corners, W, H)
    const est = await estimateSkew(q)
    const Hfwd = solveH([[0, 0], [W, 0], [W, H], [0, H]], s.corners)
    const res = rowYs.map((y) => residualDeg(Hfwd, y, 0, est.rotateDeg))
    const st = stats(res)
    console.log(
      `${s.name.padEnd(22)} ${f2(est.rotateDeg)}° ${est.confidence.toFixed(3).padStart(7)}   ` +
        `${f2(st.mean)}° ${f2(st.std)}° ${f2(st.range)}°${st.range > 1 ? '  ⚠️ 行间不平行的残留' : ''}`,
    )
  }

  console.log('\n══════ 实验 C：旋转 + 透视（真实拍照形态）══════')
  console.log('场景                 真实θ  估计φ  角度误差  残留倾角: 均值    std    极差')
  for (const s of [perspScenes[2], perspScenes[4]]) {
    for (const theta of [-5, 3]) {
      const emb = await embedPerspective(basePng, W, H, s.corners, W, H)
      const q = await sharp(emb).rotate(theta, { background: '#fdfdfa' }).png().toBuffer()
      const est = await estimateSkew(q)
      const Hfwd = solveH([[0, 0], [W, 0], [W, H], [0, H]], s.corners)
      const res = rowYs.map((y) => residualDeg(Hfwd, y, theta, est.rotateDeg))
      const st = stats(res)
      const angErr = Math.abs(est.rotateDeg + theta)
      console.log(
        `${s.name.padEnd(20)} ${String(theta).padStart(5)}° ${f2(est.rotateDeg)}° ${f2(angErr)}°   ` +
          `${f2(st.mean)}° ${f2(st.std)}° ${f2(st.range)}°${st.range > 1 ? '  ⚠️' : ''}`,
      )
    }
  }

  console.log('\n══════ 实验 D：鲁棒性（光照渐变 / 拍照模糊 / 无手写）══════')
  console.log('场景                     真实θ  估计φ  误差     置信度  deskewImage')
  const variants: { name: string; buf: Promise<Buffer> }[] = [
    { name: '清晰(对照)', buf: Promise.resolve(basePng) },
    { name: '光照渐变', buf: sharp(sheetSvg({ gradient: true })).png().toBuffer() },
    { name: '模糊σ=0.8', buf: sharp(basePng).blur(0.8).png().toBuffer() },
    { name: '模糊σ=1.5', buf: sharp(basePng).blur(1.5).png().toBuffer() },
    { name: '无手写(纯印刷)', buf: sharp(sheetSvg({ hand: false })).png().toBuffer() },
  ]
  for (const v of variants) {
    const src = await v.buf
    for (const theta of [-4]) {
      const q = await sharp(src).rotate(theta, { background: '#fdfdfa' }).png().toBuffer()
      const est = await estimateSkew(q)
      const d = await deskewImage(q)
      console.log(
        `${v.name.padEnd(22)} ${String(theta).padStart(5)}° ${f2(est.rotateDeg)}° ` +
          `${f2(Math.abs(est.rotateDeg + theta))}° ${est.confidence.toFixed(3).padStart(7)}  ` +
          `${d ? `是(${d.rotateDeg}°)` : '否 ← 点了没反应'}`,
      )
    }
  }

  /* ───────────────────────────────────────────────────────────────────────────
   * 【独立测量仪】条带 PCA 主轴 —— 回答唯一重要的问题："输出图里的字到底正不正"
   *
   * 刻意不复用 estimateSkew（它优化 Σhist²，用它评价自己＝循环论证）。
   * 做法：把图切成水平条带 → 每条带内墨迹点求协方差 → 最大特征向量的方向 = 该处
   *       文本行的走向（这是标准的行方向估计，与被测算法无任何共用代码）。
   */
  console.log('\n══════ 实验 F：端到端 straightenImage —— 输出图的文字行实际有多正 ══════')
  console.log('（指标＝条带列质心回归倾角；|均值| 越小越正，std/极差 越大=透视残留越大）')
  console.log('场景                     路径    输出尺寸        行倾角: 均值    std    极差')

  // 测量用**纯印刷**图（无手写）：条带 PCA 会被"手写+印刷"两个方向的墨迹污染，
  // 噪声掩盖真实信号。另加"旋转 -6°"这一纯旋转场景作为对照（它本应被完全修正）。
  const cleanPng = await sharp(sheetSvg({ hand: false })).png().toBuffer()
  const rotOnly = await sharp(cleanPng).rotate(-6, { background: '#fdfdfa' }).png().toBuffer()

  const baseSt = stats(await rowSlopesByBand(cleanPng, ROWS))
  console.log(
    `  ── 基线（无畸变原图）${' '.repeat(12)}900x1200`.padEnd(46) +
      `${f2(baseSt.mean)}° ${f2(baseSt.std)}° ${f2(baseSt.range)}°   ← 测量噪声地板`,
  )

  const cases: { name: string; buf: Buffer }[] = [
    { name: '纯旋转-6°(对照)', buf: rotOnly },
    ...perspScenes.slice(1).map((s) => ({ name: s.name, buf: null as unknown as Buffer, scene: s })),
  ]
  for (const c of cases) {
    if (!c.buf) continue
  }
  for (const s of perspScenes.slice(1)) {
    for (const withDesk of [false, true]) {
      let q = await embedPerspective(cleanPng, W, H, s.corners, W, H)
      if (withDesk) {
        q = await sharp(q).extend({ top: 60, bottom: 60, left: 60, right: 60, background: '#3a3a3a' }).png().toBuffer()
      }
      const pre = stats(await rowSlopesByBand(q, ROWS))
      const out = await straightenImage(q, { auto: true })
      const buf = out.buffer ?? q
      const m = await sharp(buf).metadata()
      const post = stats(await rowSlopesByBand(buf, ROWS))
      const tag = `${s.name}${withDesk ? '+桌面' : '(满画面)'}`
      const path = out.needManual ? 'none' : (out.method ?? '?')
      // 改善率：把"处理前偏离基线的量"修掉了多少（100% = 完全回到基线水平）
      const fix = (a: number, b: number) =>
        Math.abs(b - baseSt.range) < 1e-9 ? 0 : ((a - b) / (a - baseSt.range)) * 100
      console.log(
        `${tag.padEnd(24)} ${path.padEnd(6)} ${String(m.width)}x${String(m.height)}  ` +
          `前[μ${f2(pre.mean)} σ${f2(pre.std)} R${f2(pre.range)}] ` +
          `后[μ${f2(post.mean)} σ${f2(post.std)} R${f2(post.range)}] ` +
          `极差修正 ${fix(pre.range, post.range).toFixed(0).padStart(4)}%`,
      )
    }
  }
  {
    const pre = stats(await rowSlopesByBand(rotOnly, ROWS))
    const out = await straightenImage(rotOnly, { auto: true })
    const buf = out.buffer ?? rotOnly
    const m = await sharp(buf).metadata()
    const post = stats(await rowSlopesByBand(buf, ROWS))
    console.log(
      `纯旋转-6°(对照)         ${(out.method ?? 'none').padEnd(6)} ${String(m.width)}x${String(m.height)}  ` +
        `前[μ${f2(pre.mean)} σ${f2(pre.std)} R${f2(pre.range)}] ` +
        `后[μ${f2(post.mean)} σ${f2(post.std)} R${f2(post.range)}]`,
    )
  }

  console.log('\n══════ 实验 G：deskew 的输出副作用（画布膨胀 / 反复调正）══════')
  let cur = await sharp(basePng).rotate(-6, { background: '#fdfdfa' }).png().toBuffer()
  for (let i = 1; i <= 3; i++) {
    const before = await sharp(cur).metadata()
    const r = await deskewImage(cur)
    if (!r) { console.log(`第 ${i} 次：deskewImage 返回 null（不再变动）`); break }
    console.log(
      `第 ${i} 次：${before.width}x${before.height} → ${r.width}x${r.height}  ` +
        `面积 ${((r.width * r.height) / (before.width * before.height)).toFixed(3)}×  施加 ${r.rotateDeg}°`,
    )
    cur = r.buffer
  }

  console.log('\n══════ 实验 E：四角检测命中率（detectCornersCV）══════')
  for (const s of perspScenes) {
    const q = await embedPerspective(basePng, W, H, s.corners, W, H)
    // 纸面占满画面：四边形外侧填深色桌面 —— 模拟"画面里能看到纸边"
    const withDesk = await sharp(q)
      .extend({ top: 60, bottom: 60, left: 60, right: 60, background: '#3a3a3a' })
      .png()
      .toBuffer()
    const hitFill = await detectCornersCV(q)
    const hitDesk = await detectCornersCV(withDesk)
    const gt = s.corners.map((c) => `[${c[0]},${c[1]}]`).join(' ')
    console.log(
      `${s.name.padEnd(22)} 纸面占满:${hitFill ? '命中' : '未命中'}  ·  有桌面背景:${hitDesk ? '命中' : '未命中'}` +
        (hitDesk ? `  检测=${hitDesk.map((c) => `[${Math.round(c[0])},${Math.round(c[1])}]`).join('')} 真理=${gt}` : ''),
    )
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
