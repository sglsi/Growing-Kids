/**
 * 【根因诊断】为什么黑笔残笔率 40%、蓝笔只有 0.05%？
 *
 * 假设：structuralExtend 的 isStructure(luma<=170 && chroma<=42) 把**黑/灰手写墨迹
 * 本身**当成"可信印刷结构"，且注释里刻意"不排除 mask 内像素"，于是填充源就是
 * 旁边还没被填掉的墨迹 → 越填越黑。蓝笔 chroma≈142 > 42 天然被排除，故不受影响。
 *
 * 证据要拿三样：
 *   ① 各笔色下 mask 覆盖区内命中 isStructure 的像素数（源污染量）
 *   ② 去掉"mask 内像素可作为源"后，残笔率的变化
 *   ③ 各策略（masked / adaptive）各自的残笔率对照
 *
 * 运行：cd /workspace/projects/server && npx tsx /workspace/dynamic-tests/probe-erase-diag.ts
 */
import sharp from 'sharp'
import {
  maskFromColorThreshold,
  maskFromDarkInk,
  unionMasks,
  inpaint,
  blendWithMask,
  type HandwritingMask,
} from '/workspace/projects/server/src/image/handwriting-mask'

const W = 900, H = 1200
const GROUPS = 7, ROW_H = 140
const HAND_BASE = (i: number) => 178 + i * ROW_H
const LABEL = '解答：36厘米'

function svgFull(color: string, fs: number): string {
  const printed = Array.from({ length: GROUPS }, (_, i) =>
    `<text x="80" y="${100 + i * ROW_H}" font-family="serif" font-size="22" fill="#111">一、填空题 第 ${i + 1} 题：请根据题意把答案写在下面的横线上。</text>` +
    `<line x1="80" y1="${118 + i * ROW_H}" x2="820" y2="${118 + i * ROW_H}" stroke="#bbb" stroke-width="1"/>`).join('')
  const hand = Array.from({ length: GROUPS }, (_, i) =>
    `<text x="150" y="${HAND_BASE(i)}" font-family="serif" font-size="${fs}" fill="${color}">${LABEL} ${i + 1}</text>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fdfdfa"/>${printed}${hand}</svg>`
}
function svgHandOnly(color: string, fs: number): string {
  const hand = Array.from({ length: GROUPS }, (_, i) =>
    `<text x="150" y="${HAND_BASE(i)}" font-family="serif" font-size="${fs}" fill="${color}">${LABEL} ${i + 1}</text>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${hand}</svg>`
}

async function gtMask(png: Buffer): Promise<Uint8Array> {
  const g = await sharp(png).grayscale().raw().toBuffer()
  const n = W * H
  let cur = new Uint8Array(n)
  for (let i = 0; i < n; i++) cur[i] = g[i] < 200 ? 1 : 0
  for (let d = 0; d < 2; d++) {
    const nx = new Uint8Array(n)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let v = cur[y * W + x]
        if (v) { nx[y * W + x] = 1; continue }
        for (let dy = -1; dy <= 1 && !v; dy++) {
          const ny = y + dy; if (ny < 0 || ny >= H) continue
          for (let dx = -1; dx <= 1; dx++) {
            const nxx = x + dx; if (nxx < 0 || nxx >= W) continue
            if (cur[ny * W + nxx]) { v = 1; break }
          }
        }
        nx[y * W + x] = v
      }
    cur = nx
  }
  return cur
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`

async function residual(img: Buffer, out: Buffer, gt: Uint8Array): Promise<number> {
  const outG = await sharp(out).resize(W, H, { fit: 'fill' }).grayscale().raw().toBuffer()
  const inG = await sharp(img).resize(W, H, { fit: 'fill' }).grayscale().raw().toBuffer()
  let gtN = 0, remain = 0
  for (let i = 0; i < W * H; i++) {
    if (!gt[i]) continue
    gtN++
    if (inG[i] < 150 && outG[i] < 150) remain++
  }
  return gtN ? remain / gtN : 0
}

async function main() {
  console.log('=== 残笔率根因诊断 ===\n')
  console.log('笔色'.padEnd(10) + 'mask覆盖'.padEnd(10) + 'mask内"结构"像素'.padEnd(18) + 'masked残笔'.padEnd(12) + 'adaptive残笔')

  for (const [name, color, fs] of [['黑笔', '#222222', 42], ['铅笔', '#5a5a5a', 42], ['蓝笔', '#1a3fd6', 42]] as const) {
    const img = await sharp(Buffer.from(svgFull(color, fs))).jpeg({ quality: 96 }).toBuffer()
    const gt = await gtMask(await sharp(Buffer.from(svgHandOnly(color, fs))).png().toBuffer())

    const soft = await unionMasks(await maskFromColorThreshold(img), await maskFromDarkInk(img))

    // ① mask 覆盖区内有多少像素满足 isStructure(luma<=170 && chroma<=42)
    const { data, info } = await sharp(img).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const { alignMask } = await import('/workspace/projects/server/src/image/handwriting-mask')
    const m = await alignMask(soft, info.width, info.height)
    let covered = 0, structInside = 0
    for (let i = 0; i < info.width * info.height; i++) {
      if (m[i] <= 127) continue
      covered++
      const p = i * info.channels
      const r = data[p], g = data[p + 1], b = data[p + 2]
      const luma = (r * 299 + g * 587 + b * 114) / 1000
      const chroma = Math.max(r, g, b) - Math.min(r, g, b)
      if (luma <= 170 && chroma <= 42) structInside++
    }

    // ② 两种策略的残笔率
    const maskedOut = await blendWithMask(img, await inpaint(img, 'masked', soft), soft)
    const adaptiveOut = await blendWithMask(img, await inpaint(img, 'adaptive', soft), soft)

    console.log(
      name.padEnd(10) +
      pct(covered / (info.width * info.height)).padEnd(10) +
      pct(covered ? structInside / covered : 0).padEnd(18) +
      pct(await residual(img, maskedOut, gt)).padEnd(12) +
      pct(await residual(img, adaptiveOut, gt)),
    )
  }
  console.log('\nmask内"结构"像素 = 待修复区里被 isStructure 判为印刷体墨色的比例（越高 = 填充源污染越严重）')
}
main().catch((e) => { console.error(e); process.exit(1) })
