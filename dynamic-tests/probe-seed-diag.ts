/**
 * 【诊断】为什么「轻微模糊」的黑笔照片残笔率从 0% 涨到 29%？
 *
 * 回归脚本用 jpg(sheet, blur=0.6)（模拟拍照轻微失焦），探针用清晰图。
 * 假设：模糊让笔迹产生一圈**渐变边缘**，这些边缘像素：
 *   · 在 Otsu 阈值之上 → 不在 ink / seed 内（seed 覆盖不足）
 *   · 但 luma 仍在 190 以下 → 满足 isStructure → 被当成"可信印刷结构"当填充源
 * 于是又变回"拿墨迹补墨迹"。
 *
 * 证据要拿：mask 内「不在 seed 内、但满足 isStructure」的像素有多少。
 *
 * 运行：cd /workspace/projects/server && npx tsx /workspace/dynamic-tests/probe-seed-diag.ts
 */
import sharp from 'sharp'
import {
  maskFromColorThreshold, maskFromDarkInk, unionMasks,
  type HandwritingMask,
} from '/workspace/projects/server/src/image/handwriting-mask'

const W = 900, H = 1200, PRINT_FS = 22, GROUPS = 7, ROW_H = 140
const HAND_BASE = (i: number) => 178 + i * ROW_H

function sheet(color: string, fs2: number): Buffer {
  const printed = Array.from({ length: GROUPS }, (_, i) =>
    `<text x="80" y="${100 + i * ROW_H}" font-family="serif" font-size="${PRINT_FS}" fill="#111">一、填空题 第 ${i + 1} 题：请根据题意把答案写在下面的横线上。</text>` +
    `<line x1="80" y1="${118 + i * ROW_H}" x2="820" y2="${118 + i * ROW_H}" stroke="#bbb" stroke-width="1"/>`).join('')
  const hand = Array.from({ length: GROUPS }, (_, i) =>
    `<text x="150" y="${HAND_BASE(i)}" font-family="serif" font-size="${fs2}" fill="${color}">解答：36 厘米 ${i + 1}</text>`).join('')
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fdfdfa"/>${printed}${hand}</svg>`)
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`

async function main() {
  console.log('=== seed 覆盖诊断（mask 内但不在 seed 内的污染源）===\n')
  console.log('笔色'.padEnd(8) + 'blur'.padEnd(8) + 'mask覆盖'.padEnd(10) + 'mask内结构'.padEnd(12) + '其中不在seed内'.padEnd(16) + '占mask比')

  for (const [name, color] of [['黑笔', '#222222'], ['铅笔', '#5a5a5a'], ['蓝笔', '#1a3fd6']] as const) {
    for (const blur of [0, 0.6]) {
      const p = sharp(sheet(color, 42))
      const img = await (blur > 0 ? p.blur(blur) : p).jpeg({ quality: 93 }).toBuffer()

      const mask: HandwritingMask = await unionMasks(await maskFromColorThreshold(img), await maskFromDarkInk(img))
      const { data, info } = await sharp(img).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      const seed = mask.seed

      let covered = 0, structIn = 0, leak = 0
      for (let i = 0; i < info.width * info.height; i++) {
        if (mask.data[i] <= 127) continue
        covered++
        const p2 = i * info.channels
        const r = data[p2], g = data[p2 + 1], b = data[p2 + 2]
        const luma = (r * 299 + g * 587 + b * 114) / 1000
        const chroma = Math.max(r, g, b) - Math.min(r, g, b)
        if (chroma <= 42 && luma <= 190) {
          structIn++
          if (!seed || seed[i] <= 127) leak++ // ⭐ 污染源：是"结构"却不在 seed 内
        }
      }
      console.log(
        name.padEnd(8) + String(blur).padEnd(8) + pct(covered / (info.width * info.height)).padEnd(10) +
        pct(covered ? structIn / covered : 0).padEnd(12) + pct(covered ? leak / covered : 0).padEnd(16) +
        (seed ? 'seed 存在' : 'seed 缺失'),
      )
    }
  }
  console.log('\n「其中不在seed内」= mask 内侧足 isStructure 却未被紧种子排除的像素（= 残笔污染源）')
  console.log('阈值用 criterion 的 chromaMax=42 / lumaMax=190')
}
main().catch((e) => { console.error(e); process.exit(1) })
