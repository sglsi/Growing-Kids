import sharp from 'sharp'

/**
 * 阶段二：手写 mask 分割 + 局部修复（Inpainting）+ 原图混合（blend）
 *
 * 核心思想（业界标准两阶段范式）：
 *
 *   原图 ──▶ ① 分割：得到手写区域的 mask ──▶ ② 修复：只重建 mask 区域
 *                                              ──▶ ③ blend：非 mask 像素**原样保留**
 *
 * 第 ③ 步的 blend 公式
 *     output = inpainted * (1 - mask) + original * mask
 * 就是"**绝不重排、绝不改版式**"的数学保证 —— 因为非手写区域的像素根本没被替换。
 *
 * 与阶段一的关系：
 *   阶段一（保比例/色调/校验）是"减少重绘损伤"的**缓解手段**；
 *   阶段二是"从机制上不做重绘"的**根治手段**。二者叠加使用。
 */

// ============================================================
// ① Mask 表示
// ============================================================

/**
 * 手写区域掩码。
 * 用单通道灰度 Buffer 表示：255 = 手写（待修复），0 = 保留原图。
 * 存为灰度是为了与 sharp 的 `joinChannel`/`composite` 直接对接。
 */
export interface HandwritingMask {
  width: number
  height: number
  /** 长度 = width*height 的单通道灰度数据 */
  data: Buffer
  /** 覆盖比例（手写像素 / 总像素），用于判断是否需要修复、以及选择策略 */
  coverage: number
  /** mask 来源，便于排查 */
  source: 'vlm' | 'threshold' | 'manual'
}

/** 矩形区域（VLM 返回的 bounding box） */
export interface MaskRect {
  /** 归一化坐标 0~1 */
  x: number
  y: number
  w: number
  h: number
  /** 该区域为手写的置信度 0~1 */
  confidence?: number
}

/**
 * 由一组归一化矩形生成 mask。
 * 会在矩形外扩 `dilate` 像素（宁可多修一点，避免留笔迹残边）。
 */
export function maskFromRects(
  width: number,
  height: number,
  rects: MaskRect[],
  opts: { dilate?: number; source?: HandwritingMask['source'] } = {},
): HandwritingMask {
  const dilate = Math.max(0, Math.round(opts.dilate ?? Math.round(Math.min(width, height) * 0.01)))
  const data = Buffer.alloc(width * height, 0)
  let covered = 0

  for (const r of rects) {
    if (r.confidence !== undefined && r.confidence < 0.3) continue
    const x0 = Math.max(0, Math.floor(r.x * width) - dilate)
    const y0 = Math.max(0, Math.floor(r.y * height) - dilate)
    const x1 = Math.min(width, Math.ceil((r.x + r.w) * width) + dilate)
    const y1 = Math.min(height, Math.ceil((r.y + r.h) * height) + dilate)
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * width + x
        if (data[i] === 0) covered++
        data[i] = 255
      }
    }
  }

  return {
    width,
    height,
    data,
    coverage: covered / (width * height),
    source: opts.source ?? 'vlm',
  }
}

/**
 * 兜底方案：用**色域阈值**生成 mask（不需要任何模型）。
 *
 * 原理：印刷体多为近黑（R≈G≈B 且很低），手写常为蓝/红（有色偏）。
 * 因此找出"有颜色倾向"的像素（通道差大）作为手写候选。
 *
 * 局限（业界公认）：对**纯黑签字笔**无效（与印刷体色差太小）。
 * 所以它只作为 VLM 不可用时的降级路径，且必须叠加下面 `inknessFilter` 抑制印刷体。
 */
export async function maskFromColorThreshold(
  buf: Buffer,
  opts: { chromaMin?: number; darknessMax?: number } = {},
): Promise<HandwritingMask> {
  const chromaMin = opts.chromaMin ?? 22 // 通道极差阈值：越大越严格
  const darknessMax = opts.darknessMax ?? 200

  const { data, info } = await sharp(buf)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  const mask = Buffer.alloc(width * height, 0)
  let covered = 0

  for (let i = 0, p = 0; i < mask.length; i++, p += channels) {
    const r = data[p]
    const g = data[p + 1]
    const b = data[p + 2]
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const chroma = max - min
    // 有颜色倾向 且 不是纯白背景
    if (chroma >= chromaMin && min < darknessMax) {
      mask[i] = 255
      covered++
    }
  }

  return {
    width,
    height,
    data: mask,
    coverage: covered / (width * height),
    source: 'threshold',
  }
}

// ============================================================
// ①-B 区域分类：区分「空白区」与「压字区」（业界"内容切分"步骤）
// ============================================================

/**
 * 区域类型（对应业界"按区域类型分别处理"的做法）
 *
 * - `blank`：mask 附近没有印刷体 → 手写落在空白答题区 → 用纸张底色填充即可
 * - `text` ：mask 附近存在印刷体 → **手写压在印刷体上** → 需要结构延拓重建
 *            （若简单填底色，会把被压住的印刷体一起抹掉，留一个缺口）
 *
 * 参考：TextIn / 华为「试卷还原」的四步流水线之「内容切分」——
 * 把图像划分为"擦除区域"与"非擦除区域"，再分别处理。
 */
export type RegionKind = 'blank' | 'text'

/** 逐块分类结果 */
export interface MaskRegion {
  /** 归一化边界（用于分块统计） */
  x: number
  y: number
  w: number
  h: number
  kind: RegionKind
  /** 该块内属于 mask 的像素数 */
  maskPixels: number
  /** 该块内"紧邻印刷体"的 mask 像素占比（判据：≥ touchThreshold 即压字区） */
  printRatio: number
}

/**
 * 判定"印刷体像素"的阈值（与 maskFromColorThreshold 互补）。
 *
 * 印刷体特征：**低色度（近黑/近灰）+ 足够深**。
 * 手写若为蓝/红笔，其色度高，不会被误判；若为黑笔，色域阈值本就分不出来（已知边界）。
 */
export interface PrintPixelCriterion {
  /** 通道极差上限：越小越"灰"（印刷体多为灰/黑） */
  chromaMax: number
  /** 亮度上限：越深越像墨 */
  lumaMax: number
}

const DEFAULT_PRINT_CRITERION: PrintPixelCriterion = { chromaMax: 42, lumaMax: 190 }

/**
 * 统计一张图里"印刷体像素"的布尔图（1 = 像印刷体）。
 * 只做一次，供后续分块统计复用（避免重复解码）。
 */
async function buildPrintMap(
  src: Buffer,
  criterion: PrintPixelCriterion,
): Promise<{ print: Buffer; width: number; height: number; channels: number; data: Buffer }> {
  const { data, info } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  const print = Buffer.alloc(width * height, 0)
  for (let i = 0, p = 0; i < print.length; i++, p += channels) {
    const r = data[p], g = data[p + 1], b = data[p + 2]
    const chroma = Math.max(r, g, b) - Math.min(r, g, b)
    const luma = (r * 299 + g * 587 + b * 114) / 1000
    if (chroma <= criterion.chromaMax && luma <= criterion.lumaMax) print[i] = 1
  }
  return { print, width, height, channels, data }
}

/**
 * 把 mask 按网格分块，逐块判定是「空白区」还是「压字区」。
 *
 * 判据：在该块 mask 像素的**环形邻域**（向外扩 `ring` 像素）里，
 * 统计"印刷体像素"占比。占比超阈值 → 该块附近有印刷体 → 压字区。
 *
 * 为什么要看"环形邻域"而不是"块内"：
 * 块内像素绝大部分被手写遮住了，看不到原本有没有印刷体；
 * 但**紧邻的周围**（mask 之外）能反映"这块区域处在什么环境里"——
 * 如果周围密密麻麻都是印刷体，那被遮住的多半也是印刷体。
 */
export async function classifyMaskRegions(
  src: Buffer,
  mask: HandwritingMask,
  opts: {
    /** 分块边长（像素），默认按短边 1/16 */
    block?: number
    /** 判断"紧邻印刷体"的外扩半径（像素），默认 6 */
    touchRadius?: number
    /** mask 像素中"紧邻印刷体"的比例超过该值判为压字区，默认 0.08 */
    touchThreshold?: number
    criterion?: PrintPixelCriterion
  } = {},
): Promise<{ regions: MaskRegion[]; blocks: Uint8Array; width: number; height: number }> {
  const { print, width, height } = await buildPrintMap(src, opts.criterion ?? DEFAULT_PRINT_CRITERION)
  const block = Math.max(8, opts.block ?? Math.round(Math.min(width, height) / 16))
  const touchRadius = Math.max(3, opts.touchRadius ?? 6)
  const touchThreshold = opts.touchThreshold ?? 0.08

  // mask 尺寸对齐
  let maskBuf = mask.data
  if (mask.width !== width || mask.height !== height) {
    maskBuf = await sharp(mask.data, { raw: { width: mask.width, height: mask.height, channels: 1 } })
      .resize(width, height, { fit: 'fill' })
      .raw()
      .toBuffer()
  }

  const cols = Math.ceil(width / block)
  const rows = Math.ceil(height / block)
  // blocks[c*rows + r] = 1 表示该块为"压字区"
  const blocks = new Uint8Array(cols * rows)
  const regions: MaskRegion[] = []

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = c * block, y0 = r * block
      const x1 = Math.min(width, x0 + block), y1 = Math.min(height, y0 + block)

      // 该块内属于 mask 的像素数
      let maskPixels = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (maskBuf[y * width + x] > 127) maskPixels++
        }
      }
      if (maskPixels === 0) continue // 无手写，跳过

      // 「紧邻印刷体」判据：对每个 mask 像素，检查其 (2R+1)² 邻域内是否存在印刷体。
      // 相比"环形占比"，这对**细线/笔画**极其敏感 ——
      // 印刷横线往往只有 3px 高，在大环形里占比天然极低（实测仅 ~0.012），
      // 但线边缘 1px 外就有墨，用"紧邻"判据即可稳定捕捉。
      let touch = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * width + x
          if (maskBuf[i] <= 127) continue
          let hit = 0
          for (let dy = -touchRadius; dy <= touchRadius && !hit; dy++) {
            const ny = y + dy
            if (ny < 0 || ny >= height) continue
            const rowBase = ny * width
            for (let dx = -touchRadius; dx <= touchRadius; dx++) {
              const nx = x + dx
              if (nx < 0 || nx >= width) continue
              if (print[rowBase + nx]) { hit = 1; break }
            }
          }
          touch += hit
        }
      }
      const touchRatio = maskPixels ? touch / maskPixels : 0
      const kind: RegionKind = touchRatio >= touchThreshold ? 'text' : 'blank'
      if (kind === 'text') blocks[c * rows + r] = 1
      regions.push({
        x: x0 / width, y: y0 / height,
        w: (x1 - x0) / width, h: (y1 - y0) / height,
        kind, maskPixels, printRatio: touchRatio,
      })
    }
  }

  return { regions, blocks, width, height }
}

/**
 * 由块分类结果构造一张"压字区 mask"（255 = 压字区，0 = 其余）。
 * 用于把「结构延拓」只作用在压字区上。
 */
function textRegionMask(
  blocks: Uint8Array,
  cols: number,
  rows: number,
  width: number,
  height: number,
  block: number,
): Buffer {
  const out = Buffer.alloc(width * height, 0)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!blocks[c * rows + r]) continue
      const x0 = c * block, y0 = r * block
      const x1 = Math.min(width, x0 + block), y1 = Math.min(height, y0 + block)
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out[y * width + x] = 255
    }
  }
  return out
}

/**
 * **结构延拓**：针对"手写压在印刷体上"的区域，沿印刷体的走向把结构补回来。
 *
 * 做法（受业界"以周围印刷内容为参考重建"启发，用确定性算法实现）：
 *  1. 在 mask **之外**的邻域找"可信的深色结构像素"（印刷体的笔画/线段）；
 *  2. 对 mask 内的每个像素，沿 8 个方向向外找最近的"可信结构像素"，
 *     若某个方向上很短时间内就命中（说明结构延伸到 mask 边界），
 *     就用该方向上的结构颜色填充 —— 这能把**被手写截断的横线/竖线/表格线接上**；
 *  3. 若 8 个方向都找不到结构（说明这里是"字"内部的空白或纯空白区），
 *     则退化为底色填充。
 *
 * ⚠️ 这是**确定性算法**，不生成任何"新内容"，只把邻域已有的结构延拓进 mask。
 */
async function structuralExtend(
  src: Buffer,
  mask: HandwritingMask,
  regionMask: Buffer | null,
  opts: { searchRadius?: number; bg: BackgroundTone },
): Promise<Buffer> {
  const meta = await sharp(src).metadata()
  const width = meta.width!, height = meta.height!
  const { data, info } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const channels = info.channels
  const searchRadius = Math.max(4, opts.searchRadius ?? Math.round(Math.min(width, height) * 0.012))

  let maskBuf = mask.data
  if (mask.width !== width || mask.height !== height) {
    maskBuf = await sharp(mask.data, { raw: { width: mask.width, height: mask.height, channels: 1 } })
      .resize(width, height, { fit: 'fill' }).raw().toBuffer()
  }

  // 输出初值 = 底色（找不到结构时就用它）
  const out = Buffer.alloc(width * height * channels)
  for (let i = 0; i < width * height; i++) {
    out[i * channels] = opts.bg.r
    out[i * channels + 1] = opts.bg.g
    out[i * channels + 2] = opts.bg.b
  }

  // "可信结构像素"：足够深 **且近灰** 的像素（印刷体墨色）。
  // ⚠️ 刻意**不排除 mask 内像素** —— 当手写压在印刷线上时，mask（含 dilate）很可能
  //    把整条线都框进去；此时"穿透 mask 找最近结构"反而能就地拿到被盖住的线，
  //    从而把横线延拓接回。蓝笔 chroma≈142 仍被 chroma<=42 排除，不会污染结果。
  const isStructure = (i: number) => {
    const p = i * channels
    const r = data[p], g = data[p + 1], b = data[p + 2]
    const luma = (r * 299 + g * 587 + b * 114) / 1000
    const chroma = Math.max(r, g, b) - Math.min(r, g, b)
    return luma <= 170 && chroma <= 42
  }

  // 8 个方向
  const DIRS: Array<[number, number]> = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
  ]

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (maskBuf[i] <= 127) {
        // 非手写像素：原样保留（这保证了"外部 100% 不变"）
        const p = i * channels
        out[p] = data[p]; out[p + 1] = data[p + 1]; out[p + 2] = data[p + 2]
        continue
      }
      // 只对"压字区"做结构延拓；其余（空白区）留底色，交给外层 fillWithBackground
      if (regionMask && regionMask[i] <= 127) continue

      // 沿 8 方向找最近的可信结构像素
      let hitR = 0, hitG = 0, hitB = 0, hits = 0
      for (const [dx, dy] of DIRS) {
        for (let step = 1; step <= searchRadius; step++) {
          const nx = x + dx * step, ny = y + dy * step
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) break
          const j = ny * width + nx
          if (isStructure(j)) {
            const pj = j * channels
            hitR += data[pj]; hitG += data[pj + 1]; hitB += data[pj + 2]; hits++
            break
          }
        }
      }
      if (hits > 0) {
        const p = i * channels
        out[p] = Math.round(hitR / hits)
        out[p + 1] = Math.round(hitG / hits)
        out[p + 2] = Math.round(hitB / hits)
      }
    }
  }

  return sharp(out, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

// ============================================================
// ② 局部修复（Inpainting）
// ============================================================

/**
 * 局部修复策略。
 *
 * - `median`：中值滤波 —— 用邻域中值填掉笔迹，保留纸张纹理，**不引入新内容**。
 *             ⚠️ 只对"细笔迹落在空白/浅色背景"有效；**大面积实心色块无效**
 *             （5x5 邻域内几乎全是笔迹时，中值仍是笔迹色）。
 * - `blur`  ：高斯模糊 —— 比 median 更柔和，适合浅色笔迹；对实心块同样只能淡化。
 * - `masked`：**背景填充** —— 先估计"纸张底色/纹理"，再整块铺进 mask 区域。
 *             能真正抹除大面积实心笔迹；但会把**被压住的印刷体一起抹掉**。
 * - `edge`  ：**由内向外扩散填充** —— 从 mask 边界逐步向内推进邻域均值。
 * - `adaptive`：**区域分类 + 差异化填充（推荐默认）** —— 先分块判定每个手写区域是
 *             「空白区」还是「压字区」，再分别处理：
 *               · 空白区 → 用 `masked` 的纸张底色填充；
 *               · 压字区 → 用 `structuralExtend` 沿邻域结构延拓，**把被手写截断的
 *                 横线/表格线/笔画接回来**，而不是留一个底色缺口。
 *             这是业界"内容切分 → 按区域类型分别重建"做法的确定性实现。
 *
 * 说明：这里刻意**不用生成式模型**补 mask 区域。
 * 原因是生成式会产生"新内容"（可能编造），而阶段二的目标是"只擦除、不改编"。
 * 需要重建被遮挡的复杂汉字笔画时，可后续接入专用 inpainting 模型（见方案文档）。
 */
export type InpaintStrategy = 'median' | 'blur' | 'masked' | 'edge' | 'adaptive'

/** mask 之外的像素统计出的"背景底色" */
export interface BackgroundTone {
  r: number
  g: number
  b: number
  /** 底色标准差（用于叠加纸张颗粒，避免出现"死平"的方块） */
  noise: number
}

/**
 * 在 mask **之外**的像素上估计纸张底色。
 * 用中位数而非均值，避免被残余墨点拉偏。
 */
export async function estimateBackground(
  src: Buffer,
  mask: HandwritingMask,
): Promise<BackgroundTone> {
  const { data, info } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info

  let maskBuf = mask.data
  if (mask.width !== width || mask.height !== height) {
    maskBuf = await sharp(mask.data, { raw: { width: mask.width, height: mask.height, channels: 1 } })
      .resize(width, height, { fit: 'fill' })
      .raw()
      .toBuffer()
  }

  const rs: number[] = []
  const gs: number[] = []
  const bs: number[] = []
  // 采样步长：大图上不必逐像素，既省时又不影响中位数稳定性
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 200000)))
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = y * width + x
      if (maskBuf[i] > 127) continue
      const p = i * channels
      rs.push(data[p]); gs.push(data[p + 1]); bs.push(data[p + 2])
    }
  }
  if (rs.length === 0) return { r: 255, g: 255, b: 255, noise: 0 }

  const median = (arr: number[]) => {
    arr.sort((a, b) => a - b)
    return arr[arr.length >> 1]
  }
  const r = median(rs), g = median(gs), b = median(bs)
  // 以中位色为基准估计高频波动
  let acc = 0
  for (let i = 0; i < rs.length; i++) {
    acc += (rs[i] - r) ** 2 + (gs[i] - g) ** 2 + (bs[i] - b) ** 2
  }
  const noise = Math.sqrt(acc / (rs.length * 3))
  return { r, g, b, noise }
}

/**
 * 背景填充：用 estimateBackground 得到的底色整块铺进 mask 区域，
 * 并叠加一点与底色同量级的随机颗粒，避免出现"纯色方块"的突兀感。
 */
async function fillWithBackground(src: Buffer, mask: HandwritingMask): Promise<Buffer> {
  const meta = await sharp(src).metadata()
  const width = meta.width!, height = meta.height!
  const bg = await estimateBackground(src, mask)

  let maskBuf = mask.data
  if (mask.width !== width || mask.height !== height) {
    maskBuf = await sharp(mask.data, { raw: { width: mask.width, height: mask.height, channels: 1 } })
      .resize(width, height, { fit: 'fill' })
      .raw()
      .toBuffer()
  }

  // 用确定性伪随机（种子固定）生成颗粒，保证结果可复现
  let seed = 0x9e3779b9
  const rand = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
    return ((seed >>> 0) % 1000) / 1000
  }

  // 底图（同尺寸纯底色）
  const base = Buffer.alloc(width * height * 3)
  for (let i = 0; i < width * height; i++) {
    base[i * 3] = bg.r
    base[i * 3 + 1] = bg.g
    base[i * 3 + 2] = bg.b
  }
  const basePng = await sharp(base, { raw: { width, height, channels: 3 } }).png().toBuffer()

  // 底图叠颗粒
  const grain = Buffer.alloc(width * height * 3)
  const amp = Math.min(6, Math.max(0, bg.noise * 0.5))
  for (let i = 0; i < width * height; i++) {
    const d = Math.round((rand() - 0.5) * 2 * amp)
    grain[i * 3] = Math.max(0, Math.min(255, bg.r + d))
    grain[i * 3 + 1] = Math.max(0, Math.min(255, bg.g + d))
    grain[i * 3 + 2] = Math.max(0, Math.min(255, bg.b + d))
  }
  const grainPng = await sharp(grain, { raw: { width, height, channels: 3 } }).png().toBuffer()

  // 用 mask 把"带颗粒的底色"切出来
  return blendWithMask(basePng, grainPng, mask)
}

/**
 * 由内向外扩散填充：反复把"未知像素"替换为其已知邻域的均值，
 * 从 mask 边界逐步向内推进。适合需要延续底色渐变的场景。
 */
async function diffuseFill(src: Buffer, mask: HandwritingMask): Promise<Buffer> {
  const { data, info } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info

  let maskBuf = mask.data
  if (mask.width !== width || mask.height !== height) {
    maskBuf = await sharp(mask.data, { raw: { width: mask.width, height: mask.height, channels: 1 } })
      .resize(width, height, { fit: 'fill' })
      .raw()
      .toBuffer()
  }

  const out = Buffer.from(data)
  // known[i] = 1 表示该像素颜色可信
  const known = Buffer.alloc(width * height)
  for (let i = 0; i < known.length; i++) known[i] = maskBuf[i] > 127 ? 0 : 1

  const rounds = Math.max(8, Math.round(Math.min(width, height) * 0.02))
  for (let r = 0; r < rounds; r++) {
    let progressed = 0
    const snapshot = Buffer.from(out)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        if (known[i]) continue
        let sr = 0, sg = 0, sb = 0, n = 0
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= height) continue
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx
            if (xx < 0 || xx >= width) continue
            const j = yy * width + xx
            if (!known[j]) continue
            const p = j * channels
            sr += snapshot[p]; sg += snapshot[p + 1]; sb += snapshot[p + 2]; n++
          }
        }
        if (n > 0) {
          const p = i * channels
          out[p] = Math.round(sr / n)
          out[p + 1] = Math.round(sg / n)
          out[p + 2] = Math.round(sb / n)
          known[i] = 1
          progressed++
        }
      }
    }
    if (progressed === 0) break // 已全部填充完
  }

  return sharp(out, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

/**
 * 对 mask 区域做局部修复，返回与输入同尺寸的修复图。
 * **注意：本函数只产出"修复后的整图"，最终必须经 `blendWithMask` 与原件混合。**
 *
 * ⚠️ 除 `median`/`blur` 外，其余策略都需要 mask 参与计算；
 *    但为了统一调用签名，这里一律接收 mask 参数。
 */
export async function inpaint(
  src: Buffer,
  strategy: InpaintStrategy = 'adaptive',
  mask?: HandwritingMask,
): Promise<Buffer> {
  if (strategy === 'masked') {
    if (!mask) throw new Error("inpaint('masked') 需要提供 mask")
    return fillWithBackground(src, mask)
  }
  if (strategy === 'edge') {
    if (!mask) throw new Error("inpaint('edge') 需要提供 mask")
    return diffuseFill(src, mask)
  }
  if (strategy === 'adaptive') {
    if (!mask) throw new Error("inpaint('adaptive') 需要提供 mask")
    return inpaintAdaptive(src, mask)
  }
  switch (strategy) {
    case 'blur':
      return sharp(src).blur(2.5).png().toBuffer()
    case 'median':
    default:
      return sharp(src).median(5).png().toBuffer()
  }
}

/**
 * **区域分类 + 差异化填充**（`adaptive` 策略的实现）。
 *
 * 流程：
 *   ① 估计纸张底色（供空白区与"找不到结构"时使用）
 *   ② 分块判定每个手写区域是「空白区」还是「压字区」
 *   ③ 先整体铺底色（= masked 的效果）
 *   ④ 把**压字区**用 `structuralExtend` 覆盖：沿邻域结构延拓，接回被截断的印刷结构
 *
 * 这样：
 *   · 空白答题区 → 干净的纸张底色（与 masked 一致）
 *   · 手写压字区 → 尽量保留/接回原有印刷结构，而不是留一个底色缺口
 *
 * 若整个 mask 都被判为空白区，则退化为纯 `masked`（**诚实降级**：
 * 此时说明邻域确实没有印刷体可参考，底色填充就是正确答案）。
 */
export async function inpaintAdaptive(
  src: Buffer,
  mask: HandwritingMask,
  opts: { block?: number; ring?: number; printThreshold?: number } = {},
): Promise<Buffer> {
  // ① 底色
  const bg = await estimateBackground(src, mask)

  // ② 区域分类
  const meta = await sharp(src).metadata()
  const width = meta.width!, height = meta.height!
  const { regions, blocks, } = await classifyMaskRegions(src, mask, opts)

  const textRegions = regions.filter((r) => r.kind === 'text')
  const block = Math.max(8, opts.block ?? Math.round(Math.min(width, height) / 16))
  const cols = Math.ceil(width / block), rows = Math.ceil(height / block)

  // 若没有任何压字区 → 直接走 masked（诚实降级）
  if (textRegions.length === 0) {
    return fillWithBackground(src, mask)
  }

  // ③ 底色打底
  const base = await fillWithBackground(src, mask)

  // ④ 压字区用结构延拓覆盖（regionMask 限定只处理压字区）
  const rmask = textRegionMask(blocks, cols, rows, width, height, block)
  const extended = await structuralExtend(src, mask, rmask, { bg })

  // 在 base 上，把"压字区且属于 mask"的像素替换为 extended 的结果
  const baseRaw = await sharp(base).removeAlpha().raw().toBuffer()
  const extRaw = await sharp(extended).removeAlpha().raw().toBuffer()
  let maskBuf = mask.data
  if (mask.width !== width || mask.height !== height) {
    maskBuf = await sharp(mask.data, { raw: { width: mask.width, height: mask.height, channels: 1 } })
      .resize(width, height, { fit: 'fill' }).raw().toBuffer()
  }
  const out = Buffer.from(baseRaw)
  for (let i = 0; i < width * height; i++) {
    if (maskBuf[i] > 127 && rmask[i] > 127) {
      const p = i * 3
      out[p] = extRaw[p]; out[p + 1] = extRaw[p + 1]; out[p + 2] = extRaw[p + 2]
    }
  }

  return sharp(out, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

// ============================================================
// ③ Blend：只替换 mask 区域（"绝不重排"的关键）
// ============================================================

/**
 * 把修复图**仅应用到 mask 覆盖的像素**，其余像素取自原图。
 *
 *   output = inpainted * mask + original * (1 - mask)
 *
 * ⚠️ 维度语义提醒（容易搞反）：
 *   本模块约定 mask 中 **255 = 手写 = 需要修复**，0 = 保留原图。
 *   因此：
 *     - mask 为白的区域 → 取 inpainted
 *     - mask 为黑的区域 → 取 original
 *
 * ⚠️⚠️ 实现坑（已踩过，务必保留注释）：
 *   sharp 的 `composite({ blend: 'dest-in' })` **在 1 通道 mask 上不生效**
 *   —— 它按 alpha 通道做遮罩，而单通道 raw 输入被当作"灰度图无 alpha"，
 *   结果 mask 被完全忽略（实测 mask 外像素也被替换）。
 *   正确做法：把 mask 值写进 **RGBA 的 alpha 通道**，再以 `over` 合成。
 *
 * @param original  原图（保留部分以它为准）
 * @param inpainted 修复后的整图
 * @param mask      手写掩码（255=手写）
 */
export async function blendWithMask(
  original: Buffer,
  inpainted: Buffer,
  mask: HandwritingMask,
): Promise<Buffer> {
  const meta = await sharp(original).metadata()
  const width = meta.width
  const height = meta.height
  if (!width || !height) throw new Error('原图尺寸无效')

  // mask 尺寸需与图一致（不同则缩放）
  let maskBuf = mask.data
  if (mask.width !== width || mask.height !== height) {
    maskBuf = await sharp(mask.data, { raw: { width: mask.width, height: mask.height, channels: 1 } })
      .resize(width, height, { fit: 'fill' })
      .raw()
      .toBuffer()
  }

  // 修复图统一尺寸 + 取 RGBA
  const inpRGBA = await sharp(inpainted)
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer()

  // 把 mask 写进 alpha 通道
  const masked = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    masked[i * 4] = inpRGBA[i * 4]
    masked[i * 4 + 1] = inpRGBA[i * 4 + 1]
    masked[i * 4 + 2] = inpRGBA[i * 4 + 2]
    masked[i * 4 + 3] = maskBuf[i]
  }

  // over：alpha=255 处被修复图覆盖，alpha=0 处原样保留
  return sharp(original)
    .ensureAlpha()
    .composite([{ input: masked, raw: { width, height, channels: 4 }, blend: 'over' }])
    .removeAlpha()
    .png()
    .toBuffer()
}

/**
 * 计算两张图的**非 mask 区域一致性**（用于验收"未重排"）。
 *
 * 返回 1 表示非手写区域逐像素完全相同（理想情况）；
 * 越低说明原图内容被改动得越多。
 *
 * 这是阶段二最重要的一条验收指标：只要它接近 1，"排版样式全变"就不可能发生。
 */
export async function unmodifiedRegionSimilarity(
  original: Buffer,
  result: Buffer,
  mask: HandwritingMask,
): Promise<{ similarity: number; sampled: number }> {
  const a = await sharp(original).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const b = await sharp(result).resize(a.info.width, a.info.height, { fit: 'fill' }).removeAlpha().raw().toBuffer()
  const { width, height, channels } = a.info

  let same = 0
  let sampled = 0
  let maskBuf = mask.data
  if (mask.width !== width || mask.height !== height) {
    maskBuf = await sharp(mask.data, { raw: { width: mask.width, height: mask.height, channels: 1 } })
      .resize(width, height, { fit: 'fill' })
      .raw()
      .toBuffer()
  }

  for (let i = 0, p = 0; i < maskBuf.length; i++, p += channels) {
    if (maskBuf[i] > 127) continue // 手写区域跳过（那里本来就该变）
    sampled++
    const dr = Math.abs(a.data[p] - b[p])
    const dg = Math.abs(a.data[p + 1] - b[p + 1])
    const db = Math.abs(a.data[p + 2] - b[p + 2])
    // 容差 2/255，容忍编码往返误差
    if (dr <= 2 && dg <= 2 && db <= 2) same++
  }

  return { similarity: sampled ? same / sampled : 1, sampled }
}
