import sharp from 'sharp'

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
  /** 升采样倍率，默认 2（ESPCN 原论文 x2/x3/x4） */
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
}

export interface SRResult {
  buffer: Buffer
  width: number
  height: number
  mode: SRMode
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
          const sx = Math.min(Math.max(x + kx - half, 0), W - 1)
          const sy = Math.min(Math.max(y + ky - half, 0), H - 1)
          acc += src[sy * W + sx] * kernel[ky * ksize + kx]
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
): Float32Array[] {
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
              const sx = Math.min(Math.max(x + kx - half, 0), W - 1)
              const sy = Math.min(Math.max(y + ky - half, 0), H - 1)
              acc += inputs[i][sy * W + sx] * kernel[ky * ksize + kx]
            }
          }
          ch[base] += acc
        }
      }
    }
    for (let p = 0; p < ch.length; p++) ch[p] = Math.max(0, ch[p] + biases[o]) // ReLU
    out.push(ch)
  }
  return out
}

/** 亚像素重排：scale² 个 W×H 通道 → 1 个 (scaleW)×(scaleH) 通道。 */
export function pixelShuffle(
  chs: Float32Array[], W: number, H: number, scale: number,
): Float32Array {
  const OW = W * scale, OH = H * scale
  const out = new Float32Array(OW * OH)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < scale * scale; c++) {
        const oy = y * scale + (c % scale)
        const ox = x * scale + Math.floor(c / scale)
        out[oy * OW + ox] = chs[c][y * W + x]
      }
    }
  }
  return out
}

export interface SRWeights {
  scale: number
  // 卷积配置
  k1: number; c1: number // conv1: 5x5, in=1, out=c1
  k2: number; c2: number // conv2: 3x3, in=c1, out=c2
  k3: number             // conv3: 3x3, in=c2, out=scale²
  w1: Float32Array; b1: Float32Array
  w2: Float32Array; b2: Float32Array
  w3: Float32Array; b3: Float32Array
}

/**
 * 解析 ESPCN-x2 权重（smoke-test 用，无需下载）。
 * 设计：conv1/conv2 近似把亮度透传到 4 个特征图（带轻微 5x5 平滑），
 * conv3 的 4 个输出通道对应 2x2 子像素位置，做「最近邻上采样 + 轻度非锐化」，
 * 让引擎跑通且产出可用的 x2 放大。生产环境应用 loadESPCNWeights 替换为真·学习权重。
 */
export function buildAnalyticESPCN(scale = 2): SRWeights {
  const c1 = 4, c2 = 4
  // conv1：近似「恒等透传」亮度（5x5 仅中心=1），避免解析权重过度平滑丢失笔画高频；
  // 真实 ESPCN 此处应是学习到的特征提取核，生产环境由 loadESPCNWeights 替换。
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
  // 仅用 ci=0（亮度通道，conv1/conv2 已近似透传）做双线性子像素采样 + 轻度非锐化，
  // 其余 ci 权重为 0 —— 避免把 4 个相同特征通道相加导致 4× 过曝。
  const w3 = new Float32Array(scale * scale * c2 * 9)
  const b3 = new Float32Array(scale * scale).fill(0)
  // 3x3 扁平索引：4=(x,y) 5=(x+1,y) 7=(x,y+1) 8=(x+1,y+1)
  for (let p = 0; p < scale * scale; p++) {
    const ox = p % scale, oy = Math.floor(p / scale)
    const fx = ox / scale, fy = oy / scale // 子像素在 2x 块内的分数偏移
    const wx0 = 1 - fx, wx1 = fx, wy0 = 1 - fy, wy1 = fy
    const k = new Float32Array(9).fill(0)
    k[4] = wx0 * wy0; k[5] = wx1 * wy0; k[7] = wx0 * wy1; k[8] = wx1 * wy1 // 双线性
    const boost = 0.08 // 轻度非锐化：中心增益，邻点回吐，保持和=1
    k[4] += boost
    k[1] -= boost * 0.25; k[3] -= boost * 0.25; k[5] -= boost * 0.25; k[7] -= boost * 0.25
    w3.set(k, (p * c2 + 0) * 9) // 仅 ci=0
  }
  return { scale, k1: 5, c1, k2: 3, c2, k3: 3, w1, b1, w2, b2, w3, b3 }
}

/** 从 JSON 加载真·ESPCN 权重（生产环境，虚拟主机有网络时）。 */
export async function loadESPCNWeights(url: string): Promise<SRWeights> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`加载 ESPCN 权重失败 HTTP ${res.status}`)
  const j = (await res.json()) as any
  const mk = (a: number[]) => Float32Array.from(a)
  return {
    scale: j.scale,
    k1: j.k1, c1: j.c1, k2: j.k2, c2: j.c2, k3: j.k3,
    w1: mk(j.w1), b1: mk(j.b1), w2: mk(j.w2), b2: mk(j.b2), w3: mk(j.w3), b3: mk(j.b3),
  }
}

/** ESPCN 前向：亮度 → 升采样亮度（Float32, 0..255）。 */
export function superResolveESPCN(
  luma: Float32Array, W: number, H: number, w: SRWeights,
): Float32Array {
  const s1 = conv2d([luma], W, H, w.k1, w.w1, w.b1, w.c1, 1)
  const s2 = conv2d(s1, W, H, w.k2, w.w2, w.b2, w.c2, w.c1)
  const s3 = conv2d(s2, W, H, w.k3, w.w3, w.b3, w.scale * w.scale, w.c2)
  const up = pixelShuffle(s3, W, H, w.scale)
  for (let i = 0; i < up.length; i++) up[i] = Math.min(255, Math.max(0, up[i]))
  return up
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
 * 升采样亮度走 SR 引擎/经典管线，色度走 Lanczos（文字场景色度细节无关紧要），
 * 重组回 RGB 后编码。
 */
export async function enhanceImage(buf: Buffer, opts: SROptions = {}): Promise<SRResult> {
  const scale = opts.scale ?? 2
  const mode: SRMode = (opts.mode ?? 'classical').toLowerCase() === 'espcn' ? 'espcn' : 'classical'
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const W = info.width, H = info.height, ch = info.channels

  // 提取亮度
  const luma = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) {
    const r = data[i * ch], g = data[i * ch + 1], b = data[i * ch + 2]
    luma[i] = rgbToLuma(r, g, b)
  }

  let lumaUp: Float32Array
  if (mode === 'espcn') {
    let weights = opts.weights
    if (!weights && opts.weightsUrl) weights = await loadESPCNWeights(opts.weightsUrl)
    if (!weights) weights = buildAnalyticESPCN(scale)
    lumaUp = superResolveESPCN(luma, W, H, weights)
  } else {
    lumaUp = await classicalUpscale(luma, W, H, scale, opts)
  }

  // 色度：整图 Lanczos 升采样到目标尺寸
  const tW = W * scale, tH = H * scale
  const up = await sharp(buf).resize(tW, tH, { kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const out = Buffer.alloc(tW * tH * up.info.channels)
  const och = up.info.channels
  for (let i = 0; i < tW * tH; i++) {
    const r = up.data[i * och], g = up.data[i * och + 1], b = up.data[i * och + 2]
    // 当前像素 YCbCr（标准 BT.601，Cb/Cr 去归一化以便精确反算）
    const Y0 = rgbToLuma(r, g, b)
    const CbC = (b - Y0) / 1.772
    const CrC = (r - Y0) / 1.402
    // 用 SR 亮度替换 Y，重组回 RGB（反变换精确，rgbToLuma(输出) ≡ Yn）
    const Yn = lumaUp[i]
    let R = Yn + 1.402 * CrC
    let G = Yn - 0.344136 * CbC - 0.714136 * CrC
    let B = Yn + 1.772 * CbC
    out[i * och] = Math.min(255, Math.max(0, R))
    out[i * och + 1] = Math.min(255, Math.max(0, G))
    out[i * och + 2] = Math.min(255, Math.max(0, B))
    if (och === 4) out[i * och + 3] = up.data[i * och + 3]
  }

  const buffer = await sharp(out, { raw: { width: tW, height: tH, channels: och } }).png().toBuffer()
  return { buffer, width: tW, height: tH, mode }
}
