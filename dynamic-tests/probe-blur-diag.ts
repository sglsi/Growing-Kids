/**
 * 【诊断】墨迹密度护栏：绝对阈值 vs 相对基准，在**模糊**与**大标题**两端各是多少？
 *
 * 背景（实测发现的严重缺陷）：
 *   密度护栏用绝对阈值 0.30 区分「大号印刷标题」与「手写行」。
 *   但**拍照模糊会让笔画变粗**，墨迹像素数可涨 35%，而分母（行高×横向跨度）几乎不变
 *   → 手写行密度整体上升 → 绝对阈值 0.30 把真实手写整片误杀：
 *     黑笔 blur=0.6：7 个手写行里 5 行被拦，覆盖率 6.71% → **1.91%**
 *     黑笔 blur=1.0：7 行全拦 → 覆盖率 **0%**（功能直接消失）
 *
 * 关键观察：手写行密度**始终低于**印刷正文行密度，且模糊越重、差距越大：
 *     blur=0   手写 0.276~0.282 / 正文基准 0.307 → 比值 0.91
 *     blur=0.6 手写 0.297~0.305 / 正文基准 0.372 → 比值 0.81
 *     blur=1.0 手写 0.325~0.334 / 正文基准 0.470 → 比值 0.70
 *   所以正确做法是**相对判据**：阈值 = 正文基准密度 × ratio。
 *   本脚本要测出「大标题密度 / 正文基准密度」，才能把 ratio 定在两者之间。
 *
 * 运行：cd /workspace/projects/server && npx tsx /workspace/dynamic-tests/probe-blur-diag.ts
 */
import sharp from 'sharp'
import { maskFromDarkInk } from '/workspace/projects/server/src/image/handwriting-mask'

const W = 900, H = 1200, GROUPS = 7, ROW_H = 140, PRINT_FS = 22
const HAND_BASE = (i: number) => 178 + i * ROW_H

function printedLayer(): string {
  return Array.from({ length: GROUPS }, (_, i) =>
    `<text x="80" y="${100 + i * ROW_H}" font-family="serif" font-size="${PRINT_FS}" fill="#111">一、填空题 第 ${i + 1} 题：请根据题意把答案写在下面的横线上。</text>` +
    `<line x1="80" y1="${118 + i * ROW_H}" x2="820" y2="${118 + i * ROW_H}" stroke="#bbb" stroke-width="1"/>`).join('')
}

/** 正常作答：印刷正文 + 写在空白区的手写 */
function sheetHand(color: string, fs2: number): Buffer {
  const hand = Array.from({ length: GROUPS }, (_, i) =>
    `<text x="150" y="${HAND_BASE(i)}" font-family="serif" font-size="${fs2}" fill="${color}">解答：36 厘米 ${i + 1}</text>`).join('')
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fdfdfa"/>${printedLayer()}${hand}</svg>`)
}

/** 反例：大号印刷标题 + 正文（**没有手写**，绝不能被擦） */
function sheetBigTitle(fs2: number): Buffer {
  const titles = Array.from({ length: 4 }, (_, i) =>
    `<text x="80" y="${120 + i * 260}" font-family="serif" font-size="${fs2}" fill="#111">第三章 综合运算 ${i + 1}</text>`).join('')
  const body = Array.from({ length: 4 }, (_, i) =>
    Array.from({ length: 5 }, (_, k) =>
      `<text x="80" y="${170 + i * 260 + k * 34}" font-family="serif" font-size="${PRINT_FS}" fill="#111">这里是正常的印刷正文内容第 ${i * 5 + k + 1} 行，用于提供正文基准密度。</text>`).join('')).join('')
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fdfdfa"/>${titles}${body}</svg>`)
}

async function probe(label: string, svg: Buffer, blur: number) {
  const p = sharp(svg)
  const img = await (blur > 0 ? p.blur(blur) : p).jpeg({ quality: 93 }).toBuffer()
  const m = await maskFromDarkInk(img)
  const d = m.debug as Record<string, unknown> | undefined
  const base = (d?.baseDensity as number) ?? 0
  const tall = (d?.tallDensities as number[]) ?? []
  const ratio = tall.length ? (base ? Math.max(...tall) / base : 0) : 0
  console.log(
    `${label}  blur=${blur}  覆盖=${(m.coverage * 100).toFixed(2).padStart(5)}%  ` +
    `基准=${base.toFixed(3)}  候选密度=[${tall.map((v) => v.toFixed(3)).join(', ')}]  ` +
    `最大/基准=${ratio.toFixed(2)}  被拦=${d?.rowDensityBlocked ?? '-'}`,
  )
}

async function main() {
  console.log('=== A. 手写（必须放行）===')
  for (const blur of [0, 0.6, 1.0]) await probe('黑笔 ', sheetHand('#222222', 42), blur)
  for (const blur of [0, 0.6, 1.0]) await probe('铅笔 ', sheetHand('#5a5a5a', 42), blur)

  console.log('\n=== B. 大号印刷标题（必须拦住，覆盖应为 0）===')
  for (const fs2 of [40, 46, 52]) {
    for (const blur of [0, 0.6]) await probe(`标题${fs2}`, sheetBigTitle(fs2), blur)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
