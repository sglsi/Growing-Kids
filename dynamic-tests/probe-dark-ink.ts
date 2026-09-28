/**
 * 探针：验证 maskFromDarkInk 能否检出「黑色中性笔/铅笔」手写（色域法检不出的场景）。
 *
 * 手写用**大字号文本**模拟（学生作答通常明显大于正文印刷字号），写在印刷行之间的
 * 空白处——这才是真实试卷的样子。早期用细曲线做 fixture 不真实（纵向跨度天然不足，
 * 导致连笔永远取不到种子）。
 *
 * 运行：cd push-ready/server && npx tsx /workspace/dynamic-tests/probe-dark-ink.ts
 */
import sharp from 'sharp'
import { maskFromColorThreshold, maskFromDarkInk, unionMasks } from '../push-ready/server/src/image/handwriting-mask'

const W = 900, H = 1200
const PRINT_FS = 22

function build(handColor: string, handFs: number, label: string) {
  const printed = Array.from({ length: 8 }, (_, i) =>
    `<text x="80" y="${130 + i * 78}" font-family="serif" font-size="${PRINT_FS}" fill="#111">` +
    `一、填空题 第 ${i + 1} 题：请根据题意把答案写在下面的横线上。` +
    `</text><line x1="80" y1="${152 + i * 78}" x2="820" y2="${152 + i * 78}" stroke="#bbb" stroke-width="1"/>`,
  ).join('')
  const hand = [152, 308, 464, 620]
    .map((y, i) =>
      `<text x="150" y="${y - 4}" font-family="serif" font-size="${handFs}" fill="${handColor}">${label} ${i + 1}</text>`,
    )
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#fdfdfa"/>${printed}${hand}</svg>`
}

async function main() {
  const cases: [string, string, number, string][] = [
    ['黑色中性笔(大字)', '#222222', 44, '解答：36厘米'],
    ['铅笔灰(大字)', '#5a5a5a', 44, '解答：36厘米'],
    ['蓝色圆珠笔(大字)', '#1a3fd6', 44, '解答：36厘米'],
    ['黑笔与印刷同字号', '#222222', PRINT_FS, '解答：36厘米'],
  ]
  for (const [name, color, fs, label] of cases) {
    const src = await sharp(Buffer.from(build(color, fs, label))).jpeg({ quality: 96 }).toBuffer()
    const chroma = await maskFromColorThreshold(src)
    const dark = await maskFromDarkInk(src)
    const union = await unionMasks(chroma, dark)
    console.log(
      `${name.padEnd(18)} 色域=${(chroma.coverage * 100).toFixed(2)}%  深色=${(dark.coverage * 100).toFixed(2)}%  并集=${(union.coverage * 100).toFixed(2)}%` +
        `   ${JSON.stringify(dark.debug)}`,
    )
  }

  // 反例 1：纯印刷、无手写 → 深色法必须≈0（不能把印刷体当手写擦掉）
  const purePrinted = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#fff"/>
    ${Array.from({ length: 16 }, (_, i) => `<text x="80" y="${120 + i * 62}" font-family="serif" font-size="${PRINT_FS}" fill="#111">纯印刷体测试文本第 ${i + 1} 行，不含任何手写内容，用于验证不会误擦。</text>`).join('')}
  </svg>`)).jpeg({ quality: 96 }).toBuffer()
  const d1 = await maskFromDarkInk(purePrinted)
  console.log(`纯印刷体(反例)      深色=${(d1.coverage * 100).toFixed(2)}%  ← 必须≈0  ${JSON.stringify(d1.debug)}`)

  // 反例 2：大号印刷标题（占比高）→ 护栏必须拦下
  const bigTitle = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#fff"/>
    ${Array.from({ length: 5 }, (_, i) => `<text x="80" y="${160 + i * 200}" font-family="serif" font-size="64" fill="#111">第 ${i + 1} 大题 标题</text>`).join('')}
  </svg>`)).jpeg({ quality: 96 }).toBuffer()
  const d2 = await maskFromDarkInk(bigTitle)
  console.log(`大号印刷标题(反例)  深色=${(d2.coverage * 100).toFixed(2)}%  ← 必须≈0  ${JSON.stringify(d2.debug)}`)

  // 反例 3：整页都是手写 → 护栏拦下，绝不全擦
  const allHand = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#fff"/>
    ${Array.from({ length: 14 }, (_, i) => `<text x="80" y="${110 + i * 78}" font-family="serif" font-size="52" fill="#222">整页手写第 ${i + 1} 行内容</text>`).join('')}
  </svg>`)).jpeg({ quality: 96 }).toBuffer()
  const d3 = await maskFromDarkInk(allHand)
  console.log(`整页手写(极端)      深色=${(d3.coverage * 100).toFixed(2)}%  ← 应被护栏拦下≈0  ${JSON.stringify(d3.debug)}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
