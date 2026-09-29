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
  source: 'vlm' | 'threshold' | 'manual'
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
function maxFilterU8(src: Buffer | Uint8Array, w: number, h: number, r: number): Buffer {
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
  const rowRatio = opts.rowRatio ?? 1.5
  const densityMax = opts.densityMax ?? 0.55
  const baseModeMin = opts.baseModeMin ?? 0.575
  const minChars = Math.max(3, opts.minChars ?? 4)
  const glyphQuantile = opts.glyphQuantile ?? 0.3
  const gapMerge = opts.gapMerge ?? 6
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
      while (x <= xmax && x < w) {
        let cc = 0
        for (let y = r.y0; y < r.y1; y++) if (ink[y * w + x]) cc++
        if (cc === 0) break
        x++
      }
      // 该字符块的底边（最下方的墨迹行）
      let bot = -1
      for (let y = r.y1 - 1; y >= r.y0; y--) {
        let hit = false
        for (let xx = x0; xx < x; xx++) if (ink[y * w + xx]) { hit = true; break }
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

  for (const r of rows) {
    const rh = r.y1 - r.y0
    if (rh < rowLimit) continue
    rowTall++
    const { density, xmin, xmax } = rowInkDensity(ink, w, r)
    tallDensities.push(density)

    // 主判据：基线众数占比 ≥ baseModeMin → 印刷体（基线对齐 = 排版特征）
    const bm = baselineModeShare(r, xmin, xmax)
    tallBaselines.push(bm)
    if (bm >= baseModeMin) { rowBaselineBlocked++; continue }
    // 兜底：密度异常高（如整块涂黑、非文字图块）才拦，阈值刻意放得很宽，
    //       绝不让它在正常模糊范围内误伤手写 —— 见函数头对密度判据的否决记录。
    if (density > densityMax) { rowDensityBlocked++; continue }
    for (let y = r.y0; y < r.y1; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (!ink[i]) continue
        seed[i] = 255
        seedCount++
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
async function structuralExtend(
  src: Buffer,
  mask: HandwritingMask,
  regionMask: Buffer | null,
  opts: {
    searchRadius?: number
    bg: BackgroundTone
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

  // 输出初值 = 底色（找不到结构时就用它）
  const out = Buffer.alloc(width * height * channels)
  for (let i = 0; i < width * height; i++) {
    out[i * channels] = opts.bg.r
    out[i * channels + 1] = opts.bg.g
    out[i * channels + 2] = opts.bg.b
  }

  // 源排除区：紧种子（有则用，没有就用整个 mask 兜底 —— 安全方向宁可多排除）
  const exclude = mask.seed && mask.seed.length >= width * height ? mask.seed : maskBuf

  // "可信结构像素"：近灰且足够深的像素（印刷体墨色）
  // ⭐ 且**不在源排除区内** —— 绝不能拿待修复的手写墨迹当参考（见函数头铁律注释）。
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
 * 背景填充：用 estimateBackground 得到的底色整块铺进 mask 区域，
 * 并叠加一点与底色同量级的随机颗粒，避免出现"纯色方块"的突兀感。
 */
async function fillWithBackground(src: Buffer, mask: HandwritingMask): Promise<Buffer> {
  const meta = await sharp(src).metadata()
  const width = meta.width!, height = meta.height!
  const bg = await estimateBackground(src, mask)

  const maskBuf = await alignMask(mask, width, height)

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
  const extended = await structuralExtend(src, mask, rmask, { bg, criterion: opts.criterion })

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
