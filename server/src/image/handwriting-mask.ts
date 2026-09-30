import sharp from 'sharp'
import { normalizeBackgroundLuma } from './image-doc-enhance'
import { estimateCharMetrics } from './image-layout'

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
  source: 'vlm' | 'threshold' | 'manual' | 'layout'
  /** 检测过程诊断（覆盖率为何是 0 / 为何被护栏拦下），便于线上排查与用户提示 */
  debug?: Record<string, unknown>
  /**
   * ⭐ **紧种子 mask**（可选，长度同为 width*height，值 0/255）。
   *
   * 表示「**确认属于手写笔画**的核心区」——即未经膨胀/羽化的原始检出结果。
   *
   * ── 为什么必须把它和 `data` 分开（实测暴露的严重缺陷）───────────────────
   * `data` 为覆盖抗锯齿边缘做了膨胀+羽化，必然**比真实笔画大一圈**。
   * 若修复时把 `data` 内像素也当作"参考源"，就会发生
   * **「拿墨迹补墨迹」**：黑/灰笔迹色（luma≤170 且 chroma≤42）与印刷体墨色
   * 完全一致，被判为"可信结构"，于是邻近未填掉的笔迹被当成参考色填回原位。
   *
   * 实测（dynamic-tests/probe-erase-diag.ts）：
   *   黑笔：mask 内"结构"像素 31.52% → 残笔率 **40.44%**
   *   铅笔：29.64% → **37.05%**；蓝笔（chroma≈142 天然被排除）：0.01% → 0.05%
   *
   * 而所有经典 inpainting（Criminisi 的 exemplar-based、Telea 的 FMM、
   * Navier-Stokes）都遵循同一条铁律：**填充源只能来自已知区域（mask 之外）**，
   * 绝不能从待修复区取。把两者分开后即可同时满足：
   *   · 修复范围 = `data`（膨胀羽化后，保证盖住抗锯齿边缘）
   *   · 源排除区 = `seed`（只排除真正的笔画，保留被膨胀框进来但未被压住的印刷线）
   * 这正是业界「两阶段 mask」的标准用法。
   */
  seed?: Buffer
}

// ============================================================
// ①-0 P0-8 检测前置：光照归一化（消除拍照阴影/低频光照梯度）
// ============================================================

/**
 * ⭐⭐ **为什么这一步是去手写的"生命线"，而不是锦上添花**（实测数据，务必保留）：
 *
 * 两条本地检测路径**都以全局阈值为地基**：
 *   · `maskFromDarkInk`  —— Otsu 全局二值化 → 行投影 → 行分割
 *   · `maskFromColorThreshold` —— 灰度高分位估纸面 → 相对彩度 + luma 暗度
 *
 * 而 **全局阈值遇到低频光照梯度必然失效**。合成千人thalames-gradient 实测
 * （见 verify-p0-2-graphic.js 与 probe-p0-8-illumination.js，含 ground truth）：
 *
 *   场景          Otsu阈值  行数  最高行    mask 覆盖率   手写召回
 *   光照均匀        147      18    40px      2.57%        100%
 *   弱阴影(0.35)    121      18    40px      1.67%        61.75%
 *   强阴影(0.50)    176       4  1161px      0.00%          0%（share_guard 触发）
 *
 * 强阴影下暗侧整页跌到阈值以下 → 全部变"墨迹" → 行投影连成一条 **1161px 的超级行**
 * → 候选占比 0.986 → 护栏 `share_guard` 触发 → coverage=0 → 返回空 mask
 * → 用户看到「**点了去手写，没反应**」。
 *
 * 这正好解释了代码里那句长期悬而未决的现象：
 *   「测试图上正常、用户拍的照片上没反应」。
 *
 * ── 修复后的实测（同样三张图，仅加了本函数）─────────────────────────────
 *   clean 2.57%→2.58% ／ shade0.35 1.67%→**2.56%** ／ shade0.5 0.00%→**2.55%**
 *   三个场景全部收敛到同一水平 —— 光照归一化把"20 路 progenitor的影响抹平了。
 *
 * ── 跨功能复用（方法论 §5.1）───────────────────────────────────────────
 * 复用智能高清 P0-1 已落地的 `normalizeBackgroundLuma`（morphological closing
 * 估背景 + Top-Hat 拉平），**不重复实现**。此处只做两件事：
 *   ① 把单通道 luma 的归一化结果**回写到 RGB**；
 *   ② 套一层 fail-open，保证前置环节绝不拖垮主链路。
 *
 * ── ⚠️ 关键设计：为什么回写用**乘性**而非加性 ──────────────────────────
 * 拍照的光照降质本质是**乘性过程** `I(x) = R(x) · L(x)`，除法才是它的逆。
 * 若用加性平移 `R + Δ`，暗部通道会被整体抬升而**色度被压扁**：同一支蓝笔写在暗角里，
 * `max−min` 会明显小于亮处，于是 P0-1 的相对彩度判据在暗角**系统性漏检**。
 * 乘性还原则保持 RGB 三通道的比例 → chroma 的相对关系不被破坏。
 *
 * ── ⚠️ 第二个关键设计：归一化图**只用于检测，不用于最终输出** ────────────
 * 修复与混合仍在**原图**上进行（`blendWithMask` 保证非 mask 区 100% 原样）。
 * 若把归一化后的图输出给用户，等于顺手把整张卷子的观感也改了 —— 那是"智能高清"的活，
 * 不是"去手写"的活，越界会让用户对一次操作的预期失控。
 */
export interface Preprocessed {
  /** 光照归一化后的图（与原图同尺寸、同像素格式） */
  buffer: Buffer
  /** 是否真的执行了归一化（medH 获取失败 / 图过小时会跳过） */
  applied: boolean
  /** 用于结构元尺寸的字高估计值 */
  medH: number
  /** luma 的平均位移量，用于判断"这张图本来就很平"（接近 0 则归一化无害且几乎无效） */
  deltaMean: number
}

export async function normalizeIlluminationForDetection(
  buf: Buffer,
  opts: { flatten?: number } = {},
): Promise<Preprocessed> {
  const flatten = opts.flatten ?? 1
  const meta = await sharp(buf).metadata()
  const W = meta.width || 0
  const H = meta.height || 0

  // fail-open：前置环节任何异常都不能中断主链路，原图照常进入检测。
  const passthrough = (medH = 0): Preprocessed => ({ buffer: buf, applied: false, medH, deltaMean: 0 })
  if (!W || !H) return passthrough()

  try {
    const metrics = await estimateCharMetrics(buf)
    // ⚠️ medH 不可用时必须**跳过而不是用拍脑袋的默认值**：closing 的结构元半径直接
    // 由 medH 决定（SE_SCALE×medH/2），默认值一旦偏小就填不掉字 → 背景估计失真，
    // 反而比不做更糟。（return false 比 return 一个可能错的结果安全。）
    const medH = metrics && Number.isFinite(metrics.medH) && metrics.medH > 0 ? metrics.medH : 0
    if (!medH) return passthrough(0)

    const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const ch = info.channels
    const n = W * H
    const luma = new Float32Array(n)
    for (let i = 0, p = 0; i < n; i++, p += ch) {
      luma[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]
    }
    const lumaN = await normalizeBackgroundLuma(luma, W, H, { medH, flatten, inkIsDark: true })

    let deltaSum = 0
    const out = Buffer.alloc(n * ch)
    for (let i = 0, p = 0; i < n; i++, p += ch) {
      deltaSum += Math.abs(lumaN[i] - luma[i])
      const k = lumaN[i] / Math.max(1, luma[i])
      for (let c = 0; c < ch; c++) {
        out[p + c] = Math.max(0, Math.min(255, Math.round(data[p + c] * k)))
      }
    }
    const buffer = await sharp(out, { raw: { width: W, height: H, channels: ch } }).png().toBuffer()
    return { buffer, applied: true, medH, deltaMean: deltaSum / n }
  } catch (e) {
    console.warn('[mask] P0-8 光照归一化失败，回退原图：', e instanceof Error ? e.message : e)
    return passthrough()
  }
}

/**
 * ⭐ 把 mask 对齐到指定尺寸，并保证**返回的一定是单通道**数据。
 *
 * ⚠️ 这是一个修复既有隐患的公共函数（实测踩到的坑）：
 *    以 `raw:{channels:1}` 把灰度 mask 喂给 sharp 后，libvips 会按 **sRGB 灰阶**处理，
 *    `.resize()` / `.blur()` / `.median()` 之后 `.raw()` 出来的**一律是 3 通道**
 *    （r=g=b，长度 = w*h*3）。老代码直接 `maskBuf[i]` 按单通道索引，于是只读到
 *    前 1/3 的数据 —— 表现为「mask 纵向错位 / 覆盖率莫名归零」，
 *    且只在「mask 尺寸与图不一致」这条分支上触发，平时掩盖得很好。
 *
 * 统一走本函数：先按 stride 取通道 0，再返回长度严格等于 width*height 的 Buffer。
 */
export async function alignMask(
  mask: HandwritingMask,
  width: number,
  height: number,
): Promise<Buffer> {
  if (mask.width === width && mask.height === height && mask.data.length === width * height) {
    return mask.data
  }
  const raw = await sharp(mask.data, { raw: { width: mask.width, height: mask.height, channels: 1 } })
    .resize(width, height, { fit: 'fill' })
    .raw()
    .toBuffer()
  const ch = Math.max(1, Math.round(raw.length / (width * height)))
  if (ch === 1) return raw
  const out = Buffer.alloc(width * height, 0)
  for (let i = 0; i < width * height; i++) out[i] = raw[i * ch]
  return out
}

/**
 * 方形结构元膨胀（max-filter）。
 *
 * ⚠️ 必须**可分离**实现：先横向一趟、再纵向一趟，等价于 (2r+1)×(2r+1) 方形膨胀，
 * 但复杂度从 O(r²) 降到 O(r)。实测朴素版在 1200×900 上 r=17 时要 1.3B 次操作
 * （跑 2 分钟不出结果），可分离版约 37M 次（~0.2s）。
 *
 * 用途：① 真形态学膨胀（捕获抗锯齿边缘，防"鬼影"残笔）；
 *       ② 墨迹内测地扩散（每步 r=1）。
 */
export function maxFilterU8(src: Buffer | Uint8Array, w: number, h: number, r: number): Buffer {
  if (r <= 0) return Buffer.from(src)
  const s = src instanceof Uint8Array ? src : new Uint8Array(src)
  // 横向
  const tmp = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const base = y * w
    for (let x = 0; x < w; x++) {
      let m = 0
      const x0 = x - r < 0 ? 0 : x - r
      const x1 = x + r >= w ? w - 1 : x + r
      for (let nx = x0; nx <= x1; nx++) {
        const v = s[base + nx]
        if (v > m) m = v
      }
      tmp[base + x] = m
    }
  }
  // 纵向
  const out = Buffer.alloc(w * h)
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
 *
 * ## P0-1（2026-09-29）实测事故：绝对 chroma 阈值对纸张底色鲁棒性为零
 *
 * 在真实试卷（1279×1706，纸张泛黄）上，旧判据 `chroma >= 22 && min < 200`
 * 命中了 **49.66% 的画面** —— mask 几乎覆盖半页，真擦下去就是整页灾难。
 * 诊断数据（见 diag-mask-ascii.js 的 P0-1 输出）：
 *   - chroma 分布：20-21 占 14.4%，**22-23 占 49.7%**（几乎全部像素挤在阈值边缘）
 *   - 命中像素 avg max=193.7 / avg min=169.5 → **这是浅色纸张，不是墨水**
 *
 * 根因：纸整页偏暖偏黄，**纸张自身的 chroma 天然就是 22~23**，绝对阈值正好切在
 * 分布峰值边缘。这类写法的隐藏前提是"背景应当是中性白"—— 真实拍摄根本不成立。
 * （这也印证 TextIn 的结论：早期**颜色定位**类方法效果不彰。）
 *
 * 修法（不调阈值，改参照基准）：
 *   ① **彩度要相对纸张算**：`chromaExcess = chroma - paperChroma`，
 *      只有比纸张**更彩**才算色偏（纸张泛黄的 20 被减掉，蓝红笔的 100+ 保留）。
 *   ② **暗度是硬约束**：真正的墨水必须明显暗于纸面（`luma <= paperLuma × 0.8`），
 *      用 luma 而非 max 通道——蓝笔的 max 通道值很高（蓝色分量 200+），但 luma 很低。
 *   ③ **整页兜底**：候选率仍异常高 → 判为纸张底色问题而非笔迹，直接返回空 mask。
 *
 * ⚠️ 教训：凡是"对背景做绝对假设"的阈值（此处假设背景中性白），换一张图就会失效。
 *     能相对化的量一定要相对化（这里相对化的是**纸张自身的彩度与亮度**）。
 */
export async function maskFromColorThreshold(
  buf: Buffer,
  opts: {
    /** 相对纸张的彩度增量阈值 */
    chromaMin?: number
    /** 暗度上限占纸张亮度的比例（luma ≤ paperLuma×该值 才算墨水） */
    darknessRatio?: number
    /**
     * 候选率硬上限：超过则判定为「纸张整体色偏」而非笔迹，返回空 mask。
     * 真实笔迹占画面比例远高于此的情况几乎不存在（>15% 就是满页涂写了）。
     */
    maxCoverage?: number
  } = {},
): Promise<HandwritingMask> {
  const chromaMin = opts.chromaMin ?? 22
  const darknessRatio = opts.darknessRatio ?? 0.8
  const maxCoverage = opts.maxCoverage ?? 0.15

  const { data, info } = await sharp(buf)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  const total = width * height
  const mask = Buffer.alloc(total, 0)

  // ① 估计纸面基准色：用**灰度直方图的高分位**取亮部像素，统计其 RGB 中位数。
  //    亮部绝大多数是纸面（墨迹占比极低），中位数对残留墨点免疫。
  const lumaArr = new Float32Array(total)
  const lumaHist = new Int32Array(256)
  for (let i = 0, p = 0; i < total; i++, p += channels) {
    const l = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]
    lumaArr[i] = l
    lumaHist[Math.min(255, Math.round(l))]++
  }
  let accN = 0
  let brightThr = 200
  for (let t = 255; t >= 0; t--) {
    accN += lumaHist[t]
    if (accN >= total * 0.25) { brightThr = t; break } // 取最亮 25% 作为纸面样本
  }
  const rs: number[] = []
  const gs: number[] = []
  const bs: number[] = []
  const step = Math.max(1, Math.floor(Math.sqrt(total / 120000)))
  for (let i = 0, p = 0; i < total; i += step, p += step * channels) {
    if (lumaArr[i] < brightThr) continue
    rs.push(data[p]); gs.push(data[p + 1]); bs.push(data[p + 2])
  }
  const med = (a: number[]) => {
    if (!a.length) return 255
    a.sort((x, y) => x - y)
    return a[a.length >> 1]
  }
  const paperR = med(rs)
  const paperG = med(gs)
  const paperB = med(bs)
  // 纸张自身的彩度与亮度 —— 这就是"相对化"的基准
  const paperChroma = Math.max(paperR, paperG, paperB) - Math.min(paperR, paperG, paperB)
  const paperLuma = 0.299 * paperR + 0.587 * paperG + 0.114 * paperB
  const lumaCap = paperLuma * darknessRatio

  // ② 逐像素判定
  let covered = 0
  for (let i = 0, p = 0; i < total; i++, p += channels) {
    const r = data[p]
    const g = data[p + 1]
    const b = data[p + 2]
    const chromaExcess = Math.max(r, g, b) - Math.min(r, g, b) - paperChroma
    // 必须同时满足：比纸张更彩 **且** 明显暗于纸面（用 luma 而非 max，否则蓝笔会被漏）
    if (chromaExcess >= chromaMin && lumaArr[i] <= lumaCap) {
      mask[i] = 255
      covered++
    }
  }

  const coverage = covered / total
  // ③ 整页兜底：候选率异常 → 是纸张底色问题，不是笔迹。宁可不擦，不能擦坏。
  if (coverage > maxCoverage) {
    return {
      width,
      height,
      data: Buffer.alloc(total, 0),
      coverage: 0,
      source: 'threshold',
      seed: Buffer.alloc(total, 0),
      debug: {
        reason: 'paper_tint_guard',
        rawCoverage: +coverage.toFixed(4),
        paperChroma,
        paperLuma: +paperLuma.toFixed(1),
        note: '整页色偏而非笔迹（纸张自身 chroma 高），P0-1 已拦截',
      },
    }
  }

  return {
    width,
    height,
    data: mask,
    coverage,
    source: 'threshold',
    // 色域法检出的是"有色偏像素"，本就与印刷墨色不同（相对纸张 chroma 超出阈值），
    // 不会被误当成结构源；这里把检出结果原样作为紧种子，供下游源排除使用。
    seed: Buffer.from(mask),
    debug: { paperChroma, paperLuma: +paperLuma.toFixed(1), chromaMin, lumaCap: +lumaCap.toFixed(1) },
  }
}

// ============================================================
// ①-C 深色笔迹检测（铅笔 / 黑色中性笔）
// ============================================================

/**
 * ⭐ 深色笔迹 mask（色域阈值的互补路径）。
 *
 * ── 为什么必须有这一层（实测暴露的根本缺陷）───────────────────────────────
 * `maskFromColorThreshold` 的判据是「通道极差 chroma ≥ 22」，只对**蓝/红等彩色笔**
 * 有效。而中国学生写作业/考试用的绝大多数是**黑色中性笔或铅笔**——chroma ≈ 0，
 * 与印刷体同为近黑，色域法**完全检测不到** → coverage ≈ 0 → `eraseV2` 走
 * 「未检测到手写，原样返回原图」→ 用户看到「去手点了没反应」。
 *
 * ── 判据：行级分类（文档分析领域的标准范式：文本行检测 → 行级分类）─────────
 * 不用颜色，也不用"逐笔画纵向游程"，而是**先分行，再按行高分类**：
 *   ① 行投影 → 分割出所有文本行；
 *   ② 取行高的低分位数作为「印刷体字高」基准（印刷行通常占多数）；
 *   ③ 行高 ≥ 基准 × 1.5 的行判为**手写行**，行内墨迹整体纳入 mask。
 *
 * ⭐ 为什么必须是"行级"而不是"逐笔画"（实测数据，见 dynamic-tests/probe-mask-tune.ts）：
 *   逐笔画判据「纵向游程 > 字高」**只认竖直笔画**，手写的横笔纵向跨度天然很小，
 *   实测召回天花板只有 **66%**（黑笔）/**46%**（铅笔）——擦完仍留一堆残笔。
 *   行级判据把整行一次覆盖，**不受笔画方向影响**，实测召回 **100%**。
 *
 * ── 关键前提：字高估计必须可靠 ────────────────────────────────────────────
 * ⚠️⚠️ 本函数第一版在这里踩了大坑（真实根因，务必保留这段注释）：
 *   旧做法用「行投影文本带的中位数」，而 bandTh = maxRow×0.25；
 *   **手写行笔画稀疏、行投影峰值低于该阈值 → 手写行被切成 3~10px 的碎片带**，
 *   把中位数从真实的 19 拉到 **6**。于是 tallTh=9，几乎全部墨迹都"超字高"
 *   → 种子泛滥 → 护栏必然触发 → 功能等价于不存在（又一次 L18 型缺陷）。
 *   现改为「低阈值行分割 + 合并小间隙 + 取行高分位数」，实测字高稳定为 21。
 *   （另一种候选方案「列向最长连续游程」也被实测否决：汉字非实心，
 *     一列穿过「填」字会被横笔间隙切断，最长**连续**游程只有 6，而字高是 19。）
 *
 * ── 保守护栏（宁可漏，不可错擦）───────────────────────────────────────────
 *   · **基线众数护栏**（最关键）：按列投影把行切成字符，看有多少字符的
 *     **底边落在同一条基线（±1px）上**。占比高 = 印刷体，低 = 手写。
 *
 *     ⭐⭐ 为什么必须是它 —— 两个前任判据都被实测否决（保留事故档案）：
 *       ① **行高**：大号标题与手写行都高 → **本质上不可分**（已知边界）。
 *       ② **墨迹密度** = ink像素/(行高×横向间距)：实测手写 0.276~0.334、
 *          标题 0.295~0.346 → **严重重叠**；更要命的是**拍照模糊会让密度整体
 *          上升 20~50%**（笔画变粗：分子涨、分母几乎不变），于是绝对阈值把真实
 *          手写整片误杀 —— 黑笔 blur=0.6 时 7 个手写行里 5 行被拦
 *          （覆盖率 6.71% → **1.91%**），blur=1.0 时 **7 行全拦、覆盖率 0%**，
 *          功能直接消失。这正是"测试图上正常、用户拍的照片上没反应"的典型成因。
 *
 *     基线众数抓住了一个更本质的差异：**印刷排版强制基线对齐，手写没有基线约束**。
 *     实测（dynamic-tests/probe-feature-sep.ts）在全部模糊梯度上完美可分，
 *     且**对模糊完全不敏感**：
 *         手写（黑笔/铅笔 × blur 0/0.6/1.0）：**0.500**（恒定不变）
 *         中文大标题 fs=40/46/52             ：0.750
 *         英文标题（含 g/y/p 下伸字母）      ：0.813~0.969
 *         中英混排                           ：0.650~0.684
 *     阈值取两者中点 **0.575**，两侧各留约 0.075 边际。
 *
 *     ⚠️ 为什么不用「底边 IQR」（同一思路的朴素版）：中英混排时中文方块底边与
 *        英文基线不在同一 y，形成**两个集群**，IQR 立刻变大（实测 0.146~0.167），
 *        与手写的 0.158 **直接重叠**。众数占比对多集群稳健，IQR 不稳健。
 *     ⚠️ 字符段数 < `minChars` 时判据不适用 → 按"手写"放行（保召回，
 *        且短行即便误擦危害也小）。
 *   · 候选墨迹总量 > 全部墨迹的 `maxInkShare` → 判为"分类失效"，整条路径作废。
 *     ⚠️ 阈值从 0.45 放宽到 0.65：实测正常作答场景 share 可达 0.47，旧阈值会误杀正例。
 *
 * ── 诚实局限（无模型条件下的硬边界，不是 bug）─────────────────────────────
 *   ① 黑色笔写得**与印刷体同字号**（填空题写在 `______` 上、大小一致）→ 行高相同，
 *      行级判据失效，几何与颜色上都无法区分；
 *   ② **手写压在印刷文字上**（不是写在空白处）→ 整行被印刷行主导，行高判据失效。
 *      且即使强行检出，擦除也会连带毁掉被压住的印刷内容，**不擦才是正确行为**。
 *   以上情况一律返回空 mask，并由 image.service 给出明确 notice 引导用户
 *   （改用蓝/红笔重拍，或用「编辑裁剪」限定范围），绝不静默失败。
 */
/** 文本行（y0 闭、y1 开） */
export interface TextRow { y0: number; y1: number }

/**
 * ② 行投影 + 行分割（低阈值 + 合并小间隙）
 * ③ 印刷字高估计 = 行高的低分位数
 *
 * ⭐ 抽成公共函数的原因：`maskFromDarkInk` 之外的诊断/调优脚本也要用它。
 *    若各写一份，参数稍不一致就会产生"生产环境正常、脚本复现不了"的鬼故事。
 *
 * ⚠️ 行分割阈值必须低（maxRow×0.05）：用 ×0.25 会把稀疏的手写行切成 3~10px 碎片带，
 *    进而把字高中位数从 19 拉到 6 → 整条链路失效（见 maskFromDarkInk 函数头注释）。
 *
 * @param ink Otsu 二值化后的墨迹图（1 = 墨迹）
 */
export function segmentTextRows(
  ink: Uint8Array,
  w: number,
  h: number,
  opts: { gapMerge?: number; glyphQuantile?: number; rowProfileRatio?: number } = {},
): { rows: TextRow[]; glyphH: number; rowProfile: Int32Array } {
  const gapMerge = opts.gapMerge ?? 6
  const glyphQuantile = opts.glyphQuantile ?? 0.3

  const rowProfile = new Int32Array(h)
  for (let y = 0; y < h; y++) {
    let c = 0
    for (let x = 0; x < w; x++) if (ink[y * w + x]) c++
    rowProfile[y] = c
  }
  let maxRow = 0
  for (let y = 0; y < h; y++) if (rowProfile[y] > maxRow) maxRow = rowProfile[y]
  const rowTh = Math.max(1, Math.round(maxRow * (opts.rowProfileRatio ?? 0.05)))
  const segs: TextRow[] = []
  {
    let y = 0
    while (y < h) {
      if (rowProfile[y] < rowTh) { y++; continue }
      const y0 = y
      while (y < h && rowProfile[y] >= rowTh) y++
      segs.push({ y0, y1: y })
    }
  }
  // 合并间隙很小的相邻段（同一行文字内部的空隙不应把行切开）
  const rows: TextRow[] = []
  for (const s of segs) {
    const last = rows[rows.length - 1]
    if (last && s.y0 - last.y1 <= gapMerge) last.y1 = s.y1
    else rows.push({ y0: s.y0, y1: s.y1 })
  }

  // 印刷字高 = 行高的低分位数（印刷行通常占多数，低分位稳定落在其字高上）
  const heights = rows.map((r) => r.y1 - r.y0).filter((v) => v >= 3).sort((a, b) => a - b)
  let glyphH = heights.length ? heights[Math.floor(heights.length * glyphQuantile)] || 8 : 8
  glyphH = Math.max(6, glyphH)

  return { rows, glyphH, rowProfile }
}

/** 一行的墨迹密度 = 墨迹像素数 / (行高 × 横向跨度) */
export function rowInkDensity(
  ink: Uint8Array,
  w: number,
  r: TextRow,
): { density: number; n: number; xmin: number; xmax: number } {
  const rh = r.y1 - r.y0
  let xmin = w, xmax = -1, n = 0
  for (let y = r.y0; y < r.y1; y++)
    for (let x = 0; x < w; x++)
      if (ink[y * w + x]) { n++; if (x < xmin) xmin = x; if (x > xmax) xmax = x }
  if (xmax < 0) return { density: 0, n: 0, xmin: 0, xmax: -1 }
  return { density: n / (rh * Math.max(1, xmax - xmin)), n, xmin, xmax }
}

/**
 * 行内**子行**拆分：行内水平投影，墨点数 >容差 的连续 y 带为一个子行。
 *
 * ⚠️ "有墨"必须带**相对容差**：照片颗粒/纸张纹理在 Otsu 后会留下零星暗点，
 * 若要求 rowProf===0 才算空带，任何真实页面都切不出子行（实测：全部焊行
 * 子行=1，子行拆分完全失效）。容差 = max(1, 0.2% × w) 个墨点。
 *
 * ⭐ 二次均分（实测暴露的第七个缺陷：零行距的双行印刷）：紧凑排版的相邻
 *   两行印刷**行距为零**，水平投影拆不开（实测 h=43 = 2.05×glyphH 的子行，
 *   两簇底边各占 ~0.45 → bm=0.563，差 0.012 没过 0.575 → 整个子行被当
 *   手写放行 → 两行印刷全被误擦）。对策：拆出的子行若 h 仍 > 1.7×glyphH
 *   （不可能是单行），按 `glyphH×1.15` 步长**均分**成单行带，每带独立做
 *   基线判定。切割线偶尔穿过字符中部无妨——字符底边本就落在带内下部，
 *   聚类不受影响；误切手写大字带的方向是"漏擦"而非"误擦"，安全。
 */
function splitSubRows(ink: Uint8Array, w: number, r: TextRow, glyphH: number): Array<[number, number]> {
  const noiseTol = Math.max(1, Math.round(w * 0.002))
  const rowProf = new Int32Array(r.y1 - r.y0)
  for (let y = r.y0; y < r.y1; y++) {
    let c = 0
    for (let x = 0; x < w; x++) if (ink[y * w + x]) c++
    rowProf[y - r.y0] = c
  }
  const bands: Array<[number, number]> = []
  for (let y = 0; y < rowProf.length;) {
    if (rowProf[y] <= noiseTol) { y++; continue }
    const sy0 = y
    while (y < rowProf.length && rowProf[y] > noiseTol) y++
    bands.push([r.y0 + sy0, r.y0 + y])
  }
  const out: Array<[number, number]> = []
  for (const [a, b] of bands) {
    const h = b - a
    if (h <= glyphH * 1.7) { out.push([a, b]); continue }
    const n = Math.max(2, Math.round(h / (glyphH * 1.15)))
    const step = h / n
    for (let k = 0; k < n; k++) out.push([a + Math.round(k * step), a + Math.round((k + 1) * step)])
  }
  return out
}

/**
 * 行内**字符块**切分：按列投影把一个子行切成若干连通块（列空隙 ≤`GAP` 视为同块）。
 * 返回每块的墨迹 bbox、墨量与底边（最下墨行）——供「图形块过滤」使用。
 *
 * 为什么需要它（实测暴露：行范式在"手写压字+图形混排"的真卷上全面失效）：
 * 手写笔画填进行距空隙后，行投影无空隙可切，"题干+手写答案+几何图形"被焊成
 * 一个 h=63~171 的大行；行级判据（行高/密度/基线）对这种混合行全部失真，
 * 只能整行放行 → 行内印刷体与图形一起被卷进候选。
 */
function rowCharBlocks(
  ink: Uint8Array,
  w: number,
  y0: number,
  y1: number,
): Array<{ x0: number; x1: number; y0: number; y1: number; n: number; bot: number }> {
  const GAP = 2
  const colInk = new Int32Array(w)
  for (let y = y0; y < y1; y++)
    for (let x = 0; x < w; x++)
      if (ink[y * w + x]) colInk[x]++

  const blocks: Array<{ x0: number; x1: number; y0: number; y1: number; n: number; bot: number }> = []
  let x = 0
  while (x < w) {
    if (colInk[x] === 0) { x++; continue }
    const bx0 = x
    let gap = 0
    while (x < w) {
      if (colInk[x] === 0) { gap++; if (gap > GAP) break } else gap = 0
      x++
    }
    // 内层退出时 x 已停在「gap 超限的首个空列」或 w，绝不能回退 ——
    // 否则外层会重新扫描同一块（实测：回退导致死循环，CPU 打满）。
    const bx1 = x - gap // 最后一个有墨列 +1
    let n = 0, by0 = y1, by1 = -1
    for (let y = y0; y < y1; y++)
      for (let xx = bx0; xx < bx1; xx++)
        if (ink[y * w + xx]) { n++; if (y < by0) by0 = y; if (y > by1) by1 = y }
    if (n > 0) blocks.push({ x0: bx0, x1: bx1, y0: by0, y1: by1 + 1, n, bot: by1 })
  }
  return blocks
}


export async function maskFromDarkInk(
  buf: Buffer,
  opts: {
    /** 行高 ≥ 印刷字高×该值 → 判为手写行 */
    rowRatio?: number
    /**
     * 墨迹密度上限（**仅作异常兜底**）：候选行密度 = ink像素/(行高×横向间距)。
     * ⚠️ 默认已从 0.30 放宽到 **0.55**，因为该判据对拍照模糊极其敏感，
     *    0.30 会在 blur≥0.6 时把真实手写整片误杀（详见函数头事故档案）。
     *    真正的"大标题 vs 手写"区分已交给 `baseModeMin`。
     */
    densityMax?: number
    /**
     * ⭐ 基线众数下限：字符底边落在同一基线（±1px）上的比例 ≥ 该值 → 判为印刷体。
     * 实测手写恒为 0.500、印刷标题 0.650~0.969，默认取中点 **0.575**。
     */
    baseModeMin?: number
    /** 基线判据所需的最少字符段数（不足则判据不适用，按手写放行） */
    minChars?: number
    /** 印刷字高的分位数（越小越偏印刷行） */
    glyphQuantile?: number
    /** 行分割时合并相邻行的最大间隙（像素） */
    gapMerge?: number
    /** ⭐ 间距离散度阈值（印刷一致性得分 v15）：子行间隙 CV ≥ 该值 → 间距忽大忽小 → 手写证据 */
    gapIrregular?: number
    maxInkShare?: number
    dilate?: number
    /** 羽化半径（像素）：产生软边缘，避免硬边接缝 */
    feather?: number
    /** 墨迹内测地扩散步数（字高倍数） */
    grow?: number
    /** 紧种子的额外膨胀半径（仅用于盖住抗锯齿边），默认 2 */
    seedDilate?: number
    workMaxSide?: number
  } = {},
): Promise<HandwritingMask> {
  // ⭐ rowRatio 从 1.5 降到 1.15（真卷实测暴露的第十个缺陷：同高手写整区漏检）
  //    1.5 时代的假设是"手写比印刷大"，但真实试卷上中性笔解答常与印刷
  //    **同高**（20 题解答行高 ≈1.19×glyphH）→ 全部 blocked='short' 跳过，
  //    连行级分类都进不了 → 20 题解答区一半漏擦。
  //    现在行级有「bm≥0.575 拦截 + 子行强印刷证据/双证据」两道闸守印刷，
  //    入口门槛可以放心放宽；仍留 1.15 是为了不把「第7题图」这类与
  //    glyphH 同高的短标题行放进分类（它们的块数少，bm 判据不稳）。
  const rowRatio = opts.rowRatio ?? 1.15
  const densityMax = opts.densityMax ?? 0.55
  const baseModeMin = opts.baseModeMin ?? 0.575
  const minChars = Math.max(3, opts.minChars ?? 4)
  const glyphQuantile = opts.glyphQuantile ?? 0.3
  const gapMerge = opts.gapMerge ?? 6
  // ⭐ 间距离散度阈值（v15，印刷一致性得分）：子行内相邻字符块间隙 CV ≥ 该值
  //    → 判"间距忽大忽小"→ 手写证据。实测调优见函数头「一致性得分」一节。
  const gapIrregular = opts.gapIrregular ?? (process.env.DARK_GAPCV ? +process.env.DARK_GAPCV : 0.75)
  const maxInkShare = opts.maxInkShare ?? 0.65
  const workMaxSide = opts.workMaxSide ?? 1200

  const meta = await sharp(buf).metadata()
  const W0 = meta.width || 0
  const H0 = meta.height || 0
  let EMPTY_REASON = 'not_run'
  const empty = (dbg?: Record<string, unknown>): HandwritingMask => ({
    width: W0, height: H0, data: Buffer.alloc(W0 * H0, 0), coverage: 0, source: 'threshold', debug: dbg,
  })
  if (!W0 || !H0) { EMPTY_REASON = 'bad_size'; return empty({ reason: EMPTY_REASON }) }

  const scale = Math.min(1, workMaxSide / Math.max(W0, H0))
  const w = Math.max(1, Math.round(W0 * scale))
  const h = Math.max(1, Math.round(H0 * scale))
  const gray = await sharp(buf).resize(w, h, { fit: 'fill' }).grayscale().raw().toBuffer()

  // ① Otsu 二值化
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
  if (inkTotal < 50) { EMPTY_REASON = 'no_ink'; return empty({ reason: EMPTY_REASON, inkTotal }) }

  // ①.5 边缘连通暗区清除（实测暴露：装订边/桌边会把整条检测链焊死）
  //   真卷拍照常见：图像边缘有连续暗带（书页边缘、桌面、装订阴影、相框）。
  //   它们贴着边框、连通成片，在 Otsu 后全部算作"墨"，把**行分割焊死**——
  //   实测一张真卷整页被连成 y=0~1062 的超级行、吞掉 96.6% 墨迹，
  //   行分类只能整行放行 → candidateInk/inkTotal=0.98 → share_guard 一票否决
  //   → 深色法整体返回空 → 页面 90% 以上的手写全部漏检（表现为"点了没反应"）。
  //
  //   判据：**与图像边界连通的暗区**。笔迹几乎从不与边框连通成片；
  //   装订边/桌边/相框必然贴边。故从四条边的墨迹像素出发 BFS，
  //   把整个连通块从 ink 中剥掉。归一化（P0-8）治的是**低频**阴影，
  //   对这种锐利的贴边暗条无能为力，所以必须在二值化后再剥一次。
  {
    const stack = new Int32Array(w * h)
    let sp = 0
    const push = (i: number) => { if (ink[i]) { ink[i] = 0; stack[sp++] = i } }
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x) }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1) }
    let stripped = 0
    while (sp > 0) {
      const i = stack[--sp]
      stripped++
      const x = i % w, y = (i / w) | 0
      if (x > 0) push(i - 1)
      if (x < w - 1) push(i + 1)
      if (y > 0) push(i - w)
      if (y < h - 1) push(i + w)
    }
    inkTotal -= stripped
  }
  if (inkTotal < 50) { EMPTY_REASON = 'no_ink_after_border_strip'; return empty({ reason: EMPTY_REASON }) }

  // ②+③ 行分割与字高估计（抽成公共函数：诊断脚本与调优脚本必须复用同一份实现，
  //     否则"两套行分割"会各自漂移，故障极难复现——本轮已因此吃过一次亏）
  const { rows, glyphH } = segmentTextRows(ink, w, h, { gapMerge, glyphQuantile })
  if (rows.length === 0) {
    EMPTY_REASON = 'no_rows'
    return empty({ reason: EMPTY_REASON, inkTotal })
  }

  // ④ 行级分类：行高 ≥ 字高×rowRatio 且 墨迹密度 ≤ densityMax → 判为手写行
  //    密度护栏是防「大号印刷标题」误擦的关键，见函数头注释。
  const seed = new Uint8Array(w * h)
  let seedCount = 0
  let rowTall = 0
  let rowDensityBlocked = 0
  let rowBaselineBlocked = 0
  const rowLimit = glyphH * rowRatio

  /**
   * ⭐ 基线众数占比：把行按列投影切成字符，统计"底边落在同一条基线（±1px）上"的
   *   字符比例。印刷排版强制基线对齐 → 高；手写无基线约束 → 低。
   *   详细的可分性实测数据见函数头「基线众数护栏」一节。
   *
   * @returns 0~1。**0 表示样本不足、判据不适用**（调用方应按"手写"放行以保召回）。
   */
  const baselineModeShare = (r: TextRow, xmin: number, xmax: number): number => {
    const bots: number[] = []
    let x = xmin
    while (x <= xmax && x < w) {
      // 找下一个含墨迹的列，向两侧扩展出一个字符块
      let c = 0
      for (let y = r.y0; y < r.y1; y++) if (ink[y * w + x]) c++
      if (c === 0) { x++; continue }
      const x0 = x
      // ⭐ 字符间隙容差 = 2 列（与 rowCharBlocks 同款）：真实照片里印刷字符
      //   间隙常被噪点/模糊填到 ≤2px，零容差会让整行切不出 4 个块 →
      //   `bots.length < minChars` → 判据"不适用"返回 0 → 印刷子行被当手写
      //   整行放行（真卷实测：14/16/20 题题干因此整行误擦）。
      let gap = 0
      while (x <= xmax && x < w) {
        let cc = 0
        for (let y = r.y0; y < r.y1; y++) if (ink[y * w + x]) cc++
        if (cc === 0) { gap++; if (gap > 2) break } else gap = 0
        x++
      }
      const xEnd = x - gap // 块尾（最后一个有墨列 +1）；x 已停在块后空列，直接续扫
      // 该字符块的底边（最下方的墨迹行）
      let bot = -1
      for (let y = r.y1 - 1; y >= r.y0; y--) {
        let hit = false
        for (let xx = x0; xx < xEnd; xx++) if (ink[y * w + xx]) { hit = true; break }
        if (hit) { bot = y; break }
      }
      if (bot >= 0) bots.push(bot)
    }
    if (bots.length < minChars) return 0
    let best = 0
    for (const b of bots) {
      let cnt = 0
      for (const o of bots) if (Math.abs(o - b) <= 1) cnt++
      if (cnt > best) best = cnt
    }
    return best / bots.length
  }

  const tallDensities: number[] = []
  const tallBaselines: number[] = []
  let blockGraphic = 0, blockPrintProtected = 0, blockHand = 0
  // 块级偏离测量辅助：块与相邻块的间隙
  const bi2g = (blocks: Array<{ x0: number; x1: number }>, b: { x0: number; x1: number }, side: 'l' | 'r'): number => {
    const idx = blocks.indexOf(b as { x0: number; x1: number })
    if (side === 'l') return idx > 0 ? b.x0 - blocks[idx - 1].x1 : -1
    return idx >= 0 && idx < blocks.length - 1 ? blocks[idx + 1].x0 - b.x1 : -1
  }
  const rowsDetail: Array<{ y0: number; y1: number; rh?: number; bm?: number; blocked?: string; g?: number; p?: number; h?: number; subs?: Array<{ y0: number; y1: number; bm: number; g: number; h: number }> }> = []

  for (const r of rows) {
    const rh = r.y1 - r.y0
    const rowInfo: { y0: number; y1: number; rh: number; bm: number; blocked: string; subs?: Array<{ y0: number; y1: number; bm: number; g: number; h: number }> } = { y0: r.y0, y1: r.y1, rh, bm: -1, blocked: '' }
    rowsDetail.push(rowInfo)
    if (rh < rowLimit) { rowInfo.blocked = 'short'; continue }
    rowTall++
    const { density, xmin, xmax } = rowInkDensity(ink, w, r)
    tallDensities.push(density)

    // 主判据：基线众数占比 ≥ baseModeMin → 印刷体（基线对齐 = 排版特征）
    const bm = baselineModeShare(r, xmin, xmax)
    tallBaselines.push(bm)
    rowInfo.bm = +bm.toFixed(3)
    if (bm >= baseModeMin) { rowBaselineBlocked++; rowInfo.blocked = 'baseline'; continue }
    // 兜底：密度异常高（如整块涂黑、非文字图块）才拦，阈值刻意放得很宽，
    //       绝不让它在正常模糊范围内误伤手写 —— 见函数头对密度判据的否决记录。
    if (density > densityMax) { rowDensityBlocked++; rowInfo.blocked = 'density'; continue }

    // ⭐⭐ 子行级判别（实测暴露的第五个缺陷：行焊接让"整行放行"变成"整行误擦"）
    //    真卷里手写压字、图形混排是常态：手写笔画填进行距空隙后行投影无空隙可切，
    //    "题干+手写+图形"被焊成一个 h=63~171 的大行，行级判据全部失真。
    //    旧行为对这种行**整行放行**（行内所有 ink 像素进种子）→ 行内印刷体与
    //    几何图形全部卷进候选 → share 冲到 0.91 触发 share_guard 一票否决 →
    //    深色法整体返回空，页面 90% 以上的手写漏检（真卷实测：超级行吞 96.6% 墨）。
    //
    //    对策 = **分层判别**，粒度从「焊行」细化到「子行 → 字符块」：
    //      ① 子行拆分（splitSubRows）：焊行内按水平投影拆回真实文字行。
    //      ② 子行级基线判定：与行级**同款判据**（baselineModeShare ≥ baseModeMin
    //         → 印刷，整行保护）。焊行失效的根源只是"跨行混合稀释了基线占比"，
    //         子行不跨行，判据语义完全恢复。
    //         ⚠️ 不能用"块级底边对齐"替代 —— 手写行自己也有基线（同书写行底边
    //         相对齐），块级对齐判据会把整行手写误保护（真卷实测 20 题解答 22 块
    //         被误保护 → 全漏）。
    //      ③ 手写子行内做**块级图形过滤**：块高 > 3×glyphH，或（块宽 > 0.25w 且
    //         块内密度 < 0.2）→ 几何图形（大而稀疏），排除；其余进种子。
    //
    //    遗留给 VLM/语义分割（P0-3/P1）的：与印刷同高、贴基线的行内小答案
    //    （如填空"3/7"），几何特征为零，不硬猜。
    let rowsG = 0, rowsP = 0, rowsH = 0
    const subsDetail: Array<{ y0: number; y1: number; bm: number; g: number; h: number }> = []
    type SubMeta = { bmSub: number; hasPrintRun: boolean; widePrint: boolean; fullWidthPrint: boolean; inkW: number; bhCV: number; gapCV: number; ay0: number; ay1: number; blocks: Array<{ x0: number; x1: number; y0: number; y1: number; n: number; bot: number }> }
    const subMeta: SubMeta[] = []
    // ① 全行尺度的图形块预标记（实测暴露：二次均分切带会把几何图形**切碎**，
    //    带内碎块的块高 ≤3×glyphH，图形判据失效 → 图形被当手写擦掉）。
    //    图形识别必须在**切带前**的整行尺度做：整行 bbox 高 >3×glyphH
    //    或"宽>0.25w 且稀疏"的块标记为图形区，带内与其相交的块一律跳过。
    const graphicRanges: Array<[number, number]> = []
    for (const b of rowCharBlocks(ink, w, r.y0, r.y1)) {
      const bw = b.x1 - b.x0, bh = b.y1 - b.y0
      if (bh > glyphH * 3 || (bw > w * 0.25 && b.n / (bw * bh) < 0.2)) graphicRanges.push([b.x0, b.x1])
    }
    const inGraphic = (x0: number, x1: number) => graphicRanges.some(([g0, g1]) => x0 < g1 && x1 > g0)
    for (const [ay0, ay1] of splitSubRows(ink, w, r, glyphH)) {
      const bmSub = baselineModeShare({ y0: ay0, y1: ay1 }, 0, w - 1)
      // ⭐⭐ 双证据保护（真卷实测暴露的第六个缺陷：基线判据在真卷上区分度不足）
      //    真卷上"基线写得齐"的手写解答行 bmSub 能到 0.5+，与含下伸字符
      //    （⊥、g/y、①）的印刷行重叠；一刀切"bmSub≥0.5 全保护"导致 20 题
      //    解答区 90% 的手写整行漏擦（coverage 仅 2.79%）。
      //    单统计特征（笔画宽/块宽 CV）实测均无区分度，改用**双证据**：
      //      ① 长印刷词块：活字排版会把相邻字符焊成长块（长宽比 ≥6），
      //         手写连笔极少连到 6 倍字高（真卷实测印刷 136~126px vs 手写 ≤57px）。
      //      ② 块高一致性：印刷字号统一 → 块高 CV < 0.35（实测纯印刷行
      //         0.05~0.30）；手写连笔上下伸 → CV ≥ 0.53。
      //    ⭐ 分层（第八个缺陷，双证据首版的误伤教训）：bmSub ≥ 0.65 是
      //    **强印刷证据**，无条件保护——双证据只用于 0.5~0.65 的灰区。
      //    首版把 0.818 的高 bmSub 子行也拿去卡双证据，结果 13/14 题被焊成
      //    一行后，14 题题干上半截（bmSub=0.818 但含上下标→块高 CV 大、
      //    无长词块）被放行整段误擦（红线事故）。
      const blocks = rowCharBlocks(ink, w, ay0, ay1)
      let maxLen = 0
      let hSum = 0, hSq = 0
      for (const b of blocks) {
        const bw = b.x1 - b.x0
        if (bw > maxLen) maxLen = bw
        const bhv = b.y1 - b.y0
        hSum += bhv
        hSq += bhv * bhv
      }
      const hMean = blocks.length ? hSum / blocks.length : 0
      const hVar = blocks.length ? hSq / blocks.length - hMean * hMean : 0
      const bhCV = hMean > 0 ? Math.sqrt(Math.max(0, hVar)) / hMean : 0
      // ⭐ 间距离散度 gapCV（印刷一致性得分第二特征，v15 新增）────────────────
      //   理论（用户提出）：印刷排版字距均匀 → 相邻字符块间隙 CV 低；
      //   手写答案塞进填空/解答区时周围留空忽大忽小 → 间隙 CV 高。
      //   与 bhCV（大小一致性）互补：工整手写可能"大小齐但间距乱"。
      //   只统计 >0 的间隙：焊接块（间隙0）是印刷长词的签名，计零反而拉高 CV
      //   把印刷行误判成"间距乱"。单块或全焊接行 → gapCV=0（判据不适用）。
      let gSum = 0, gSq = 0, gN = 0
      for (let bi = 1; bi < blocks.length; bi++) {
        const g = blocks[bi].x0 - blocks[bi - 1].x1
        if (g <= 0) continue
        gSum += g; gSq += g * g; gN++
      }
      const gMean = gN ? gSum / gN : 0
      const gapCV = gN > 1 && gMean > 0 ? Math.sqrt(Math.max(0, gSq / gN - gMean * gMean)) / gMean : 0
      const hasPrintRun = maxLen >= glyphH * 6
      // 最长字符块占页宽比：印刷行整体铺满整行（块宽常 > 0.45w），
      // 手写答案（填空序号、短字母）连通域窄；用于甄别"基线被稀释的合并印刷行"。
      let maxBW = 0, minBX = w, maxBX = 0
      for (const b of blocks) { const bw = b.x1 - b.x0; if (bw > maxBW) maxBW = bw; if (b.x0 < minBX) minBX = b.x0; if (b.x1 > maxBX) maxBX = b.x1 }
      const widePrint = maxBW >= w * 0.45 && hasPrintRun
      // 整行墨迹跨度：印刷题干铺满整行(≥0.8w)，手写答案几乎从不铺满整行。
      // 专治"多行印刷被合并成高行、基线被稀释到 0.5 左右"的漏保护(16 题)。
      const inkW = maxBX - minBX
      const fullWidthPrint = inkW >= w * 0.8
      // 保护判定延后到收集完全部子行后统一进行（需要行级投票信息）
      subMeta.push({ bmSub, hasPrintRun, widePrint, fullWidthPrint, inkW, bhCV, gapCV, ay0, ay1, blocks })
    }
    // ⭐ 行级投票（第九个缺陷）：焊行（手写压字把 13/14 题题干焊成一行）拆带后，
    //    带边界与真实行错位，个别印刷带块高 CV 被上下标拉大 + 无长词块，
    //    双证据双双失效 → 印刷带被放行误擦。
    //    对策：焊行内**任一**子行出现强印刷证据（bmSub≥0.65 或长印刷词块）
    //    → 该行所有 bmSub≥0.5 的子行一律保护（印刷排版特征在行内传播）。
    //    仅对焊行生效：普通行各行其是，不受行内其他子行牵连。
    //
    //    ⭐ 灰区放行的双通道（e2e 回归暴露的教训）：bhCV 判据**只能用于
    //    保护方向**（CV 小 → 印刷），不能反向作放行依据 —— 合成图手写
    //    （SVG 逐字渲染、抖动受控）块高 CV 只有 0.15，比真卷手写（0.53+）
    //    小得多，"CV 大 → 手写"会把合成手写全保护（e2e 曾因此退化到
    //    coverage 0.67%）。放行通道改用**行高手写证据**：rh ≥ 1.5×glyphH
    //    的行本身就是"写得比印刷大"的手写特征（合成手写 2.2×、真卷
    //    解答行 1.19×——后者由 bhCV≥0.35 通道覆盖）。两通道互备：
    //      · 通道A（高行）：rh ≥ 1.5g 且 bmSub ∈ [0.5, 0.65) → 放行
    //      · 通道B（齐行）：rh < 1.5g 且 bhCV ≥ 0.35 → 放行
    const welded = rh > glyphH * 1.7
    const strongPrint = subMeta.some((m) => m.bmSub >= 0.65 || m.hasPrintRun || m.widePrint)
    for (const m of subMeta) {
      const grayZone = m.bmSub >= 0.5 && m.bmSub < 0.65
      const handTall = grayZone && rh >= glyphH * 1.5 // 通道A
      // 通道B（v15 扩展）：大小离散（bhCV≥0.35）**或间距忽大忽小**（gapCV≥gapIrregular）
      //   ——印刷一致性得分双特征。工整手写（块高齐、bhCV<0.35）若塞在填空/
      //   解答区，周围留空忽大忽小，gapCV 抓住它；纯印刷行字距均匀 gapCV 低，
      //   不会被误放行。
      const handUneven = grayZone && rh < glyphH * 1.5 && (m.bhCV >= 0.35 || m.gapCV >= gapIrregular) // 通道B
      // ⭐⭐ 宽印刷行保护（真卷实测暴露：16 题两印刷行被合并成 rh=35 高行，
      //    baselineModeShare 被稀释到 0.375 < 0.575 → 行级不拦截；子行 bmSub 仍
      //    0.375 < 0.5 → 灰区保护门槛也进不去 → 整行被当手写塞进种子，
      //    16 题整段印刷题干被误擦）。对策：印刷行几乎必然含长横笔(hasPrintRun)
      //    且块宽铺满整行(≥0.45w)，手写答案极少同时满足 → 作为**独立**保护信号，
      //    不依赖 bmSub 门槛，专门兜住"基线被稀释的合并印刷行"。手写长横(下划线/
      //    破折号/长√)通常连通域窄，widePrint 不会误伤。
      const widePrintProtect = m.widePrint || m.fullWidthPrint
      const protect =
        m.bmSub >= 0.65 ||
        widePrintProtect ||
        (m.bmSub >= 0.5 &&
          !(handTall || handUneven) &&
          (m.bmSub >= 0.65 || m.hasPrintRun || m.bhCV < 0.35 || (welded && strongPrint)))
      if (process.env.DARK_DBG) console.error(`[dark subrow] y=${m.ay0}-${m.ay1} bm=${m.bmSub.toFixed(2)} bhCV=${m.bhCV.toFixed(2)} gapCV=${m.gapCV.toFixed(2)} rh=${rh} welded=${welded} run=${m.hasPrintRun} wide=${m.widePrint} full=${m.fullWidthPrint} → ${protect ? '保护' : '候选'}`)
      if (protect) {
        // ⭐ 块级一致性偏离测量（v15）：保护子行内，印刷块高度/底边/间隙应
        //   一致（中位数附近）；手写块必然偏离——比中位块高得多、底边脱离
        //   中位基线、两侧间隙远大于中位间隙。DARK_DBG=2 输出每块明细供调阈。
        if (process.env.DARK_DBG === '2') {
          const hs = m.blocks.map((b) => b.y1 - b.y0).sort((a, b) => a - b)
          const bs = m.blocks.map((b) => b.bot).sort((a, b) => a - b)
          const hMed2 = hs.length ? hs[(hs.length / 2) | 0] : 0
          const bMed2 = bs.length ? bs[(bs.length / 2) | 0] : 0
          const gaps: number[] = []
          for (let bi = 1; bi < m.blocks.length; bi++) { const g = m.blocks[bi].x0 - m.blocks[bi - 1].x1; if (g > 0) gaps.push(g) }
          gaps.sort((a, b) => a - b)
          const gMed2 = gaps.length ? gaps[(gaps.length / 2) | 0] : 0
          for (const b of m.blocks) {
            const bhv = b.y1 - b.y0
            const gl = bi2g(m.blocks, b, 'l'), gr = bi2g(m.blocks, b, 'r')
            const sus = bhv > hMed2 * 1.5 && Math.abs(b.bot - bMed2) > 2
            console.error(`[dark block] y=${m.ay0} x=${b.x0}-${b.x1} bh=${bhv}(med${hMed2}) bot=${b.bot}(med${bMed2}) gapL=${gl}(med${gMed2}) gapR=${gr} ${sus ? '⚠️偏离' : ''}`)
          }
        }
        rowsP++; subsDetail.push({ y0: m.ay0, y1: m.ay1, bm: +m.bmSub.toFixed(3), g: 0, h: 0 }); continue
      }
      // 手写/图形子行：块级图形过滤
      let sg = 0, sh = 0
      for (const b of m.blocks) {
        const bw = b.x1 - b.x0, bh = b.y1 - b.y0
        if (bh > glyphH * 3 || (bw > w * 0.25 && b.n / (bw * bh) < 0.2) || inGraphic(b.x0, b.x1)) { blockGraphic++; rowsG++; sg++; continue }
        blockHand++; rowsH++; sh++
        for (let y = b.y0; y < b.y1; y++)
          for (let x = b.x0; x < b.x1; x++) {
            const i = y * w + x
            if (!ink[i]) continue
            seed[i] = 255
            seedCount++
          }
      }
      subsDetail.push({ y0: m.ay0, y1: m.ay1, bm: +m.bmSub.toFixed(3), g: sg, h: sh })
    }
    rowsDetail.push({ y0: r.y0, y1: r.y1, g: rowsG, p: rowsP, h: rowsH, subs: subsDetail })
  }

  // ⭐⭐ 填空横线邻域（真卷实测暴露的第七个缺陷：填空手写答案整片漏检）
  //    真卷：13/14/16 题填空手写（"m≤2且m≠1"、"2√7-3"、"000("）全部压在
  //    印刷作图线上书写 —— 与印刷同行同基线，被切进同一子行；
  //    基线/笔画宽/块宽特征全部无区分度（实测记录见方法论 §5.3），
  //    三处填空 mask=0 全漏。
  //    唯一可靠的是**结构特征**：答案墨紧贴一条「细长横线」。
  //    判据链：
  //      ① 线检测：行内 run（断点容差 2）长度 ≥ 4×glyphH 且厚度 ≤ 4px；
  //      ② 表格排除：线上下 ±0.6×glyphH 内另有平行长线 → 是表格/图形，跳过；
  //      ③ 连通域核对：邻域（±0.9×glyphH）内的墨所属连通域必须是
  //         「压线的小域」（bbox 高 ≤3×glyphH 且宽 ≤0.28w，且 y 范围与线相交）
  //         → 答案笔迹进种子；图形横边等大连通域整体排除。
  //    答案与线连通时域=线+答案（长≈线长仍属"小域"），写回时排除线身像素。
  const compLabel = new Int32Array(w * h).fill(-1)
  const comps: Array<{ x0: number; x1: number; y0: number; y1: number; n: number }> = []
  {
    const stack = new Int32Array(w * h)
    for (let i0 = 0; i0 < w * h; i0++) {
      if (!ink[i0] || compLabel[i0] >= 0) continue
      const id = comps.length
      comps.push({ x0: w, x1: 0, y0: h, y1: 0, n: 0 })
      let sp = 0
      stack[sp++] = i0
      compLabel[i0] = id
      while (sp > 0) {
        const i = stack[--sp]
        const x = i % w, y = (i / w) | 0
        const c = comps[id]
        c.n++
        if (x < c.x0) c.x0 = x
        if (x > c.x1) c.x1 = x
        if (y < c.y0) c.y0 = y
        if (y > c.y1) c.y1 = y
        if (x > 0 && ink[i - 1] && compLabel[i - 1] < 0) { compLabel[i - 1] = id; stack[sp++] = i - 1 }
        if (x < w - 1 && ink[i + 1] && compLabel[i + 1] < 0) { compLabel[i + 1] = id; stack[sp++] = i + 1 }
        if (y > 0 && ink[i - w] && compLabel[i - w] < 0) { compLabel[i - w] = id; stack[sp++] = i - w }
        if (y < h - 1 && ink[i + w] && compLabel[i + w] < 0) { compLabel[i + w] = id; stack[sp++] = i + w }
      }
    }
  }
  const blankLines: Array<{ y0: number; y1: number; x0: number; x1: number; seeds: number }> = []
  {
    const lineMin = glyphH * 4
    type Seg = { y: number; x0: number; x1: number }
    const segs: Seg[] = []
    for (let y = 0; y < h; y++) {
      let x = 0
      while (x < w) {
        if (!ink[y * w + x]) { x++; continue }
        const sx = x
        let gap = 0, e = x
        for (let j = x; j < w; j++) {
          if (ink[y * w + j]) { e = j; gap = 0 } else { gap++; if (gap > 2) break }
        }
        if (e - sx + 1 >= lineMin) segs.push({ y, x0: sx, x1: e })
        x = e + 1
      }
    }
    // 垂直合并：相邻 y 且 x 重叠率 >0.7 的 run 归并为同一条线
    const lines: Array<{ y0: number; y1: number; x0: number; x1: number }> = []
    const overlap = (a0: number, a1: number, b0: number, b1: number) => {
      const o = Math.min(a1, b1) - Math.max(a0, b0)
      return o > 0.7 * Math.min(a1 - a0, b1 - b0)
    }
    for (const s of segs) {
      const hit = lines.find((L) => L.y1 >= s.y - 1 && overlap(L.x0, L.x1, s.x0, s.x1))
      if (hit) {
        hit.y1 = Math.max(hit.y1, s.y)
        hit.x0 = Math.min(hit.x0, s.x0)
        hit.x1 = Math.max(hit.x1, s.x1)
      } else lines.push({ y0: s.y, y1: s.y, x0: s.x0, x1: s.x1 })
    }
    for (const L of lines) {
      if (L.y1 - L.y0 + 1 > 4) continue // 厚的不是作图线
      const cy = (L.y0 + L.y1) / 2
      const isTable = lines.some((O) => {
        if (O === L) return false
        if (Math.abs((O.y0 + O.y1) / 2 - cy) > glyphH * 0.6) return false
        return overlap(L.x0, L.x1, O.x0, O.x1)
      })
      if (isTable) continue
      // ②-b 端点连接核对（真卷实测暴露：第 7 题图形的水平边通过了①②，
      //      其邻域内的顶点字母标注（A/B/E/G…小连通域）被当"压线答案"
      //      误擦 88px）。几何结构特征：**填空作图线两端悬空**，
      //      图形边两端必然连接其他笔画（斜边/顶点）。检查线两端向外
      //      0.4×glyphH 的窗口：墨量多 → 端点连接 → 图形/表格结构，跳过。
      {
        const ew = Math.max(3, Math.round(glyphH * 0.4))
        let endInk = 0
        for (const isLeft of [true, false]) {
          const x0 = isLeft ? Math.max(0, L.x0 - ew) : L.x1 + 1
          const x1 = isLeft ? L.x0 - 1 : Math.min(w - 1, L.x1 + ew)
          for (let y = Math.max(0, L.y0 - ew); y <= Math.min(h - 1, L.y1 + ew); y++)
            for (let xx = x0; xx <= x1; xx++) if (ink[y * w + xx]) endInk++
        }
        if (endInk > 8) continue
      }
      const vBand = Math.round(glyphH * 0.9)
      const xPad = Math.round(glyphH * 0.3)
      const bx0 = Math.max(0, L.x0 - xPad), bx1 = Math.min(w - 1, L.x1 + xPad)
      const by0 = Math.max(0, L.y0 - vBand), by1 = Math.min(h - 1, L.y1 + vBand)
      let added = 0
      const seen = new Set<number>()
      for (let y = by0; y <= by1; y++)
        for (let x = bx0; x <= bx1; x++) {
          const i = y * w + x
          if (!ink[i]) continue
          if (y >= L.y0 - 1 && y <= L.y1 + 1) continue // 线身 ±1 不算
          const cid = compLabel[i]
          if (cid < 0 || seen.has(cid)) continue
          seen.add(cid)
          const c = comps[cid]
          // 只收「压线的小域」：图形横边/边框等大连通域在此排除
          if (c.y1 - c.y0 + 1 > glyphH * 3 || c.x1 - c.x0 + 1 > w * 0.28) continue
          if (c.y1 < L.y0 - 2 || c.y0 > L.y1 + 2) continue // 未压线（悬空小结构）
          for (let yy = c.y0; yy <= c.y1; yy++)
            for (let xx = c.x0; xx <= c.x1; xx++) {
              const ii = yy * w + xx
              if (!ink[ii] || seed[ii]) continue
              if (yy >= L.y0 - 1 && yy <= L.y1 + 1 && xx >= L.x0 - 2 && xx <= L.x1 + 2) continue // 排除线身
              seed[ii] = 255
              seedCount++
              added++
            }
        }
      blankLines.push({ y0: L.y0, y1: L.y1, x0: L.x0, x1: L.x1, seeds: added })
    }
  }
  if (seedCount === 0) {
    EMPTY_REASON = rowTall === 0 ? 'no_tall_row' : 'baseline_guard'
    return empty({
      reason: EMPTY_REASON, inkTotal, glyphH, rowLimit, rows: rows.length, rowTall,
      rowBaselineBlocked, rowDensityBlocked,
      tallDensities: tallDensities.map((d) => +d.toFixed(3)),
      tallBaselines: tallBaselines.map((d) => +d.toFixed(3)),
    })
  }

  // ⑤ 在**墨迹连通域内**做测地扩散：每步半径 1 膨胀后与 ink 取交。
  //    手写笔画彼此连通 → 整字被覆盖；印刷体与手写若不相连 → 传播不过去
  //    （比方形膨胀安全：方形膨胀会跨过空白把邻近印刷体一起吞掉）。
  const steps = Math.max(1, Math.round(glyphH * (opts.grow ?? 0.5)))
  const grown = new Uint8Array(seed)
  for (let k = 0; k < steps; k++) {
    const nx = maxFilterU8(grown, w, h, 1)
    for (let i = 0; i < w * h; i++) {
      if (!ink[i]) { grown[i] = 0; continue }
      if (nx[i] > grown[i]) grown[i] = nx[i]
    }
  }
  let candidateInk = 0
  const candMask = Buffer.alloc(w * h, 0)
  for (let i = 0; i < w * h; i++) {
    if (!ink[i]) continue
    if (grown[i] < 64) continue
    candMask[i] = grown[i]
    candidateInk++
  }

  // ⑥ 保守护栏：候选占比过高 → 分类失效，整条路径作废（绝不冒险擦整页）
  if (candidateInk <= 0 || candidateInk / inkTotal > maxInkShare) {
    EMPTY_REASON = candidateInk <= 0 ? 'no_candidate' : 'share_guard'
    return empty({ reason: EMPTY_REASON, inkTotal, glyphH, rowLimit, seedCount, candidateInk, share: candidateInk / inkTotal })
  }

  // ⑦ 真形态学膨胀：捕获抗锯齿的半透明边缘像素。
  //    领域共识（WPI_inpainting 的 MaxPool 膨胀 / LaMa 流程）：不膨胀会残留"鬼影"轮廓。
  //    ⚠️ 旧实现是「blur + 阈值 24」，对细笔画净效果是**腐蚀**，与领域做法相反。
  //
  // ⭐ **P0-7 自适应膨胀半径**：必须随**字高/笔画宽**变化，不能随图片尺寸。
  //    旧式 `min(w,h)×0.004` 的依据是"图片多大"，与笔画粗细毫无关系：
  //      · 密集小字试卷（1200px 宽、字高 16）→ 半径 4~5 ≈ 笔画宽的 2 倍以上
  //        → 膨胀过度，把紧邻的印刷字一起吞进 mask（实测「外扩过度波及印刷文字」）；
  //      · 大字笔记（同图片尺寸、字高 60）→ 半径仍是 4~5，相对笔画太窄
  //        → 盖不住抗锯齿边缘，擦完留下"残影轮廓"。
  //    正确的量纲是笔画本身：`笔画宽 ≈ 字高/8`（中文宋体的经验比例，
  //    OCR/版面分析领域常用），再乘 1.5 留足覆盖抗锯齿的余量。
  const strokeW = glyphH / 8
  const autoDilate = Math.max(2, Math.round(strokeW * 1.5))
  const dilate = opts.dilate ?? autoDilate
  const dilated = maxFilterU8(candMask, w, h, dilate)

  // ⑧ 羽化：把硬边 mask 变成**软 mask**（灰度渐变）。
  //    领域共识：硬二值 mask 是可见接缝的第一大成因（ComfyUI MaskBlur/MaskSmooth、
  //    guided filter 做 mask 精修）。百度网盘手写擦除冠军方案的 mask 也是
  //    「差异 >20 置 1，<20 归一化」的连续值，而非硬 0/255。
  //    取 max(膨胀结果, 模糊结果) → 只向外柔化，**绝不缩小覆盖范围**。
  const feather = opts.feather ?? Math.max(2, Math.round(Math.min(w, h) * 0.003))
  const blurredRaw = await sharp(dilated, { raw: { width: w, height: h, channels: 1 } })
    .blur(Math.max(1, feather * 0.6))
    .raw()
    .toBuffer()
  // ⚠️ 单通道 raw 经 blur 后实际是 3 通道（L19），按 stride 取通道 0
  const bch = Math.max(1, Math.round(blurredRaw.length / (w * h)))
  const soft = Buffer.alloc(w * h, 0)
  for (let i = 0; i < w * h; i++) {
    const b = blurredRaw[i * bch]
    soft[i] = b > dilated[i] ? b : dilated[i]
  }

  // ⑨ 还原到原图尺寸
  const fullRaw = await sharp(soft, { raw: { width: w, height: h, channels: 1 } })
    .resize(W0, H0, { fit: 'fill', kernel: 'nearest' })
    .raw()
    .toBuffer()
  const fch = Math.max(1, Math.round(fullRaw.length / (W0 * H0)))
  const full = Buffer.alloc(W0 * H0, 0)
  let covered = 0
  // ⭐ 保留 0~255 的**连续值**（软 mask），不再二值化为 0/255：
  //    下游 blendWithMask 直接把 mask 值写进 alpha 通道，天然支持软边融合。
  for (let i = 0; i < W0 * H0; i++) {
    const v = fullRaw[i * fch]
    full[i] = v
    if (v > 127) covered++
  }

  // ⑨-b ⭐ 紧种子：只膨胀 `seedDilate` 像素（仅够盖住笔画自身的抗锯齿边），
  //      远小于上面的 dilate。用途见 HandwritingMask.seed 的注释——
  //      它是修复阶段的**源排除区**，必须"紧"，否则会把该保留的印刷结构也排除掉。
  // ⚠️ 紧种子必须**严格窄于**修复区(`dilate`)：种子是"修复时的源排除区"，
  //    若它等于或宽于修复区，就等于把整个待修复区都排除出参考源，
  //    `structuralExtend` 无源可取 → 豁口。P0-7 让 dilate 可能降到下限 2，
  //    这里必须跟着夹紧。
  const seedDilate = Math.min(opts.seedDilate ?? 2, Math.max(1, dilate - 1))
  const seedTight = maxFilterU8(candMask, w, h, seedDilate)
  const seedRaw = await sharp(seedTight, { raw: { width: w, height: h, channels: 1 } })
    .resize(W0, H0, { fit: 'fill', kernel: 'nearest' })
    .raw()
    .toBuffer()
  const sch = Math.max(1, Math.round(seedRaw.length / (W0 * H0)))
  const seedFull = Buffer.alloc(W0 * H0, 0)
  for (let i = 0; i < W0 * H0; i++) seedFull[i] = seedRaw[i * sch] > 127 ? 255 : 0

  return {
    width: W0,
    height: H0,
    data: full,
    coverage: covered / (W0 * H0),
    source: 'threshold',
    seed: seedFull,
    debug: {
      inkTotal, glyphH, rowLimit, rows: rows.length, rowTall,
      rowBaselineBlocked, rowDensityBlocked,
      tallDensities: tallDensities.map((d) => +d.toFixed(3)),
      tallBaselines: tallBaselines.map((d) => +d.toFixed(3)),
      blockGraphic, blockPrintProtected, blockHand,
      rowsDetail,
      blankLines,
      seedCount, candidateInk, share: candidateInk / inkTotal, dilate, feather,
    },
  }
}

/**
 * 两张 mask 取并集（要求同尺寸；不同尺寸时按 nearest 拉伸对齐）。
 *
 * ⭐ 用 `max` 而不是「>127 ? 255 : 0」：后者会把**软 mask 丢弃**——
 *    深色笔迹路径现在产出的是 0~255 连续值的软 mask（羽化后边缘是渐变），
 *    二值化并集会把羽化效果抹掉，退回硬边接缝。
 */
export async function unionMasks(a: HandwritingMask, b: HandwritingMask): Promise<HandwritingMask> {
  const ad = await alignMask(a, a.width, a.height)
  const bd = await alignMask(b, a.width, a.height)
  const out = Buffer.alloc(a.width * a.height, 0)
  let covered = 0
  const n = Math.min(out.length, Math.min(ad.length, bd.length))
  for (let i = 0; i < n; i++) {
    const v = ad[i] > bd[i] ? ad[i] : bd[i]
    out[i] = v
    if (v > 127) covered++
  }

  // 紧种子同样取并集（max）。任一路缺失就退化为"另一路的种子"；
  // 两路都缺失则为 undefined，下游会用 mask 自身兜底（安全方向：排除得更多）。
  let seed: Buffer | undefined
  if (a.seed || b.seed) {
    seed = Buffer.alloc(a.width * a.height, 0)
    for (let i = 0; i < n; i++) {
      const av = a.seed ? a.seed[i] ?? 0 : 0
      const bv = b.seed ? b.seed[i] ?? 0 : 0
      seed[i] = av > bv ? av : bv
    }
  }

  return { width: a.width, height: a.height, data: out, coverage: covered / (a.width * a.height), source: a.source, seed }
}

/**
 * ⭐ 笔画粗细（1 轮 4 邻域腐蚀存活率）——「手写 vs 印刷线稿」的本质判据（v14）
 *
 * 物理依据：中性笔/圆珠笔笔尖 0.5~0.7mm，在试卷分辨率下笔画粗 3~5px；
 * 印刷字/作图线 1~2px。1 轮 4 邻域腐蚀后：3px 笔画中轴存活（>8%），
 * 2px 以下线条全部消失（<2%）。
 *
 * 用途：
 *  - 括号槽位：槽内墨存活率高 → 有手写笔画 → 保留；全细笔画（印刷题干/序号）→ 跳过
 *  - 横线槽位：连通域存活率低 → 纯线框几何图 → 跳过；含粗笔画（压线手写）→ 保留
 */
function erodeSurvivalRate(
  ink: Uint8Array, w: number, h: number,
  x0: number, y0: number, x1: number, y1: number,
  restrictCid = -1, compLabel?: Int32Array,
): { alive: number; total: number } {
  let total = 0, alive = 0
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x
      if (!ink[i]) continue
      if (restrictCid >= 0 && compLabel && compLabel[i] !== restrictCid) continue
      total++
      const up = y > y0 && ink[i - w] && (restrictCid < 0 || compLabel![i - w] === restrictCid)
      const dn = y < y1 && ink[i + w] && (restrictCid < 0 || compLabel![i + w] === restrictCid)
      const lf = x > x0 && ink[i - 1] && (restrictCid < 0 || compLabel![i - 1] === restrictCid)
      const rt = x < x1 && ink[i + 1] && (restrictCid < 0 || compLabel![i + 1] === restrictCid)
      if (up && dn && lf && rt) alive++
    }
  }
  return { alive, total }
}

/**
 * ⭐ **布局先验通道（第三检测通道）**：用题型结构（横线填空槽位）直接定位手写，
 * 绕开"印刷与手写外观不可分"的死局。
 *
 * 原理：填空/阅读理解/简答题的填空答案，在设计上就写在**细横线**上或**括号**内——
 * 这些位置默认是空白的，槽位里出现墨迹≈手写。问题从"全页外观分类(印刷≡手写)"
 * 转化为"空槽里有没有墨"，正面避开五特征死局（§5.3.3 / §5.5）。
 *
 * 实测（真卷）：13/14/16 题填空手写、20 题解答区——深色外观路径漏检，本通道补回。
 *
 * ⚠️ 槽位是**搜索区不是擦除区**：槽内仍走印刷保护（长横笔线身排除、大连通域排除），
 *    仅负责收窄搜索空间；最终与外观/VLM 通道取**并集**。
 *
 * @param buf 归一化后的检测用图（与 maskFromDarkInk 同款输入）
 */
export async function maskFromLayoutSlots(
  buf: Buffer,
  opts: { workMaxSide?: number; grow?: number } = {},
): Promise<HandwritingMask> {
  const meta = await sharp(buf).metadata()
  const W0 = meta.width || 0, H0 = meta.height || 0
  const empty = (reason: string): HandwritingMask => ({ width: W0, height: H0, data: Buffer.alloc(W0 * H0, 0), coverage: 0, source: 'layout', debug: { reason } })
  if (!W0 || !H0) return empty('bad_size')
  const workMaxSide = opts.workMaxSide ?? 1200
  const scale = Math.min(1, workMaxSide / Math.max(W0, H0))
  const w = Math.max(1, Math.round(W0 * scale))
  const h = Math.max(1, Math.round(H0 * scale))
  const gray = await sharp(buf).resize(w, h, { fit: 'fill' }).grayscale().raw().toBuffer()

  // ⚠️ 用**固定阈值**而非 Otsu：填空横线常为浅灰，Otsu(按全页直方图)会被白纸拉高，
  // 把浅灰线判成"纸面"→ 检不到线 → 槽位全空。归一化已压平光照，固定阈值更稳。
  const thr = 140
  const ink = new Uint8Array(w * h)
  for (let i = 0; i < gray.length; i++) if (gray[i] < thr) ink[i] = 1
  const { glyphH } = segmentTextRows(ink, w, h, {})
  if (!glyphH) return empty('no_glyph')
  const lineMin = glyphH * 4, maxThick = 6

  // ① 横线检测：每行找长≥lineMin、断点容差2的连续暗段；垂直合并相邻 y（重叠率>0.7）
  const segs: Array<{ y: number; x0: number; x1: number }> = []
  for (let y = 0; y < h; y++) {
    let x = 0
    while (x < w) {
      if (!ink[y * w + x]) { x++; continue }
      const sx = x; let gap = 0, e = x
      for (let j = x; j < w; j++) {
        if (ink[y * w + j]) { e = j; gap = 0 } else { gap++; if (gap > 2) break }
      }
      if (e - sx + 1 >= lineMin) segs.push({ y, x0: sx, x1: e })
      x = e + 1
    }
  }
  const lines: Array<{ y0: number; y1: number; x0: number; x1: number }> = []
  const overlap = (a0: number, a1: number, b0: number, b1: number) => {
    const o = Math.min(a1, b1) - Math.max(a0, b0)
    return o > 0.7 * Math.min(a1 - a0, b1 - b0)
  }
  for (const s of segs) {
    const hit = lines.find((L) => L.y1 >= s.y - 1 && overlap(L.x0, L.x1, s.x0, s.x1))
    if (hit) { hit.y1 = Math.max(hit.y1, s.y); hit.x0 = Math.min(hit.x0, s.x0); hit.x1 = Math.max(hit.x1, s.x1) }
    else lines.push({ y0: s.y, y1: s.y, x0: s.x0, x1: s.x1 })
  }
  // 排除：厚度>maxThick（非作图细线）、表格/图形（附近有平行长线）。
  // ⚠️ 不排"线两端连墨"：行内填空线(如 "则QE=___" 的线)两端本就接在印刷句上，
  // 端墨排除会把这类线误杀 → 14/13 题填空答案跟着漏检。图形横边改用"大连通域排除"兜底。
  const kept: typeof lines = []
  for (const L of lines) {
    if (L.y1 - L.y0 + 1 > maxThick) continue
    const cy = (L.y0 + L.y1) / 2
    const isTable = lines.some((O) => O !== L && Math.abs((O.y0 + O.y1) / 2 - cy) <= glyphH * 0.6 && overlap(L.x0, L.x1, O.x0, O.x1))
    if (isTable) continue
    kept.push(L)
  }

  // ② 槽内取墨：横线 ±vBand 带内，排除线身(±1px)、排除大连通域(图形/印刷长横)，其余进种子
  const vBand = Math.round(glyphH * 0.9), xPad = Math.round(glyphH * 0.3)
  const seed = new Uint8Array(w * h)
  const srcTag = new Uint8Array(w * h) // 1=line槽位 2=paren槽位 (调试用)
  let seedCount = 0
  // 连通域尺寸（排除图形/长印刷横笔）
  const compLabel = new Int32Array(w * h).fill(-1)
  const comps: Array<{ x0: number; x1: number; y0: number; y1: number; n: number }> = []
  {
    const stack = new Int32Array(w * h)
    for (let i0 = 0; i0 < w * h; i0++) {
      if (!ink[i0] || compLabel[i0] >= 0) continue
      const id = comps.length; comps.push({ x0: w, x1: 0, y0: h, y1: 0, n: 0 })
      let sp = 0; stack[sp++] = i0; compLabel[i0] = id
      while (sp > 0) {
        const i = stack[--sp], x = i % w, y = (i / w) | 0, c = comps[id]
        c.n++; if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y
        if (x > 0 && ink[i - 1] && compLabel[i - 1] < 0) { compLabel[i - 1] = id; stack[sp++] = i - 1 }
        if (x < w - 1 && ink[i + 1] && compLabel[i + 1] < 0) { compLabel[i + 1] = id; stack[sp++] = i + 1 }
        if (y > 0 && ink[i - w] && compLabel[i - w] < 0) { compLabel[i - w] = id; stack[sp++] = i - w }
        if (y < h - 1 && ink[i + w] && compLabel[i + w] < 0) { compLabel[i + w] = id; stack[sp++] = i + w }
      }
    }
  }
  // 长横笔掩膜：线身/印刷长横笔是连续长 run，手写笔画是短 run。
  // 只排除"长横笔本身"，保留压在线上/紧贴线的短笔画手写（关键：填空答案常直接写在横线上）。
  const longRun = Buffer.alloc(w * h)
  const longRunThresh = Math.floor(glyphH * 4)
  for (let y = 0; y < h; y++) {
    let runS = -1
    for (let x = 0; x <= w; x++) {
      const on = x < w && ink[y * w + x] === 1
      if (on && runS < 0) runS = x
      if (!on && runS >= 0) {
        if (x - runS >= longRunThresh) for (let xx = runS; xx < x; xx++) longRun[y * w + xx] = 1
        runS = -1
      }
    }
  }
  for (const L of kept) {
    // ── 几何图线段排除（v14 新增，真卷红框反馈修复）─────────────────────────
    // 事故：20 题右侧印刷几何图的长直线段（BF、FC 边）满足"长≥4×glyphH、厚≤6px、
    //       无平行相邻线"的填空横线判据 → vBand 带内把 ∠1/∠2/∠3 角标与数字收进
    //       种子 → 擦除毁掉几何图（用户红框反馈：印刷图形被误删）。
    // 判据（必须同时满足才判图形线，防误杀压线手写）：
    //   a. 线所属连通域垂直跨度 > 2.5×glyphH；
    //   b. 连通域**笔画粗细判伪**（erodeSurvivalRate，仅限本连通域像素）：1 轮腐蚀
    //      存活率 <2% → 纯细线线框 = 几何图 → 跳过；≥2% → 含粗笔画（压线手写的
    //      3~5px 笔迹）→ 保留。
    //      ⚠️ 曾试过"斜 run/竖 run/横线簇"佐证，均被压线手写的长竖/分数线误触
    //      （14 题回归暴露），粗细判伪是唯一稳定区分：几何图整体都是 1~2px 印刷线。
    {
      const cxi = Math.min(w - 1, Math.max(0, Math.round((L.x0 + L.x1) / 2)))
      const cyi = Math.min(h - 1, Math.max(0, Math.round((L.y0 + L.y1) / 2)))
      const cid = compLabel[cyi * w + cxi]
      if (cid >= 0) {
        const cc = comps[cid]
        const vSpan = cc.y1 - cc.y0 + 1
        if (vSpan > glyphH * 2.5) {
          const bx0 = Math.max(0, cc.x0), bx1 = Math.min(w - 1, cc.x1)
          const by0 = Math.max(0, cc.y0), by1 = Math.min(h - 1, cc.y1)
          const { alive, total } = erodeSurvivalRate(ink, w, h, bx0, by0, bx1, by1, cid, compLabel)
          const survival = total > 0 ? alive / total : 0
          if (survival < 0.02) {
            if (process.env.LAYOUT_DBG) console.error(`[line slot] @${L.x0},${L.y0} 图形线跳过 (跨度${vSpan} 存活率${(survival * 100).toFixed(2)}% n=${total})`)
            continue
          }
          if (process.env.LAYOUT_DBG) console.error(`[line slot] @${L.x0},${L.y0} 跨度大但连通域有粗笔画(存活率${(survival * 100).toFixed(2)}%) → 保留(疑压线手写)`)
        }
      }
    }
    const bx0 = Math.max(0, L.x0 - xPad), bx1 = Math.min(w - 1, L.x1 + xPad)
    const by0 = Math.max(0, L.y0 - vBand), by1 = Math.min(h - 1, L.y1 + vBand)
    // ── 带内印刷基线排除（v14 新增，真卷红框反馈修复）────────────────────────
    // 事故：填空横线与印刷文字同行（如 14 题"PB=1，则QE=___"），vBand=±0.9×glyphH
    //       带内"非长横墨全部进种子"把同行印刷字符整段吞掉（用户红框：印刷被误删）。
    // 判据：印刷字符底边整齐坐在行基线上；手写答案底边参差或压线。对带内候选连通域
    //       的底边 y1 做 ±2px 聚类，若某簇 ≥3 域且占比 ≥0.6 → 判为行基线，簇内域
    //       排除（印刷），簇外域（手写）照常进种子。带内纯手写时判据不触发（现状不变）。
    const bandComps: Array<{ c: typeof comps[number]; y1: number }> = []
    {
      const seenB = new Set<number>()
      for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
        const i = y * w + x
        if (!ink[i] || longRun[i]) continue
        const cid = compLabel[i]; if (cid < 0 || seenB.has(cid)) continue; seenB.add(cid)
        const c = comps[cid]
        if (c.y1 - c.y0 + 1 > glyphH * 3 || c.x1 - c.x0 + 1 > w * 0.28) continue
        bandComps.push({ c, y1: c.y1 })
      }
    }
    const baselineY1 = new Set<number>()
    if (bandComps.length >= 3) {
      const sorted = [...bandComps].sort((a, b) => a.y1 - b.y1)
      let bestN = 0, bestY = -1
      for (let a = 0; a < sorted.length; a++) {
        let n = 0, sum = 0
        for (let b = a; b < sorted.length && sorted[b].y1 - sorted[a].y1 <= 2; b++) { n++; sum += sorted[b].y1 }
        if (n > bestN) { bestN = n; bestY = Math.round(sum / n) }
      }
      if (bestN >= 3 && bestN >= bandComps.length * 0.6) {
        for (const bc of bandComps) if (Math.abs(bc.y1 - bestY) <= 2) baselineY1.add(bc.c.x0 * 100000 + bc.c.y0)
        if (process.env.LAYOUT_DBG) console.error(`[line slot] @${L.x0},${L.y0} 基线y=${bestY} 排除${baselineY1.size}/${bandComps.length}个印刷域`)
      }
    }
    const seen = new Set<number>()
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
      const i = y * w + x
      if (!ink[i]) continue
      if (longRun[i]) continue // 仅排除长横笔(线身)，保留压线短笔画
      const cid = compLabel[i]; if (cid < 0 || seen.has(cid)) continue; seen.add(cid)
      const c = comps[cid]
      if (c.y1 - c.y0 + 1 > glyphH * 3 || c.x1 - c.x0 + 1 > w * 0.28) continue // 图形/长印刷横笔
      if (baselineY1.has(c.x0 * 100000 + c.y0)) continue // 印刷基线域排除
      for (let yy = c.y0; yy <= c.y1; yy++) for (let xx = c.x0; xx <= c.x1; xx++) {
        const ii = yy * w + xx
        if (!ink[ii] || longRun[ii] || seed[ii]) continue
        seed[ii] = 255; srcTag[ii] = 1; seedCount++
      }
    }
  }
  if (seedCount === 0 && comps.length === 0) return empty('no_seed')

  // ②-b 括号槽位（选择填空：答案写在印刷 "（ ）" 内）。对应题型"选择填在括号内"。
  // 锚点 = 一对左右括号（细高、空心、开口相对的连通域）；槽位 = 两括号之间区域，
  // 区域内短笔画(手写字母)进种子；印刷长文本(高墨密度)跳过避免误擦题干。
  const paren = (c: typeof comps[number]) => {
    const hh = c.y1 - c.y0 + 1, ww = c.x1 - c.x0 + 1
    if (hh < glyphH * 0.7 || hh > glyphH * 2.6) return 0
    if (ww > glyphH * 1.3 || ww / hh > 1.3) return 0 // 兼容全角"（ ）"(近方形)
    const dens = c.n / (ww * hh)
    if (dens > 0.6) return 0 // 实心块不是括号
    return hh
  }
  const lefts: Array<{ c: typeof comps[number]; cy: number; cx: number }> = []
  const rights: Array<{ c: typeof comps[number]; cy: number; cx: number }> = []
  const matchedL = new Set<number>(), matchedR = new Set<number>()
  for (const c of comps) {
    if (!paren(c)) continue
    const cy = (c.y0 + c.y1) / 2, cx = (c.x0 + c.x1) / 2
    // 开口朝右=左括号(墨偏左)，开口朝左=右括号(墨偏右)
    let leftInk = 0, rightInk = 0
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (ink[y * w + x]) { if (x < cx) leftInk++; else rightInk++ }
    if (leftInk >= rightInk) lefts.push({ c, cy, cx }); else rights.push({ c, cy, cx })
  }
  for (const L of lefts) for (const R of rights) {
    if (process.env.SKIP_PAREN) continue
    if (Math.abs(L.cy - R.cy) > glyphH * 0.5) continue
    matchedL.add(L.c.x0 * 100000 + L.c.y0)
    matchedR.add(R.c.x0 * 100000 + R.c.y0)
    const gap = R.c.x0 - L.c.x1
    // 手写答案括号通常紧贴答案(间隙小)；间隙过大(>1.5倍字高)几乎必为"跨印刷文本"的印刷括号对，
    // 其槽内是印刷正文而非手写答案 → 跳过。可经 GAPMUL 覆盖微调。
    const gapMul = process.env.GAPMUL ? +process.env.GAPMUL : 1.5
    if (gap < 0 || gap > glyphH * gapMul) continue
    const sy0 = Math.max(0, Math.floor(Math.min(L.cy, R.cy) - glyphH * 0.8))
    const sy1 = Math.min(h - 1, Math.ceil(Math.max(L.cy, R.cy) + glyphH * 0.8))
    const sx0 = Math.max(0, L.c.x1 - 2), sx1 = Math.min(w - 1, R.c.x0 + 2)
    // ── 印刷括号对闸门（v14 新增，真卷红框反馈修复）──────────────────────────
    // 事故：印刷数学表达式自带括号对（如 13 题"(m-1)x²+2x+1=0"、"PB=1"旁的假括号对、
    //       "EM//FN"旁假对、题干"(1)"），完美骗过 gap/密度/空括号三道闸 → 槽内印刷题干
    //       整段进种子被误擦（用户红框反馈：q7/q13/q14/q16 四处印刷被删）。
    // 判据（两条件同时满足才跳过）：
    //   ① 左右括号等高对齐（印刷同字体渲染差 ≤1px，手写 ≥2px）；
    //   ② 槽内墨**笔画粗细判伪**（erodeSurvivalRate）：槽内墨 1 轮腐蚀存活率 <8%
    //      → 全是细笔画 = 印刷题干 → 跳过；≥8% → 有粗笔画（手写答案，如选择"( B )"，
    //      其碎笔画域此前让"基线聚簇"判据失效）→ 保留。
    const lh = L.c.y1 - L.c.y0 + 1, rh = R.c.y1 - R.c.y0 + 1
    if (Math.abs(lh - rh) <= 1 && Math.abs(L.cy - R.cy) <= 1.5) {
      const py0 = Math.max(sy0, Math.min(L.c.y0, R.c.y0) - 2)
      const py1 = Math.min(sy1, Math.max(L.c.y1, R.c.y1) + 2)
      // 越界检查：槽内 x 范围中的墨，若连通域垂直范围越过括号自身 y 范围（±3px）
      // → 手写答案"写出格"（如 case1 7题手写 B 拖尾贯穿到选项行）→ 保留。
      // 印刷字符的域高 ≤ 括号高，永不越界。
      let overflow = false
      {
        const oy0 = Math.min(L.c.y0, R.c.y0) - 3
        const oy1 = Math.max(L.c.y1, R.c.y1) + 3
        const seenO = new Set<number>()
        for (let y = py0; y <= py1 && !overflow; y++) for (let x = sx0; x <= sx1; x++) {
          const i = y * w + x
          if (!ink[i]) continue
          const cid = compLabel[i]; if (cid < 0 || seenO.has(cid)) continue; seenO.add(cid)
          const c = comps[cid]
          if (c.y0 < oy0 || c.y1 > oy1) { overflow = true; break }
        }
      }
      if (!overflow) {
        const { alive, total } = erodeSurvivalRate(ink, w, h, Math.max(sx0, 0), py0, Math.min(sx1, w - 1), py1)
        const survival = total > 0 ? alive / total : 0
        if (total >= 30 && survival < 0.08) {
          if (process.env.LAYOUT_DBG) console.error(`[paren slot] @${L.c.x0},${L.c.y0} 印刷等高对跳过 (lh=${lh} rh=${rh} 腐蚀存活率${(survival * 100).toFixed(1)}% n=${total})`)
          continue
        }
        if (process.env.LAYOUT_DBG) console.error(`[paren slot] @${L.c.x0},${L.c.y0} 等高但槽内有粗笔画(存活率${(survival * 100).toFixed(1)}% n=${total}) → 保留(疑手写)`)
      } else {
        if (process.env.LAYOUT_DBG) console.error(`[paren slot] @${L.c.x0},${L.c.y0} 等高但槽内墨越界 → 保留(手写写出格)`)
      }
    }
    // 槽内墨密度过高(印刷长文本)→ 跳过
    let tot = 0, inkN = 0
    for (let y = sy0; y <= sy1; y++) for (let x = sx0; x <= sx1; x++) { tot++; if (ink[y * w + x]) inkN++ }
    const dens = tot > 0 ? inkN / tot : 0
    let slotComps = 0, slotInk = 0
    {
      const seen3 = new Set<number>()
      for (let y = sy0; y <= sy1; y++) for (let x = sx0; x <= sx1; x++) {
        const i = y * w + x
        if (!ink[i]) continue
        const cid = compLabel[i]; if (cid < 0 || seen3.has(cid)) continue; seen3.add(cid)
        slotComps++; slotInk += comps[cid].n
      }
    }
    // 内容墨 = 槽墨减去左右两个括号笔画本身。空括号(仅括号无答案，如印刷题干里的"（ ）")
    // 不应被判为手写 → 跳过。阈值 50：手写单字母答案通常 >50px，空括号为 0。
    const contentInk = Math.max(0, slotInk - L.c.n - R.c.n)
    if (contentInk < 50) continue
    if (process.env.LAYOUT_DBG) console.error(`[paren slot] @${L.c.x0},${L.c.y0}-${R.c.x0},${R.c.y0} gap=${gap.toFixed(1)} dens=${dens.toFixed(3)} comps=${slotComps} slotInk=${slotInk} contentInk=${contentInk}`)
    if (tot > 0 && dens > 0.35) continue
    const seen2 = new Set<number>()
    for (let y = sy0; y <= sy1; y++) for (let x = sx0; x <= sx1; x++) {
      const i = y * w + x
      if (!ink[i]) continue
      const cid = compLabel[i]; if (cid < 0 || seen2.has(cid)) continue; seen2.add(cid)
      const c = comps[cid]
      if (c.y1 - c.y0 + 1 > glyphH * 3 || c.x1 - c.x0 + 1 > w * 0.28) continue
      for (let yy = c.y0; yy <= c.y1; yy++) for (let xx = c.x0; xx <= c.x1; xx++) {
        const ii = yy * w + xx
        if (!ink[ii] || seed[ii]) continue
        seed[ii] = 255; srcTag[ii] = 2; seedCount++
      }
    }
  }

  // ②-c 碎裂括号复活（v14 新增，case1 7题回归修复）────────────────────────────
  // 事故：拍照模糊把细弧"（"打断成 2~3 个 <0.7×glyphH 的碎片 → paren() 全拒 →
  //       括号对湮灭 → 口内手写答案（7 题的 B）漏检。右括号"）"通常仍独立存活。
  // 处理：对**无 L 配对的 R**，收「R 左侧 ≤1.5×glyphH × R 的 y 带（±2px）」内的墨
  //       进种子——该范围就是括号口，B 的中段被擦。
  // 印刷防御：左括号完好的场景走正常成对流程（印刷等高闸门把守）；此处仅覆盖
  //       "左括号碎裂"（印刷左括号清晰拍碎极少见）。只做 R 侧：L 侧没有右边界，
  //       "（xx"后接印刷字时会误收邻字（宁漏勿毁）。
  if (!process.env.SKIP_PAREN) {
    for (const R of rights) {
      if (matchedR.has(R.c.x0 * 100000 + R.c.y0)) continue
      const bx0 = Math.max(0, R.c.x0 - Math.round(glyphH * 1.5))
      const bx1 = Math.max(0, R.c.x0 - 1)
      const by0 = Math.max(0, R.c.y0 - 2), by1 = Math.min(h - 1, R.c.y1 + 2)
      let got = 0
      for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
        const i = y * w + x
        if (ink[i] && !seed[i]) { seed[i] = 255; srcTag[i] = 2; seedCount++; got++ }
      }
      if (process.env.LAYOUT_DBG && got > 0) console.error(`[paren slot] 碎裂左括号复活 R@${R.c.x0},${R.c.y0} 口内收墨${got}px`)
    }
  }

  if (seedCount === 0) return empty('no_seed')

  // ③ 轻微膨胀盖住抗锯齿边，还原原图尺寸
  // v14 测地化：膨胀曾是无差别 maxFilter，种子外扩 3px 会把紧邻的印刷笔画间空隙一并
  // 罩进擦除区（行距小的印刷行被"连根拔"）。现限制膨胀只能到达**墨迹的 2px 邻域**——
  // 抗锯齿边(1~2px)保留，笔画间的纸面空隙不再被吞。与 dark 通道的测地扩散同思想。
  const dilate = Math.max(2, Math.round((glyphH / 8) * 1.5))
  const dilated = maxFilterU8(seed, w, h, dilate)
  {
    const nearInk = maxFilterU8(ink, w, h, 2)
    for (let i = 0; i < w * h; i++) if (dilated[i] && !nearInk[i]) dilated[i] = 0
  }
  const outBuf = process.env.SPLIT ? srcTag : dilated
  const full = await sharp(outBuf, { raw: { width: w, height: h, channels: 1 } }).resize(W0, H0, { fit: 'fill', kernel: 'nearest' }).raw().toBuffer()
  const fch = Math.max(1, Math.round(full.length / (W0 * H0)))
  const out = Buffer.alloc(W0 * H0, 0); let covered = 0
  for (let i = 0; i < W0 * H0; i++) { const v = full[i * fch]; out[i] = v; if (v > 127) covered++ }
  return { width: W0, height: H0, data: out, coverage: covered / (W0 * H0), source: 'layout', debug: { seedCount, lines: kept.length, glyphH } }
}

/**
 * ⭐ 剥离「贴边细长条」伪影（真卷 P0 缺陷修复，2026-09-30）
 *
 * ── 事故档案 ──────────────────────────────────────────────────────────────
 * 真卷（1279×1706 拍照）上，`maskFromColorThreshold` 把右缘装订阴影/页边
 * 检出为 32×1520 的竖条（占总 coverage 的 **37%**！），被当成手写整条擦掉。
 * 深色路径有「①.5 边缘连通暗区清除」，但**色域路径没有对应防线**——
 * 阴影带轻微偏色（彩度 > 阈值）即可在色域路径存活。
 *
 * ── 判据（三条同时满足才剥，宁漏勿误）──────────────────────────────────
 *   ① bbox 与图像边界接触，且**接触长度 ≥ 长边的 70%**（整条贴边）；
 *   ② 细长：max(宽,高) / min(宽,高) ≥ 6（手写字团很少是 6:1 的细长条）;
 *   ③ 连通域为硬 mask（>127）成分主导。
 * 右缘竖条：1519/1520 接触 ✓、47.5:1 ✓ → 剥离；
 * 右下 14×32 小块：2.3:1 ✗ → 保留（宁漏勿误）。
 *
 * ⚠️ 只应用于**本地检测路径**的输出（VLM / 用户框选的 mask 是更高优先级的
 *    意志表达，绝不在此剥除——用户主动框选边缘区就该擦）。
 *
 * @returns 被剥离的连通块列表（写入 debug）
 */
export function stripEdgeTouchingArtifacts(mask: HandwritingMask): Array<{
  x0: number; y0: number; x1: number; y1: number; area: number
}> {
  const { width: W, height: H, data } = mask
  const hard = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) hard[i] = data[i] > 127 ? 1 : 0
  const seen = new Uint8Array(W * H)
  const stack = new Int32Array(W * H)
  const stripped: Array<{ x0: number; y0: number; x1: number; y1: number; area: number }> = []

  for (let s = 0; s < W * H; s++) {
    if (!hard[s] || seen[s]) continue
    let sp = 0
    stack[sp++] = s
    seen[s] = 1
    let x0 = W, y0 = H, x1 = 0, y1 = 0, area = 0
    const comp: number[] = []
    while (sp > 0) {
      const i = stack[--sp]
      comp.push(i)
      const x = i % W, y = (i / W) | 0
      area++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
          const j = yy * W + xx
          if (hard[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j }
        }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1
    const longSide = Math.max(bw, bh), shortSide = Math.min(bw, bh)
    // 接触长度：连通域落在各边上的像素数取最大
    let touch = 0
    if (x0 === 0 || x1 === W - 1 || y0 === 0 || y1 === H - 1) {
      let tL = 0, tR = 0, tT = 0, tB = 0
      for (const i of comp) {
        const x = i % W, y = (i / W) | 0
        if (x === 0) tL++
        if (x === W - 1) tR++
        if (y === 0) tT++
        if (y === H - 1) tB++
      }
      touch = Math.max(tL, tR, tT, tB)
    }
    if (touch >= longSide * 0.7 && longSide / shortSide >= 6) {
      for (const i of comp) data[i] = 0
      // seed 一并清（保持"种子 ⊆ 修复区"的不变式）
      if (mask.seed) for (const i of comp) mask.seed[i] = 0
      stripped.push({ x0, y0, x1, y1, area })
    }
  }
  if (stripped.length) {
    // 重算 coverage
    let covered = 0
    for (let i = 0; i < W * H; i++) if (data[i] > 127) covered++
    mask.coverage = covered / (W * H)
  }
  return stripped
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
  const maskBuf = await alignMask(mask, width, height)

  const cols = Math.ceil(width / block)
  const rows = Math.ceil(height / block)
  // blocks[c*rows + r] = 1 表示该块为"压字区"
  const blocks = new Uint8Array(cols * rows)
  const regions: MaskRegion[] = []

  // ⭐ 到 mask 的 chamfer 距离图（整图算一次，O(n)）—— 供"紧贴核对"用
  const maskU8 = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) maskU8[i] = maskBuf[i] > 127 ? 1 : 0
  const distToMask = chamferDistance(maskU8, width, height)

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
      //
      // ⭐⭐ 紧贴核对（e2e 回归暴露：合成图 adaptive 从 8.18 退化到 46.8 的根因）
      // 压字区的本质是「印刷笔画被手写**截断**」——截断处必然与 mask 紧贴
      // （0~2px，中间只隔膨胀/羽化边）。而 mask 邻域里**隔空独立**的深色文字
      // （相邻的手写行、邻行的印刷字）不是被截断的结构，把它们当压字证据
      // 会触发 structuralExtend 把邻行的字"搬"进填充区（fillWithBackground
      // 本来填的是正确纸色，被延拓覆盖成墨色 → 色距 8.2 → 46.8）。
      // 对策：命中条件加 `distToMask ≤ 2` —— 只有紧贴 mask 的印刷像素
      // （= 被截断笔画的断口）才算压字证据；隔空文字一律不算。
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
              const ni = rowBase + nx
              if (print[ni] && distToMask[ni] <= 2) { hit = 1; break }
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
 *
 * ── ⭐ 填充源的铁律（实测踩坑后重写，务必保留）─────────────────────────────
 * 上一版注释写着「刻意**不排除** mask 内像素 —— 穿透 mask 能就地拿到被盖住的线」。
 * 这在**黑笔/铅笔**场景下是灾难：黑墨色（luma≤170、chroma≤42）与印刷体墨色
 * 完全同分布，于是 `isStructure` 把**还没被填掉的手写笔迹**当成"可信印刷结构"，
 * 直接把墨色填回原处 —— 实测残笔率黑笔 40.44% / 铅笔 37.05%，而蓝笔仅 0.05%
 * （chroma≈142 天然被 chroma≤42 挡掉）。这是"越擦越黑"的直接来源。
 *
 * 所有经典 inpainting（Criminisi exemplar-based、Telea FMM、Navier-Stokes）
 * 都遵循同一条铁律：**填充源只能来自已知区域，绝不能取自待修复区**。
 *
 * 但"完全排除 mask 内像素"又会丢掉"把手写截断的印刷线接回来"的能力
 * （膨胀后的 mask 可能把整条线都框进去）。解决办法是**双层 mask**：
 *   · 修复范围 = `mask.data`（膨胀+羽化，比笔画大一圈）
 *   · 源排除区 = `mask.seed`（紧种子，只含真正的笔画本体）
 * 于是线上"被膨胀框进来但未被手写压住"的部分**仍在可选源内**，
 * 而手写笔画本体被排除 —— 两头都要。
 *
 * 若连紧种子都没有（历史调用方未传），退化为"排除整个 mask"：
 * 宁可接不回线（留底色），也绝不能拿墨迹补墨迹。
 */
/**
 * 两遍 chamfer 距离变换：求每个像素到最近「mask 内像素」的近似欧氏距离。
 * 用于给 mask 生成外扩隔离带（`structuralExtend` 的抗锯齿隔离带）。
 * O(n) 两遍扫描，比逐像素方框膨胀快一个量级。
 */
function chamferDistance(mask: Uint8Array | Buffer, width: number, height: number): Float32Array {
  const D = new Float32Array(width * height)
  const INF = 1e9
  const D1 = 1, D2 = 1.4 // 正交 / 对角步长（近似 √2）
  for (let i = 0; i < D.length; i++) D[i] = mask[i] > 127 ? 0 : INF
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      let v = D[i]
      if (y > 0) {
        v = Math.min(v, D[i - width] + D1)
        if (x > 0) v = Math.min(v, D[i - width - 1] + D2)
        if (x < width - 1) v = Math.min(v, D[i - width + 1] + D2)
      }
      if (x > 0) v = Math.min(v, D[i - 1] + D1)
      D[i] = v
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x
      let v = D[i]
      if (y < height - 1) {
        v = Math.min(v, D[i + width] + D1)
        if (x > 0) v = Math.min(v, D[i + width - 1] + D2)
        if (x < width - 1) v = Math.min(v, D[i + width + 1] + D2)
      }
      if (x < width - 1) v = Math.min(v, D[i + 1] + D1)
      D[i] = v
    }
  }
  return D
}

async function structuralExtend(
  src: Buffer,
  mask: HandwritingMask,
  regionMask: Buffer | null,
  opts: {
    searchRadius?: number
    bg: BackgroundTone
    /**
     * ⭐ 局部底色图（可选，长度 = width*height*3）。存在时优先用它做逐像素底色兜底，
     *    否则退回 `bg` 单色（见 `buildLocalBackgroundMap`）。
     *    为什么必须传进来：`adaptive` 是默认策略，它用本函数的输出**覆盖**压字区；
     *    若兜底仍是全局单色，局部底色的收益会被整片抵消（实测色距 59.28 vs 8.64）。
     */
    bgMap?: Buffer
    criterion?: PrintPixelCriterion
    maxExtend?: number
    lineRatio?: number
    minLineSamples?: number
  },
): Promise<Buffer> {
  const meta = await sharp(src).metadata()
  const width = meta.width!, height = meta.height!
  const { data, info } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const channels = info.channels
  const searchRadius = Math.max(4, opts.searchRadius ?? Math.round(Math.min(width, height) * 0.012))
  /** 远场延拓的最大步幅：默认整幅对角线，保证能跨越任意宽度的遮挡 */
  const maxExtend = Math.max(4, opts.maxExtend ?? Math.max(width, height))
  /** 判定"该行/列存在贯穿线"所需的结构密度（mask 外像素中 structure 的占比） */
  const lineRatio = opts.lineRatio ?? 0.5
  /** 判定贯穿线所需的最小 mask 外像素数（太少则比值不可信） */
  const minLineSamples = Math.max(16, opts.minLineSamples ?? Math.round(Math.min(width, height) * 0.08))

  const maskBuf = await alignMask(mask, width, height)

  // 输出初值 = 底色（找不到结构时就用它）：**局部底色图优先**，否则全局单色
  const bgMap = opts.bgMap && opts.bgMap.length >= width * height * 3 ? opts.bgMap : null
  const out = Buffer.alloc(width * height * channels)
  for (let i = 0; i < width * height; i++) {
    const p = i * channels
    if (bgMap) {
      out[p] = bgMap[i * 3]; out[p + 1] = bgMap[i * 3 + 1]; out[p + 2] = bgMap[i * 3 + 2]
    } else {
      out[p] = opts.bg.r
      out[p + 1] = opts.bg.g
      out[p + 2] = opts.bg.b
    }
  }

  // 源排除区：紧种子（有则用，没有就用整个 mask 兜底 —— 安全方向宁可多排除）
  const exclude = mask.seed && mask.seed.length >= width * height ? mask.seed : maskBuf

  // ⭐⭐ 抗锯齿隔离带（实测暴露的第四个缺陷：**彩色笔残色**）
  //   mask 只圈住笔迹"核心"，而笔迹边缘有 1~3px 的抗锯齿过渡带留在 mask 之外。
  //   对蓝笔 rgb(30,60,190) 混入 <20% 墨色的最外圈像素：
  //       rgb≈(171,180,212) → chroma ≈ 33、luma ≈ 181
  //   这个数**正好落进** DEFAULT_PRINT_CRITERION(chroma≤42, luma≤190) 的"印刷体"区间，
  //   于是被近场延拓当成可信结构搬进填充区 → 擦完残留一圈淡蓝（实测压字区 2.30%）。
  //
  //   对策：mask 外扩 `antialiasBand` 的整条过渡带一律**不算结构**。
  //   方向是"宁可找不到结构退回局部底色，也绝不搬运墨迹"（与紧种子同一原则）。
  //   带宽取 min(w,h)×0.0025（1279×1706 → 3px），只吃掉抗锯齿宽度，
  //   远小于 searchRadius（≈15px），不会让近场搜索整体失效。
  const antialiasBand = Math.max(1, Math.round(Math.min(width, height) * 0.0025))
  const bandDist = chamferDistance(maskBuf, width, height)

  // "可信结构像素"：近灰且足够深的像素（印刷体墨色）
  // ⭐ 且**不在源排除区内** —— 绝不能拿待修复的手写墨迹当参考（见函数头铁律注释）。
  // ⭐⭐ 且**不在抗锯齿隔离带内** —— 见上方事故档案。
  //
  // ⭐⭐ 判据必须与 `classifyMaskRegions` **完全一致**（实测暴露的第二个缺陷）：
  //   上一版这里硬编码 `luma <= 170`，而分类用的 `DEFAULT_PRINT_CRITERION` 是 190。
  //   结果出现自相矛盾 —— 印刷横线 #bbb 的 luma≈187：
  //     分类阶段：187 ≤ 190 → 判为"压字区"，需要结构延拓 ✅
  //     延拓阶段：187 > 170 → 一个"可信结构"都找不到 → 全线退化成底色 ❌
  //   「同一概念（什么是印刷体）在系统里只能有一个定义」，否则两个模块各自漂移，
  //   故障表现是"功能静默降级"，极难排查。现统一走同一个 criterion。
  const criterion = opts.criterion ?? DEFAULT_PRINT_CRITERION
  const isStructure = (i: number) => {
    if (exclude[i] > 127) return false
    if (bandDist[i] <= antialiasBand) return false
    const p = i * channels
    const r = data[p], g = data[p + 1], b = data[p + 2]
    const luma = (r * 299 + g * 587 + b * 114) / 1000
    const chroma = Math.max(r, g, b) - Math.min(r, g, b)
    return chroma <= criterion.chromaMax && luma <= criterion.lumaMax
  }

  // 8 个方向
  const DIRS: Array<[number, number]> = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
  ]

  // ⭐ 预计算「哪些行/列是贯穿线」：统计每行（列）在 **mask 之外** 的像素里
  //   structure 的占比，超过 `lineRatio` 即认为该行（列）存在一条贯穿的线。
  //   这是 O(w*h) 一次性扫描，之后每像素 O(1) 查表，比逐像素远距离搜索快得多。
  //   ⚠️ 必须只看 mask 外的像素：mask 内的结构正是待重建的部分，不能拿来当证据
  //      （否则"手写压在印刷体上"会自证为该行是线）。
  const rowOut = new Int32Array(height)
  const rowHit = new Int32Array(height)
  const colOut = new Int32Array(width)
  const colHit = new Int32Array(width)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const j = y * width + x
      if (maskBuf[j] > 127) continue
      rowOut[y]++; colOut[x]++
      if (isStructure(j)) { rowHit[y]++; colHit[x]++ }
    }
  }
  // 样本太少时比值不稳定，要求至少 minLineSamples 个 mask 外像素
  const rowIsLine = new Uint8Array(height)
  const colIsLine = new Uint8Array(width)
  for (let y = 0; y < height; y++) {
    if (rowOut[y] >= minLineSamples && rowHit[y] / rowOut[y] >= lineRatio) rowIsLine[y] = 1
  }
  for (let x = 0; x < width; x++) {
    if (colOut[x] >= minLineSamples && colHit[x] / colOut[x] >= lineRatio) colIsLine[x] = 1
  }

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

      // ── 近场：沿 8 方向找最近的可信结构像素（半径 searchRadius）────────────
      //    适用：文字笔画、短线等"就在旁边"的结构。按距离加权，近的权重大。
      let wsum = 0, accR = 0, accG = 0, accB = 0
      for (const [dx, dy] of DIRS) {
        for (let step = 1; step <= searchRadius; step++) {
          const nx = x + dx * step, ny = y + dy * step
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) break
          const j = ny * width + nx
          if (!isStructure(j)) continue
          const w = 1 / (1 + step)
          const pj = j * channels
          accR += data[pj] * w; accG += data[pj + 1] * w; accB += data[pj + 2] * w
          wsum += w
          break
        }
      }
      if (wsum > 0) {
        const p = i * channels
        out[p] = Math.round(accR / wsum)
        out[p + 1] = Math.round(accG / wsum)
        out[p + 2] = Math.round(accB / wsum)
        continue
      }

      // ── 线延拓：接回**贯穿型线条**（横线 / 竖线 / 表格线）───────────────
      //    为什么需要这一段（实测暴露的第三个问题）：
      //    只做近场时，"手写盖住横线中段 300px"的接回率只有 **0.71%** ——
      //    搜索半径只有 ~11px，够得着的只有线段两端各 11px，中间全留白。
      //
      //    ⭐ 判据必须用「**同一行/列的连续密度**」，而不是"两端都能看到"：
      //    前一版用「相反两方向都命中且颜色接近」，结果在真实版面上**严重误伤** ——
      //    手写区的上下方都是印刷文字，两端颜色都很深、差值轻易 <24，
      //    于是整块手写区被填成灰色补丁，接缝均值从 0.38 暴涨到 **21.73**。
      //    根因：文字不是线，但"两端都看得到"这个判据区分不了它们。
      //
      //    线的本质是**在同一行（列）上连续**：
      //      · 横线所在行 → 该行在 mask 之外的像素里，structure 占比接近 1；
      //      · 手写所在的空白行 → 占比接近 0。
      //    用这个密度判据即可干净地区分，且是 O(1) 查表，不必远距离搜索。
      if (rowIsLine[y]) {
        const hit = axialAvg(x, y, -1, 0, x, y, 1, 0)
        if (hit) { const p = i * channels; out[p] = hit[0]; out[p + 1] = hit[1]; out[p + 2] = hit[2] }
      } else if (colIsLine[x]) {
        const hit = axialAvg(x, y, 0, -1, x, y, 0, 1)
        if (hit) { const p = i * channels; out[p] = hit[0]; out[p + 1] = hit[1]; out[p + 2] = hit[2] }
      }
    }
  }

  return sharp(out, { raw: { width, height, channels: 3 } }).png().toBuffer()

  /**
   * 沿一对相反的主轴方向各找第一个可信结构像素，按距离加权平均。
   * 找不到（单侧或双侧）就返回 null —— 此时老实留底色。
   */
  function axialAvg(
    x0: number, y0: number, dx1: number, dy1: number,
    x1: number, y1: number, dx2: number, dy2: number,
  ): [number, number, number] | null {
    const a = scan(x0, y0, dx1, dy1)
    const b = scan(x1, y1, dx2, dy2)
    if (!a && !b) return null
    let r = 0, g = 0, bl = 0, w = 0
    if (a) { const wa = 1 / (1 + a.d); r += a.r * wa; g += a.g * wa; bl += a.b * wa; w += wa }
    if (b) { const wb = 1 / (1 + b.d); r += b.r * wb; g += b.g * wb; bl += b.b * wb; w += wb }
    return [Math.round(r / w), Math.round(g / w), Math.round(bl / w)]
  }

  /** 沿单个主轴方向找到第一个可信结构像素（返回其颜色与距离） */
  function scan(x0: number, y0: number, dx: number, dy: number) {
    for (let step = 1; step <= maxExtend; step++) {
      const nx = x0 + dx * step, ny = y0 + dy * step
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) return null
      const j = ny * width + nx
      if (!isStructure(j)) continue
      const pj = j * channels
      return { r: data[pj], g: data[pj + 1], b: data[pj + 2], d: step }
    }
    return null
  }
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
 * ⭐ **P0-6 底色取样铁律**：在 mask 之外的**最亮 10% 像素**上估计纸张底色。
 *
 * ── 为什么不能用"mask 外的全量中位数"（实测事故：输出背景发灰）───────────
 * 真实拍摄永远有照明梯度、纸张自带的暗角、装订阴影、脏污.
 * 这些**暗背景像素不在 mask 内**、数量又巨大，会把全量中位数从真实的纸张白拉向暗侧。
 * 于是填进去的"底色"比纸暗 → 用户看到「擦完的方块发灰 / 像贴了一块补丁」。
 *
 * 对策是**先在非 mask 区内取亮部**（然后对亮部取中位数，保留对残余墨点的免疫），
 * 把光照引起的低频暗衰减排除掉，取到真正的纸面。
 *
 * ⚠️ 份额为什么是 10%（在 45% vignette 的合成图上扫描得出）：
 *        最亮 50% → 色距 28.9 ｜ 20% → 11.6 ｜ **10% → 5.2** ｜ 5% → 3.5 ｜ 2% → 1.7
 *    起点"全量中位数"的色距是 **58.3**，可见主要收益在前 10% 就拿到了；
 *    再往下收紧收益递减，却开始牺牲抗噪性（样本量与单点噪点的主导风险）。
 *
 * ⚠️ 为什么阈值要在**非 mask 区内部**统计亮度分位，而不是用全局常量 200：
 *    全局常量又变回了对纸色的**绝对假设**（见 P0-1 的教训）——纸张泛黄时
 *    "最亮 10%"可能整体低于 200，用常量会一个样本都取不到，退化成死白。
 *
 * ⚠️ 诚实局限：vignette 是**连续**径向衰减，只要取样窗口还有宽度，就一定残留
 *    一点偏差（本例 5.2）。要彻底抹平只能做**局部底色**（按 mask 邻域取色），
 *    那属于 P1 —— 全局底色在"整页光照一致"时已经足够。
 */
export async function estimateBackground(
  src: Buffer,
  mask: HandwritingMask,
): Promise<BackgroundTone> {
  const { data, info } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info

  const maskBuf = await alignMask(mask, width, height)

  // 采样步长：大图上不必逐像素，既省时又不影响中位数稳定性
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 200000)))
  const px: Array<{ r: number; g: number; b: number; l: number }> = []
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = y * width + x
      if (maskBuf[i] > 127) continue
      const p = i * channels
      const r = data[p]
      const g = data[p + 1]
      const b = data[p + 2]
      px.push({ r, g, b, l: 0.299 * r + 0.587 * g + 0.114 * b })
    }
  }
  if (px.length === 0) return { r: 255, g: 255, b: 255, noise: 0 }

  // ① 在**非 mask 区内部**求亮度分位，取最亮 `BRIGHT_SHARE` 作为纸面样本
  //    ⚠️ 份额不是拍脑袋定的：在暗角(45% vignette)合成图上做过敏感度扫描——
  //        最亮 50% → 色距 28.9 ｜ 20% → 11.6 ｜ 10% → 5.2 ｜ 5% → 3.5 ｜ 2% → 1.7
  //    取 **10%**：把色距从 11.6（20% 时）进一步压到 5.2，
  //    又保住充足样本量（即便在下采样采样点上，仍有数以万计的像素参与中位数统计，
  //    不会被个别噪点主导）。比它更严的份额收益递减，却开始牺牲抗噪性。
  const lumas = px.map((o) => o.l).sort((a, b) => a - b)
  const BRIGHT_SHARE = 0.1
  const thr = lumas[Math.max(0, Math.floor(lumas.length * (1 - BRIGHT_SHARE)) - 1)]
  const sample = px.filter((o) => o.l >= thr)
  const use = sample.length > 0 ? sample : px

  const median = (arr: number[]) => {
    const a = arr.slice().sort((x, y) => x - y)
    return a[a.length >> 1]
  }
  const rs = use.map((o) => o.r)
  const gs = use.map((o) => o.g)
  const bs = use.map((o) => o.b)
  const r = median(rs), g = median(gs), b = median(bs)

  // ② 以纸面样本为基准估计高频波动（颗粒强度）。
  //    注意只在**同一批样本**上算，别把阴影的低频起伏算成纸张颗粒 —— 那会让
  //    补出来的区域比周围"脏"。
  let acc = 0
  for (let i = 0; i < use.length; i++) {
    acc += (rs[i] - r) ** 2 + (gs[i] - g) ** 2 + (bs[i] - b) ** 2
  }
  const noise = Math.sqrt(acc / (use.length * 3))
  return { r, g, b, noise }
}

/**
 * ⭐ **局部底色图 v2：归一化卷积 + 迭代墨迹排除**（主流「背景重建」环节的实现）
 *
 * ── v1（归一化判定 + 全局高分位采样）为什么被替换（真卷实测，2026-09-30）────
 * v1 在归一化图上用**全局 85 分位**判定"哪里是纸面"，再回原图取样本中位色。
 * 真卷（1279×1706 拍照试卷）实测：归一化本身拉平良好（页面上/下部 nl 分布一致，
 * p50 都 ≈192），但 thr=196.7 只让每个邻域**最亮的 5~15% 噪点样本**通过判定——
 * 样本系统性偏亮，填充色比邻域真实纸面**亮 8~29 luma**（20 题解答区 +26.6/+28.6）。
 * 暗背景下的亮补丁，就是用户看到的"擦除处灰斑残影"。
 * 教训：**"判定哪里是纸面"这件事本身不可靠**——阈值松了混入墨迹、紧了偏向亮噪点。
 *
 * ── v2 的做法：不判定，直接**加权平均**（normalized convolution）──────────
 *   bg(i) = Σ_j w(j)·src(j) / Σ_j w(j)，j ∈ i 的高斯邻域
 * 权重 w(j) = (1−hole) × paperLike(j)：
 *   · (1−hole)：待重建区自己绝不进统计（修复源只能在已知区——与 inpaint 同一条铁律）；
 *   · paperLike：**相对**该点粗背景的亮度。第一轮全体非 mask 等权求粗背景 bg0，
 *     第二轮 paperLike = clamp((luma − 0.82·bg0)/40, 0, 1)，把明显暗于纸面的墨迹
 *     像素权重压到 0。两轮迭代 = MSFF-Net（IJDAR 2024）「把未擦净残留当噪声
 *     迭代精修」思想在背景重建上的直接落地。
 *
 * ── 为什么它处处匹配局部纸色（含阴影渐变）─────────────────────────────────
 * 高斯权重自适应：mask 区拿到的就是**周围真实纸面的加权平均**——阴影处自然暗、
 * 亮处自然亮，不需要任何"纸面判定"阈值。v1 的"全局阈值+取样"在阴影区失效的
 * 根因（样本偏亮）在这里不存在，因为**没有一个二选一的判定**。
 *
 * ⚠️ fail-open：任何一步失败返回 null，调用方回退 `estimateBackground` 全局底色。
 *
 * @returns 与原图同尺寸的 RGB 底色图；失败返回 null
 */
export async function buildLocalBackgroundMap(
  src: Buffer,
  mask: HandwritingMask,
  _opts: { block?: number; paperQuantile?: number } = {},
): Promise<Buffer | null> {
  try {
    const meta = await sharp(src).metadata()
    const W = meta.width || 0
    const H = meta.height || 0
    if (!W || !H) return null

    const { data: od, info: oi } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const maskBuf = await alignMask(mask, W, H)

    // ── ① 工作尺度（box 下采样，长边 640）：卷积开销与平滑粒度兼得 ──
    const WORK = 640
    const scale = Math.min(1, WORK / Math.max(W, H))
    const w = Math.max(8, Math.round(W * scale))
    const h = Math.max(8, Math.round(H * scale))
    const small = await sharp(od, { raw: { width: W, height: H, channels: 3 } })
      .resize(w, h, { fit: 'fill' })
      .raw()
      .toBuffer()
    // mask 同步下采样：块内 mask 占比 > 0.3 → 整块算待重建
    //（宁保守：绝不让墨迹像素以低权重混进"纸面统计"）
    const maskSmall = await sharp(maskBuf, { raw: { width: W, height: H, channels: 1 } })
      .resize(w, h, { fit: 'fill' })
      .raw()
      .toBuffer()

    const ns = w * h
    const chs: Float32Array[] = [new Float32Array(ns), new Float32Array(ns), new Float32Array(ns)]
    const hole = new Uint8Array(ns)
    const lumaS = new Float32Array(ns)
    for (let i = 0; i < ns; i++) {
      chs[0][i] = small[i * 3]
      chs[1][i] = small[i * 3 + 1]
      chs[2][i] = small[i * 3 + 2]
      hole[i] = maskSmall[i] > 76 ? 1 : 0 // 255×0.3
      lumaS[i] = 0.299 * chs[0][i] + 0.587 * chs[1][i] + 0.114 * chs[2][i]
    }

    // ── ② 两轮归一化卷积 ──
    const sigma = Math.max(8, Math.round(Math.min(w, h) / 32))
    const K = gaussKernel1D(sigma)
    let bgRGB: Float32Array[] | null = null
    for (let round = 0; round < 2; round++) {
      const wt = new Float32Array(ns)
      for (let i = 0; i < ns; i++) {
        if (hole[i]) { wt[i] = 0; continue }
        if (round === 0) { wt[i] = 1; continue }
        // 第二轮：明显暗于粗背景的像素（墨迹）压权重；纸面 ≈1，过渡带软权重
        const bg0 = bgRGB ? 0.299 * bgRGB[0][i] + 0.587 * bgRGB[1][i] + 0.114 * bgRGB[2][i] : 190
        wt[i] = Math.min(1, Math.max(0, (lumaS[i] - 0.82 * bg0) / 40))
      }
      // 分子 = conv(src·w)，分母 = conv(w)：权重在求和号内，可分离卷积两趟完成
      const den = normConvolve1(wt, w, h, K)
      const num = chs.map((c) => normConvolve1(c, w, h, K, wt))
      const fallbackRGB = bgRGB
      if (!fallbackRGB) {
        const g = await estimateBackground(src, mask)
        for (let i = 0; i < ns; i++) {
          if (den[i] < 1e-4) {
            for (let c = 0; c < 3; c++) num[c][i] = [g.r, g.g, g.b][c]
          } else {
            for (let c = 0; c < 3; c++) num[c][i] /= den[i]
          }
        }
      } else {
        for (let i = 0; i < ns; i++) {
          if (den[i] < 1e-4) {
            for (let c = 0; c < 3; c++) num[c][i] = fallbackRGB[c][i]
          } else {
            for (let c = 0; c < 3; c++) num[c][i] /= den[i]
          }
        }
      }
      bgRGB = num
    }

    // ── ③ 上采样回原图（双线性）→ RGB 底色图 ──
    const flat = Buffer.alloc(ns * 3)
    for (let i = 0; i < ns; i++) {
      flat[i * 3] = Math.max(0, Math.min(255, Math.round(bgRGB![0][i])))
      flat[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(bgRGB![1][i])))
      flat[i * 3 + 2] = Math.max(0, Math.min(255, Math.round(bgRGB![2][i])))
    }
    return await sharp(flat, { raw: { width: w, height: h, channels: 3 } })
      .resize(W, H, { fit: 'fill' })
      .raw()
      .toBuffer()
  } catch (e) {
    console.warn('[mask] 局部底色估计失败，回退全局底色：', e instanceof Error ? e.message : e)
    return null
  }
}

/** 一维高斯核（已归一化） */
function gaussKernel1D(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 2))
  const k = new Float32Array(2 * r + 1)
  let s = 0
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma))
    k[i + r] = v
    s += v
  }
  for (let i = 0; i < k.length; i++) k[i] /= s
  return k
}

/**
 * 可分离卷积的单通道 pass（横向再纵向），边缘 clamp。
 * `srcWt` 提供时先把输入逐点乘以权重（归一化卷积的分子 conv(src·w)）；
 * 之所以手写而不用 sharp.blur：这里要做的是 **加权** 卷积（分子分母同卷），
 * sharp 的 blur 无法携带逐像素权重。
 */
function normConvolve1(
  src: Float32Array,
  w: number,
  h: number,
  K: Float32Array,
  srcWt?: Float32Array,
): Float32Array {
  let input = src
  if (srcWt) {
    input = new Float32Array(src.length)
    for (let i = 0; i < src.length; i++) input[i] = src[i] * srcWt[i]
  }
  const r = (K.length - 1) / 2
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  // 横向
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let k = -r; k <= r; k++) {
        let xx = x + k
        if (xx < 0) xx = 0
        else if (xx >= w) xx = w - 1
        acc += input[row + xx] * K[k + r]
      }
      tmp[row + x] = acc
    }
  }
  // 纵向
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let k = -r; k <= r; k++) {
        let yy = y + k
        if (yy < 0) yy = 0
        else if (yy >= h) yy = h - 1
        acc += tmp[yy * w + x] * K[k + r]
      }
      out[y * w + x] = acc
    }
  }
  return out
}

/**
 * 背景填充：用底色整块铺进 mask 区域，
 * 并叠加一点与底色同量级的随机颗粒，避免出现"纯色方块"的突兀感。
 */
export async function fillWithBackground(src: Buffer, mask: HandwritingMask): Promise<Buffer> {
  const meta = await sharp(src).metadata()
  const width = meta.width!, height = meta.height!
  const bg = await estimateBackground(src, mask)
  // ⭐ 局部底色图（归一化识别纸面 + 分块取色）；不可用时回退全局单色（fail-open）
  const local = await buildLocalBackgroundMap(src, mask)

  const maskBuf = await alignMask(mask, width, height)

  // 用确定性伪随机（种子固定）生成颗粒，保证结果可复现
  let seed = 0x9e3779b9
  const rand = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
    return ((seed >>> 0) % 1000) / 1000
  }

  // 底图：局部底色图（可用时，逐块匹配局部光照）或全局单色（回退）
  const base = Buffer.alloc(width * height * 3)
  if (local && local.length === width * height * 3) {
    local.copy(base)
  } else {
    for (let i = 0; i < width * height; i++) {
      base[i * 3] = bg.r
      base[i * 3 + 1] = bg.g
      base[i * 3 + 2] = bg.b
    }
  }
  const basePng = await sharp(base, { raw: { width, height, channels: 3 } }).png().toBuffer()

  // 底图叠颗粒（颗粒叠加在**已局部化的底色**上，幅度沿用全局噪声估计）
  const grain = Buffer.alloc(width * height * 3)
  const amp = Math.min(6, Math.max(0, bg.noise * 0.5))
  for (let i = 0; i < width * height; i++) {
    const d = Math.round((rand() - 0.5) * 2 * amp)
    grain[i * 3] = Math.max(0, Math.min(255, base[i * 3] + d))
    grain[i * 3 + 1] = Math.max(0, Math.min(255, base[i * 3 + 1] + d))
    grain[i * 3 + 2] = Math.max(0, Math.min(255, base[i * 3 + 2] + d))
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

  const maskBuf = await alignMask(mask, width, height)

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
  opts: { block?: number; ring?: number; printThreshold?: number; criterion?: PrintPixelCriterion } = {},
): Promise<Buffer> {
  // ① 底色
  const bg = await estimateBackground(src, mask)
  // ⭐ 局部底色图：让"结构延拓"的底色兜底同样匹配局部光照。
  //    adaptive 是默认策略，缺了这一步局部底色的收益会被压字区覆盖抵消（实测 59.28 → 8.6x）。
  const bgMap = (await buildLocalBackgroundMap(src, mask)) ?? undefined

  // ② 区域分类（与 ④ 的延拓共用同一套"什么是印刷体"判据，见 structuralExtend 注释）
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
  const extended = await structuralExtend(src, mask, rmask, { bg, bgMap, criterion: opts.criterion })

  // 在 base 上，把"压字区且属于 mask"的像素替换为 extended 的结果
  const baseRaw = await sharp(base).removeAlpha().raw().toBuffer()
  const extRaw = await sharp(extended).removeAlpha().raw().toBuffer()
  const maskBuf = await alignMask(mask, width, height)
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
  const maskBuf = await alignMask(mask, width, height)

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
  const maskBuf = await alignMask(mask, width, height)

  for (let i = 0, p = 0; i < maskBuf.length; i++, p += channels) {
    // ⭐ 口径 = mask==0 的**硬外区**（P0-6 铁律的本意："不该动的一个像素都不能动"）。
    //    旧口径 mask≤127 会把羽化过渡带算进"非 mask 区"——但软边本就是 mask 的
    //    组成部分（output = inpainted*(1-m)+original*m，m 小 → 几乎全为原图，
    //    承担防硬边接缝的过渡功能，ComfyUI FeatherMask 等领域做法一致）。
    //    实测真卷：硬外区 100.0000% 一致（0 像素变化）；按旧口径统计则被
    //    3873 个软边过渡像素拉到 99.81%，纯属统计误报。
    if (maskBuf[i] > 0) continue // mask 区（含软边）跳过——那里本来就该变
    sampled++
    const dr = Math.abs(a.data[p] - b[p])
    const dg = Math.abs(a.data[p + 1] - b[p + 1])
    const db = Math.abs(a.data[p + 2] - b[p + 2])
    // 容差 2/255，容忍编码往返误差
    if (dr <= 2 && dg <= 2 && db <= 2) same++
  }

  return { similarity: sampled ? same / sampled : 1, sampled }
}
