/**
 * 端到端探针（修复后）：用真实源码跑「去手写 / 自动调正 / 智能高清」三条链路，量化差异。
 * 运行：cd push-ready/server && npx tsx /workspace/dynamic-tests/probe-three-features.ts
 */
import sharp from 'sharp'
import { straightenImage, detectDocumentCorners } from '../push-ready/server/src/image/image-dewarp'
import { enhanceImage } from '../push-ready/server/src/image/image-superres'
import {
  maskFromColorThreshold, maskFromDarkInk, unionMasks, inpaint, blendWithMask, unmodifiedRegionSimilarity,
} from '../push-ready/server/src/image/handwriting-mask'
import { getCV } from '../push-ready/server/src/image/image-cv'

const W = 900, H = 1200
const PRINT_FS = 22

/** 试卷：印刷正文 + 写在横线上的手写答案（可指定笔色与字号） */
function sheet(handColor: string, handFs: number) {
  const printed = Array.from({ length: 8 }, (_, i) =>
    `<text x="80" y="${130 + i * 78}" font-family="serif" font-size="${PRINT_FS}" fill="#111">` +
    `一、填空题 第 ${i + 1} 题：请根据题意把答案写在下面的横线上。` +
    `</text><line x1="80" y1="${152 + i * 78}" x2="820" y2="${152 + i * 78}" stroke="#bbb" stroke-width="1"/>`,
  ).join('')
  const hand = [152, 308, 464, 620]
    .map((y, i) => `<text x="150" y="${y - 4}" font-family="serif" font-size="${handFs}" fill="${handColor}">解答：${36 + i} 厘米 ${i + 1}</text>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#fdfdfa"/>${printed}${hand}</svg>`
}

async function meanDiff(a: Buffer, b: Buffer) {
  const A = await sharp(a).removeAlpha().greyscale().raw().toBuffer()
  const B = await sharp(b).removeAlpha().greyscale().raw().toBuffer()
  const ma = await sharp(a).metadata(), mb = await sharp(b).metadata()
  const ca = Math.max(1, Math.round(A.length / (ma.width! * ma.height!)))
  const cb = Math.max(1, Math.round(B.length / (mb.width! * mb.height!)))
  const n = Math.min(ma.width! * ma.height!, mb.width! * mb.height!)
  let s = 0, changed = 0
  for (let i = 0; i < n; i++) {
    const d = Math.abs(A[i * ca] - B[i * cb])
    s += d
    if (d > 8) changed++
  }
  return { mad: s / n, changedRatio: changed / n }
}

async function sharpness(buf: Buffer) {
  const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true })
  const ch = Math.max(1, Math.round(data.length / (info.width * info.height)))
  let e = 0
  for (let y = 1; y < info.height - 1; y++) {
    for (let x = 1; x < info.width - 1; x++) {
      const i = y * info.width + x
      e += Math.abs(data[i * ch] - data[(i - 1) * ch]) + Math.abs(data[i * ch] - data[(i - info.width) * ch])
    }
  }
  return e / ((info.width - 2) * (info.height - 2))
}

async function main() {
  // 真实感：拍照通常略糊 + 略歪（纸面占满画面，没有纸张外框）
  const src = await sharp(Buffer.from(sheet('#222222', 44))).blur(0.8).jpeg({ quality: 93 }).toBuffer()
  console.log(`\n=== 输入 ${W}x${H}（模拟手机拍照：轻微模糊、纸面占满画面） ===`)

  // ---------- 1. 自动调正 ----------
  console.log('\n---- 1) 自动调正 ----')
  const flat = src
  const tilted = await sharp(flat).rotate(-4.5, { background: '#e8e8e4' }).jpeg({ quality: 93 }).toBuffer()
  console.log('OpenCV 可用:', !!(await getCV()))
  console.log('四角自动检测(倾斜图):', JSON.stringify(await detectDocumentCorners(tilted)))
  for (const [name, img] of [['正图', flat], ['倾斜 -4.5°', tilted]] as const) {
    const r = await straightenImage(img, { auto: true })
    console.log(
      `  ${name.padEnd(10)} → needManual=${r.needManual} method=${r.method}` +
        (r.buffer ? ` 输出 ${r.width}x${r.height} 旋转 ${r.rotateDeg ?? 0}° 置信 ${(r.confidence ?? 0).toFixed(2)}` : ''),
    )
  }
  // 手动四角仍然优先
  const manual = [[0.08, 0.06], [0.9, 0.11], [0.93, 0.94], [0.05, 0.9]].map(([x, y]) => [x * W, y * H]) as any
  const mr = await straightenImage(flat, { manualCorners: manual, auto: true })
  console.log(`  手动四角   → method=${mr.method} ${mr.width}x${mr.height}`)

  // ---------- 2. 去手写 ----------
  console.log('\n---- 2) 去手写 ----')
  for (const [name, color, fs] of [
    ['黑色中性笔(大字)', '#222222', 44],
    ['铅笔灰(大字)', '#5a5a5a', 44],
    ['蓝色圆珠笔', '#1a3fd6', 40],
  ] as const) {
    const img = await sharp(Buffer.from(sheet(color, fs))).blur(0.6).jpeg({ quality: 93 }).toBuffer()
    const chroma = await maskFromColorThreshold(img)
    const dark = await maskFromDarkInk(img)
    const mask = await unionMasks(chroma, dark)
    if (mask.coverage <= 0.0001) { console.log(`  ${name}: 覆盖 0% → 走「原样返回 + notice」`); continue }
    const inp = await inpaint(img, 'adaptive', mask)
    const merged = await blendWithMask(img, inp, mask)
    const d = await meanDiff(img, merged)
    const sim = await unmodifiedRegionSimilarity(img, merged, mask)
    console.log(
      `  ${name.padEnd(16)} 覆盖 ${(mask.coverage * 100).toFixed(2)}%（色域 ${(chroma.coverage * 100).toFixed(2)}% + 深色 ${(dark.coverage * 100).toFixed(2)}%）` +
        ` 改动像素 ${(d.changedRatio * 100).toFixed(2)}% 非手写区一致性 ${(sim.similarity * 100).toFixed(2)}%`,
    )
  }

  // ---------- 3. 智能高清 ----------
  console.log('\n---- 3) 智能高清 ----')
  const t = Date.now()
  const sr = await enhanceImage(src, { scale: 2, mode: 'classical' })
  const sm = await sharp(sr.buffer).metadata()
  const pure = await sharp(src).resize(sm.width!, sm.height!, { kernel: 'lanczos3' }).jpeg({ quality: 95 }).toBuffer()
  const dsr = await meanDiff(pure, sr.buffer)
  console.log(`  输出 ${sm.width}x${sm.height} 耗时 ${Date.now() - t}ms`)
  console.log(`  锐度：原图 ${(await sharpness(src)).toFixed(3)} → SR ${(await sharpness(sr.buffer)).toFixed(3)}（纯放大基准 ${(await sharpness(pure)).toFixed(3)}，增益 ${(((await sharpness(sr.buffer)) - (await sharpness(pure))) / (await sharpness(pure)) * 100).toFixed(1)}%）`)
  console.log(`  相对纯放大：MAD=${dsr.mad.toFixed(2)} 改动像素 ${(dsr.changedRatio * 100).toFixed(2)}%`)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
