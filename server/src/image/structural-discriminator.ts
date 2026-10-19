// src/image/structural-discriminator.ts —— 结构一致性判别器（任务 B-1 · 影子版，不接主路径）
//
// ⚠️ 本文件所有"标定类"常量（w1~w4 / τ / 容差）必须注释来源层级（L0 物理 / L3 版面 / 标定），
//    否则 G10 门禁失败（见 erase-guard.ts paramSourceCheck）。
//    标定类常量在未做合成集扫描（B-3）前，一律标注 `// 待标定`，不得声称最优。
//
// 设计依据：去手写-结构一致性判别器-实施设计-v21.2.md
// 核心命题：把"手写"的定义从「靠近红笔的暗像素（位置代理）」换成
//           「在本行印刷字体系统中结构不一致的笔画（身份判别）」。
//   现状黑笔召回(E5) 与 红笔周边印刷保持(E7) 是零和（共享「红笔半径」一个旋钮）；
//   本判别器从"身份"而非"位置"判定 → 两条门禁不再共享旋钮 → 零和消解。
//
// 输入 ：DocContext（复用 P0，含 work 灰度 + 局部 ink + 版面 charH）+ 可选家具先验
// 输出 ：labels(work 尺度, 0=PRINT / 1=HANDWRITING / 2=UNCERTAIN) + 逐 CC 记录 + 锚点 + debug
//
// 本模块**零副作用**：不读 env、不改全局、不碰主路径。调用方（segmenter）负责
// STRUCT_ADAPTIVE 门禁与是否并入 mask（B-2 才接）。

import { connectedComponents, closeInk3x3, type Comp } from './image-layout'
import type { DocContext } from './adaptive-stats'

// ── L0 物理常数 ──────────────────────────────────────────────
const DEG = Math.PI / 180 // L0 · 弧度↔角度（图像无关）

// ── L3 版面常量（源自"同一行印刷字体一致"的结构先验）──────
const BLOCK_X_HI = 0.9 // L3 · 排除整宽线/阴影：块宽 < 0.9×图宽
const BLOCK_Y_HI = 0.3 // L3 · 排除竖向大块（插图/照片）：块高 < 0.3×图高
const ROW_GAP_K = 1.2 // L3 · 行间距聚类阈值 = 1.2×行高 p25（与 metricsFromGray 同口径）
const PRINT_H_LO = 0.55 // L3 · 印刷候选字高下界 = 0.55×行印刷字高
const PRINT_H_HI = 1.7 // L3 · 印刷候选字高上界 = 1.7×行印刷字高
const ASPECT_LO = 0.05 // L3 · 印刷候选长宽比下界（排除极细长线）
const ASPECT_HI = 3.0 // L3 · 印刷候选长宽比上界（排除超大块/照片）
const UNDERLINE_AR = 6 // L3 · 下划线锚点：长宽比 > 6（细长水平）
const UNDERLINE_BELOW = 0.5 // L3 · 下划线须位于行基线下方 ≤0.5×行字高（压线书写仍命中）
const PAREN_SPAN_LO = 1.0 // L3 · 括号锚点：两括号水平间距 ≥1×行字高
const PAREN_SPAN_HI = 4.0 // L3 · 括号锚点：两括号水平间距 ≤4×行字高
const GAP_K = 2.0 // L3 · 空档锚点：行内间距 ≥2×行间距众数
const BLANK_SIDE_K = 8 // L3 · 空白区：≥8×行字高见方的非印刷区才计"空白块"（phys4 解答区）
const MERGE_H_K = 2.2 // L3 · 合并域判据：域高 >2.2×行字高且横跨锚点+印刷 ⇒ UNCERTAIN

// ── 标定类常量（⚠️ 待 B-3 合成集扫参，当前为经验初值，非最优）──
const W_ANCHOR = 0.45 // 待标定 · 锚点证据权重
const W_INCONS = 0.35 // 待标定 · 行内一致性离群权重
const W_BLANK = 0.50 // 待标定 · 空白区墨迹权重
const W_SLANT = 0.20 // 待标定 · 倾斜度权重
const TAU_LO = 0.30 // 待标定 · 三态下界（≤ 判 PRINT）
const TAU_HI = 0.60 // 待标定 · 三态上界（≥ 判 HANDWRITING）

export type PixelState = 0 | 1 | 2 // PRINT / HANDWRITING / UNCERTAIN

export interface CompRecord {
  id: number
  x0: number; y0: number; x1: number; y1: number; n: number
  row: number
  h: number; w: number
  aspect: number
  slantDeg: number
  printLike: boolean
  furnitureHit: boolean
  inconsistency: number // 0..1（相对本行印刷众数）
  anchorEvidence: number // 0..1（是否落在锚点填写区/空白区）
  blankEvidence: number // 0..1（是否落在空白解答块）
  score: number // 融合分 0..1
  state: PixelState
  _explain?: boolean // 内部：是否被判手写且有≥1 证据（B-2 可解释性）
}

export interface AnchorZone {
  type: 'underline' | 'paren' | 'gap'
  x0: number; y0: number; x1: number; y1: number
}

export interface StructuralDiscriminantInput {
  ctx: DocContext
  /** 工作尺度家具/印刷先验（255=印刷/家具），可选；来自 protectPrintUnderColorHandwriting 等 */
  furniturePrior?: Uint8Array
}

export interface StructuralDiscriminantResult {
  w: number; h: number
  labels: Uint8Array // 工作尺度，值=PixelState
  /** 可解释性掩码（工作尺度，1=该像素有≥1 信号解释为手写）：供 B-2「增擦可解释性」判定（S4） */
  explain: Uint8Array
  comps: CompRecord[]
  anchors: AnchorZone[]
  debug: Record<string, unknown>
}

// ── 内部工具 ────────────────────────────────────────────────
function median(a: number[]): number {
  if (!a.length) return 0
  const s = a.slice().sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
function quantileSorted(a: number[], p: number): number {
  if (!a.length) return 0
  const i = Math.min(a.length - 1, Math.max(0, Math.floor(a.length * p)))
  return a[i]
}
/** 中位数绝对偏差（鲁棒σ），乘 1.4826 换算。 */
function mad(a: number[], med?: number): number {
  if (a.length < 2) return 0
  const m = med ?? median(a)
  const dev = a.map((v) => Math.abs(v - m)).sort((x, y) => x - y)
  return median(dev) * 1.4826
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

interface RowInfo {
  idx: number
  comps: Comp[]
  baseH: number
  baseGap: number
  baseY1: number
  x0: number; x1: number; y0: number; y1: number
  confidence: 'high' | 'low'
}

/** 行内印刷字高：取高度直方图的**众数（最高频）**——同一行印刷字体一致 ⇒ 印刷是高频主导系统。
 *  仅当最高频众数过矮（<0.4×行高 p25，疑为碎片噪声）时，退而取次高频众数。 */
function modalSmallHeight(hs: number[], hInit: number): number {
  if (!hs.length) return hInit
  const bin = Math.max(2, Math.round(hInit * 0.3))
  const maxH = Math.max(...hs)
  const nb = Math.floor(maxH / bin) + 1
  const cnt = new Array(nb).fill(0)
  for (const hh of hs) cnt[Math.min(nb - 1, Math.floor(hh / bin))]++
  // 收集达阈值的众数候选，按频次降序
  const thr = Math.max(1, hs.length * 0.1)
  const cand: { center: number; c: number }[] = []
  for (let i = 0; i < nb; i++) if (cnt[i] >= thr) cand.push({ center: (i + 0.5) * bin, c: cnt[i] })
  if (!cand.length) return quantileSorted(hs.slice().sort((a, b) => a - b), 0.25)
  cand.sort((a, b) => b.c - a.c)
  // 最高频众数若过矮（疑碎片），取下一个更高的众数
  for (const c of cand) {
    if (c.center >= 0.4 * hInit) return c.center
  }
  return cand[0].center
}

/**
 * 行检测：复用生产验证的 metricsFromGray 思路——
 *   闭合 ink → 连通域 → 排除整宽线/竖向大块 → 按块质心 Y 聚类（间距=1.2×p25 高度）→ 过滤窄行。
 * 比"按质心 Y 直接聚类 raw 碎片"稳健：raw 碎片高度≈4px 且高度重叠，会塌缩成 1~2 行。
 */
function detectRows(blocks: Comp[], w: number, h: number): RowInfo[] {
  if (!blocks.length) return []
  const heights = blocks.map((b) => b.y1 - b.y0 + 1).sort((a, b) => a - b)
  const hInit = Math.max(3, quantileSorted(heights, 0.25))
  const sorted = blocks.slice().sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2)
  const gap = Math.max(2, hInit * ROW_GAP_K)
  const groups: Comp[][] = []
  let cur: Comp[] = []
  let lastY = -1e9
  for (const b of sorted) {
    const cy = (b.y0 + b.y1) / 2
    if (cur.length && cy - lastY > gap) { groups.push(cur); cur = [] }
    cur.push(b)
    lastY = cy
  }
  if (cur.length) groups.push(cur)

  const rows: RowInfo[] = []
  groups.forEach((g, idx) => {
    const x0 = Math.min(...g.map((b) => b.x0))
    const x1 = Math.max(...g.map((b) => b.x1))
    const y0 = Math.min(...g.map((b) => b.y0))
    const y1 = Math.max(...g.map((b) => b.y1))
    const baseH = modalSmallHeight(g.map((b) => b.y1 - b.y0 + 1), hInit)
    const cand = g.filter((b) => {
      const hh = b.y1 - b.y0 + 1
      return hh >= PRINT_H_LO * baseH && hh <= PRINT_H_HI * baseH
    })
    const cx = g.map((b) => (b.x0 + b.x1) / 2).sort((a, b) => a - b)
    const gaps: number[] = []
    for (let i = 1; i < cx.length; i++) gaps.push(cx[i] - cx[i - 1])
    const baseGap = gaps.length ? median(gaps) : baseH * 0.6
    const baseY1 = cand.length ? Math.max(...cand.map((b) => b.y1)) : y1
    rows.push({
      idx, comps: g, baseH, baseGap, baseY1, x0, x1, y0, y1,
      confidence: cand.length >= 6 ? 'high' : 'low',
    })
  })
  // 只保留"像正文行"的组（横跨一定宽度或含多个块）
  return rows.filter((r) => r.x1 - r.x0 >= w * 0.12 || r.comps.length >= 3)
}

/** 计算一个连通域的主轴倾角（相对竖直，0~45°）。
 *  ⚠️ 二阶矩对近方形（sxx≈syy，如汉字块）数值不稳定 → atan2(0,0) 噪声角度。
 *   必须用特征值比作可信度闸门：λ1/λ2 < 1.5（近各向同性）时倾角不可信，返回 0。 */
function compSlant(c: Comp, ink: Uint8Array, w: number): number {
  // ⚠️ "偏离竖直角"只对**竖向拉长**部件有意义：横长形（中文横笔画/下划线，宽≥1.2×高）
  //   主轴是水平的，算出来恒≈45°，纯噪声 → 直接置 0。
  if ((c.y1 - c.y0 + 1) <= 1.2 * (c.x1 - c.x0 + 1)) return 0
  let sx = 0, sy = 0, cnt = 0
  for (let y = c.y0; y <= c.y1; y++) {
    const base = y * w
    for (let x = c.x0; x <= c.x1; x++) {
      if (!ink[base + x]) continue
      sx += x; sy += y; cnt++
    }
  }
  if (cnt < 2) return 0
  const mx = sx / cnt, my = sy / cnt
  let sxx = 0, syy = 0, sxy = 0
  for (let y = c.y0; y <= c.y1; y++) {
    const base = y * w
    for (let x = c.x0; x <= c.x1; x++) {
      if (!ink[base + x]) continue
      const dx = x - mx, dy = y - my
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy
    }
  }
  // 特征值比闸门：近各向同性（方形汉字块）倾角不可信
  const tr = sxx + syy
  const det = sxx * syy - sxy * sxy
  if (tr <= 0) return 0
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det))
  const l1 = tr / 2 + disc, l2 = Math.max(1e-9, tr / 2 - disc)
  if (l1 / l2 < 1.5) return 0
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy) / DEG
  const a = Math.abs(theta)
  return a > 45 ? 90 - a : a
}

/** 矩形框膨胀。 */
function dilateBox(src: Uint8Array, w: number, h: number, d: number): Uint8Array {
  const out = new Uint8Array(src.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!src[y * w + x]) continue
      const y0 = Math.max(0, y - d), y1 = Math.min(h - 1, y + d)
      const x0 = Math.max(0, x - d), x1 = Math.min(w - 1, x + d)
      for (let yy = y0; yy <= y1; yy++) { const b = yy * w; for (let xx = x0; xx <= x1; xx++) out[b + xx] = 1 }
    }
  }
  return out
}

/** 判定一个 comp 是否触达锚点填写区。 */
function testAnchor(r: CompRecord, anchorMask: Uint8Array, w: number): boolean {
  for (let y = r.y0; y <= r.y1; y++) {
    const base = y * w
    for (let x = r.x0; x <= r.x1; x++) if (anchorMask[base + x]) return true
  }
  return false
}

/** 主入口：纯函数判别。 */
export function discriminate(input: StructuralDiscriminantInput): StructuralDiscriminantResult {
  const { ctx, furniturePrior } = input
  const { w, h, ink } = ctx.work
  const labels = new Uint8Array(w * h) // 默认 0 = PRINT

  // ① 闭合 ink → 连通域（用于行检测与块统计）
  const inkC = closeInk3x3(ink, w, h)
  if (!inkC.some((v) => v)) {
    // explain 为 B-2 可解释性掩码，空 ink 时全 0（类型要求必填）
    return { w, h, labels, explain: new Uint8Array(w * h), comps: [], anchors: [], debug: { note: 'empty ink' } }
  }

  // ② 行检测（用闭合 ink 的块）
  const blocks = connectedComponents(inkC, w, h, false).comps.filter(
    (c) => c.n >= 4 && (c.x1 - c.x0) < w * BLOCK_X_HI && (c.y1 - c.y0) < h * BLOCK_Y_HI,
  )
  const rows = detectRows(blocks, w, h)

  // ③ 逐 CC 基础量（recs 与 row.comps 同源：均来自闭合 ink 的 blocks，保证坐标可匹配）
  const recs: CompRecord[] = []
  for (const c of blocks) {
    const hgt = c.y1 - c.y0 + 1
    const wdt = c.x1 - c.x0 + 1
    const aspect = wdt / Math.max(1, hgt)
    const slantDeg = compSlant(c, ink, w)
    let fOverlap = 0
    if (furniturePrior) {
      let ov = 0, tot = 0
      for (let y = c.y0; y <= c.y1; y++) {
        const base = y * w
        for (let x = c.x0; x <= c.x1; x++) {
          if (!ink[base + x]) continue
          tot++; if (furniturePrior[base + x]) ov++
        }
      }
      fOverlap = tot ? ov / tot : 0
    }
    // 绑定行（按质心）
    let best = rows.length ? rows[0].idx : -1, bestD = 1e9
    for (const r of rows) {
      const cy = (c.y0 + c.y1) / 2
      if (cy >= r.y0 - 4 && cy <= r.y1 + 4) { best = r.idx; break }
      const d = Math.min(Math.abs(cy - r.y0), Math.abs(cy - r.y1))
      if (d < bestD) { bestD = d; best = r.idx }
    }
    const rowRef = rows.find((r) => r.idx === best)
    const baseH = rowRef?.baseH ?? (ctx.layout.charH || Math.max(6, Math.round(Math.min(w, h) / 40)))
    const printLike = hgt >= PRINT_H_LO * baseH && hgt <= PRINT_H_HI * baseH &&
      aspect >= ASPECT_LO && aspect <= ASPECT_HI && fOverlap < 0.5
    recs.push({
      id: 0, x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, n: c.n,
      row: best, h: hgt, w: wdt, aspect, slantDeg, printLike,
      furnitureHit: fOverlap >= 0.5,
      inconsistency: 0, anchorEvidence: 0, blankEvidence: 0, score: 0, state: 0,
    })
  }

  // ④ 行内一致性离群分（F2）
  for (const row of rows) {
    const cr = row.comps.map((c) => recs.find((r) => r.x0 === c.x0 && r.y0 === c.y0 && r.x1 === c.x1 && r.y1 === c.y1)!)
      .filter(Boolean)
    const printC = cr.filter((r) => r.printLike)
    const refH = printC.length >= 3 ? printC.map((r) => r.h) : cr.map((r) => r.h)
    const refA = printC.length >= 3 ? printC.map((r) => r.aspect) : cr.map((r) => r.aspect)
    const refS = printC.length >= 3 ? printC.map((r) => r.slantDeg) : cr.map((r) => r.slantDeg)
    const mH = median(refH), mADh = mad(refH, mH) || Math.max(2, mH * 0.3)
    const mA = median(refA), mADa = mad(refA, mA) || 0.1
    const mS = median(refS), mADs = mad(refS, mS) || 2
    const cx = cr.map((r) => (r.x0 + r.x1) / 2).sort((a, b) => a - b)
    const gaps: number[] = []
    for (let i = 1; i < cx.length; i++) gaps.push(cx[i] - cx[i - 1])
    const mG = gaps.length ? median(gaps) : row.baseGap
    const mADg = mad(gaps, mG) || Math.max(2, mG * 0.5)
    for (const r of cr) {
      const zH = clamp(Math.abs(r.h - mH) / mADh, 0, 3)
      const zA = clamp(Math.abs(r.aspect - mA) / mADa, 0, 3)
      const zS = clamp(Math.abs(r.slantDeg - mS) / mADs, 0, 3)
      let zG = 0
      const myCx = (r.x0 + r.x1) / 2
      const neigh = cx.filter((v) => Math.abs(v - myCx) > 1).sort((a, b) => Math.abs(a - myCx) - Math.abs(b - myCx))
      if (neigh.length) {
        const g = Math.min(Math.abs(neigh[0] - myCx), neigh.length > 1 ? Math.abs(neigh[1] - myCx) : mG)
        zG = clamp(Math.abs(g - mG) / mADg, 0, 3)
      }
      // ⚠️ 归一化到 [0,1]：各 z 钳到 [0,3]，权重和=1，故除以 3.0（此前未除 → 最大 3.0，
      //   单项即可把 score 顶满 1.0，是"印刷被大面积误判手写"的直接元凶）
      r.inconsistency = (0.35 * zH + 0.20 * zA + 0.25 * zG + 0.20 * zS) / 3.0
    }
  }

  // ⑤ 几何锚点（F3）
  const anchors: AnchorZone[] = []
  const anchorUnderlineMask = new Uint8Array(w * h) // 下划线/括号区：任何墨迹皆手写证据
  const anchorGapMask = new Uint8Array(w * h) // 空档区：仅"非印刷尺寸"墨迹算手写证据
  const charH = rows.length ? median(rows.map((r) => r.baseH)) : (ctx.layout.charH || 20)
  for (const row of rows) {
    for (const c of row.comps) {
      const r = recs.find((x) => x.x0 === c.x0 && x.y0 === c.y0 && x.x1 === c.x1 && x.y1 === c.y1)!
      const ar = r.w / Math.max(1, r.h)
      if (ar >= UNDERLINE_AR && r.slantDeg < 20) {
        const top = c.y0, below = row.baseY1
        if (top >= below - 2 && top <= below + UNDERLINE_BELOW * charH + charH) {
          const zy0 = Math.min(below, top)
          const zy1 = Math.max(top + r.h - 1, below) + Math.round(0.5 * charH)
          const z: AnchorZone = { type: 'underline', x0: row.x0, y0: zy0, x1: row.x1, y1: zy1 }
          anchors.push(z)
          paintZone(anchorUnderlineMask, w, h, z)
        }
      }
    }
    const pc = row.comps.filter((c) => {
      const r = recs.find((x) => x.x0 === c.x0 && x.y0 === c.y0 && x.x1 === c.x1 && x.y1 === c.y1)!
      return r.printLike
    }).sort((a, b) => (a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2)
    for (let i = 1; i < pc.length; i++) {
      const gap = (pc[i].x0 + pc[i].x1) / 2 - (pc[i - 1].x0 + pc[i - 1].x1) / 2
      if (row.baseGap > 0 && gap >= GAP_K * row.baseGap) {
        const z: AnchorZone = { type: 'gap', x0: pc[i - 1].x1, y0: row.y0, x1: pc[i].x0, y1: row.y1 }
        anchors.push(z)
        paintZone(anchorGapMask, w, h, z)
      }
    }
  }
  // 括号锚点（A2）
  const parenCands = blocks.filter((c) => {
    const r = recs.find((x) => x.x0 === c.x0 && x.y0 === c.y0 && x.x1 === c.x1 && x.y1 === c.y1)!
    return r.h >= PRINT_H_LO * charH && r.h <= PRINT_H_HI * charH && r.aspect < 0.5
  }).sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2)
  for (let i = 0; i < parenCands.length; i++) {
    for (let j = i + 1; j < parenCands.length; j++) {
      const a = parenCands[i], b = parenCands[j]
      const cyA = (a.y0 + a.y1) / 2, cyB = (b.y0 + b.y1) / 2
      if (Math.abs(cyA - cyB) > charH) continue
      const span = Math.abs((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2)
      if (span >= PAREN_SPAN_LO * charH && span <= PAREN_SPAN_HI * charH) {
        const z: AnchorZone = {
          type: 'paren', x0: Math.min(a.x1, b.x1), y0: Math.min(a.y0, b.y0),
          x1: Math.max(a.x0, b.x0), y1: Math.max(a.y1, b.y1),
        }
        anchors.push(z)
        paintZone(anchorUnderlineMask, w, h, z)
      }
    }
  }

  // ⑥ 空白区墨迹（F4）：以"全部块"膨胀求印刷占据，空白=远离一切墨迹的大块
  const printOcc = new Uint8Array(w * h)
  for (const r of recs) {
    for (let y = r.y0; y <= r.y1; y++) { const base = y * w; for (let x = r.x0; x <= r.x1; x++) printOcc[base + x] = 1 }
  }
  const dil = Math.max(2, Math.round(charH))
  const printOccD = dilateBox(printOcc, w, h, dil)
  const blank = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) blank[i] = printOccD[i] ? 0 : 1
  const { comps: blankComps } = connectedComponents(blank, w, h, false)
  const minBlank = (BLANK_SIDE_K * charH) * (BLANK_SIDE_K * charH)
  for (const bc of blankComps) {
    if (bc.n < minBlank) continue
    // ⚠️ 排除"贴边/占满半图"的全局背景连通域：它会在全图包裹所有墨迹，
    //   导致每个 comp 都被误判为"位于空白区"。真实空白块是印刷周围的**内部留白 pocket**。
    if (bc.x0 <= 0 || bc.y0 <= 0 || bc.x1 >= w - 1 || bc.y1 >= h - 1) continue
    if (bc.n > 0.5 * w * h) continue
    for (const r of recs) {
      const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2
      if (cx >= bc.x0 && cx <= bc.x1 && cy >= bc.y0 && cy <= bc.y1) r.blankEvidence = 1
    }
  }

  // ⑦ 融合（F5）→ 三态
  const explain = new Uint8Array(w * h) // B-2：可解释性掩码
  for (const r of recs) {
    const underHit = testAnchor(r, anchorUnderlineMask, w)
    // 空档锚点只对"非印刷尺寸"墨迹生效：正常词间距里的印刷字不误判
    const gapHit = testAnchor(r, anchorGapMask, w) && !r.printLike
    const anchorHit = underHit || gapHit
    if (anchorHit) r.anchorEvidence = Math.max(r.anchorEvidence, 1)
    const slantNorm = clamp(r.slantDeg / 15, 0, 1)
    r.score = clamp(
      W_ANCHOR * r.anchorEvidence + W_INCONS * r.inconsistency + W_BLANK * r.blankEvidence + W_SLANT * slantNorm,
      0, 1,
    )
    const merged = r.h > MERGE_H_K * (rows.find((rr) => rr.idx === r.row)?.baseH || charH) && r.aspect < 0.9
    if (merged) r.state = 2
    else if (r.score >= TAU_HI || r.blankEvidence >= 1) r.state = 1
    else if (r.score <= TAU_LO) r.state = 0
    else r.state = 2
    // 「可解释」：被判手写(1)且至少有一条独立证据（锚点/空白区/显著离群/高分）
    const isExplained = r.state === 1 && (r.anchorEvidence >= 1 || r.blankEvidence >= 1 || r.inconsistency >= 0.25 || r.score >= TAU_HI)
    r._explain = isExplained
  }

  // ⑧ 写 labels / explain（仅 ink 像素）
  // ⭐ E7 保护闸（像素级，与 protectPrintUnderColorHandwriting 同口径）：
  //   家具先验判定的印刷像素绝不被结构通道擦除。锚点带/空白区可能把"落在填写区里的印刷"
  //   （如压在印刷上的手写旁的表达式、下划线附近的印刷项）整体抬成 state=1，
  //   但印刷像素本身必须保住——否则退化为 E7（现状 hybrid 用半径/protect 兜，本判别器在更底层兜底）。
  //   这同时满足 S2 keepPrint=1.0（度量口径与保护口径一致：都看 furniturePrior）。
  let printingProtected = 0
  for (const r of recs) {
    for (let y = r.y0; y <= r.y1; y++) {
      const base = y * w
      for (let x = r.x0; x <= r.x1; x++) {
        if (!ink[base + x]) continue
        if (furniturePrior && furniturePrior[base + x]) { labels[base + x] = 0; printingProtected++; continue }
        labels[base + x] = r.state
        if (r._explain) explain[base + x] = 1
      }
    }
  }

  // ⑨ 汇总 debug（仅统计 ink 像素上的标签，分母=inkN）
  const stateCount = [0, 0, 0]
  let inkN = 0
  for (let i = 0; i < w * h; i++) {
    if (!ink[i]) continue
    inkN++
    stateCount[labels[i]]++
  }
  return {
    w, h, labels, explain,
    comps: recs.map((r) => ({
      id: 0, x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, n: r.n, row: r.row,
      h: r.h, w: r.w, aspect: +r.aspect.toFixed(3), slantDeg: +r.slantDeg.toFixed(1),
      printLike: r.printLike, furnitureHit: r.furnitureHit, inconsistency: +r.inconsistency.toFixed(3),
      anchorEvidence: +r.anchorEvidence.toFixed(3), blankEvidence: +r.blankEvidence.toFixed(3),
      score: +r.score.toFixed(3), state: r.state,
    })),
    anchors,
    debug: {
      charH: +charH.toFixed(1),
      nComps: recs.length,
      nRows: rows.length,
      nAnchors: anchors.length,
      labelInkShare: stateCount.map((c) => +(c / Math.max(1, inkN)).toFixed(3)),
      printingProtected, // ⭐ E7 保护闸：被像素级保护保留的印刷像素数
      weights: { W_ANCHOR, W_INCONS, W_BLANK, W_SLANT, TAU_LO, TAU_HI },
      note: 'B-1 影子版；像素级 E7 保护闸已加；权重/阈值待 B-3 合成集标定（当前为经验初值，非最优）',
    },
  }
}

function paintZone(mask: Uint8Array, w: number, h: number, z: AnchorZone) {
  for (let y = Math.max(0, z.y0); y <= Math.min(h - 1, z.y1); y++) {
    const base = y * w
    for (let x = Math.max(0, z.x0); x <= Math.min(w - 1, z.x1); x++) mask[base + x] = 1
  }
}
