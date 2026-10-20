import sharp from 'sharp'
import { estimateOrientation, rotateBuffer, ocrAngleFromSidecar, type OrientationAngle } from './image-orient'

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
 * 双线性重采样：把 src(raw, w×h×ch) 按单应 H 映射到 outW×outH。
 *
 * ⚠️【事故档案 · 单应矩阵方向用反】───────────────────────────────────────────
 * 旧注释写着「H 为 src->dst，反向采样时复用同一组系数（把目标坐标代入即得源坐标）」。
 * 这句话是错的，而且后果严重：**反向采样需要的是 dst→src，即 H⁻¹，不是 H。**
 *
 * 实测（源图四角 [30,15]……，目标 890×1180）：
 *   输出像素 (0,0) 本该取源图的 [30,15]，旧实现取到的是 [-32.1,-15.9] ——
 *   整幅图被平移 + 施加了**反向**的透视，纸根本没被压平，只是被换了个错法弄歪。
 *
 * 它解释了长期无法定位的多个现象：
 *   ① 用户反馈「四角拉框确认后，图片未按四角裁剪」—— 不是流程没走，是 warp 本身就错；
 *   ② probe-corners-acc 里「喂真四角进去，输出行倾角 σ 仍有 2.23°」——真四角也救不了；
 *   ③ 自动调正「命中反而比不命中更糟」（σ 0.06° → 3.3°）—— 错得更彻底。
 *
 * 修复：调用方改为传入 **dst→src** 的 H（solveHomography(dst, ordered)）。
 * 判定依据（勿凭直觉改回）：`H(输出角) === 源图对应角`。
 *
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
export async function dewarpBuffer(
  buf: Buffer,
  cornersRaw: Corner[],
  opts: { keepFullCanvas?: boolean } = {},
): Promise<DewarpResult> {
  if (!cornersRaw || cornersRaw.length !== 4) throw new Error('dewarp 需要 4 个角点')
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const ordered = orderCorners(cornersRaw)
  let homo: number[]
  let W: number
  let H: number
  if (opts.keepFullCanvas) {
    // 「只拉直、不裁边」模式：把原图四个角点经正向单应映射到目标空间，取包围盒作为
    // 输出画布 —— 原图全部像素（含页面左右/上下留白）都被纳入，边距原样保留。
    // 否则（默认）以内容包络四角定输出尺寸，会把页面空白整段裁掉，造成用户反馈的
    // "外框及四周文字被裁剪"（实测横图 1440px 宽被砍到 994px，丢 31%）。
    const unitDst: Corner[] = [[0, 0], [1, 0], [1, 1], [0, 1]]
    const F = solveHomography(ordered, unitDst) // src(角) → 单位网格（正向）
    const apply = (x: number, y: number): Corner => {
      const d = F[6] * x + F[7] * y + 1
      return [(F[0] * x + F[1] * y + F[2]) / d, (F[3] * x + F[4] * y + F[5]) / d]
    }
    const pts = [apply(0, 0), apply(info.width, 0), apply(info.width, info.height), apply(0, info.height)]
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    const spanX = Math.max(...xs) - minX
    const spanY = Math.max(...ys) - minY
    // ⭐ 单位空间 → 像素空间：单位网格（= 检测到的文档四角）对应的像素尺寸与默认路径
    // 同口径（targetSize 取四角边长像素值）。
    // ⚠️ 事故档案（2026-10-20 思傅真机）：此处曾把「像素 margin」直接加在单位坐标上，
    // 而单位空间的全图包围盒跨度只有 ~1~3 → 输出画布恒塌缩成
    // ~1+2×(2%×max边长) ≈ 37px（640×902 原图实测输出 37×39 的糊图）。
    // OCR 后前端把页面图换成该裂图，用户感知「识别后图被裁剪成小局部/被换图」。
    const [docW, docH] = targetSize(ordered)
    const margin = Math.max(2, Math.round(Math.max(info.width, info.height) * 0.02))
    W = Math.max(1, Math.round(spanX * docW) + margin * 2)
    H = Math.max(1, Math.round(spanY * docH) + margin * 2)
    // homo（输出像素 → 源图像素）：输出画布四角 ↔ 单位空间包围盒四角 ↔ 源图（F 的逆）。
    // ⚠️ 事故档案（同次排查）：此前把「图像四角的显示位置」与「文档四角」直接配给
    // solveHomography——两组点语义不同，homo 把整幅输出映射到文档四角周边的源区域，
    // 且单位空间跨度仅 ~1 使输出塌缩成 ~37px 糊图；用户实测「识别后页面文字消失、
    // 图被换成空白纸」。正确做法：输出四角 ↔ 包围盒四角经 F⁻¹ 回投到源图，
    // 保证全图像素按同一透视映入画布（文档四角区被摆正，四周内容原样保留）。
    const outCorners: Corner[] = [
      [margin, margin],
      [W - margin, margin],
      [W - margin, H - margin],
      [margin, H - margin],
    ]
    const unitBox: Corner[] = [
      [minX, minY],
      [minX + spanX, minY],
      [minX + spanX, minY + spanY],
      [minX, minY + spanY],
    ]
    const invF = solveHomography(unitDst, ordered) // 单位网格 → src(角)
    const applyInv = (x: number, y: number): Corner => {
      const d = invF[6] * x + invF[7] * y + 1
      return [(invF[0] * x + invF[1] * y + invF[2]) / d, (invF[3] * x + invF[4] * y + invF[5]) / d]
    }
    homo = solveHomography(outCorners, unitBox.map(([x, y]) => applyInv(x, y)))
  } else {
    const sz = targetSize(ordered)
    W = sz[0]
    H = sz[1]
    const dst: Corner[] = [[0, 0], [W, 0], [W, H], [0, H]]
    homo = solveHomography(dst, ordered)
  }
  // 反向采样：对输出像素 (X,Y) 求它在源图中的位置 → homo 已由上方分支按各自坐标系
  // 正确装配（输出像素 → 源图像素），见 warpRaw 顶部事故档案。
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
  /**
   * 透视压平时是否「只拉直、不裁边」（默认 false）。
   * true = 保留原图全部像素（含页面四周留白），仅做几何摆正，绝不按内容包络裁掉边角文字；
   * false（默认）= 以内容包络四角定输出尺寸，会裁掉页面空白、可能切到边角文字。
   * OCR/版面分析等需要整页内容的场景应传 true（见 buildLayoutContext）。
   */
  keepFullCanvas?: boolean
  /**
   * 是否在「四角检测未命中」后继续尝试**文本行倾斜估计**（默认 true）。
   *
   * ⭐ 这是让「自动调正」在真实场景真正可用的关键：四角检测要求画面里有纸张外框，
   *   而手机拍试卷绝大多数是**纸面占满画面**（没有外框），Canny 只抓到文字碎边 →
   *   恒不命中 → 旧行为直接原样返回，用户看到「点了没反应」。
   *   文本行法只要有字就能算倾斜角，与有没有外框无关。
   */
  deskew?: boolean
  /**
   * 是否在「四角检测未命中」后尝试 **UVDoc 矫正**（3.x 侧车 /ppsv3/rectify，默认 true）。
   *
   * ⭐ 摆正链路的首选矫正路径（溯源文档 §四决策 1）：UVDoc 是透视/曲面模型（治本），
   *   投影估计器（deskew）只是旋转模型且密页上已证明不可靠（#135 修复后保守拒动）。
   *   四角检测要求画面里有纸张外框，而手机拍试卷绝大多数纸面占满画面 → 恒不命中，
   *   此时 UVDoc 是唯一能修透视/曲面的路径。侧车不可用 → 静默回落 deskew 兜底。
   *   关闭：`OCR_RECTIFY=0` 或传 `rectify: false`。
   */
  rectify?: boolean
  /**
   * 是否在 deskew 之后继续检测**透视残留**并校正（默认 true）。
   *
   * deskew 是旋转模型，只问「整体歪了多少度」；而真实拍照常常整体不歪
   * （μ≈0°）却**各行互不平行**（σ>1°）—— 那是透视，旋转原理上修不了。
   * 本项在纸面占满画面（无纸边可检测）时是唯一能修透视的路径。
   * 见 image-perspective.ts 顶部说明。
   */
  perspective?: boolean
  /**
   * 是否做**朝向自动摆正**（0/90/180/270° 翻转，默认 true）。
   *
   * 纯几何投影法判定文字横排/竖排，确定性修掉 90°/270° 侧翻（零外部依赖）；
   * 0/180、90/270 的镜像消歧为最佳努力，需侧车 OCR（CV 模型，非大模型）辅助。
   * 详见 image-orient.ts。
   */
  orient?: boolean
  /**
   * 朝向镜像消歧是否启用 OCR 侧车细化（默认跟随 env `OCR_ORIENT_REFINE`）。
   * 关闭则仅用纯几何（侧车不可达时自动回落此项）。
   */
  orientOcrRefine?: boolean
}

export interface StraightenOutput {
  buffer: Buffer | null
  width?: number
  height?: number
  orderedCorners?: Corner[]
  /** true 表示未做变换，需要前端提供 manual_corners */
  needManual: boolean
  /** 实际使用的路径（便于 debug / 回归） */
  method?: 'manual' | 'auto' | 'curved' | 'skew' | 'rectify' | 'rectify+skew' | 'rectify+perspective' | 'perspective' | 'orient-only' | 'none'
  /** 朝向摆正：实际施加的旋转角与判定方式（无旋转时为 0 / 'none'） */
  orientAngle?: OrientationAngle
  orientMethod?: 'projection' | 'ocr' | 'none'
  orientAxis?: 'horizontal' | 'vertical'
  /**
   * true = 朝向**未经 OCR 消歧确认**，可能整页倒置（上下颠倒）。
   *
   * ⚠️ 由来（实测踩出来的坑）：0°/180°、90°/270° 的"正立与否"**纯几何无法判定**
   * （投影关于 180° 镜像对称），必须靠 OCR 读文字量来定。若 OCR 侧车不可达
   * （进程被杀/超时/DRY_RUN），几何法会静默给出一个角度——**可能是反的**。
   * 实测表现：侧车挂掉后摆正回落 projection、angle=90（正确应为 270），
   * 整页上下颠倒却照样出结果，medH 28.3→24.7、红笔标记 288→281，
   * 错题数从 6 掉到 5——这类"静默脏数据"比直接报错危险得多。
   * 上层（错题提取等）应据此字段决定是否信任本页结果 / 提示用户复核。
   */
  orientSuspect?: boolean
  /** skew 路径专用：实际施加的旋转角（度）与置信度 */
  rotateDeg?: number
  confidence?: number
  /** perspective 路径专用：校正前后的行不平行度（度） */
  parallelBefore?: number
  parallelAfter?: number
}

/**
 * 编排：优先 manual，其次 auto 检测；`curved` 时优先尝试曲面展开（当前不可用，会自动回落）。
 * 皆失败则返回原图（needManual=true）。
 *
 * ⚠️ 曲面展开（Phase 3 交付 2）经实测判定不可靠（见 image-curvedewarp.ts 顶部说明），
 * 当前恒回落平面 homography，故行为与 Phase 1 一致、不劣化。
 */
export async function straightenImage(buf: Buffer, opts: StraightenOptions): Promise<StraightenOutput> {
  // ⭐ 朝向自动摆正（默认开启，纯几何、零外部依赖）：
  //   先判定文字横排/竖排并转正，再走后续四角/倾斜/透视流程——否则 90° 侧翻的图
  //   会让四角检测、deskew、版面切分全部在错误朝向下工作（实测横躺图文字被竖读、切块碎片化）。
  let workBuf: Buffer = buf
  const orientResult: {
    angle: OrientationAngle
    method: 'none' | 'projection' | 'ocr'
    axis: 'horizontal' | 'vertical'
    suspect: boolean
  } = { angle: 0, method: 'none', axis: 'horizontal', suspect: false }
  if (opts.orient !== false) {
    try {
      const refine = opts.orientOcrRefine ?? process.env.OCR_ORIENT_REFINE !== '0'
      const ocrAngle = refine ? ocrAngleFromSidecar() : undefined
      const o = await estimateOrientation(workBuf, ocrAngle)
      orientResult.angle = o.angle
      orientResult.method = o.method
      orientResult.axis = o.axis
      if (o.angle !== 0) workBuf = await rotateBuffer(workBuf, o.angle)
      console.log(`[image-dewarp] 朝向摆正：旋转 ${o.angle}°（方法 ${o.method}，主轴 ${o.axis}）`)
      // 落回几何 = OCR 消歧没生效：0/180、90/270 无法区分（投影关于 180° 镜像对称）。
      // 保守策略下不再猜转（正排图误转 90° 是用户实测事故），但竖排图可能侧躺——
      // method=projection 且（suspect 或非零旋转）即标记不可直接采信。
      // ⚠️ 必须无条件打告警（此前错误加了 `&& refine` 门控）：当 OCR 细化被显式关闭
      // （OCR_ORIENT_REFINE=0）或未配置侧车时，refine 为 false，但若仍走了几何非零旋转，
      // orientSuspect 竟为 false —— 倒置结果看起来"正常、无报警"，正是这次诊断图静默倒置的根因。
      if (o.suspect === true || (o.method === 'projection' && o.angle !== 0)) {
        orientResult.suspect = true
        console.warn(
          `⚠️ [image-dewarp] 朝向未经 OCR 确认（method=${o.method}，主轴 ${o.axis}，旋转 ${o.angle}°），本页可能侧躺/颠倒！` +
            ` OCR 细化${refine ? '已启用但侧车不可用/为 DRY_RUN' : '未启用（OCR_ORIENT_REFINE=0 或侧车缺失）'}；` +
            `已按保守策略不猜转，请检查 OCR 侧车或开启细化后重跑，勿直接采信本次结果。`,
        )
      }
    } catch (e) {
      console.warn('[image-dewarp] 朝向摆正失败，沿用原图：', (e as Error).message)
    }
  }

  // 曲面优先（若启用）：命中则用它，否则继续走平面路径
  if (opts.curved) {
    const { dewarpCurved } = await import('./image-curvedewarp')
    const curved = await dewarpCurved(workBuf)
    if (curved) {
      return { buffer: curved.buffer, width: curved.width, height: curved.height, needManual: false, method: 'curved', orientAngle: orientResult.angle, orientMethod: orientResult.method, orientAxis: orientResult.axis, orientSuspect: orientResult.suspect }
    }
  }
  if (opts.manualCorners && opts.manualCorners.length === 4) {
    // 手动四角：用户拉的四边形可能退化（共线/面积≈0/自交）→ 单应矩阵奇异。
    // 此处捕获并**回落自动检测**，绝不把几何异常抛给上层（否则前端一次误拖就 500）。
    try {
      const r = await dewarpBuffer(workBuf, opts.manualCorners, { keepFullCanvas: opts.keepFullCanvas })
      return { buffer: r.buffer, width: r.width, height: r.height, orderedCorners: r.orderedCorners, needManual: false, method: 'manual', orientAngle: orientResult.angle, orientMethod: orientResult.method, orientAxis: orientResult.axis, orientSuspect: orientResult.suspect }
    } catch (e) {
      console.warn('[image-dewarp] 手动四角无效，回落自动检测：', (e as Error).message)
    }
  }
  if (opts.auto) {
    const corners = await detectDocumentCorners(workBuf)
    if (corners) {
      try {
        const r = await dewarpBuffer(workBuf, corners, { keepFullCanvas: opts.keepFullCanvas })
        return { buffer: r.buffer, width: r.width, height: r.height, orderedCorners: r.orderedCorners, needManual: false, method: 'auto', orientAngle: orientResult.angle, orientMethod: orientResult.method, orientAxis: orientResult.axis, orientSuspect: orientResult.suspect }
      } catch (e) {
        console.warn('[image-dewarp] 自动检测四角无效：', (e as Error).message)
      }
    }
  }

  // ⭐ UVDoc 矫正（四角未命中时的首选矫正路径，默认开启）：
  //   四角检测依赖「画面里有纸张外框」，纸面占满画面时恒不命中；UVDoc 是透视/
  //   曲面模型（治本），投影估计器（deskew）只是旋转模型且密页上不可靠（#135）。
  //   矫正成功 → 后续 deskew/透视残留在矫正后的图上继续跑（coarse-to-fine）；
  //   侧车不可用/超时/失败 → 静默回落 deskew 兜底，主链路不抛错。
  let rectInfo: { elapsed_ms: number } | null = null
  if (opts.rectify !== false) {
    try {
      const { rectifyBySidecar } = await import('./image-rectify')
      const r = await rectifyBySidecar(workBuf)
      if (r) {
        workBuf = r.buffer
        rectInfo = { elapsed_ms: r.elapsed_ms }
        console.log(
          `[image-dewarp] UVDoc 矫正完成：${r.width}x${r.height}（${r.elapsed_ms}ms）`,
        )
      }
    } catch (e) {
      console.warn('[image-dewarp] UVDoc 矫正失败，回落投影估计器：', (e as Error).message)
    }
  }

  // ⭐ 倾斜兜底（默认开启）：四角检测依赖「画面里有纸张外框」，而真实拍摄绝大多数是
  //   纸面占满画面 → 四角恒不命中 → 旧实现直接原样返回（用户感知＝"点了没反应"）。
  //   文本行投影法不依赖外框，只要纸上有字就能算出倾斜角并转正。
  // ⭐ 旋转兜底（默认开启）：四角检测依赖「画面里有纸张外框」，而真实拍摄绝大多数是
  //   纸面占满画面 → 四角恒不命中 → 旧实现直接原样返回（用户感知＝"点了没反应"）。
  //   文本行投影法不依赖外框，只要纸上有字就能算出倾斜角并转正。
  let rotBuf: Buffer | null = null
  let skewInfo: { rotateDeg: number; confidence: number } | null = null
  if (opts.deskew !== false) {
    try {
      const { deskewImage } = await import('./image-deskew')
      const d = await deskewImage(workBuf)
      if (d) {
        console.log(
          `[image-dewarp] 四角检测未命中，走文本行倾斜估计：旋转 ${d.rotateDeg}°（置信度 ${d.confidence.toFixed(2)}）`,
        )
        rotBuf = d.buffer
        skewInfo = { rotateDeg: d.rotateDeg, confidence: d.confidence }
      }
    } catch (e) {
      console.warn('[image-dewarp] 文本行倾斜估计失败：', (e as Error).message)
    }
  }

  // ⭐ 透视残留校正（默认开启，继旋转之后——coarse-to-fine）：
  //   旋转模型修不了「行与行互不平行」，那是透视的指纹。此时整体角度往往≈0，
  //   deskew 会判定"本来就正"而放手不管，用户看到的就是"点了没反应"。
  //   在旋转后的图上继续校正（先去掉整体旋转，剩下的 σ 才干净地代表透视）。
  const baseForPersp = rotBuf ?? workBuf
  if (opts.perspective !== false) {
    try {
      const { fixPerspectiveFromText } = await import('./image-perspective')
      const p = await fixPerspectiveFromText(baseForPersp)
      if (p) {
        const m = await sharp(p.buffer).metadata()
        console.log(
          `[image-dewarp] 检测到透视残留并校正：行不平行度 ${p.beforeStd.toFixed(2)}° → ${p.afterStd.toFixed(2)}°`,
        )
        return {
          buffer: p.buffer,
          width: m.width || p.width,
          height: m.height || p.height,
          needManual: false,
          method: rectInfo ? 'rectify+perspective' : 'perspective',
          orderedCorners: p.corners,
          ...(skewInfo ?? {}),
          orientAngle: orientResult.angle,
          orientMethod: orientResult.method,
          orientAxis: orientResult.axis, orientSuspect: orientResult.suspect,
          parallelBefore: p.beforeStd,
          parallelAfter: p.afterStd,
        }
      }
    } catch (e) {
      console.warn('[image-dewarp] 透视残留校正失败：', (e as Error).message)
    }
  }

  if (rotBuf) {
    const m = await sharp(rotBuf).metadata()
    return {
      buffer: rotBuf,
      width: m.width || 0,
      height: m.height || 0,
      needManual: false,
      method: rectInfo ? 'rectify+skew' : 'skew',
      ...(skewInfo ?? {}),
      orientAngle: orientResult.angle,
      orientMethod: orientResult.method,
      orientAxis: orientResult.axis, orientSuspect: orientResult.suspect,
    }
  }

  // ⭐ 兜底：即使四角/倾斜/透视三路全部未命中，也【绝不能丢弃已完成的朝向旋转】。
  // 否则 full-bleed 照片（纸面占满画面、无外框）会一路落到本分支，把 orientAngle
  // 算出来的旋转结果整个丢掉，buildLayoutContext 回退到原图 → 方向校正名存实亡、
  // 下游 OCR 在竖排/倒置图上工作（实测表现为「绿框方向上下颠倒、题目范围截错」）。
  // 故此处返回【已旋转的 workBuf】（可能还含 UVDoc 矫正结果），needManual 视是否真拿到可用图决定。
  const fbBuf = workBuf ?? buf
  try {
    const m = await sharp(fbBuf).metadata()
    return {
      buffer: fbBuf,
      width: m.width || 0,
      height: m.height || 0,
      needManual: false,
      method: rectInfo ? 'rectify' : 'orient-only',
      orientAngle: orientResult.angle,
      orientMethod: orientResult.method,
      orientAxis: orientResult.axis,
      orientSuspect: orientResult.suspect,
    }
  } catch {
    return {
      buffer: fbBuf,
      width: 0,
      height: 0,
      needManual: false,
      method: rectInfo ? 'rectify' : 'orient-only',
      orientAngle: orientResult.angle,
      orientMethod: orientResult.method,
      orientAxis: orientResult.axis,
      orientSuspect: orientResult.suspect,
    }
  }
}
