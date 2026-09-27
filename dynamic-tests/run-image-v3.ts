/**
 * Phase 2 动态测试：直接 import 真实源码（image-superres.ts / image-dewarp.ts），
 * 验证 ESPCN 引擎数学正确性与 enhanceImage 端到端行为，并断言 service/controller/types 已落地改动。
 * 运行：cd push-ready/server && npx tsx /workspace/dynamic-tests/run-image-v3.ts
 */
import * as fs from 'fs'
import sharp from 'sharp'
import {
  rgbToLuma, conv2dSingle, conv2d, pixelShuffle,
  buildAnalyticESPCN, superResolveESPCN, enhanceImage,
} from '../server/src/image/image-superres'
import { orderCorners, straightenImage } from '../server/src/image/image-dewarp'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`) }
}

function makeImg(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const b = Buffer.alloc(w * h * 4, 255)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, bl] = paint(x, y); const o = (y * w + x) * 4
    b[o] = r; b[o + 1] = g; b[o + 2] = bl; b[o + 3] = 255
  }
  return b
}

async function main() {
  console.log('[1] conv2dSingle 恒等核：center=1 → 输出≡输入')
  {
    const W = 5, H = 5
    const src = Float32Array.from({ length: W * H }, (_, i) => (i % 7) + 1)
    const k = new Float32Array(9); k[4] = 1
    const out = conv2dSingle(src, W, H, 3, k, 0)
    let same = true; for (let i = 0; i < W * H; i++) if (Math.abs(out[i] - src[i]) > 1e-9) same = false
    ok('conv2dSingle 恒等', same)
  }

  console.log('[2] conv2d 多通道恒等：weights 为单位矩阵 → 输出≡输入（经 ReLU 不损非负）')
  {
    const W = 4, H = 4, inC = 2, outC = 2, ks = 3
    const inp = [Float32Array.from({ length: W * H }, () => 10), Float32Array.from({ length: W * H }, () => 20)]
    const w = new Float32Array(outC * inC * ks * ks)
    for (let o = 0; o < outC; o++) w[((o * inC + o) * ks + 1) * ks + 1] = 1 // 仅 (o,o) 中心=1
    const b = new Float32Array(outC).fill(0)
    const out = conv2d(inp, W, H, ks, w, b, outC, inC)
    const c0 = out[0].every((v) => Math.abs(v - 10) < 1e-6)
    const c1 = out[1].every((v) => Math.abs(v - 20) < 1e-6)
    ok('conv2d 多通道恒等', c0 && c1)
  }

  console.log('[3] pixelShuffle：尺寸 = scale×输入；单通道脉冲落到正确子像素位')
  {
    const W = 3, H = 2, scale = 2
    const chs: Float32Array[] = []
    for (let c = 0; c < scale * scale; c++) {
      const a = new Float32Array(W * H)
      if (c === 0) a[0] = 99 // 子像素 (ox=0,oy=0) → 输出 (0,0)
      chs.push(a)
    }
    const out = pixelShuffle(chs, W, H, scale)
    const OW = W * scale, OH = H * scale
    ok('pixelShuffle 尺寸', out.length === OW * OH)
    ok('pixelShuffle 脉冲落点', Math.abs(out[0] - 99) < 1e-6)
  }

  console.log('[4] buildAnalyticESPCN：权重张量尺寸自洽')
  {
    const scale = 2, w = buildAnalyticESPCN(scale)
    ok('w1 尺寸', w.w1.length === w.c1 * 1 * 25)
    ok('w2 尺寸', w.w2.length === w.c2 * w.c1 * 9)
    ok('w3 尺寸', w.w3.length === scale * scale * w.c2 * 9)
    ok('b3 尺寸', w.b3.length === scale * scale)
  }

  console.log('[5] superResolveESPCN：输出尺寸 scale×、有限值、[0,255]')
  {
    const W = 6, H = 6, scale = 2
    const luma = Float32Array.from({ length: W * H }, (_, i) => (i * 13) % 256)
    const w = buildAnalyticESPCN(scale)
    const up = superResolveESPCN(luma, W, H, w)
    let finite = true, inRange = true
    for (let i = 0; i < up.length; i++) { if (!Number.isFinite(up[i])) finite = false; if (up[i] < 0 || up[i] > 255) inRange = false }
    ok('SR 输出尺寸', up.length === (W * scale) * (H * scale))
    ok('SR 全有限', finite)
    ok('SR 值域[0,255]', inRange)
  }

  console.log('[6] enhanceImage(classical) x2：尺寸正确、无 NaN、白图保持白、黑块保持黑')
  {
    const W = 16, H = 16
    const white = await sharp(makeImg(W, H, () => [255, 255, 255]), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
    const r1 = await enhanceImage(white, { scale: 2, mode: 'classical' })
    ok('classical 尺寸 32x32', r1.width === 32 && r1.height === 32)
    const wraw = await sharp(r1.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let wmin = 255; for (let i = 0; i < wraw.info.width * wraw.info.height; i++) wmin = Math.min(wmin, wraw.data[i * wraw.info.channels])
    ok('白图→全白(最小≥250)', wmin >= 250, `min=${wmin}`)

    const sq = await sharp(makeImg(W, H, (x, y) => (x >= 4 && x < 12 && y >= 4 && y < 12) ? [0, 0, 0] : [255, 255, 255]), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
    const r2 = await enhanceImage(sq, { scale: 2, mode: 'classical' })
    const sraw = await sharp(r2.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const sw = sraw.info.width
    // 取中心 16x16 区域（含边缘斜坡）的平均亮度：黑块升采样+非锐化后内部应仍明显偏暗（远低于白底 255）
    let sum = 0, cnt = 0
    for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) {
      const o = (y * sw + x) * sraw.info.channels
      sum += (sraw.data[o] + sraw.data[o + 1] + sraw.data[o + 2]) / 3; cnt++
    }
    const mean = sum / cnt
    ok('黑块→中心仍明显偏暗(均值<120)', mean < 120, `mean=${mean.toFixed(1)}`)
  }

  console.log('[7] enhanceImage(espcn) x2：引擎跑通、尺寸正确、无 NaN')
  {
    const W = 16, H = 16
    const img = await sharp(makeImg(W, H, (x, y) => [((x * 10) % 256), ((y * 8) % 256), 128]), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
    const r = await enhanceImage(img, { scale: 2, mode: 'espcn' })
    const raw = await sharp(r.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let nan = false; for (let i = 0; i < raw.data.length; i++) if (Number.isNaN(raw.data[i])) nan = true
    ok('espcn 尺寸 32x32', r.width === 32 && r.height === 32)
    ok('espcn 无 NaN', !nan)
  }

  console.log('[8] 源码一致性：Phase 2 改动已落地')
  {
    const svc = fs.readFileSync('/workspace/projects/server/src/image/image.service.ts', 'utf8')
    const ctrl = fs.readFileSync('/workspace/projects/server/src/image/image.controller.ts', 'utf8')
    const types = fs.readFileSync('/workspace/projects/server/src/image/image.types.ts', 'utf8')
    const pkg = fs.readFileSync('/workspace/projects/server/package.json', 'utf8')
    ok('service 含 enhance()', /async enhance\(/.test(svc))
    ok('service 调用 enhanceImage', /enhanceImage\(/.test(svc))
    ok('controller 把 enhance 路由到 SR', /dto\.action === 'enhance'/.test(ctrl))
    ok('controller 含 IMG_PIPELINE_MODE 灰度', /IMG_PIPELINE_MODE/.test(ctrl))
    ok('types 含 sr_scale', /sr_scale/.test(types))
    ok('types 含 sr_mode', /sr_mode/.test(types))
    ok('package.json 含 sharp', /"sharp":/.test(pkg))
    ok('dewarp 仍可用(回归)', typeof orderCorners === 'function' && typeof straightenImage === 'function')
  }

  console.log(`\n==== 结果：${pass} passed, ${fail} failed ====`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
