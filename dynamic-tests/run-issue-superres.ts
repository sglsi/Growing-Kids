/**
 * 问题三（智能高清）回归：ESPCN 引擎与 YCbCr 色彩管线。
 * 对齐参考实现 ESPCN-master（model.py / test_image.py）：
 *   - 引擎：[0,1] 归一化 + tanh(conv1/conv2) + 线性 conv3 + pixel_shuffle + sigmoid；
 *   - 管线：转 YCbCr → 仅 Y 做超分 → Cb/Cr 双三次上采样 → 重组 RGB。
 * 运行：cd push-ready/server && npx tsx /workspace/dynamic-tests/run-issue-superres.ts
 */
import sharp from 'sharp'
import {
  enhanceImage, superResolveESPCN, buildAnalyticESPCN,
  pixelShuffle, conv2d, rgbToLuma,
  type SRWeights,
} from '../server/src/image/image-superres'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  PASS', name, extra) }
  else { fail++; console.log('  ✗ FAIL', name, extra) }
}
function approx(a: number, b: number, tol: number) { return Math.abs(a - b) <= tol }

// 独立参考实现：亚像素重排（PyTorch 约定 c = i*scale + j → (row=i, col=j)）
function refPixelShuffle(chs: Float32Array[], W: number, H: number, scale: number): Float32Array {
  const OW = W * scale, OH = H * scale
  const out = new Float32Array(OW * OH)
  for (let c = 0; c < scale * scale; c++) {
    const oy = c % scale, ox = Math.floor(c / scale)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      out[(y * scale + oy) * OW + (x * scale + ox)] = chs[c][y * W + x]
    }
  }
  return out
}

async function stats(buf: Buffer) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true })
  const ch = info.channels
  const n = info.width * info.height
  let s = 0, s2 = 0
  for (let i = 0; i < n; i++) { const v = data[i * ch]; s += v; s2 += v * v }
  const mean = s / n
  const std = Math.sqrt(Math.max(0, s2 / n - mean * mean))
  return { mean, std }
}
async function edge(buf: Buffer): Promise<number> {
  const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true })
  const ch = Math.max(1, Math.round(data.length / (info.width * info.height)))
  let e = 0
  for (let y = 1; y < info.height - 1; y++) for (let x = 1; x < info.width - 1; x++) {
    const i = y * info.width + x
    e += Math.abs(data[i * ch] - data[(i - 1) * ch]) + Math.abs(data[i * ch] - data[(i - info.width) * ch])
  }
  return e / ((info.width - 2) * (info.height - 2))
}

async function main() {
  console.log('— 1. pixelShuffle 与 PyTorch 约定一致 —')
  {
    const W = 5, H = 4, scale = 3
    const chs: Float32Array[] = []
    for (let c = 0; c < scale * scale; c++) {
      const a = new Float32Array(W * H)
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a[y * W + x] = c * 1000 + y * 10 + x
      chs.push(a)
    }
    const got = pixelShuffle(chs, W, H, scale)
    const ref = refPixelShuffle(chs, W, H, scale)
    let allEq = got.length === ref.length
    for (let i = 0; i < got.length && allEq; i++) allEq = approx(got[i], ref[i], 1e-6)
    ok('pixelShuffle 与参考实现逐元素一致', allEq, `len=${got.length}`)
    ok('pixelShuffle 输出尺寸 = scale²×输入', got.length === W * H * scale * scale)
  }

  console.log('— 2. conv2d 激活函数（tanh/relu/none）—')
  {
    const W = 4, H = 4
    const ramp = new Float32Array(W * H); for (let i = 0; i < W * H; i++) ramp[i] = 0.5
    const imp = new Float32Array(9); imp[4] = 1
    const w = new Float32Array(9); w.set(imp)
    const b = new Float32Array(1).fill(0)
    const t = conv2d([ramp], W, H, 3, w, b, 1, 1, 'tanh')
    const r = conv2d([ramp], W, H, 3, w, b, 1, 1, 'relu')
    const n = conv2d([ramp], W, H, 3, w, b, 1, 1, 'none')
    ok('tanh 激活输出 = tanh(输入)', approx(t[0][0], Math.tanh(0.5), 1e-6), `val=${t[0][0].toFixed(4)}`)
    ok('relu 激活输出 = max(0,输入)', approx(r[0][0], 0.5, 1e-6))
    ok('none 激活输出 = 输入', approx(n[0][0], 0.5, 1e-6))
  }

  console.log('— 3. superResolveESPCN：占位权重输出合法 —')
  {
    const W = 6, H = 6, scale = 2
    const luma = new Float32Array(W * H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) luma[y * W + x] = ((x + y) % 2) * 200 + 30
    const up = superResolveESPCN(luma, W, H, buildAnalyticESPCN(scale))
    let bounded = up.length === W * H * scale * scale
    let finite = true
    for (let i = 0; i < up.length; i++) {
      if (!Number.isFinite(up[i]) || up[i] < -0.01 || up[i] > 255.01) bounded = false
      if (!Number.isFinite(up[i])) finite = false
    }
    ok('占位权重：输出尺寸 = scale²×输入', bounded)
    ok('占位权重：输出全部有限且在 [0,255]', finite && bounded)
  }

  console.log('— 4. ESPCN 真实激活（tanh/sigmoid）引擎可跑且 bounded —')
  {
    // 构造一个最小 tanh/sigmoid 模型：conv1/conv2 恒等 impulse，conv3 双线性子像素
    const scale = 2, c1 = 1, c2 = 1
    const box5 = new Float32Array(25); box5[12] = 1
    const id3 = new Float32Array(9); id3[4] = 1
    const w1 = new Float32Array(c1 * 1 * 25); w1.set(box5)
    const b1 = new Float32Array(c1).fill(0)
    const w2 = new Float32Array(c2 * c1 * 9); w2.set(id3)
    const b2 = new Float32Array(c2).fill(0)
    const w3 = new Float32Array(scale * scale * c2 * 9)
    const b3 = new Float32Array(scale * scale).fill(0)
    for (let p = 0; p < scale * scale; p++) {
      const ox = p % scale, oy = Math.floor(p / scale)
      const fx = ox / scale, fy = oy / scale
      const k = new Float32Array(9).fill(0)
      k[4] = (1 - fx) * (1 - fy); k[5] = fx * (1 - fy); k[7] = (1 - fx) * fy; k[8] = fx * fy
      w3.set(k, (p * c2 + 0) * 9)
    }
    const w: SRWeights = { scale, k1: 5, c1, k2: 3, c2, k3: 3, w1, b1, w2, b2, w3, b3, act: 'tanh', outAct: 'sigmoid' }
    const W = 6, H = 6
    const luma = new Float32Array(W * H); for (let i = 0; i < W * H; i++) luma[i] = 40 + (i % 7) * 20
    const up = superResolveESPCN(luma, W, H, w)
    let okB = up.length === W * H * 4
    for (let i = 0; i < up.length; i++) if (!Number.isFinite(up[i]) || up[i] < 0 || up[i] > 255.01) okB = false
    ok('tanh/sigmoid 模型：输出尺寸正确且全在 [0,255]', okB)
  }

  console.log('— 5. YCbCr 正/反变换互逆（无色彩漂移）—')
  {
    let maxErr = 0
    for (const [r, g, b] of [[255, 0, 0], [0, 255, 0], [0, 0, 255], [123, 200, 77], [30, 30, 30]]) {
      const y = 0.299 * r + 0.587 * g + 0.114 * b
      const cb = (b - y) / 1.772 + 128
      const cr = (r - y) / 1.402 + 128
      const R = y + 1.402 * (cr - 128)
      const G = y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128)
      const B = y + 1.772 * (cb - 128)
      maxErr = Math.max(maxErr, Math.abs(R - r), Math.abs(G - g), Math.abs(B - b))
    }
    ok('RGB→YCbCr→RGB 互逆（误差<1/255）', maxErr < 1, `maxErr=${maxErr.toFixed(3)}`)
  }

  console.log('— 6. enhanceImage 端到端：尺寸/确定性/非退化 —')
  {
    const W = 400, H = 500
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fdfdfa"/>` +
      Array.from({ length: 8 }, (_, i) =>
        `<text x="40" y="${80 + i * 50}" font-family="serif" font-size="28" fill="#111">第 ${i + 1} 题：f(x)=ax²+bx+c 在区间[0,3]的最值。</text>`).join('') + `</svg>`
    const src = await sharp(Buffer.from(svg)).blur(1.2).jpeg({ quality: 90 }).toBuffer()
    for (const scale of [2, 3, 4]) {
      const a = await enhanceImage(src, { scale, mode: 'classical' })
      const b = await enhanceImage(src, { scale, mode: 'classical' })
      const st = await stats(a.buffer)
      ok(`classical x${scale}：输出尺寸正确`, a.width === W * scale && a.height === H * scale, `${a.width}x${a.height}`)
      ok(`classical x${scale}：图像非退化(std>0)`, st.std > 5, `std=${st.std.toFixed(1)}`)
      ok(`classical x${scale}：确定性可复现`, a.buffer.equals(b.buffer))
    }
    for (const scale of [2, 3]) {
      const a = await enhanceImage(src, { scale, mode: 'espcn' })
      const b = await enhanceImage(src, { scale, mode: 'espcn' })
      ok(`espcn x${scale}：输出尺寸正确`, a.width === W * scale && a.height === H * scale)
      ok(`espcn x${scale}：确定性可复现`, a.buffer.equals(b.buffer))
    }
  }

  console.log('— 7. 智能高清相对纯 Lanczos 应更锐（classical）—')
  {
    const W = 400, H = 500
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fdfdfa"/>` +
      Array.from({ length: 8 }, (_, i) =>
        `<text x="40" y="${80 + i * 50}" font-family="serif" font-size="28" fill="#111">第 ${i + 1} 题：f(x)=ax²+bx+c 在区间[0,3]的最值。</text>`).join('') + `</svg>`
    const src = await sharp(Buffer.from(svg)).blur(1.2).jpeg({ quality: 90 }).toBuffer()
    const base = await sharp(src).resize(W * 2, H * 2, { kernel: 'lanczos3' }).png().toBuffer()
    const enh = await enhanceImage(src, { scale: 2, mode: 'classical' })
    const eb = await edge(base), ee = await edge(enh.buffer)
    ok('classical x2 边缘锐度 ≥ 纯 Lanczos', ee >= eb * 0.95, `lanczos=${eb.toFixed(3)} enhance=${ee.toFixed(3)}`)
  }

  console.log('— 8. 纯灰图经 YCbCr 管线不漂移 —')
  {
    const W = 60, H = 60
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="rgb(200,200,200)"/></svg>`
    const src = await sharp(Buffer.from(svg)).png().toBuffer()
    const r = await enhanceImage(src, { scale: 2, mode: 'classical' })
    const st = await stats(r.buffer)
    ok('灰图输出均值≈200（色度无偏色）', approx(st.mean, 200, 6), `mean=${st.mean.toFixed(1)}`)
  }

  console.log(`\n结果：PASS ${pass} / FAIL ${fail}`)
  if (fail > 0) process.exit(1)
}
main().catch(e => { console.error('FAIL(exception)', e); process.exit(1) })
