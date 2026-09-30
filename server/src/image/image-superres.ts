import sharp from 'sharp'
import {
  enhanceDocumentLuma,
  normalizeBackgroundLuma,
  scaleMetrics,
  tuningFor,
  type EnhancePreset,
  type EnhanceStrength,
} from './image-doc-enhance'
import { estimateCharMetricsFromLuma, type CharMetrics } from './image-layout'

/**
 * Phase 2 智能高清（Super-Resolution）核心。
 *
 * 设计对齐《自动调正与智能高清重构方案》§3（CPU-only 虚拟主机前提）：
 *  - 重型 GAN（Real-ESRGAN）不可作 CPU 主引擎；轻量 SR（ESPCN/FSRCNN）可行。
 *  - 本模块提供两条路径，共用 enhanceImage 接口：
 *      1) mode='classical'（默认，零权重）：Lanczos 升采样 + 边缘感知 unsharp + 轻量去噪。
 *         对文档文字最稳、最快、无外部依赖，离线即可运行。
 *      2) mode='espcn'：真实 ESPCN 前向推理（conv2d + ReLU + 像素重排 pixel-shuffle）。
 *         默认用 buildAnalyticESPCN 生成的「解析权重」（smoke-test 用，跑通引擎）；
 *         生产可在有网络的虚拟主机上置 ESPCN_WEIGHTS_URL 加载真·学习权重，
 *         引擎与接口完全不变（loadESPCNWeights）。
 *
 * 与几何纠偏一致的工程原则：像素级处理、CPU、依赖仅 sharp 做 I/O。
 */

export type SRMode = 'classical' | 'espcn'

export interface SROptions {
  /**
   * 高清扩展升采样倍率（X2/X3/X4）。彩色类模式（enhance/brighten/gray）默认 2；
   * **黑白模式固定为 1（不超分）**——二值图超分只是对 0/255 插值，徒增体积与耗时。
   * 见《智能高清-方法论》§P2：高清扩展是"可选清晰度增强"，与基础增强（背景归一化+对比增强）正交。
   */
  scale?: number
  /** 'classical' | 'espcn'，默认 classical */
  mode?: SRMode
  /** espcn 模式下的解析/学习权重；缺省时按 mode 取 analytic 或尝试 URL */
  weights?: SRWeights
  /** 真·ESPCN 权重 JSON 地址（生产环境有网络时填），加载后覆盖解析权重 */
  weightsUrl?: string
  /** 非锐化强度（classical），默认 0.6 */
  sharpen?: number
  /** 是否做轻量中值去噪（classical），默认 true */
  denoise?: boolean
  /**
   * classical 路径是否用 libvips 原生锐化（fast=true，默认，CPU 上快得多）；
   * false 则走 JS 边缘感知非锐化（慢，留作质量对比）。
   */
  fast?: boolean
  /**
   * 【P1 多模式输出】original（原样）/ enhance（默认，彩色增强）/ bw（黑白硬二值化）/
   * brighten（增亮）/ gray（去色增强，保留灰阶）。对齐扫描全能王的五种模式设计（方案 §P1）。
   * 单图入口 enhanceImage 用 preset 选定其一；并列入口 enhanceImageModes 一次性产出全部五种。
   */
  preset?: EnhancePreset
  /**
   * 【P1 强度档位】weak / medium（默认）/ strong。
   * 存在理由：避免"算法觉得好看、用户觉得过头"——把最终把控权交给用户（方案 §P1）。
   */
  strength?: EnhanceStrength
  /**
   * 置 true 时跳过整条文档增强管线，退化为旧行为（仅超分 + 固定 sigma 锐化）。
   * 仅用于 A/B 对照与问题排查，生产不要开。
   */
  legacy?: boolean
}

export interface SRResult {
  buffer: Buffer
  width: number
  height: number
  mode: SRMode
  /** P1 输出模式（回显给调用方，便于日志与前端展示） */
  preset?: EnhancePreset
  /** 文档增强过程诊断（字高 / 窗口 / 版面保护块数 / 各环节耗时） */
  debug?: Record<string, unknown>
}

/* ============================ 颜色工具 ============================ */

/** RGB(A) → 亮度 Y（Rec.601），范围 0..255 */
export function rgbToLuma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/* ====================== ESPCN 引擎原语（纯 JS） ====================== */

/** 单通道 2D 卷积，'same' 反射填充，ksize 为奇数。 */
export function conv2dSingle(
  src: Float32Array, W: number, H: number,
  ksize: number, kernel: Float32Array, bias = 0,
): Float32Array {
  const half = (ksize - 1) >> 1
  const out = new Float32Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let acc = bias
      for (let ky = 0; ky < ksize; ky++) {
        for (let kx = 0; kx < ksize; kx++) {
          // 零填充（zero-padding），对齐 TensorFlow 的 SAME 卷积约定；
          // 边缘复制会在边界引入与训练图不一致的偏差。
          const sx = x + kx - half
          const sy = y + ky - half
          if (sx >= 0 && sx < W && sy >= 0 && sy < H) {
            acc += src[sy * W + sx] * kernel[ky * ksize + kx]
          }
        }
      }
      out[y * W + x] = acc
    }
  }
  return out
}

/**
 * 多通道卷积：[inC] 个 W×H → [outC] 个 W×H。
 * weights 布局：((o*inC + i)*ksize + ky)*ksize + kx
 */
export function conv2d(
  inputs: Float32Array[], W: number, H: number,
  ksize: number, weights: Float32Array, biases: Float32Array,
  outC: number, inC: number,
  act: SRSAct = 'relu',
): Float32Array[] {
  const fn =
    act === 'tanh' ? Math.tanh
    : act === 'relu' ? (x: number) => Math.max(0, x)
    : (x: number) => x
  const out: Float32Array[] = []
  for (let o = 0; o < outC; o++) {
    const ch = new Float32Array(W * H)
    for (let i = 0; i < inC; i++) {
      const half = (ksize - 1) >> 1
      const koff = (o * inC + i) * ksize * ksize
      const kernel = weights.subarray(koff, koff + ksize * ksize)
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          let acc = 0
          const base = y * W + x
      for (let ky = 0; ky < ksize; ky++) {
        for (let kx = 0; kx < ksize; kx++) {
          // 零填充，对齐 TF SAME 卷积（见 conv2dSingle 注释）
          const sx = x + kx - half
          const sy = y + ky - half
          if (sx >= 0 && sx < W && sy >= 0 && sy < H) {
            acc += inputs[i][sy * W + sx] * kernel[ky * ksize + kx]
          }
        }
      }
          ch[base] += acc
        }
      }
    }
    for (let p = 0; p < ch.length; p++) ch[p] = fn(ch[p] + biases[o])
    out.push(ch)
  }
  return out
}

/**
 * 亚像素重排：scale² 个 W×H 通道 → 1 个 (scaleW)×(scaleH) 通道。
 * 顺序严格对齐 TensorFlow 的 tf.nn.depth_to_space（NHWC, block_size=scale）：
 *   输出子位置 (oy, ox) 取自通道 c = oy*scale + ox，即 oy=⌊c/scale⌋, ox=c%scale。
 * （早期实现写成 oy=c%scale / ox=⌊c/scale⌋，把横纵子位置对调，导致 scale=2 时全盘错位。）
 */
export function pixelShuffle(
  chs: Float32Array[], W: number, H: number, scale: number,
): Float32Array {
  const OW = W * scale, OH = H * scale
  const out = new Float32Array(OW * OH)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < scale * scale; c++) {
        const oy = y * scale + Math.floor(c / scale)
        const ox = x * scale + (c % scale)
        out[oy * OW + ox] = chs[c][y * W + x]
      }
    }
  }
  return out
}

/**
 * 隐藏层激活。注意：本项目实际部署的训练权重（来自 ESPCN 冻结图，conv_espcn_xN.pb）
 * 其 conv1/conv2 用的是 ReLU（与“原论文用 tanh”不同），conv3 为线性。
 * 故真实权重 JSON 里 act='relu'；占位解析权重用 'none'。
 */
export type SRSAct = 'tanh' | 'relu' | 'none'
/** 输出激活。本项目真实权重用 tanh（输出 ∈[-1,1]，再 ×255 还原灰度），不是 sigmoid。 */
export type SRSOutAct = 'sigmoid' | 'relu' | 'tanh' | 'none'

export type SRFamily = 'espcn' | 'classic' | 'tatt' | 'real-esrgan'

export interface SRWeights {
  scale: number
  // 卷积配置
  k1: number; c1: number // conv1: 5x5, in=1, out=c1
  k2: number; c2: number // conv2: 3x3, in=c1, out=c2
  k3: number             // conv3: 3x3, in=c2, out=scale²
  w1: Float32Array; b1: Float32Array
  w2: Float32Array; b2: Float32Array
  w3: Float32Array; b3: Float32Array
  /**
   * 隐藏层激活。本项目真实训练权重（conv_espcn_xN.pb）conv1/conv2 用 'relu'、conv3 线性（'none'）；
   * 占位解析权重（buildAnalyticESPCN）用 'none' 以保证无学习权重时仍是可用上采样。
   * 注意：原作者论文用 tanh，但本项目实际权重是 ReLU，转换脚本据此写 act='relu'。
   */
  act?: SRSAct
  outAct?: SRSOutAct
  /**
   * 输入归一化与输出反归一化（适配不同训练约定）。
   * 本项目真实权重（已数值验证，combo C 胜出）的约定：
   *   lin = luma * inScale + inShift        （inScale=1/255, inShift=0 → 输入 Y/255 ∈ [0,1]）
   *   pixel = act_out * outScale + outShift （outAct='tanh', outScale=255, outShift=0 → tanh×255）
   * 转换脚本 convert_espcn_pb.py 已据此写出 inScale/outScale/outShift，无需手动调整。
   * （历史上曾误用 ESPCN-master 的 [-1,1] 约定 inScale=1/127.5/inShift=-1；对当前 .pb 已排除。）
   */
  inScale?: number
  inShift?: number
  outScale?: number
  outShift?: number
  /**
   * 高清扩展引擎族（P2 可插拔化）。决定 `runSREngine` 走哪个前向：
   *   · 'espcn'   经典 ESPCN 三层卷积（真·学习权重，或解析退化权重）
   *   · 'classic' 解析退化权重（双线性 + 轻锐化，等价于经典上采样）
   *   · 'tatt' / 'real-esrgan' 为 **P2 中期接入点**，需加载对应预训练权重（权重文件应携带 `family` 字段）
   */
  family?: SRFamily
}

/**
 * 解析 ESPCN 权重（smoke-test 用，无需下载）。
 *
 * 与真实 ESPCN 保持同一结构（仅 Y 通道 + 子像素重排），但：
 *   - 激活用 'none'（线性）：无学习权重时退化为「双线性子像素上采样 + 轻度非锐化」，
 *     仍是可用上采样，避免 tanh/sigmoid 在无权重时把图像洗白；
 *   - 真实权重经 ESPCN_WEIGHTS_URL 载入（loadESPCNWeights）后，引擎按论文的
 *     tanh/sigmoid 激活在 [0,1] 归一化空间运行（见 superResolveESPCN）。
 * 真实 ESPCN 架构为 conv1 1→64(5×5)、conv2 64→32(3×3)、conv3 32→scale²(3×3)，
 * 此处 c1=c2=4 仅为占位，载入真实权重时由 w1..w3 张量尺寸决定通道数。
 */
export function buildAnalyticESPCN(scale = 2): SRWeights {
  const c1 = 4, c2 = 4
  // conv1：近似「恒等透传」亮度（5x5 仅中心=1）
  const box5 = new Float32Array(25); box5[12] = 1
  const w1 = new Float32Array(c1 * 1 * 25)
  const b1 = new Float32Array(c1).fill(0)
  for (let o = 0; o < c1; o++) w1.set(box5, o * 25)

  // conv2：1x1 风格（3x3 仅中心为 1）把 4 通道透传到 4 通道
  const id3 = new Float32Array(9); id3[4] = 1
  const w2 = new Float32Array(c2 * c1 * 9)
  const b2 = new Float32Array(c2).fill(0)
  for (let o = 0; o < c2; o++) for (let i = 0; i < c1; i++) {
    if (o === i) w2.set(id3, (o * c1 + i) * 9)
  }

  // conv3：scale² 个输出，每个对应一个子像素位置 (ox,oy)∈{0..scale-1}²。
  // 仅用 ci=0（亮度通道）做双线性子像素采样 + 轻度非锐化，其余 ci 权重为 0。
  const w3 = new Float32Array(scale * scale * c2 * 9)
  const b3 = new Float32Array(scale * scale).fill(0)
  // 3x3 扁平索引：4=(x,y) 5=(x+1,y) 7=(x,y+1) 8=(x+1,y+1)
  for (let p = 0; p < scale * scale; p++) {
    const ox = p % scale, oy = Math.floor(p / scale)
    const fx = ox / scale, fy = oy / scale // 子像素在 scale× 块内的分数偏移
    const wx0 = 1 - fx, wx1 = fx, wy0 = 1 - fy, wy1 = fy
    const k = new Float32Array(9).fill(0)
    k[4] = wx0 * wy0; k[5] = wx1 * wy0; k[7] = wx0 * wy1; k[8] = wx1 * wy1 // 双线性
    const boost = 0.08 // 轻度非锐化：中心增益，邻点回吐，保持和=1
    k[4] += boost
    k[1] -= boost * 0.25; k[3] -= boost * 0.25; k[5] -= boost * 0.25; k[7] -= boost * 0.25
    w3.set(k, (p * c2 + 0) * 9) // 仅 ci=0
  }
  return { scale, k1: 5, c1, k2: 3, c2, k3: 3, w1, b1, w2, b2, w3, b3, act: 'none', outAct: 'none', family: 'classic' }
}

/**
 * 权重缓存：真·权重 JSON 约 0.5MB（含 Float32Array 转换），每次请求重新加载
 * 会显著拖慢 enhance。同一 url/路径只解析一次，进程内复用。
 */
const espcnWeightCache = new Map<string, SRWeights>()

/**
 * 从 JSON 加载真·ESPCN 权重。
 *
 * 支持三种来源（自动识别）：
 *  - `http(s)://...`：远程/对象存储/CDN；
 *  - `file:///abs/path.json`：本地文件；
 *  - `/abs/path.json` 或 `./rel/path.json`：本地文件（相对 process.cwd()）。
 * 本机部署时直接放磁盘即可，无需额外起静态服务。
 */
export async function loadESPCNWeights(url: string): Promise<SRWeights> {
  const cached = espcnWeightCache.get(url)
  if (cached) return cached

  let j: any
  if (/^https?:\/\//i.test(url)) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`加载 ESPCN 权重失败 HTTP ${res.status}`)
    j = (await res.json()) as any
  } else {
    const p = url.startsWith('file://') ? url.slice('file://'.length) : url
    const { readFile } = await import('node:fs/promises')
    j = JSON.parse(await readFile(p, 'utf8'))
  }

  const mk = (a: number[]) => Float32Array.from(a)
  const w: SRWeights = {
    scale: j.scale,
    k1: j.k1, c1: j.c1, k2: j.k2, c2: j.c2, k3: j.k3,
    w1: mk(j.w1), b1: mk(j.b1), w2: mk(j.w2), b2: mk(j.b2), w3: mk(j.w3), b3: mk(j.b3),
    act: j.act, outAct: j.outAct, family: j.family ?? 'espcn',
    inScale: j.inScale, inShift: j.inShift, outScale: j.outScale, outShift: j.outShift,
  }
  espcnWeightCache.set(url, w)
  return w
}

/**
 * ESPCN 前向：亮度(0..255) → 升采样亮度(0..255)。
 *
 * 数值约定（与本项目真实训练权重 conv_espcn_xN.pb 逐位对齐，已数值验证）：
 *   - 输入 Y 归一化到 [0,1]：lin = Y/255（inScale=1/255, inShift=0）；
 *   - conv1/conv2 走 ReLU，conv3 为线性；
 *   - pixel_shuffle 后过 Tanh（输出 ∈[-1,1]），再 ×255 还原灰度并裁剪到 [0,255]。
 * 占位解析权重（act/outAct='none'）则退化为可用上采样。
 * 注：ESPCN 原论文用 tanh+sigmoid，但本项目实际部署权重是 ReLU+Tanh，故以权重 JSON 字段为准。
 */
export function superResolveESPCN(
  luma: Float32Array, W: number, H: number, w: SRWeights,
): Float32Array {
  const n = W * H
  const inScale = w.inScale ?? 1 / 255
  const inShift = w.inShift ?? 0
  const lin = new Float32Array(n)
  for (let i = 0; i < n; i++) lin[i] = luma[i] * inScale + inShift
  const act = w.act ?? 'tanh'
  const s1 = conv2d([lin], W, H, w.k1, w.w1, w.b1, w.c1, 1, act)
  const s2 = conv2d(s1, W, H, w.k2, w.w2, w.b2, w.c2, w.c1, act)
  const s3 = conv2d(s2, W, H, w.k3, w.w3, w.b3, w.scale * w.scale, w.c2, 'none')
  const up = pixelShuffle(s3, W, H, w.scale)
  const outAct = w.outAct ?? 'sigmoid'
  const outScale = w.outScale ?? 255
  const outShift = w.outShift ?? 0
  const out = new Float32Array(up.length)
  for (let i = 0; i < up.length; i++) {
    let v = up[i]
    if (outAct === 'sigmoid') v = 1 / (1 + Math.exp(-v))
    else if (outAct === 'relu') v = Math.max(0, v)
    else if (outAct === 'tanh') v = Math.tanh(v)
    out[i] = Math.min(255, Math.max(0, v * outScale + outShift))
  }
  return out
}

/**
 * 高清扩展统一分发入口（P2 可插拔地基）。
 * 按 `weights.family` 选择前向引擎；当前支持 `espcn` / `classic`（解析退化权重），
 * `tatt` / `real-esrgan` 为 **P2 中期接入点**——需加载对应预训练权重并实现前向，
 * 当前未实现时给出明确错误（而非静默退化成错误结果）。
 */
export function runSREngine(w: SRWeights, luma: Float32Array, W: number, H: number): Float32Array {
  const fam = w.family ?? 'espcn'
  if (fam === 'tatt' || fam === 'real-esrgan') {
    throw new Error(
      `高清扩展引擎 '${fam}' 尚未接入：P2 中期需加载对应预训练权重并在 runSREngine 实现前向（见《智能高清-方法论》§P2）`,
    )
  }
  return superResolveESPCN(luma, W, H, w)
}

/* ====================== 经典路径（默认，零权重） ====================== */

function median3(src: Float32Array, W: number, H: number): Float32Array {
  const out = new Float32Array(W * H)
  const win: number[] = []
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      win.length = 0
      for (let ky = -1; ky <= 1; ky++) for (let kx = -1; kx <= 1; kx++) {
        const sx = Math.min(Math.max(x + kx, 0), W - 1)
        const sy = Math.min(Math.max(y + ky, 0), H - 1)
        win.push(src[sy * W + sx])
      }
      win.sort((a, b) => a - b)
      out[y * W + x] = win[4]
    }
  }
  return out
}

function gaussian3(src: Float32Array, W: number, H: number): Float32Array {
  // 3x3 可分离高斯（σ≈1）
  const k = [1, 2, 1]
  const tmp = new Float32Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a = 0
    for (let kx = -1; kx <= 1; kx++) {
      const sx = Math.min(Math.max(x + kx, 0), W - 1)
      a += src[y * W + sx] * k[kx + 1]
    }
    tmp[y * W + x] = a
  }
  const out = new Float32Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a = 0
    for (let ky = -1; ky <= 1; ky++) {
      const sy = Math.min(Math.max(y + ky, 0), H - 1)
      a += tmp[sy * W + x] * k[ky + 1]
    }
    out[y * W + x] = a / 16
  }
  return out
}

/**
 * 经典智能高清：
 *   1) Lanczos 升采样（走 sharp/libvips 原生 SIMD，CPU 上比纯 JS 快 ~17×）；
 *   2) 锐化：默认 `fast=true` 时用 libvips 的 `sharpen()`（原生实现，微秒级）；
 *      需要「边缘感知 + 精确控制」时置 `fast=false` 走 JS 非锐化（较慢，留作质量对比）。
 * 返回语义不变：升采样后的亮度 Float32（tW×tH）。
 *
 * ⚠️ 性能教训（Phase 2 压测）：纯 JS 的 conv/高斯循环在 1 核虚拟主机上极慢
 *    （1600x1200 x2 时 ESPCN 前向 ~2.9s），必须把可原生的部分交给 libvips。
 */
async function classicalUpscale(
  luma: Float32Array, W: number, H: number, scale: number, opts: SROptions,
): Promise<Float32Array> {
  const tW = W * scale, tH = H * scale
  const lumaBytes = Uint8Array.from(luma, (v) => Math.min(255, Math.max(0, v)))
  // 升采样（原生 SIMD）。libvips 会把单通道提升为多通道，故显式取回单通道。
  let pipe = sharp(lumaBytes, { raw: { width: W, height: H, channels: 1 } })
    .resize(tW, tH, { kernel: 'lanczos3' })
  if (opts.denoise === true) pipe = pipe.median(3) // 原生中值去噪（可选）
  // 原生非锐化（fast 路径，默认）：libvips sharpen 对灰度图无通道耦合问题
  if (opts.fast !== false) {
    const strength = Math.min(4, Math.max(0, (opts.sharpen ?? 0.9) * 3)) // 0..4 强度档
    if (strength > 0) {
      pipe = pipe.sharpen({ sigma: 1.4, m1: 0, m2: strength, x1: 2, y2: 10, y3: 20 })
    }
    const buf = await pipe.raw().toBuffer()
    const ch = (buf.length / (tW * tH)) | 0 || 1
    const f = new Float32Array(tW * tH)
    for (let i = 0; i < tW * tH; i++) f[i] = buf[i * ch]
    return f
  }
  // 精确 JS 路径（慢，留作质量对比）：边缘感知非锐化
  const up = await pipe.raw().toBuffer()
  const ch = (up.length / (tW * tH)) | 0 || 1
  const f0 = new Float32Array(tW * tH)
  for (let i = 0; i < tW * tH; i++) f0[i] = up[i * ch]
  const blurred = gaussian3(f0, tW, tH)
  const strength = opts.sharpen ?? 0.9
  for (let i = 0; i < f0.length; i++) {
    const diff = f0[i] - blurred[i]
    const edge = Math.min(1, Math.abs(diff) / 16)
    f0[i] = Math.min(255, Math.max(0, f0[i] + strength * edge * diff))
  }
  return f0
}

/* ============================ 顶层编排 ============================ */

/**
 * 智能高清主入口（进程内 CPU 推理，无外部模型服务）。
 *
 * ── 管线（方案 §四「总体管线」的程序化落地）─────────────────────────────────
 * ```
 *   RGB → YCbCr
 *     ① P0-1 背景归一化      （原尺度；低频 → 工作图降采样做）
 *     ② 超分辨率              （ESPCN / classical Lanczos，色度双三次）
 *     ③ P0-4 自适应参数       （字符度量按倍率换算到超分尺度）
 *     ④ P0-5 版面感知         （图形/插图/表格线保护区）
 *     ⑤ P0-2 局部对比软增强   （Sauvola 软映射，积分图 O(1)）
 *     ⑥ P0.5 自适应锐化       （sigma ≈ 笔画宽/2 + 梯度软门控）
 *     ⑦ P1 硬二值化           （仅 bw 模式）
 *   → 重组 RGB
 * ```
 *
 * **顺序理由**（每一条都对应方案里的一句约束）：
 *  · ① 在最前：它削的是低频背景，先做才不会干扰后续笔画级高频处理；
 *    若在超分之后做，等于让超分先把阴影梯度插值放大了一遍。
 *  · ② → ⑤：硬映射会永久损失灰阶，之后再超分没有意义（方案原话）。
 *  · ⑤ → ⑥：见 `adaptiveSharpen` 的顺序说明（增强后边缘更陡，门控更准，
 *    且锐化的小过冲不会被随后的对比拉伸再放大一次）。
 *  · ⑦ 永远最后。
 *
 * 转 YCbCr 本身对齐 ESPCN 参考实现（test_image.py）：仅亮度走增强，色度廉价上采样。
 * 这是 ESPCN「人眼对亮度最敏感」的精髓，也保证**增强不引入色偏**。
 */
/** 枚举防御：直接调用路径（脚本/测试/新入口）不该被拼错的枚举带偏，非法值落回默认 */
function normalizePreset(p?: EnhancePreset): EnhancePreset {
  return p === 'original' || p === 'enhance' || p === 'bw' || p === 'brighten' || p === 'gray'
    ? p
    : 'enhance'
}
function normalizeStrength(s?: EnhanceStrength): EnhanceStrength {
  return s === 'weak' || s === 'strong' ? s : 'medium'
}
function normalizeMode(o?: SRMode): SRMode {
  return o === 'espcn' ? 'espcn' : 'classical'
}

interface EnhanceCtx {
  rawBuf: Buffer
  W: number
  H: number
  tW: number
  tH: number
  scale: number
  mode: SRMode
  legacy: boolean
  lumaUp: Float32Array
  /** 原分辨率归一化亮度（超分前）。黑白模式二值化直接用此，避免对二值图做无意义的超分插值 */
  lumaBase: Float32Array
  cbUp: Buffer
  crUp: Buffer
  metricsUp?: CharMetrics
  /** 原分辨率字符度量（未 scale）。黑白模式用原分辨率渲染时传此，避免膨胀/去噪阈值被 scale 放大 */
  metrics0?: CharMetrics
  debug: Record<string, unknown>
}

/**
 * 共享预处理：YCbCr 分离 → 字符度量 → 背景归一化(超分前，一次) → 超分(一次) → 色度上采样(一次)。
 * 五模式只在这一步之后分叉，背景归一化与超分不重复计算。
 */
async function prepareEnhanceContext(buf: Buffer, opts: SROptions): Promise<EnhanceCtx> {
  const strength = normalizeStrength(opts.strength)
  const mode = normalizeMode(opts.mode)
  const legacy = opts.legacy === true
  const scale = opts.scale ?? 2

  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const W = info.width, H = info.height, ch = info.channels

  const Y = new Float32Array(W * H)
  const Cb = new Float32Array(W * H)
  const Cr = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) {
    const r = data[i * ch], g = data[i * ch + 1], b = data[i * ch + 2]
    const y = 0.299 * r + 0.587 * g + 0.114 * b
    Y[i] = y
    Cb[i] = (b - y) / 1.772 + 128
    Cr[i] = (r - y) / 1.402 + 128
  }

  const debug: Record<string, unknown> = { mode, scale }
  let metrics0: CharMetrics | undefined
  if (!legacy) {
    const t = Date.now()
    metrics0 = estimateCharMetricsFromLuma(Y, W, H)
    debug.msMetrics = Date.now() - t
  }

  const tW = W * scale, tH = H * scale
  let Yn: Float32Array = Y
  if (!legacy && metrics0) {
    const tuning = tuningFor(strength)
    const t = Date.now()
    Yn = await normalizeBackgroundLuma(Y, W, H, {
      medH: metrics0.medH > 0 ? metrics0.medH : 14,
      flatten: tuning.flatten,
      inkIsDark: metrics0.inkIsDark,
      levelStretch: tuning.levelStretch,
    })
    debug.msNormalizePrefill = Date.now() - t
  }

  let lumaUp: Float32Array
  if (scale === 1) {
    lumaUp = Float32Array.from(Yn)
  } else if (mode === 'espcn') {
    let weights = opts.weights
    if (!weights && opts.weightsUrl) weights = await loadESPCNWeights(opts.weightsUrl)
    if (!weights) weights = buildAnalyticESPCN(scale)
    lumaUp = runSREngine(weights, Yn, W, H)
  } else {
    lumaUp = await classicalUpscale(Yn, W, H, scale, legacy ? opts : { ...opts, sharpen: 0 })
  }

  const cbBytes = Uint8Array.from(Cb, (v) => Math.min(255, Math.max(0, Math.round(v))))
  const crBytes = Uint8Array.from(Cr, (v) => Math.min(255, Math.max(0, Math.round(v))))
  const upChroma = (bytes: Uint8Array) =>
    sharp(bytes, { raw: { width: W, height: H, channels: 1 } })
      .toColourspace('b-w')
      .resize(tW, tH, { kernel: 'cubic' })
      .raw()
      .toBuffer()
  const cbUp = await upChroma(cbBytes)
  const crUp = await upChroma(crBytes)

  const metricsUp = metrics0 && metrics0.medH > 0 ? scaleMetrics(metrics0, scale) : undefined
  return { rawBuf: buf, W, H, tW, tH, scale, mode, legacy, lumaUp, lumaBase: Yn, cbUp, crUp, metricsUp, metrics0, debug }
}

/** YCbCr → RGB 重组（灰度类预设中性化色度），输出 PNG */
async function recombineToPng(
  luma: Float32Array,
  tW: number,
  tH: number,
  neutral: boolean,
  cbUp: Buffer,
  crUp: Buffer,
): Promise<Buffer> {
  const n = tW * tH
  const out = Buffer.alloc(n * 4)
  for (let i = 0; i < n; i++) {
    const y = luma[i]
    const cb = neutral ? 0 : cbUp[i] - 128
    const cr = neutral ? 0 : crUp[i] - 128
    const R = y + 1.402 * cr
    const G = y - 0.344136 * cb - 0.714136 * cr
    const B = y + 1.772 * cb
    out[i * 4] = Math.min(255, Math.max(0, R))
    out[i * 4 + 1] = Math.min(255, Math.max(0, G))
    out[i * 4 + 2] = Math.min(255, Math.max(0, B))
    out[i * 4 + 3] = 255
  }
  return sharp(out, { raw: { width: tW, height: tH, channels: 4 } }).png().toBuffer()
}

/** 单预设渲染：原图直出，其余在共享 lumaUp 上做文档增强并重组 RGB */
async function renderPreset(
  ctx: EnhanceCtx,
  preset: EnhancePreset,
  strength: EnhanceStrength,
  debug?: Record<string, unknown>,
): Promise<Buffer> {
  if (preset === 'original') return sharp(ctx.rawBuf).png().toBuffer()
  // 黑白模式在「原分辨率」(scale=1) 直接二值化：二值图超分只是对 0/255 插值，徒增体积、拖慢速度，
  // 且扫描王自身输出也低于原图分辨率。neutral=true 时 recombine 不读 cbUp/crUp，故无尺寸冲突。
  const useBase = preset === 'bw' && ctx.scale > 1
  const luma = useBase ? ctx.lumaBase : ctx.lumaUp
  const w = useBase ? ctx.W : ctx.tW
  const h = useBase ? ctx.H : ctx.tH
  const metrics = useBase ? ctx.metrics0 : ctx.metricsUp
  const r = await enhanceDocumentLuma(luma, w, h, {
    preset,
    strength,
    metrics,
    preNormalized: true,
    debug: debug ?? {},
  })
  const neutral = preset === 'bw' || preset === 'gray'
  return recombineToPng(r.luma, w, h, neutral, ctx.cbUp, ctx.crUp)
}

export async function enhanceImage(buf: Buffer, opts: SROptions = {}): Promise<SRResult> {
  const preset = normalizePreset(opts.preset)
  // 「原图」模式：一步不动，直接回原图（保真场景，方案 P1 模式之一）。
  if (preset === 'original') {
    const meta = await sharp(buf).metadata()
    const buffer = await sharp(buf).png().toBuffer()
    return {
      buffer,
      width: meta.width || 0,
      height: meta.height || 0,
      mode: normalizeMode(opts.mode),
      preset,
      debug: { preset, stage: 'original', note: '未做任何像素改动' },
    }
  }
  // 黑白模式不超分：二值图超分无意义，强制原分辨率输出（更小体积、更快、效果一致）。
  const effScale = preset === 'bw' ? 1 : opts.scale
  const ctx = await prepareEnhanceContext(buf, { ...opts, scale: effScale })
  const buffer = await renderPreset(ctx, preset, normalizeStrength(opts.strength), ctx.debug)
  return { buffer, width: ctx.tW, height: ctx.tH, mode: ctx.mode, preset, debug: ctx.debug }
}

export interface SRModesResult {
  /** 五模式并列输出（均为 PNG Buffer） */
  modes: {
    original: Buffer
    enhance: Buffer
    bw: Buffer
    brighten: Buffer
    gray: Buffer
  }
  /** 处理后尺寸（original 为原图尺寸，可能不同） */
  width: number
  height: number
  debug: Record<string, unknown>
}

/**
 * 【P1 多模式并列输出入口】一次性产出 原图 / 增强 / 黑白 / 增亮 / 灰度 五种结果。
 *
 * 设计要点（见《智能高清-方法论》§P1）：
 *  · 背景归一化与超分（ESPCN）只对归一化后的亮度做**一次**，五模式共享；
 *    各模式仅在「对比增强 / 锐化 / 二值化 / 提亮」这一步分叉，成本可控。
 *  · 默认 scale=1（轻量预览）；要最终画质可传 scale=2，彩色类模式做超分。
 *    黑白模式无论 scale 多少都固定原分辨率输出（二值图不超分，见 renderPreset）。
 *  · 模式语义：
 *      original 原样直出 | enhance 彩色增强(默认) | bw 黑白硬二值 | brighten 增亮 | gray 去色增强(留灰阶)
 *  · 前端拿到后可并列渲染缩略图，让用户挑最满意的一张（提升满意度 / 粘性）。
 */
export async function enhanceImageModes(buf: Buffer, opts: SROptions = {}): Promise<SRModesResult> {
  const strength = normalizeStrength(opts.strength)
  const scale = opts.scale ?? 1
  const ctx = await prepareEnhanceContext(buf, { ...opts, scale })
  const modes = {
    original: await renderPreset(ctx, 'original', strength),
    enhance: await renderPreset(ctx, 'enhance', strength),
    bw: await renderPreset(ctx, 'bw', strength),
    brighten: await renderPreset(ctx, 'brighten', strength),
    gray: await renderPreset(ctx, 'gray', strength),
  }
  return { modes, width: ctx.tW, height: ctx.tH, debug: ctx.debug }
}

