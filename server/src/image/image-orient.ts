/**
 * 图片自动摆正 · 朝向估计（orientation）
 *
 * 目标：把"横拍 / 颠倒 / 侧翻"的试卷图转正，使文字呈水平可读。
 * 覆盖 0° / 90° / 180° / 270° 四种朝向。
 *
 * 设计原则（不依赖大模型 / VLM）：
 *   - 核心判定 **纯几何、零外部依赖、常驻生效**：用「投影轮廓峰数」判断文字是横排还是竖排。
 *     横排图 → 行投影（每行墨迹和）呈强周期性峰谷；竖排图 → 列投影峰更显著。
 *     该信号能**确定性修掉 90°/270° 侧翻**（把图转为横排），且无需任何模型。
 *   - 0° vs 180°、90° vs 270° 属「同一轴内的镜像」，纯几何无法区分（投影对称）。
 *     此时用 **3.x OCR 侧车（PP-LCNet 朝向分类，CV 模型非大模型）做细化**：单模型四分类
 *     （0/90/180/270 校正角），一次性给出可靠朝向。侧车不可达时回落纯几何结果（并打 orientSuspect 告警）。
 *
 * 为什么不直接用大模型：朝向是「结构几何问题」，投影法在 CPU 上毫秒级、离线可用、
 * 不引入外部调用与费用；大模型属杀鸡用牛刀且带来可用性/隐私耦合。
 */

import sharp from 'sharp'
import { estimateSkew } from './image-deskew'
import { getPpsv3Supervisor } from '../ocr/ppsv3.client'
import { toolOcr, toolInvokeEnabled } from '../ocr/ocr-tool'

export type OrientationAngle = 0 | 90 | 180 | 270
export type OrientMethod = 'projection' | 'ocr' | 'none'

export interface OrientationResult {
  /** 需对「输入图」施加的旋转角（度），使其转正 */
  angle: OrientationAngle
  method: OrientMethod
  /** 几何判定出的文字主轴 */
  axis: 'horizontal' | 'vertical'
  /** 四个候选朝向的几何分（仅调试用） */
  scores?: Record<OrientationAngle, number>
  /** OCR 4 向投票各候选质量分（仅调试用） */
  volumes?: Partial<Record<OrientationAngle, number>>
  /** 是否启用了 OCR 细化 */
  ocrRefined?: boolean
  /**
   * 朝向未经 OCR 消歧且存在侧躺/倒置风险（method=projection 且几何判为竖排时）。
   * true = 本页可能侧躺，结果勿直接采信（摆正链路据此打告警，见 image-dewarp）。
   */
  suspect?: boolean
}

const CANDIDATES: OrientationAngle[] = [0, 90, 180, 270]

/**
 * 注入式 OCR 朝向判定（生产用 3.x 侧车 /orient 端点，测试可替换）。
 * 入参为原始图，返回朝向分类器给出的校正角 + 置信度分。
 * PP-LCNet 单模型四分类（~0.1s），替代旧版 2.x 的「四向全量 OCR 投票」；
 * 能确定性消歧 0/180 与 90/270（投影对称、几何无能）。
 */
export type OcrAngleProvider = (
  buf: Buffer,
) => Promise<{ angle: OrientationAngle; scores?: Partial<Record<OrientationAngle, number>> }>

function localOtsu(hist: Int32Array, total: number): number {
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0
  let wB = 0
  let maxVar = -1
  let threshold = 127
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
      threshold = t
    }
  }
  return threshold
}

/** 投影轮廓的「峰数」：高于均值且为局部极大的采样点个数，表征"文字行/列"的结构强度 */
function peakCount(p: Int32Array): number {
  const n = p.length
  let sum = 0
  for (let i = 0; i < n; i++) sum += p[i]
  if (sum === 0) return 0
  const mean = sum / n
  let cnt = 0
  for (let i = 1; i < n - 1; i++) {
    if (p[i] > mean && p[i] >= p[i - 1] && p[i] >= p[i + 1]) cnt++
  }
  if (p[0] > mean && p[0] >= p[1]) cnt++
  if (p[n - 1] > mean && p[n - 1] >= p[n - 2]) cnt++
  return cnt
}

/** 纯几何朝向分：仅需一次二值化，四个候选由行列投影推导（无需 4 次旋转） */
export function scoreOrientation(ink: Uint8Array, w: number, h: number): {
  scores: Record<OrientationAngle, number>
  axis: 'horizontal' | 'vertical'
} {
  const horiz = new Int32Array(h)
  const vert = new Int32Array(w)
  for (let y = 0; y < h; y++) {
    const base = y * w
    let c = 0
    for (let x = 0; x < w; x++) c += ink[base + x]
    horiz[y] = c
  }
  for (let x = 0; x < w; x++) {
    let c = 0
    for (let y = 0; y < h; y++) c += ink[y * w + x]
    vert[x] = c
  }
  const hp = peakCount(horiz)
  const vp = peakCount(vert)
  // 0/180：横排 → 行峰 - 列峰；90/270：竖排 → 列峰 - 行峰（投影关于镜像对称，无法区分 0 vs 180 / 90 vs 270）
  const scores: Record<OrientationAngle, number> = {
    0: hp - vp,
    90: vp - hp,
    180: hp - vp,
    270: vp - hp,
  }
  return { scores, axis: hp >= vp ? 'horizontal' : 'vertical' }
}

/** 对输入图做二值墨迹（缩小到 ≤800px 以提速，朝向估计对分辨率不敏感） */
async function binarize(buf: Buffer): Promise<{ ink: Uint8Array; w: number; h: number }> {
  const { data, info } = await sharp(buf)
    .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const w = info.width
  const h = info.height
  const hist = new Int32Array(256)
  for (let i = 0; i < data.length; i++) hist[data[i]]++
  const t = localOtsu(hist, data.length)
  const ink = new Uint8Array(w * h)
  for (let i = 0; i < data.length; i++) ink[i] = data[i] < t ? 1 : 0
  return { ink, w, h }
}

/** 旋转缓冲区（sharp 对 90/180/270 走无损路径） */
export async function rotateBuffer(buf: Buffer, angle: OrientationAngle): Promise<Buffer> {
  if (angle === 0) return buf
  return sharp(buf).rotate(angle).toBuffer()
}

/**
 * 估计输入图应旋转的角度（度）以转正。
 * @param ocrAngle 可选 OCR 朝向判定（侧车 /orient 端点），用于 0/180 与 90/270 的镜像消歧；缺失则纯几何。
 *
 * ⚠️ 侧车细化缺席时的保守回落（2026-10 修复，用户实测"正排图被转 90°"）：
 * 纯几何只能判「横排/竖排」轴，且投影关于 180° 镜像对称——0/180、90/270 的正立与否
 * 几何本质无能，此前竖排直接转 90°，横排图被 peakCount 误判时即整页侧翻。
 * 新策略：**不猜转**——
 *   · 横排 → 0°（横排无需旋转，安全，同旧行为）；
 *   · 竖排 → 仍取 0°（不施加旋转）：误转正排图比漏摆正更糟，漏摆正由 OCR/人工兜底，
 *     同时 suspect=true 告知上层"本页可能侧躺，勿直接采信朝向"。
 */
export async function estimateOrientation(
  buf: Buffer,
  ocrAngle?: OcrAngleProvider,
): Promise<OrientationResult> {
  const { ink, w, h } = await binarize(buf)
  const { scores, axis } = scoreOrientation(ink, w, h)

  // 保守回落角：恒 0（不猜转，理由见上方注释）
  let angle: OrientationAngle = 0

  if (ocrAngle) {
    try {
      // 3.x 侧车 /orient：PP-LCNet 单模型四分类（0/90/180/270 校正角），~0.1s：
      // 一次性给出可靠朝向，彻底规避「几何轴猜错 → 整页 180° 倒置」的静默脏数据。
      // 实测：横拍练习卷投影法会选成 90°（倒立），而 270° 才是正立，分类器可正确选出。
      const r = await ocrAngle(buf)
      if (r && (r.angle === 0 || r.angle === 90 || r.angle === 180 || r.angle === 270)) {
        return { angle: r.angle, method: 'ocr', axis, scores, volumes: r.scores, ocrRefined: true }
      }
    } catch {
      /* 侧车失败 → 回落纯几何（保守不转 + suspect 告警） */
    }
  }
  // 纯几何且判为竖排：不转，但本页可能侧躺——标记 suspect 供上层告警/人工复核
  return { angle, method: 'projection', axis, scores, suspect: axis === 'vertical' }
}

/** 便捷封装：直接返回转正后的图与朝向信息 */
export async function autoOrient(
  buf: Buffer,
  ocrAngle?: OcrAngleProvider,
): Promise<{ buffer: Buffer; angle: OrientationAngle; method: OrientMethod; axis: 'horizontal' | 'vertical' }> {
  const r = await estimateOrientation(buf, ocrAngle)
  const buffer = await rotateBuffer(buf, r.angle)
  return { buffer, angle: r.angle, method: r.method, axis: r.axis }
}

/**
 * 工厂：用 3.x OCR 侧车（PP-LCNet 朝向分类，CV 模型非大模型）判定文档朝向（0/90/180/270）。
 * - 2026-10-15 起生产主引擎切到 3.x（main3.py :9001）；2.x /orient 四向投票下线。
 * - 侧车是 DRY_RUN（无模型）→ 主动抛错，由调用方回落纯几何结果（避免假数据污染朝向）。
 * - 侧车不可达 / 超时 → 抛错，回落纯几何。
 * 注意：90° vs 270°、0° vs 180° 的「正立与否」纯几何无法判定（投影关于 180° 镜像对称），
 * 必须靠「读出文字/分类」来确定——这正是朝向分类器的价值，且它属 CV 模型、非大模型。
 * 单次 HTTP 调用（或工具式子进程），PP-LCNet 单模型 ~0.1s，远比旧版「四向全量 OCR 投票」轻。
 */
export function ocrAngleFromSidecar(baseUrl?: string): OcrAngleProvider {
  const url = baseUrl ?? process.env.OCR_ORIENT_URL ?? process.env.PPSV3_URL ?? 'http://127.0.0.1:9001'
  let checked = false
  let usable = true
  // 借 3.x 侧车守护进程做自愈：侧车若中途崩了（段错误等），先 ensureReady 拉动重启再打，
  // 绝不让"侧车挂掉 → 朝向判定失败 → 静默回落 50% 猜错的投影角 → 整页翻反"发生。
  let supervisor: ReturnType<typeof getPpsv3Supervisor> | null = null
  try { supervisor = getPpsv3Supervisor() } catch { supervisor = null }
  const revive = async () => { if (supervisor) { try { await supervisor.ensureReady(30_000) } catch { /* ignore */ } } }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  return async (buf: Buffer) => {
    // ① 工具式调用（默认）：每次朝向判定独立子进程（main3.py --once --op orient，venv python），
    //    崩/卡只影响当次、下条全新进程自动恢复；硬超时 + SIGKILL 可强制中断。
    if (toolInvokeEnabled()) {
      const r = await toolOcr(buf, { op: 'orient', engine: 'ppsv3', timeoutMs: Number(process.env.OCR_TOOL_TIMEOUT_MS ?? 120_000) })
      if (r.ok && r.data && typeof (r.data as { angle?: unknown }).angle === 'number') {
        const d = r.data as { angle: number; scores?: Partial<Record<OrientationAngle, number>> }
        return { angle: d.angle as OrientationAngle, scores: d.scores }
      }
      throw new Error(`ocr tool orient failed (${r.reason})`)
    }
    // ② 回落：长驻服务 HTTP 模式（OCR_INVOKE=server 时）
    if (!usable) throw new Error('ocr sidecar unusable (dry_run or unreachable)')
    if (!checked) {
      checked = true
      try {
        const h = await fetch(url + '/healthz', { signal: AbortSignal.timeout(5000) })
        const hj = (await h.json().catch(() => ({}))) as { dry_run?: boolean }
        if (hj.dry_run === true) {
          usable = false
          throw new Error('ocr sidecar is DRY_RUN')
        }
      } catch (e) {
        if (!usable) throw e
      }
      // 首次调用即确保侧车活着（自愈第一环）
      await revive()
    }
    const b64 = buf.toString('base64')
    // 重试 + 自愈：侧车在并发/内存压力下可能偶发超时、瞬时不可达甚至进程段错误。
    // 朝向判定（0/180、90/270 区分）完全依赖这次分类——一次失败就静默回落到
    // 50% 概率猜错的投影角，会把整页翻反。故每次尝试前先 ensureReady 拉动侧车，
    // 失败后也先自愈重启再决定是否放弃，宁可多花几百毫秒也要拿到可靠朝向。
    let j: { angle?: number; scores?: Partial<Record<OrientationAngle, number>> } | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await revive()
        const r = await fetch(url + '/orient', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_base64: 'data:image/jpeg;base64,' + b64 }),
          signal: AbortSignal.timeout(60_000),
        })
        if (!r.ok) { await sleep(400 * (attempt + 1)); continue }
        j = (await r.json()) as { angle?: number; scores?: Partial<Record<OrientationAngle, number>> }
        break
      } catch {
        await revive() // 失败后先尝试自愈重启侧车
        if (attempt === 2) throw new Error('ocr sidecar unreachable after retries')
        await sleep(400 * (attempt + 1))
      }
    }
    if (!j || typeof j.angle !== 'number') throw new Error('ocr sidecar /orient returned empty')
    return { angle: j.angle as OrientationAngle, scores: j.scores }
  }
}

export { estimateSkew }
