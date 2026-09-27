import sharp from 'sharp'

export type Corner = [number, number]

/**
 * 几何纠偏（自动调正）核心：四点透视变换（perspective warping）。
 *
 * 设计原则（对齐《自动调正与智能高清重构方案》§2）：
 *  - 纠偏是**几何变换**，像素不被重画 → 内容 100% 保真（区别于图生图整图重绘）。
 *  - 主路径：straightenImage 接收四角（manual_corners，前端拉框）后做透视压平。
 *  - 自动四角检测（Canny + contours + approxPolyDP）为后续增强，需接入 OpenCV
 *    绑定（WASM / 原生），见 detectDocumentCorners 占位说明。
 *
 * 与 image-preprocess 保持一致：依赖 sharp 做像素 I/O（解码→RAW→变换→编码）。
 */

/** 把任意顺序的四角点排序为 [tl, tr, br, bl]（左上/右上/右下/左下）。 */
export function orderCorners(pts: Corner[]): Corner[] {
  const p = pts.map((x) => [...x] as Corner)
  const s = p.map((q) => q[0] + q[1])
  const tl = p[s.indexOf(Math.min(...s))]
  const br = p[s.indexOf(Math.max(...s))]
  const diff = p.map((q) => q[1] - q[0]) // 右上 y-x 最小，左下 y-x 最大
  const tr = p[diff.indexOf(Math.min(...diff))]
  const bl = p[diff.indexOf(Math.max(...diff))]
  return [tl, tr, br, bl]
}

/** 解单应矩阵 H（src -> dst），返回 [h0..h7]，约定 h8=1。8×8 高斯消元。 */
function solveHomography(src: Corner[], dst: Corner[]): number[] {
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]
    const [X, Y] = dst[i]
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X)
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y)
  }
  return gaussianSolve(A, b)
}

/** 解 Ax=b（A 为 n×n 方阵），部分主元高斯消元 + 回代。 */
function gaussianSolve(A: number[][], b: number[]): number[] {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    ;[M[col], M[piv]] = [M[piv], M[col]]
    const d = M[col][col]
    if (Math.abs(d) < 1e-12) throw new Error('透视矩阵奇异，四角可能共线')
    for (let c = col; c <= n; c++) M[col][c] /= d
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = M[r][col]
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c]
    }
  }
  return M.map((row) => row[n])
}

/**
 * 双线性重采样：把 src(raw, w×h×ch) 按单应 H 反向映射到 outW×outH。
 * H 为 src->dst，反向采样时复用同一组系数（把目标坐标代入即得源坐标）。
 * 边界外像素填 background（默认不透明白）。
 */
function warpRaw(
  src: Buffer, w: number, h: number, ch: number,
  H: number[], outW: number, outH: number, background = 255,
): Buffer {
  const out = Buffer.alloc(outW * outH * ch, background)
  const [h0, h1, h2, h3, h4, h5, h6, h7] = H
  for (let Y = 0; Y < outH; Y++) {
    for (let X = 0; X < outW; X++) {
      const denom = h6 * X + h7 * Y + 1
      if (Math.abs(denom) < 1e-9) continue
      const x = (h0 * X + h1 * Y + h2) / denom
      const y = (h3 * X + h4 * Y + h5) / denom
      if (x < 0 || y < 0 || x > w - 1 || y > h - 1) continue
      const x0 = Math.floor(x), y0 = Math.floor(y)
      const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1)
      const fx = x - x0, fy = y - y0
      const i00 = (y0 * w + x0) * ch
      const i10 = (y0 * w + x1) * ch
      const i01 = (y1 * w + x0) * ch
      const i11 = (y1 * w + x1) * ch
      const o = (Y * outW + X) * ch
      for (let c = 0; c < ch; c++) {
        const v00 = src[i00 + c], v10 = src[i10 + c], v01 = src[i01 + c], v11 = src[i11 + c]
        const top = v00 * (1 - fx) + v10 * fx
        const bot = v01 * (1 - fx) + v11 * fx
        out[o + c] = Math.round(top * (1 - fy) + bot * fy)
      }
    }
  }
  return out
}

/** 由四角推算目标矩形尺寸（取对角最大边，避免方向性偏差）。 */
function targetSize(corners: Corner[]): [number, number] {
  const dist = (a: Corner, b: Corner) => Math.hypot(a[0] - b[0], a[1] - b[1])
  const W = Math.round(Math.max(dist(corners[0], corners[1]), dist(corners[3], corners[2])))
  const H = Math.round(Math.max(dist(corners[0], corners[3]), dist(corners[1], corners[2])))
  return [Math.max(W, 1), Math.max(H, 1)]
}

export interface DewarpResult {
  buffer: Buffer
  width: number
  height: number
  orderedCorners: Corner[]
}

/** 主函数：给定四角，把原图透视压平成正面矩形。 */
export async function dewarpBuffer(buf: Buffer, cornersRaw: Corner[]): Promise<DewarpResult> {
  if (!cornersRaw || cornersRaw.length !== 4) throw new Error('dewarp 需要 4 个角点')
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const ordered = orderCorners(cornersRaw)
  const [W, H] = targetSize(ordered)
  const dst: Corner[] = [[0, 0], [W, 0], [W, H], [0, H]]
  const homo = solveHomography(ordered, dst)
  const out = warpRaw(data, info.width, info.height, info.channels, homo, W, H)
  const buffer = await sharp(out, { raw: { width: W, height: H, channels: info.channels } })
    .png()
    .toBuffer()
  return { buffer, width: W, height: H, orderedCorners: ordered }
}

/**
 * 自动四角检测（Phase 3 交付 1）。
 *
 * 实现已从占位升级为**经典检测管线**（Canny + 轮廓 + approxPolyDP，见 image-corners.ts），
 * 依赖 OpenCV WASM（懒加载，不可用时自动降级返回 null）。
 *
 * 返回 null 表示「未命中」，调用方降级为 manual_corners 或原图+提示（方案 §2.3）。
 */
export async function detectDocumentCorners(buf: Buffer): Promise<Corner[] | null> {
  // 动态 import 避免顶层加载 OpenCV（WASM 初始化成本高、需懒加载）
  const { detectCornersCV, detectCornersNeural } = await import('./image-corners')
  if ((process.env.IMG_CORNERS || 'on').toLowerCase() === 'dbnet') {
    const neural = await detectCornersNeural(buf)
    if (neural) return neural
  }
  return detectCornersCV(buf)
}

export interface StraightenOptions {
  /** 前端手动拉框的四角（优先），顺序任意，函数内部排序 */
  manualCorners?: Corner[]
  /** 是否尝试自动检测（Phase 3 起为真实检测，OpenCV 不可用时自动降级） */
  auto?: boolean
  /**
   * 是否尝试曲面展开（Phase 3）。当前 `dewarpCurved` 经实测判为不可靠、恒返回 null，
   * 故此项为「未来神经模型」预留；为 true 时先试曲面、失败即回落平面 homography，不劣化。
   */
  curved?: boolean
}

export interface StraightenOutput {
  buffer: Buffer | null
  width?: number
  height?: number
  orderedCorners?: Corner[]
  /** true 表示未做变换，需要前端提供 manual_corners */
  needManual: boolean
  /** 实际使用的路径（便于 debug / 回归） */
  method?: 'manual' | 'auto' | 'curved' | 'none'
}

/**
 * 编排：优先 manual，其次 auto 检测；`curved` 时优先尝试曲面展开（当前不可用，会自动回落）。
 * 皆失败则返回原图（needManual=true）。
 *
 * ⚠️ 曲面展开（Phase 3 交付 2）经实测判定不可靠（见 image-curvedewarp.ts 顶部说明），
 * 当前恒回落平面 homography，故行为与 Phase 1 一致、不劣化。
 */
export async function straightenImage(buf: Buffer, opts: StraightenOptions): Promise<StraightenOutput> {
  // 曲面优先（若启用）：命中则用它，否则继续走平面路径
  if (opts.curved) {
    const { dewarpCurved } = await import('./image-curvedewarp')
    const curved = await dewarpCurved(buf)
    if (curved) {
      return { buffer: curved.buffer, width: curved.width, height: curved.height, needManual: false, method: 'curved' }
    }
  }
  if (opts.manualCorners && opts.manualCorners.length === 4) {
    // 手动四角：用户拉的四边形可能退化（共线/面积≈0/自交）→ 单应矩阵奇异。
    // 此处捕获并**回落自动检测**，绝不把几何异常抛给上层（否则前端一次误拖就 500）。
    try {
      const r = await dewarpBuffer(buf, opts.manualCorners)
      return { buffer: r.buffer, width: r.width, height: r.height, orderedCorners: r.orderedCorners, needManual: false, method: 'manual' }
    } catch (e) {
      console.warn('[image-dewarp] 手动四角无效，回落自动检测：', (e as Error).message)
    }
  }
  if (opts.auto) {
    const corners = await detectDocumentCorners(buf)
    if (corners) {
      try {
        const r = await dewarpBuffer(buf, corners)
        return { buffer: r.buffer, width: r.width, height: r.height, orderedCorners: r.orderedCorners, needManual: false, method: 'auto' }
      } catch (e) {
        console.warn('[image-dewarp] 自动检测四角无效：', (e as Error).message)
      }
    }
  }
  return { buffer: null, needManual: true, method: 'none' }
}
