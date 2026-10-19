import sharp from 'sharp'
import { getCV, safeDelete } from './image-cv'
import { orderCorners, type Corner } from './image-dewarp'

/* eslint-disable @typescript-eslint/no-explicit-any */
type CV = any

/**
 * Phase 3 交付 1：自动文档四角检测（经典等价实现）。
 *
 * 方案 §2.1 的落地：边缘检测(Canny) + 轮廓(findContours) + 多边形逼近(approxPolyDP) 取文档四边形。
 * 说明：真实 DBNet 角点模型权重在部署沙箱不可得（GitHub/HF TLS 掐断），故用方案自身列出的
 * 经典管线作为生产可用实现；若未来拿到 DBNet ONNX，可在 detectCornersCV 前插入神经分支
 * （见文件末尾 detectCornersNeural 插槽）。
 *
 * 已实测：Canny(50,150) → findContours → 最大面积 → approxPolyDP(0.02·peri) 在合成透视四边形上
 * 给出 4 顶点、≤1px 误差，orderCorners 排序正确。
 */

/** 缩小到该长边再做检测，限制 WASM 内存与 CPU；坐标检测后按比例还原。 */
const DETECT_MAX_SIDE = 1024
const MIN_AREA_RATIO = 0.25 // 文档应占画面主体
const MAX_EDGE_RATIO = 5 // 最长边 / 最短边
const MIN_EDGE_PX = 60
/** 判定角点「贴到画面边缘」的容差像素（用于剔除 full-frame 伪文档）。 */
const BORDER_TOL = 3

/** 四点叉积同号判定凸四边形。 */
function isConvex(pts: Corner[]): boolean {
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4], c = pts[(i + 2) % 4]
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
    if (Math.abs(cross) < 1e-6) continue
    const s = cross > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

function dedupeClose(pts: Corner[], eps = 3): Corner[] {
  const out: Corner[] = []
  for (const p of pts) if (!out.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < eps)) out.push(p)
  return out
}

/** 几何护栏：面积占比、凸性、边长比、宽高比、最小边。任一不过 → 判为无效。 */
function passesGuards(quad: Corner[], W: number, H: number): boolean {
  const [tl, tr, br, bl] = orderCorners(quad)
  const edges = [
    Math.hypot(tr[0] - tl[0], tr[1] - tl[1]),
    Math.hypot(br[0] - tr[0], br[1] - tr[1]),
    Math.hypot(bl[0] - br[0], bl[1] - br[1]),
    Math.hypot(tl[0] - bl[0], tl[1] - bl[1]),
  ]
  const minE = Math.min(...edges)
  const maxE = Math.max(...edges)
  if (minE < MIN_EDGE_PX) return false
  if (maxE / minE > MAX_EDGE_RATIO) return false
  // 面积（Shoelace）
  const ordered = [tl, tr, br, bl]
  let area = 0
  for (let i = 0; i < 4; i++) {
    const a = ordered[i], b = ordered[(i + 1) % 4]
    area += a[0] * b[1] - b[0] * a[1]
  }
  area = Math.abs(area) / 2
  const ratio = area / (W * H)
  if (ratio < MIN_AREA_RATIO) return false
  // 拒绝「贴满整幅画面」的伪文档：真实拍摄件四角不会同时顶到画面四条边。
  // 纯噪声/纯色图常产生 full-frame 矩形，面积比≈1 且四角贴边 → 在此剔除。
  if (ratio > 0.985) return false
  const bd = BORDER_TOL
  const touches = (p: Corner) => p[0] <= bd || p[1] <= bd || p[0] >= W - bd || p[1] >= H - bd
  if (ordered.filter(touches).length >= 3) return false
  if (!isConvex(ordered)) return false
  // 宽高比（用平均对边）
  const wTop = Math.hypot(tr[0] - tl[0], tr[1] - tl[1])
  const wBot = Math.hypot(br[0] - bl[0], br[1] - bl[1])
  const hL = Math.hypot(tl[0] - bl[0], tl[1] - bl[1])
  const hR = Math.hypot(tr[0] - br[0], tr[1] - br[1])
  const w = (wTop + wBot) / 2
  const h = (hL + hR) / 2
  const ar = w / h
  if (ar < 0.3 || ar > 3.3) return false
  return true
}

/** 从候选轮廓里逼近出最像文档四边形的四角（多 epsilon 重试）。 */
function quadFromContour(cv: CV, contour: any, scale: number, W: number, H: number): Corner[] | null {
  const peri = cv.arcLength(contour, true)
  const epsilons = [0.02, 0.015, 0.025, 0.03, 0.04]
  let best: Corner[] | null = null
  for (const e of epsilons) {
    const approx = new cv.Mat()
    try {
      cv.approxPolyDP(contour, approx, e * peri, true)
      if (approx.rows !== 4) continue
      const raw: Corner[] = []
      for (let i = 0; i < 4; i++) {
        raw.push([approx.data32S[i * 2] / scale, approx.data32S[i * 2 + 1] / scale])
      }
      const uniq = dedupeClose(raw)
      if (uniq.length !== 4) continue
      if (passesGuards(uniq, W, H)) {
        best = orderCorners(uniq)
        break
      }
    } finally {
      safeDelete(approx)
    }
  }
  return best
}

/**
 * 主入口：检测文档四角。失败/不可用返回 null（调用方降级为手动四角或原图）。
 * @param buf 原图（任意 sharp 可解码格式）
 */
export async function detectCornersCV(buf: Buffer): Promise<Corner[] | null> {
  if ((process.env.IMG_CORNERS || 'on').toLowerCase() === 'off') return null
  const cv = await getCV()
  if (!cv) return null

  let src: any = null, gray: any = null, edges: any = null
  let contours: any = null, hier: any = null, kernel: any = null
  try {
    // ① 解码 + 灰度 + 限尺寸
    const meta = await sharp(buf).metadata()
    const W0 = meta.width || 0
    const H0 = meta.height || 0
    if (!W0 || !H0) return null
    const scale = Math.min(1, DETECT_MAX_SIDE / Math.max(W0, H0))
    const w = Math.max(1, Math.round(W0 * scale))
    const h = Math.max(1, Math.round(H0 * scale))
    const grayBuf = await sharp(buf).resize(w, h, { fit: 'fill' }).grayscale().raw().toBuffer()

    src = cv.matFromArray(h, w, cv.CV_8UC1, Array.from(grayBuf))
    gray = new cv.Mat()
    // 轻微高斯降噪，利于 Canny 稳定
    cv.GaussianBlur(src, gray, new cv.Size(3, 3), 0)

    // ② 边缘 + 闭运算桥接断口
    edges = new cv.Mat()
    cv.Canny(gray, edges, 50, 150)
    kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5))
    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel)

    // ③ 轮廓 → 最大面积
    contours = new cv.MatVector()
    hier = new cv.Mat()
    cv.findContours(edges, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

    let bestIdx = -1
    let bestArea = 0
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i)
      try {
        const a = cv.contourArea(c)
        if (a > bestArea) { bestArea = a; bestIdx = i }
      } finally { safeDelete(c) }
    }
    if (bestIdx < 0) return null

    const biggest = contours.get(bestIdx)
    try {
      return quadFromContour(cv, biggest, scale, W0, H0)
    } finally { safeDelete(biggest) }
  } catch (e) {
    console.warn('[image-corners] 自动角点检测异常，降级为手动四角：', (e as Error)?.message)
    return null
  } finally {
    safeDelete(src, gray, edges, contours, hier, kernel)
  }
}

/**
 * 【神经插槽】真实 DBNet 角点模型接入点。
 * 部署环境若提供 DBNet ONNX（IMG_CORNERS=dbnet），在此用 onnxruntime-node 推理得到角点热图 → 四角，
 * 失败则回落 detectCornersCV。当前权重不可得，故不实现。
 */
export async function detectCornersNeural(_buf: Buffer): Promise<Corner[] | null> {
  return null
}
