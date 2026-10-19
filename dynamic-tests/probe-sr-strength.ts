/**
 * 探针：量化不同锐化/对比度参数下「智能高清」相对「纯 Lanczos 放大」的差异与锐度增益。
 * 目标：找到一个「明显可感知、又不会因过锐产生振铃」的档位。
 * 运行：cd push-ready/server && npx tsx /workspace/dynamic-tests/probe-sr-strength.ts
 */
import sharp from 'sharp'
import { enhanceImage } from '../push-ready/server/src/image/image-superres'

const W = 800, H = 1000
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#fdfdfa"/>
  ${Array.from({ length: 12 }, (_, i) =>
    `<text x="70" y="${110 + i * 72}" font-family="serif" font-size="26" fill="#111">` +
    `第 ${i + 1} 题：已知函数 f(x)=ax²+bx+c，求其在区间 [0,3] 上的最大值与最小值。` +
    `</text>`).join('')}
</svg>`

async function sharpness(buf: Buffer): Promise<number> {
  const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true })
  const ch = Math.max(1, Math.round(data.length / (info.width * info.height)))
  let e = 0
  for (let y = 1; y < info.height - 1; y++) {
    for (let x = 1; x < info.width - 1; x++) {
      const i = y * info.width + x
      const gx = data[i * ch] - data[(i - 1) * ch]
      const gy = data[i * ch] - data[(i - info.width) * ch]
      e += Math.abs(gx) + Math.abs(gy)
    }
  }
  return e / ((info.width - 2) * (info.height - 2))
}

async function mad(a: Buffer, b: Buffer): Promise<number> {
  const A = await sharp(a).greyscale().raw().toBuffer()
  const B = await sharp(b).greyscale().raw().toBuffer()
  const chA = Math.max(1, Math.round(A.length / (W * 2 * H * 2)))
  const chB = Math.max(1, Math.round(B.length / (W * 2 * H * 2)))
  const n = W * 2 * H * 2
  let s = 0
  for (let i = 0; i < n; i++) s += Math.abs(A[i * chA] - B[i * chB])
  return s / n
}

async function main() {
  // 模拟"拍照模糊"：先轻微模糊再当输入，更贴近真实场景
  const src = await sharp(Buffer.from(svg)).blur(1.1).jpeg({ quality: 92 }).toBuffer()
  const base = await sharp(src).resize(W * 2, H * 2, { kernel: 'lanczos3' }).jpeg({ quality: 95 }).toBuffer()
  const baseS = await sharpness(base)
  console.log(`基准：纯 Lanczos 放大 锐度=${baseS.toFixed(3)}\n`)

  for (const sh of [0.6, 0.9, 1.2, 1.6, 2.0]) {
    const r = await enhanceImage(src, { scale: 2, mode: 'classical', sharpen: sh })
    const s = await sharpness(r.buffer)
    const d = await mad(base, r.buffer)
    console.log(`sharpen=${sh.toFixed(1)} → 锐度 ${s.toFixed(3)} (增益 ${(((s - baseS) / baseS) * 100).toFixed(1)}%)  相对纯放大 MAD=${d.toFixed(2)}`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
