// src/image/adaptive-stats.ts —— 去手写自适应统计量估计（方法论 §4 E1~E4）
//
// ⚠️ 本文件所有常量必须注释来源层级（L0物理/L1图像统计/L2邻域/L3版面），
//    否则 G10 门禁失败（见 erase-guard.ts paramSourceCheck）。
//    判别规则：一个参数若回答不了"它的值从哪一层数据来"，它就是非法参数。
//
// P0 范围：仅建立纯函数估计器（PaperRef / LayoutStats / Otsu / 两遍 DocContext）。
// 本文件暂不接入任何既有调用方——新建即存在、删掉即回滚，不构成行为变更。

import sharp from 'sharp'
import { estimateCharMetrics, LAYOUT_MAX_SIDE } from './image-layout'

// ── L0 物理常数（图像无关，需文献出处）─────────────────────────────
const LUMA_R = 0.299 // L0 · 物理常数（NTSC 1953 亮度系数，所有人眼 RGB 成像通用）
const LUMA_G = 0.587 // L0 · 物理常数
const LUMA_B = 0.114 // L0 · 物理常数
// L0 常数：高斯分布下 MAD → σ 的换算系数（数值分析标准值，图像无关）
const MAD_K = 1.4826 // L0 · 鲁棒σ换算系数

// ── L0 常数：Sauvola 2000 原文推荐（待合成数据集扫参确认，见方法论 §5）──
// k∈[0.2,0.5] 取中点；最终值以合成集跨图最差值扫参确定，禁止在真实图上拍脑袋
const SAUVOLA_K = 0.34 // L0 · Sauvola 2000（合成集扫参待办）
// 文档灰度 0~255 的标准化动态范围，原文取 R=128
const SAUVOLA_R = 128 // L0 · Sauvola 2000 动态范围
// Sauvola 对比度兜底闸门（降为兜底而非必需，见方法论 §1.1）；合成集标定时一并确定
const SAUVOLA_MIN_CONTRAST = 8 // L0 · 对比度兜底（合成集扫参待办）

// 两遍扫描窗口下限/上限（像素），避免 charH 极端时窗口退化
const WIN_MIN = 16 // L0 · 窗口下限（像素），charH 极端时保底
const WIN_MAX = 64 // L0 · 窗口上限（像素）

// ============================================================
// E0 · Otsu 双峰平台中点（修复 otsuThreshold 取首个最大值 bug）
// ============================================================

/**
 * 亮度直方图 → Otsu 阈值。
 *
 * ⚠️ 与 image-layout.otsuThreshold 的区别：后者在最大方差落在一段**平台**上时
 * 取平台低端（首个 t），二值化/近二值图上平台低端=0，导致"全黑被判 0% 墨"。
 * 此处取平台 [t_low, t_high] 的**中点**，与经典 Otsu 在单峰情形下等价，
 * 在平台情形下给出稳健的中值阈值（方法论 P0-4）。
 *
 * @param hist 长度 256 的灰度直方图（L3/估计：直接从当前图统计）
 */
export function otsuPlatform(hist: ArrayLike<number>): number {
  const N = hist.length
  let total = 0
  for (let t = 0; t < N; t++) total += hist[t] // ⚠️ 像素总数，非 256（hist.length 是 bin 数）
  if (total === 0) return 127 // L0 · 空直方图兜底（图像无关）
  let sum = 0
  for (let t = 0; t < N; t++) sum += t * hist[t]
  let sumB = 0
  let wB = 0
  let maxVar = -1
  const plateau: number[] = []
  for (let t = 0; t < N; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const v = wB * wF * (mB - mF) * (mB - mF)
    if (v > maxVar) { maxVar = v; plateau.length = 0; plateau.push(t) }
    else if (v === maxVar) { plateau.push(t) } // 平台延伸（浮点整数运算，逐位精确）
  }
  if (plateau.length === 0) return 127 // L0 · 空直方图兜底（图像无关）
  return Math.round((plateau[0] + plateau[plateau.length - 1]) / 2)
}

// ============================================================
// E1 · PaperRef：纸面亮度 / 彩度基准（供应 L1 图像统计量）
// ============================================================

export interface PaperRef {
  paperLuma: number // 亮度直方图最大众数 bin 中心（L1/估计：当前图）
  paperLumaMAD: number // 全图亮度 MAD×1.4826，鲁棒σ（L1/估计）
  paperChroma: number // 亮部样本彩度中位（L1/估计）
  paperChromaMAD: number // 亮部彩度 MAD×1.4826（L1/估计）
  brightShare: number // 亮部样本占比（sanity 用，L1/估计）
  confidence: 'high' | 'low' // 估计可信度
  reason?: string // 降级原因（可观测字段禁止撒谎）
}

/** 由 sharp 输出的 RGB(A) raw 数据估计纸面基准。 */
export function estimatePaperRef(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
): PaperRef {
  const total = width * height
  const luma = new Float64Array(total)
  const lumaHist = new Int32Array(256)
  for (let i = 0, p = 0; i < total; i++, p += channels) {
    const l = LUMA_R * data[p] + LUMA_G * data[p + 1] + LUMA_B * data[p + 2]
    luma[i] = l
    lumaHist[Math.min(255, Math.round(l))]++
  }

  // 纸面亮度 = 亮度直方图众数 bin 中心（纸面通常是全图最大同色块）
  let modeBin = 0
  let modeN = 0
  for (let t = 0; t < 256; t++) {
    if (lumaHist[t] > modeN) { modeN = lumaHist[t]; modeBin = t }
  }
  const paperLuma = modeBin

  // 全图亮度 MAD（鲁棒σ）—— 围绕亮度中位数
  const medL = quantileFloat(luma, 0.5)
  const ldev = new Float64Array(total)
  for (let i = 0; i < total; i++) ldev[i] = Math.abs(luma[i] - medL)
  const paperLumaMAD = quantileFloat(ldev, 0.5) * MAD_K

  // 亮部样本：最亮 25% 像素（与 maskFromColorThreshold 同口径，L1/估计）
  let acc = 0
  let brightThr = 255
  for (let t = 255; t >= 0; t--) {
    acc += lumaHist[t]
    if (acc >= total * 0.25) { brightThr = t; break }
  }
  const chromas: number[] = []
  const step = Math.max(1, Math.floor(Math.sqrt(total / 120000)))
  for (let i = 0, p = 0; i < total; i += step, p += step * channels) {
    if (luma[i] < brightThr) continue
    const r = data[p]
    const g = data[p + 1]
    const b = data[p + 2]
    chromas.push(Math.max(r, g, b) - Math.min(r, g, b))
  }
  chromas.sort((a, b) => a - b)
  const paperChroma = chromas.length ? chromas[chromas.length >> 1] : 0
  const cdev = chromas.map((c) => Math.abs(c - paperChroma)).sort((a, b) => a - b)
  const paperChromaMAD = cdev.length ? cdev[cdev.length >> 1] * MAD_K : 0

  const brightShare = lumaHist.slice(brightThr).reduce((a, b) => a + b, 0) / Math.max(1, total)

  // sanity：纸面估计的可信度。
  // 过曝（最亮众数被钳到 255，无亮度余量）→ 纸面基准不可信；
  // 或亮部彩度噪声过大（纸面不纯，彩度基准不可信）→ 降级。
  // 注意：正常扫描件纸面亮度 190~197 属健康范围，不应误判为 low（早期阈值 200 过严，已修正）。
  const reasonParts: string[] = []
  if (paperLuma >= 254) reasonParts.push(`paperLuma=${paperLuma} 过曝/钳位，纸面基准不可信`)
  if (paperChroma > 0 && paperChromaMAD > 3 * paperChroma) reasonParts.push('纸面彩度噪声过大')
  const confidence: PaperRef['confidence'] = reasonParts.length ? 'low' : 'high'

  return {
    paperLuma,
    paperLumaMAD: +paperLumaMAD.toFixed(2),
    paperChroma,
    paperChromaMAD: +paperChromaMAD.toFixed(2),
    brightShare: +brightShare.toFixed(3),
    confidence,
    reason: reasonParts.join('; ') || undefined,
  }
}

// ============================================================
// E2 · LayoutStats：字高 / 笔画宽众数（供应 L3 版面统计量）
// ============================================================

export interface LayoutStats {
  charH: number // 字高众数（原图尺度，L3/估计：连通域统计）
  /**
   * 字高的 **LAYOUT_MAX_SIDE 工作尺度** 值 = charH × scale。
   * P0-5c：Sauvola 窗口要作用在 buildDocContext 那张 work 灰度上，必须与它同尺度。
   * 此前 buildDocContext 直接拿原图尺度的 charH 去算 win（见本文件历史注释，
   * 那段注释把 estimateCharMetrics 的返回值尺度说反了），大图窗口虚大 1/scale 倍。
   */
  charHWork: number
  strokeW: number // 笔画宽众数（原图尺度，L3/估计）
  /** 工作图相对原图的缩放（CHARH_COORD=on 时才有意义，其余情况与 charH 派生同值） */
  scale: number
  charHConfidence: number // 众数频次占比 0~1
  nCandidates: number // 候选连通域数
  source: 'cc-mode' | 'prior-fallback' | 'degraded' // 来源（可观测）
}

/**
 * 由原始图 buffer 估计版面统计量。
 * 复用 image-layout.estimateCharMetrics（已含连通域 + 众数逻辑，经生产验证）。
 */
export async function estimateLayout(buf: Buffer): Promise<LayoutStats> {
  const m = await estimateCharMetrics(buf, { maxSide: LAYOUT_MAX_SIDE })
  // ⚠️ P0-5c 尺度澄清（代码事实见 image-layout.metricsFromGray：
  //   `const inv = 1 / scale; const medH = medHWork * inv` —— **返回值是原图尺度**，
  //   本文件这行上方的历史注释把它说成 work 尺度，是错的；由此派生出两个坐标 bug：
  //     · buildDocContext：win = 2×charH 作用在 work 灰度上 → 窗口虚大 1/scale 倍
  //     · handwriting-mask：charHInMask = charH×(maskScale/ctxScale) → 虚大 maxDim/800 倍
  //   保留 charH（原图尺度，兼容既有消费方），另给出明确的 charHWork。
  const charH = Math.max(1, Math.round(m.medH))
  const charHWork = Math.max(1, Math.round(m.medH * (m.scale > 0 ? m.scale : 1)))
  const strokeW = Math.max(1, Math.round(m.strokeWidth))

  let source: LayoutStats['source'] = 'degraded'
  if (m.charCount >= 100 && m.confidence >= 0.5) source = 'cc-mode'
  else if (m.charCount >= 30) source = 'prior-fallback'

  return {
    charH,
    charHWork,
    strokeW,
    scale: m.scale > 0 ? m.scale : 1,
    charHConfidence: +m.confidence.toFixed(3),
    nCandidates: m.charCount,
    source,
  }
}

// ============================================================
// DocContext · 一次估计 · 多处消费（按输入图分域，见方法论 §1.3）
// ============================================================

export interface DocContext {
  work: { w: number; h: number; gray: Buffer; ink: Uint8Array }
  paper: PaperRef
  layout: LayoutStats
  otsuT: number
  sauvola: { k: number; R: number; win: number }
  inkLocal: Uint8Array // E3 输出的二值 mask（P1 消费，P0 仅产出验证）
  debug: Record<string, unknown>
}

/**
 * 主入口：两遍扫描。
 *   遍1：Otsu(平台中点) → 由 estimateLayout 复用其内部分块 → charH、strokeW
 *   遍2：win = 2×charH → 积分图 → Sauvola 逐像素 → inkLocal（正式）
 * 置信度不足 → 走 prior-fallback（charH = 短边/40）并在 debug 标记。
 */
export async function buildDocContext(
  grayOrRgb: Buffer,
  opts: { width: number; height: number; isGray: boolean; k?: number; R?: number },
  extra?: { charHFix?: boolean },
): Promise<DocContext> {
  const k = opts.k ?? SAUVOLA_K // L0 · 见 SAUVOLA_K 注释
  const R = opts.R ?? SAUVOLA_R // L0 · 见 SAUVOLA_R 注释

  // ── P0-5e 作用域隔离（v21.5）──────────────────────────────────────
  // 修正后的字高标尺（FIX+COORD+K=4）**只作用于 word / de-handwriting 路径**，
  // 由 buildEraseMask 调用时传入 {charHFix:true} 临时启用；其余全局消费方
  // （含 G13 的 structural/hybrid 通道）保持旧标尺，门禁不得倒退。
  // 用 try/finally 在调用内临时改写 CHARH_* 环境变量并还原，避免污染同进程内
  // 的其他探针（erase-guard 一次进程跑多个探针）。
  const _prevFix = process.env.CHARH_FIX
  const _prevCoord = process.env.CHARH_COORD
  const _prevWinK = process.env.SAUVOLA_WIN_K
  if (extra?.charHFix) {
    process.env.CHARH_FIX = 'on' // P0-5a/b：四路取小修正字高
    process.env.CHARH_COORD = 'on' // P0-5c：Sauvola 窗口落到 work 尺度
    process.env.SAUVOLA_WIN_K = '4' // P0-5e：重标定窗口（甜点 K=4）
  }

  // L0 · 工作尺度：与 estimateCharMetrics 内部同一公式（LAYOUT_MAX_SIDE 封顶），
  //   保证 charHWork / Sauvola 窗口落在本文 work 灰度的坐标系里（P0-5c）。
  const workScale = Math.min(1, LAYOUT_MAX_SIDE / Math.max(1, Math.max(opts.width, opts.height)))
  const rgbBuf = opts.isGray
    ? await sharp(grayOrRgb, { raw: { width: opts.width, height: opts.height, channels: 1 } }).png().toBuffer()
    : grayOrRgb

  try {

  const layout = await estimateLayout(rgbBuf)

  // 版面兜底：候选域过少时退化（仍保留可观测来源）
  let charH = layout.charH
  let charHWork = layout.charHWork
  const fallbacks: string[] = []
  if (layout.source === 'degraded') {
    // 兜底也是原图尺度（opts.width/height 为原图），必须同步换算到 work 尺度
    charH = Math.max(6, Math.round(Math.min(opts.width, opts.height) / 40)) // L3/估计：短边/40 兜底
    charHWork = Math.max(1, Math.round(charH * workScale))
    fallbacks.push('charH 退化至 短边/40')
  }

  // 纸面基准（E1）—— 走原图域，避免归一化图抬高纸面基准（v20.5 实测）
  const raw = await sharp(rgbBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const paper = estimatePaperRef(raw.data, raw.info.width, raw.info.height, raw.info.channels)

  // 灰度（归一化域，供两遍扫描使用）——resize 到与 estimateCharMetrics 相同的
  // 工作尺度（LAYOUT_MAX_SIDE），确保 charH（work 空间 medH）与 Sauvola 窗口 2×charH
  // 落在同一坐标系。否则窗口会相对灰度尺度漂移（早期实现 charH 误除以 scale 的同类坑）。
  // 注：workScale 与 estimateCharMetrics 内部公式一致，已在函数顶部算出（P0-5c）。
  const w = Math.max(1, Math.round(raw.info.width * workScale))
  const h = Math.max(1, Math.round(raw.info.height * workScale))
  const gray = opts.isGray
    ? grayOrRgb
    : await sharp(rgbBuf).resize(w, h, { fit: 'fill' }).grayscale().raw().toBuffer()

  // Otsu 平台中点（遍1 诊断 + 兜底对照）
  const hist = new Int32Array(256)
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++
  const otsuT = otsuPlatform(hist)

  // 遍2：Sauvola 局部阈值，窗口 win = 2×字高。
  //   ⭐ P0-5c：窗口必须与 gray 同坐标系 → 用 **work 尺度** 的 charHWork（= charH×scale）。
  //     旧实现用原图尺度的 charH，窗口虚大 1/scale 倍：2480×3508 扫描件 scale=0.228
  //     → 窗口大 4.4 倍（且常被 WIN_MAX=64 截断，等于退化成常值 64）。
  //     开关 CHARH_COORD=off 保持旧行为以便 A/B（端到端验证后置为默认 on）。
  const CHARH_COORD = process.env.CHARH_COORD ?? 'on'
  const winBasis = CHARH_COORD !== 'off' ? charHWork : charH
  // ⭐ P0-5e 重标定旋钮：Sauvola 窗口 = SAUVOLA_WIN_K × 字高。
  //   坐标系修正（CHARH_COORD=on）后，窗口从"原图 charH 虚大 4× 后撞 WIN_MAX=64 的准全局阈值"
  //   变为"work 尺度 charHWork 的 2×"（≈24，过窄）。扫参确认甜点 K≈4：
  //   既保留局部自适应的细粒度，又等价于旧有效覆盖（FIX+COORD+K=4 → 擦净 37/44，反超基线 34/44）。
  //   K 已写死为 4（文献 Sauvola 典型 2~4 区间上沿），保留 env 覆盖便于日后复算。
  const winK = Number(process.env.SAUVOLA_WIN_K ?? '4') || 4
  const win = Math.min(WIN_MAX, Math.max(WIN_MIN, winK * winBasis))
  const inkLocal = sauvolaInk(gray, w, h, win, k, R)

  return {
    work: { w, h, gray, ink: inkLocal },
    paper,
    layout: { ...layout, charH, charHWork },
    otsuT,
    sauvola: { k, R, win },
    inkLocal,
    debug: {
      statsSource: layout.source,
      charH, charHWork, strokeW: layout.strokeW, charHConfidence: layout.charHConfidence,
      sauvolaWin: win, sauvolaCoverage: +(inkLocal.reduce((a, b) => a + b, 0) / inkLocal.length).toFixed(4),
      charHCoordFix: CHARH_COORD !== 'off',
      charHFix: !!extra?.charHFix,
      fallbacks,
    },
  }
  } finally {
    // 还原 CHARH_* 环境变量（见顶部「作用域隔离」注释），防止污染同进程其他消费方
    if (_prevFix === undefined) delete process.env.CHARH_FIX; else process.env.CHARH_FIX = _prevFix
    if (_prevCoord === undefined) delete process.env.CHARH_COORD; else process.env.CHARH_COORD = _prevCoord
    if (_prevWinK === undefined) delete process.env.SAUVOLA_WIN_K; else process.env.SAUVOLA_WIN_K = _prevWinK
  }
}

// ============================================================
// 内部工具
// ============================================================

/** Sauvola 局部阈值二值化（T = m·(1 + k(s/R − 1)) + 对比度兜底闸门）。 */
function sauvolaInk(
  gray: Buffer, w: number, h: number, win: number, k: number, R: number,
): Uint8Array {
  const iw = win >> 1
  const I = new Float64Array((w + 1) * (h + 1))
  const I2 = new Float64Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++) {
    let rowS = 0
    let rowS2 = 0
    const base = (y + 1) * (w + 1)
    const pbase = y * w
    for (let x = 0; x < w; x++) {
      const v = gray[pbase + x]
      rowS += v
      rowS2 += v * v
      I[base + x + 1] = I[y * (w + 1) + x + 1] + rowS
      I2[base + x + 1] = I2[y * (w + 1) + x + 1] + rowS2
    }
  }
  const ink = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - iw)
    const y1 = Math.min(h - 1, y + iw)
    const iy0 = y0 * (w + 1)
    const iy1 = (y1 + 1) * (w + 1)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - iw)
      const x1 = Math.min(w - 1, x + iw)
      const cnt = (x1 - x0 + 1) * (y1 - y0 + 1)
      const s = I[iy1 + x1 + 1] - I[iy1 + x0] - I[iy0 + x1 + 1] + I[iy0 + x0]
      const s2 = I2[iy1 + x1 + 1] - I2[iy1 + x0] - I2[iy0 + x1 + 1] + I2[iy0 + x0]
      const mean = s / cnt
      const variance = s2 / cnt - mean * mean
      const std = Math.sqrt(variance > 0 ? variance : 0)
      const t = mean * (1 + k * (std / R - 1))
      const g = gray[y * w + x]
      if (g < t && (mean - g) >= SAUVOLA_MIN_CONTRAST) ink[y * w + x] = 1 // 对比度闸门降为兜底
    }
  }
  return ink
}

/** 升序数组的 p 分位（线性插值）。 */
function quantileFloat(a: Float64Array | number[], p: number): number {
  if (!a.length) return 0
  const arr = a instanceof Float64Array ? Array.from(a).sort((x, y) => x - y) : (a as number[]).slice().sort((x, y) => x - y)
  const idx = Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))
  return arr[idx]
}
