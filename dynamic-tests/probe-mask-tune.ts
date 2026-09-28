/**
 * 探针 P2：借鉴领域方法论的 mask 改造 —— 参数网格实验（离线试错，不改生产代码）
 *
 * ── 要借鉴的三条领域方法论 ──────────────────────────────────────────────────
 * ① 多尺度感受野（ExamCleaner 的 ILKC：Inception Large Kernel Convolution）
 *    原实现只在 ±2 列的**单尺度**邻域里取纵向跨度 → 汉字内部结构复杂
 *    （「厘」「解」横笔多，单列游程被切断），大量笔画取不到种子 → 召回仅 68%。
 *    改为多尺度 {2,4,8,16} 取最大，模拟大核卷积的多感受野。
 *
 * ② 软 mask / 连续置信度（百度网盘手写擦除冠军方案）
 *    冠军方案的 mask 定义：与原图差异 >20 置 1，<20 **归一化**（不是直接丢 0）。
 *    原实现是硬阈值 `>= tallTh ? 255 : 0` → 边界笔画要不全要、要不不要，
 *    既掉召回又产生硬边。改为在 [lo,hi] 区间线性归一化到 0~255。
 *
 * ③ 真形态学膨胀（WPI_inpainting 用 MaxPool 膨胀；LaMa 流程明确「必须膨胀以捕获
 *    抗锯齿半透明边缘，否则残留鬼影」）
 *    原实现是 `blur + 阈值 24`，对细笔画净效果可能是**腐蚀**。改为真 max-filter。
 *
 * 本脚本离线扫参，找到「召回↑ 且 精确率不塌 且 反例仍 0%」的组合，再落地到生产代码。
 *
 * 运行：cd /workspace/projects/server && npx tsx /workspace/dynamic-tests/probe-mask-tune.ts
 */
import sharp from 'sharp'

const W = 900
const H = 1200
const PRINT_FS = 22
const HAND_YS = [152, 308, 464, 620]
const WORK_MAX = 1200

// ───────────────────────── fixture ─────────────────────────
//
// ⚠️ 版面设计（此前版本的坑）：旧 fixture 把手写（fs=44, baseline 148）直接压在
//    印刷文字（108~137）与横线（152）上，于是「误擦印刷体」天然 50%+，掩盖了算法
//    真实表现。真实试卷里学生答案多写在**题目之间的空白处**，压字是少数困难场景。
//    现按每组 140px 重排，两种场景分开测：
//      · 空白区作答(A)：手写 baseline 178，fs=42 → 占 136~188，与横线(118)留 18px
//      · 压字作答(B)  ：手写 baseline 108，fs=42 → 占 66~118，与印刷文字重叠
const GROUPS = 7
const ROW_H = 140
const PRINT_BASE = (i: number) => 100 + i * ROW_H // fs=22 → 占 78~107
const RULE_Y = (i: number) => 118 + i * ROW_H
const HAND_BASE_A = (i: number) => 178 + i * ROW_H // 空白区场景
const HAND_BASE_B = (i: number) => 108 + i * ROW_H // 压字场景

function printedLayer(): string {
  return Array.from(
    { length: GROUPS },
    (_, i) =>
      `<text x="80" y="${PRINT_BASE(i)}" font-family="serif" font-size="${PRINT_FS}" fill="#111">` +
      `一、填空题 第 ${i + 1} 题：请根据题意把答案写在下面的横线上。` +
      `</text><line x1="80" y1="${RULE_Y(i)}" x2="820" y2="${RULE_Y(i)}" stroke="#bbb" stroke-width="1"/>`,
  ).join('')
}

/** mode: 'A' 空白区作答 / 'B' 压字作答 */
function svgFull(handColor: string, handFs: number, label: string, mode: 'A' | 'B'): string {
  const base = mode === 'A' ? HAND_BASE_A : HAND_BASE_B
  const hand = Array.from(
    { length: GROUPS },
    (_, i) =>
      `<text x="150" y="${base(i)}" font-family="serif" font-size="${handFs}" fill="${handColor}">${label} ${i + 1}</text>`,
  ).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#fdfdfa"/>${printedLayer()}${hand}</svg>`
}
/** 只有印刷体（白底）→ 用于构造「禁区」：检测 mask 压到印刷体墨迹 = 误擦 */
function svgPrintOnly(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#fdfdfa"/>${printedLayer()}</svg>`
}
function svgHandOnly(handColor: string, handFs: number, label: string, mode: 'A' | 'B'): string {
  const base = mode === 'A' ? HAND_BASE_A : HAND_BASE_B
  const hand = Array.from(
    { length: GROUPS },
    (_, i) =>
      `<text x="150" y="${base(i)}" font-family="serif" font-size="${handFs}" fill="${handColor}">${label} ${i + 1}</text>`,
  ).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#fff"/>${hand}</svg>`
}

async function groundTruth(handOnlyPng: Buffer, dilate = 2): Promise<Uint8Array> {
  const g = await sharp(handOnlyPng).grayscale().raw().toBuffer()
  const n = W * H
  let cur = new Uint8Array(n)
  for (let i = 0; i < n; i++) cur[i] = g[i] < 200 ? 1 : 0
  for (let d = 0; d < dilate; d++) {
    const next = new Uint8Array(n)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let v = cur[y * W + x]
        if (v) { next[y * W + x] = 1; continue }
        for (let dy = -1; dy <= 1 && !v; dy++) {
          const ny = y + dy
          if (ny < 0 || ny >= H) continue
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx
            if (nx < 0 || nx >= W) continue
            if (cur[ny * W + nx]) { v = 1; break }
          }
        }
        next[y * W + x] = v
      }
    cur = next
  }
  return cur
}

// ───────────────────────── 被测算法（可切换开关） ─────────────────────────
interface TuneOpts {
  /** 多尺度邻域半径集合；单元素 = 退化为原实现的单尺度 */
  scales: number[]
  /** 软阈值区间（相对字高的倍数）；lo===hi 表示硬阈值 */
  lo: number
  hi: number
  /** 行分割后合并相邻行的最大间隙（像素） */
  gapMerge: number
  /** 字高估计方式：
   *   'band'   = 行投影文本带中位数（现状，实测在稀疏手写行崩塌）
   *   'colSpan'= 列向最长**连续游程**分位数（实测也崩：汉字非实心，游程≠字高）
   *   'rowSpan'= 行分割后的**行高**分位数（低阈值分割+合并间隙，最贴近真实字高） */
  glyphMode: 'band' | 'colSpan' | 'rowSpan'
  /** colSpan 分位数（越大越偏手写，越小越偏印刷） */
  glyphQ: number
  /** 检测范式：'stroke'=逐笔画(纵向游程超字高，只能检出竖笔) / 'row'=行级分类(行高显著大于印刷行→整行判为手写) */
  detectMode: 'stroke' | 'row'
  /** row 模式下：行高 ≥ glyphH×rowRatio 的行判为手写行 */
  rowRatio: number
  /** row 模式下：候选行墨迹横向跨度 > 页宽×spanGuard 则判为"印刷大标题"排除（0=关闭） */
  spanGuard: number
  /** row 模式下：候选行墨迹密度(ink像素/(行高×横向跨度)) > 该值 判为"印刷"排除。
   *  ⭐ 这是区分「大号印刷标题」与「手写行」的关键——两者行高都大，**仅靠行高本质上不可分**，
   *     但印刷体笔画规整、字面填满，墨迹密度显著高于手写，且该特征**对字号不敏感**。 */
  densityGuard: number
  /** 生长方式：'box'=方形膨胀(会跨过空白污染邻近印刷体) / 'ink'=只在墨迹连通域内测地扩散 */
  growMode: 'box' | 'ink'
  /** 生长步数（相对字高倍数）；ink 模式下为测地扩散的像素步数 */
  grow: number
  /** ink 模式下每步的置信度衰减（<1 会产生自然的软边缘，正是领域要的软 mask） */
  decay: number
  /** 候选门限：膨胀后的置信度 ≥ 该值才纳入候选（防止软阈值无限放宽候选范围） */
  seedMin: number
  /** 护栏：候选墨迹 / 全部墨迹 超过该比例则整条路径作废 */
  shareGuard: number
  /** 真膨胀半径（像素，0=不膨胀） */
  dilate: number
  /** 羽化半径（像素，0=硬边） */
  feather: number
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * 方形结构元膨胀（max-filter）。
 *
 * ⚠️ 必须**可分离**实现：先横向一趟、再纵向一趟，等价于 (2r+1)×(2r+1) 方形膨胀，
 * 但复杂度从 O(r²) 降到 O(r)。实测 r=17 时朴素版在 1200×900 上要 1.3B 次操作
 * （跑 2 分钟不出结果），可分离版降到 ~37M 次（约 0.2s）。
 */
function maxFilter(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return src
  // 横向
  const tmp = new Uint8Array(src.length)
  for (let y = 0; y < h; y++) {
    const base = y * w
    for (let x = 0; x < w; x++) {
      let m = 0
      const x0 = x - r < 0 ? 0 : x - r
      const x1 = x + r >= w ? w - 1 : x + r
      for (let nx = x0; nx <= x1; nx++) {
        const v = src[base + nx]
        if (v > m) m = v
      }
      tmp[base + x] = m
    }
  }
  // 纵向
  const out = new Uint8Array(src.length)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 0
      const y0 = y - r < 0 ? 0 : y - r
      const y1 = y + r >= h ? h - 1 : y + r
      for (let ny = y0; ny <= y1; ny++) {
        const v = tmp[ny * w + x]
        if (v > m) m = v
      }
      out[y * w + x] = m
    }
  }
  return out
}

/** 横向一维 max-filter（Uint16），用于多尺度邻域跨度 */
function maxFilterU16Row(src: Uint16Array, w: number, h: number, r: number): Uint16Array {
  const out = new Uint16Array(src.length)
  if (r <= 0) { out.set(src); return out }
  for (let y = 0; y < h; y++) {
    const base = y * w
    for (let x = 0; x < w; x++) {
      let m = 0
      const x0 = x - r < 0 ? 0 : x - r
      const x1 = x + r >= w ? w - 1 : x + r
      for (let nx = x0; nx <= x1; nx++) {
        const v = src[base + nx]
        if (v > m) m = v
      }
      out[base + x] = m
    }
  }
  return out
}

/** 盒式模糊（用于羽化），可重复若干次近似高斯 */
function boxBlur(src: Float32Array, w: number, h: number, r: number, passes = 2): Float32Array {
  let cur = src
  for (let p = 0; p < passes; p++) {
    const tmp = new Float32Array(cur.length)
    // 横向
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0
        for (let d = -r; d <= r; d++) {
          const nx = x + d
          if (nx < 0 || nx >= w) continue
          s += cur[y * w + nx]; n++
        }
        tmp[y * w + x] = s / n
      }
    const out = new Float32Array(cur.length)
    // 纵向
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0
        for (let d = -r; d <= r; d++) {
          const ny = y + d
          if (ny < 0 || ny >= h) continue
          s += tmp[ny * w + x]; n++
        }
        out[y * w + x] = s / n
      }
    cur = out
  }
  return cur
}

async function tuneDarkInk(
  buf: Buffer,
  o: TuneOpts,
): Promise<{ mask: Uint8Array; w: number; h: number; debug: Record<string, unknown> }> {
  const meta = await sharp(buf).metadata()
  const W0 = meta.width || 0
  const H0 = meta.height || 0
  const scale = Math.min(1, WORK_MAX / Math.max(W0, H0))
  const w = Math.max(1, Math.round(W0 * scale))
  const h = Math.max(1, Math.round(H0 * scale))
  const gray = await sharp(buf).resize(w, h, { fit: 'fill' }).grayscale().raw().toBuffer()

  // Otsu
  const hist = new Int32Array(256)
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0, wB = 0, maxVar = -1, thr = 127
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = gray.length - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > maxVar) { maxVar = between; thr = t }
  }
  const ink = new Uint8Array(w * h)
  let inkTotal = 0
  for (let i = 0; i < gray.length; i++) if (gray[i] < thr) { ink[i] = 1; inkTotal++ }
  if (inkTotal < 50) return { mask: new Uint8Array(W0 * H0), w: W0, h: H0, debug: { reason: 'no_ink' } }

  // 逐像素纵向游程长度 runLen（像素所在游程的长度）
  // ⚠️ 必须在字高估计**之前**算：新的 colSpan 字高估计法依赖它。
  const runLen = new Uint16Array(w * h)
  for (let x = 0; x < w; x++) {
    let y = 0
    while (y < h) {
      if (!ink[y * w + x]) { y++; continue }
      let y0 = y
      while (y < h && ink[y * w + x]) y++
      const L = y - y0
      for (let k = y0; k < y; k++) runLen[k * w + x] = L
    }
  }

  // ── 字高估计 ────────────────────────────────────────────────────────────
  // ⚠️⚠️ 实测根因（探针 P3）：'band' 法在最常见的输入形态下会崩塌。
  //   行投影的 bandTh = maxRow*0.25，而手写行笔画稀疏、行投影峰值低于该阈值 →
  //   手写行被切成 3~10px 的**碎片带**，把中位数拉到 6（真实印刷字高 19）。
  //   于是 tallTh=9，几乎全部墨迹都"超字高" → 种子泛滥 → share=0.94 → 护栏必然触发
  //   → 功能等价于不存在。
  //   'colSpan' 法改用**笔画级**统计：每列的最长纵向游程 ≈ 该列穿过的字高，
  //   不受行投影切断影响，且印刷列占多数 → 分位数稳定落在印刷字高上。
  // 行投影（rowSpan / band 两种字高估计都用）
  const rowProfile = new Int32Array(h)
  for (let y = 0; y < h; y++) {
    let c = 0
    for (let x = 0; x < w; x++) if (ink[y * w + x]) c++
    rowProfile[y] = c
  }
  let maxRow = 0
  for (let y = 0; y < h; y++) if (rowProfile[y] > maxRow) maxRow = rowProfile[y]

  // 行分割：低阈值（只要该行有墨迹即算行内）+ 合并小间隙。
  // 供 rowSpan 字高估计与 row 级检测范式共用。
  const rowTh = Math.max(1, Math.round(maxRow * 0.05))
  const segs: Array<{ y0: number; y1: number }> = []
  {
    let y = 0
    while (y < h) {
      if (rowProfile[y] < rowTh) { y++; continue }
      const y0 = y
      while (y < h && rowProfile[y] >= rowTh) y++
      segs.push({ y0, y1: y })
    }
  }
  const merged: Array<{ y0: number; y1: number }> = []
  for (const s of segs) {
    const last = merged[merged.length - 1]
    if (last && s.y0 - last.y1 <= o.gapMerge) last.y1 = s.y1
    else merged.push({ y0: s.y0, y1: s.y1 })
  }

  let glyphH = 0
  if (o.glyphMode === 'rowSpan') {
    const heights = merged.map((s) => s.y1 - s.y0).filter((v) => v >= 3).sort((a, b) => a - b)
    if (heights.length) glyphH = heights[Math.floor(heights.length * o.glyphQ)] || 8
  } else if (o.glyphMode === 'colSpan') {
    const colSpan: number[] = []
    for (let x = 0; x < w; x++) {
      let m = 0
      for (let y = 0; y < h; y++) {
        const v = runLen[y * w + x]
        if (v > m) m = v
      }
      if (m > 0) colSpan.push(m)
    }
    if (colSpan.length) {
      colSpan.sort((a, b) => a - b)
      glyphH = colSpan[Math.floor(colSpan.length * o.glyphQ)] || 8
    }
  } else {
    const bandTh = Math.max(2, maxRow * 0.25)
    const bands: number[] = []
    {
      let run = 0
      for (let y = 0; y <= h; y++) {
        const on = y < h && rowProfile[y] >= bandTh
        if (on) run++
        else if (run > 0) { bands.push(run); run = 0 }
      }
    }
    if (bands.length >= 2) {
      const s = bands.slice().sort((a, b) => a - b)
      glyphH = s[s.length >> 1]
    }
    if (glyphH < 6) {
      const runs: number[] = []
      for (let x = 0; x < w; x++) {
        let run = 0
        for (let y = 0; y <= h; y++) {
          const on = y < h && ink[y * w + x] === 1
          if (on) run++
          else if (run > 0) { runs.push(run); run = 0 }
        }
      }
      if (runs.length) {
        runs.sort((a, b) => a - b)
        glyphH = runs[Math.floor(runs.length * 0.9)] || 8
      }
    }
  }
  glyphH = Math.max(6, glyphH)

  // ① 种子生成
  // ── 'stroke'：逐笔画判据（多尺度邻域最大 runLen 超字高）。缺陷（实测）：
  //    只认**竖直笔画**，手写的横笔 runLen 天然小 → 召回天花板约 66%。
  //    ⚠️ 必须用「逐像素 runLen」而不是「整列 colSpan」——后者是整列的全局最长，
  //    与该像素是否真处于长笔画无关，会把种子判据放得过宽，直接触发 share_guard
  //    护栏导致整条路径作废（实测：改用 colSpan 后所有场景归零）。
  // ── 'row'：行级分类（文档分析的标准范式：文本行检测 → 行级分类）。
  //    行高 ≥ 印刷字高 × rowRatio 的行整体判为手写行，行内墨迹全取种子。
  //    手写通常整行都比印刷行高，因此这一判据能覆盖**所有笔画方向**。
  const seedConf = new Uint8Array(w * h)
  let seedCount = 0
  if (o.detectMode === 'row') {
    const rowLimit = glyphH * o.rowRatio
    for (const r of merged) {
      if (r.y1 - r.y0 < rowLimit) continue
      // 护栏：横跨整页的行更像「印刷大标题」而不是作答（学生通常写在答题区局部）
      let xmin = w, xmax = -1, n = 0
      for (let y = r.y0; y < r.y1; y++)
        for (let x = 0; x < w; x++)
          if (ink[y * w + x]) { n++; if (x < xmin) xmin = x; if (x > xmax) xmax = x }
      if (xmax < 0) continue
      if (o.spanGuard > 0 && (xmax - xmin) / w > o.spanGuard) continue
      if (o.densityGuard > 0) {
        const spanX = Math.max(1, xmax - xmin)
        const density = n / ((r.y1 - r.y0) * spanX)
        if (density > o.densityGuard) continue // 墨迹过密 = 印刷体（含大号标题）
      }
      for (let y = r.y0; y < r.y1; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x
          if (!ink[i]) continue
          seedConf[i] = 255
          seedCount++
        }
    }
  } else {
    const best = new Uint16Array(w * h)
    for (const S of o.scales) {
      const span = maxFilterU16Row(runLen, w, h, S)
      for (let i = 0; i < best.length; i++) if (span[i] > best[i]) best[i] = span[i]
    }
    for (let i = 0; i < w * h; i++) {
      if (!ink[i]) continue
      const t = best[i] / glyphH
      let conf: number
      if (o.hi <= o.lo) conf = t >= o.lo ? 255 : 0
      else conf = Math.round(clamp01((t - o.lo) / (o.hi - o.lo)) * 255)
      seedConf[i] = conf
      if (conf > 0) seedCount++
    }
  }
  if (seedCount === 0)
    return { mask: new Uint8Array(W0 * H0), w: W0, h: H0, debug: { reason: 'no_tall_seed', glyphH } }

  // 生长
  // ── 'box'：方形膨胀。缺点（实测）：会跨过空白把邻近印刷体一起吞掉。
  // ── 'ink'：只在**墨迹连通域内**做测地扩散（每步半径 1 的膨胀后与 ink 取交）。
  //    手写笔画彼此连通 → 整字被覆盖；印刷体与手写若不相连 → 传播不过去。
  //    每步乘 decay(<1) → 离种子越远置信度越低，**天然产生领域要的软 mask**。
  // ⚠️ 候选门限用 seedMin 而不是固定 12：软阈值下低置信度种子（conf=1）扩散后
  //    也会 >12，若不设门限候选范围会被无限放宽 → share_guard 必然触发。
  let grown: Uint8Array
  if (o.growMode === 'ink') {
    const steps = Math.max(1, Math.round(glyphH * o.grow))
    const cur = new Uint8Array(seedConf)
    for (let k = 0; k < steps; k++) {
      const nx = maxFilter(cur, w, h, 1)
      for (let i = 0; i < w * h; i++) {
        if (!ink[i]) { cur[i] = 0; continue }
        // 每个像素取「自身值」与「邻域值 × decay」的较大者 → 置信度由种子向外递减
        const v = Math.min(255, Math.round(nx[i] * o.decay))
        if (v > cur[i]) cur[i] = v
      }
    }
    grown = cur
  } else {
    const growR = Math.max(3, Math.round(glyphH * o.grow))
    grown = maxFilter(seedConf, w, h, growR)
  }
  const cand = new Uint8Array(w * h)
  let candidateInk = 0
  for (let i = 0; i < w * h; i++) {
    if (!ink[i]) continue
    if (grown[i] < o.seedMin) continue
    cand[i] = grown[i]
    candidateInk++
  }
  if (candidateInk <= 0 || candidateInk / inkTotal > o.shareGuard)
    return {
      mask: new Uint8Array(W0 * H0), w: W0, h: H0,
      debug: { reason: candidateInk <= 0 ? 'no_candidate' : 'share_guard', glyphH, candidateInk, inkTotal },
    }

  // ③ 真膨胀（捕获抗锯齿边缘）
  const dilR = o.dilate
  const dilated = dilR > 0 ? maxFilter(cand, w, h, dilR) : cand

  // ④ 羽化（软边）：盒式模糊后与膨胀结果取「外包」——保覆盖的同时边缘渐变
  let soft = dilated
  if (o.feather > 0) {
    const f = new Float32Array(dilated.length)
    for (let i = 0; i < dilated.length; i++) f[i] = dilated[i]
    const b = boxBlur(f, w, h, o.feather, 2)
    soft = new Uint8Array(dilated.length)
    for (let i = 0; i < dilated.length; i++) soft[i] = Math.max(dilated[i], Math.round(b[i]))
  }

  // 还原到原尺寸（最近邻，避免引入额外插值导致尺寸对齐问题；羽化已在小图上完成）
  const fullRaw = await sharp(Buffer.from(soft), { raw: { width: w, height: h, channels: 1 } })
    .resize(W0, H0, { fit: 'fill', kernel: 'nearest' })
    .raw()
    .toBuffer()
  const fch = Math.max(1, Math.round(fullRaw.length / (W0 * H0)))
  const full = new Uint8Array(W0 * H0)
  for (let i = 0; i < W0 * H0; i++) full[i] = fullRaw[i * fch]
  return {
    mask: full, w: W0, h: H0,
    debug: { glyphH, inkTotal, candidateInk, seedCount, share: +(candidateInk / inkTotal).toFixed(3) },
  }
}

// ───────────────────────── 评分 ─────────────────────────
function score(det: Uint8Array, gt: Uint8Array, printInk?: Uint8Array) {
  let inter = 0, uni = 0, detN = 0, gtN = 0, soft = 0, hit = 0
  for (let i = 0; i < det.length; i++) {
    const d = det[i] > 127 ? 1 : 0
    const g = gt[i]
    if (d && g) inter++
    if (d || g) uni++
    if (d) detN++
    if (g) gtN++
    if (det[i] > 8 && det[i] < 247) soft++
    // ⭐ 安全指标：检测区域压到印刷体墨迹的比例（误擦印刷体 = 毁图，必须低）
    if (d && printInk && printInk[i]) hit++
  }
  return {
    iou: uni ? inter / uni : 0,
    recall: gtN ? inter / gtN : 0,
    precision: detN ? inter / detN : 0,
    softRatio: det.length ? soft / det.length : 0,
    printHit: detN ? hit / detN : 0,
  }
}
const pct = (v: number) => `${(v * 100).toFixed(1)}%`

async function main() {
  const label = '解答：36厘米'
  const fixtures: Array<[string, string, number, 'A' | 'B']> = [
    ['黑笔A', '#222222', 42, 'A'],
    ['铅笔A', '#5a5a5a', 42, 'A'],
    ['蓝笔A', '#1a3fd6', 42, 'A'],
    ['黑笔B压字', '#222222', 42, 'B'],
  ]
  const gts = new Map<string, Uint8Array>()
  const imgs = new Map<string, Buffer>()
  for (const [name, color, fs, mode] of fixtures) {
    imgs.set(name, await sharp(Buffer.from(svgFull(color, fs, label, mode))).jpeg({ quality: 96 }).toBuffer())
    gts.set(name, await groundTruth(await sharp(Buffer.from(svgHandOnly(color, fs, label, mode))).png().toBuffer(), 2))
  }
  // ── 反例集合（误擦 = 毁图，覆盖率必须 ≈0）─────────────────────────────────
  // ⚠️ 关键反例 C：真实试卷是「大标题 + 小字正文」混合版面。
  //    行级判据的风险正在于此——大标题行高(≈64) 远大于正文字高(≈21)，
  //    若把标题行判成"手写行"，就会把题目大标题整行擦掉。必须实测守住。
  const negMixed = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>` +
        Array.from({ length: 7 }, (_, i) =>
          `<text x="80" y="${100 + i * 150}" font-family="serif" font-size="34" fill="#111">第 ${i + 1} 大题 选择题</text>` +
          `<text x="80" y="${130 + i * 150}" font-family="serif" font-size="22" fill="#111">下列关于本题的说法中，正确的一项是，请根据题干内容作答。</text>` +
          `<text x="80" y="${158 + i * 150}" font-family="serif" font-size="22" fill="#111">A. 选项甲　B. 选项乙　C. 选项丙　D. 选项丁</text>`,
        ).join('') +
        `</svg>`,
    )).jpeg({ quality: 96 }).toBuffer()
  // 反例 D：更大的标题（fs=46）—— 行高必然超过 1.5×正文字高，是最严峻的考验
  const negMixedBig = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>` +
        Array.from({ length: 5 }, (_, i) =>
          `<text x="70" y="${120 + i * 220}" font-family="serif" font-size="46" fill="#111">第 ${i + 1} 大题 解答题</text>` +
          `<text x="70" y="${160 + i * 220}" font-family="serif" font-size="22" fill="#111">本题共两小问，请写出必要的推理过程与计算步骤。</text>` +
          `<text x="70" y="${192 + i * 220}" font-family="serif" font-size="22" fill="#111">解：（1）由题意可得，设未知数为 x，则方程为 2x+3=11。</text>`,
        ).join('') +
        `</svg>`,
    )).jpeg({ quality: 96 }).toBuffer()
  const negAllHand = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>` +
        Array.from({ length: 13 }, (_, i) => `<text x="60" y="${100 + i * 85}" font-family="serif" font-size="52" fill="#222">整页手写第 ${i + 1} 行内容</text>`).join('') +
        `</svg>`,
    )).jpeg({ quality: 96 }).toBuffer()

  // 反例
  const negPure = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>` +
        Array.from({ length: 16 }, (_, i) => `<text x="80" y="${120 + i * 62}" font-family="serif" font-size="${PRINT_FS}" fill="#111">纯印刷体测试文本第 ${i + 1} 行，不含任何手写内容，用于验证不会误擦。</text>`).join('') +
        `</svg>`,
    )).jpeg({ quality: 96 }).toBuffer()
  const negTitle = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>` +
        Array.from({ length: 5 }, (_, i) => `<text x="80" y="${160 + i * 200}" font-family="serif" font-size="64" fill="#111">第 ${i + 1} 大题 标题</text>`).join('') +
        `</svg>`,
    )).jpeg({ quality: 96 }).toBuffer()

  const B = {
    seedMin: 64, shareGuard: 0.75, dilate: 4, feather: 3,
    glyphMode: 'rowSpan' as const, glyphQ: 0.5, gapMerge: 6,
    growMode: 'ink' as const, grow: 0.5, decay: 1,
    detectMode: 'stroke' as const, rowRatio: 1.5,
  }
  // 禁区：印刷体墨迹（含横线），膨胀 2px 容纳抗锯齿
  const printInk = await groundTruth(
    await sharp(Buffer.from(svgPrintOnly())).png().toBuffer(),
    2,
  )

  // 固定：软阈值 lo=1.1/hi=1.6 + 多尺度 + 生长0.5 + 膨胀4 + 羽化3；只扫护栏阈值。
  // 目的：验证「share_guard 是不是反例的真正防线」——若放宽护栏后反例仍 0%，
  // 说明防线其实是 no_tall_seed，护栏只是误杀正例的冗余闸门（典型的护栏前提不成立）。
  const variants: Array<[string, TuneOpts]> = [
    // 对照组：证明两种旧字高估计都会崩
    ['band法(对照)', { scales: [2, 4, 8, 16], lo: 1.1, hi: 1.6, grow: 0.5, ...B, glyphMode: 'band', shareGuard: 0.9 }],
    ['colSpan法(对照)', { scales: [2, 4, 8, 16], lo: 1.1, hi: 1.6, grow: 0.5, ...B, glyphMode: 'colSpan', shareGuard: 0.9 }],
    // 对照组：stroke 逐笔画范式（召回天花板）
    ['stroke 逐笔画(对照)', { scales: [2, 4, 8, 16], lo: 1.1, hi: 1.6, ...B, glyphQ: 0.3, grow: 1.5 }],
    // 实验组：row 行级分类范式，扫行高倍率
    ['密度0.28', { scales: [2, 4, 8, 16], lo: 1.1, hi: 1.6, ...B, glyphQ: 0.3, detectMode: 'row', rowRatio: 1.5, densityGuard: 0.28 }],
    ['密度0.30', { scales: [2, 4, 8, 16], lo: 1.1, hi: 1.6, ...B, glyphQ: 0.3, detectMode: 'row', rowRatio: 1.5, densityGuard: 0.30 }],
    ['密度0.32', { scales: [2, 4, 8, 16], lo: 1.1, hi: 1.6, ...B, glyphQ: 0.3, detectMode: 'row', rowRatio: 1.5, densityGuard: 0.32 }],
    ['密度0.34', { scales: [2, 4, 8, 16], lo: 1.1, hi: 1.6, ...B, glyphQ: 0.3, detectMode: 'row', rowRatio: 1.5, densityGuard: 0.34 }],
    ['密度0.36', { scales: [2, 4, 8, 16], lo: 1.1, hi: 1.6, ...B, glyphQ: 0.3, detectMode: 'row', rowRatio: 1.5, densityGuard: 0.36 }],
    ['密度0.40', { scales: [2, 4, 8, 16], lo: 1.1, hi: 1.6, ...B, glyphQ: 0.3, detectMode: 'row', rowRatio: 1.5, densityGuard: 0.40 }],
  ]

  console.log('=== 探针 P2：mask 改造参数网格 ===')
  console.log('目标：召回↑、误擦印刷体↓、反例 0%、软像素↑\n')
  console.log('方案'.padEnd(20) + fixtures.map(([n]) => `${n} 召回/误擦`.padEnd(17)).join('') + ' 软像素 反例')
  for (const [vname, o] of variants) {
    let line = vname.padEnd(20)
    let softAvg = 0
    const reasons: string[] = []
    let diag = ''
    for (const [name] of fixtures) {
      const r = await tuneDarkInk(imgs.get(name)!, o)
      const s = score(r.mask, gts.get(name)!, printInk)
      softAvg += s.softRatio
      if (r.debug.reason) reasons.push(`${name}:${r.debug.reason}`)
      if (!diag) diag = `字高${r.debug.glyphH} share${r.debug.share}`
      line += `${pct(s.recall)}/${pct(s.printHit)}`.padEnd(17)
    }
    if (reasons.length) line += ` ⚠${reasons.join(',')}`
    line += ` [${diag}]`
    const negCov = (m: Uint8Array) => m.reduce((a, v) => a + (v > 127 ? 1 : 0), 0) / m.length
    const negs = [negPure, negTitle, negMixed, negMixedBig, negAllHand]
    const covs: string[] = []
    for (const n of negs) covs.push(pct(negCov((await tuneDarkInk(n, o)).mask)))
    line += `  ${pct(softAvg / fixtures.length)}  ${covs.join('/')}`
    console.log(line)
  }
  console.log('\n召回 = 真实手写被覆盖比例（越高越干净）；误擦 = 检测区压到印刷体墨迹的比例（越低越安全）')
  console.log('反例列 = 纯印刷 / 大号标题 / 【标题+正文混合】 / 整页手写   的覆盖率，必须 ≈0%')
}
main().catch((e) => { console.error(e); process.exit(1) })
