/**
 * 【权威测量】去手写 mask 质量（直接调用生产代码 handwriting-mask.ts）
 *
 * ── 指标口径（对齐领域：EraseNet / ExamCleaner / 百度网盘手写擦除冠军方案）──────
 *   · 召回 = 真实手写被覆盖比例 → 低召回 = 擦完还有残笔（用户体感"没擦干净"）
 *   · 误擦 = 检测区压到印刷体墨迹的比例 → 高误擦 = 把题目擦掉（毁图）
 *   · 反例覆盖率 = 不该有任何手写的图上检出了多少 → 必须 ≈0
 *   · 软像素 = mask 中既非 0 也非 255 的比例 → 0 = 硬边（领域公认的接缝成因）
 *
 * ── ground-truth 做法 ─────────────────────────────────────────────────────
 * 同一份 SVG 渲染两遍：full（印刷+手写，送检测器）/ handOnly（只有手写，非白即 GT）。
 *
 * ── 版面设计（此前版本的坑）────────────────────────────────────────────────
 * 旧 fixture 把手写直接压在印刷文字上，导致"误擦印刷体"天然 50%+，掩盖真实表现。
 * 现按每组 140px 重排，区分两种作答形态：
 *   A 空白区作答（主场景）：手写与印刷行分离
 *   B 压字作答（困难场景）：手写与印刷文字重叠
 *
 * 运行：cd /workspace/projects/server && npx tsx /workspace/dynamic-tests/probe-mask-quality.ts
 */
import sharp from 'sharp'
import {
  maskFromColorThreshold,
  maskFromDarkInk,
  unionMasks,
  type HandwritingMask,
} from '/workspace/projects/server/src/image/handwriting-mask'

const W = 900
const H = 1200
const PRINT_FS = 22
const GROUPS = 7
const ROW_H = 140
const PRINT_BASE = (i: number) => 100 + i * ROW_H
const RULE_Y = (i: number) => 118 + i * ROW_H
const HAND_BASE_A = (i: number) => 178 + i * ROW_H
const HAND_BASE_B = (i: number) => 108 + i * ROW_H
const LABEL = '解答：36厘米'

function printedLayer(): string {
  return Array.from({ length: GROUPS }, (_, i) =>
    `<text x="80" y="${PRINT_BASE(i)}" font-family="serif" font-size="${PRINT_FS}" fill="#111">一、填空题 第 ${i + 1} 题：请根据题意把答案写在下面的横线上。</text>` +
    `<line x1="80" y1="${RULE_Y(i)}" x2="820" y2="${RULE_Y(i)}" stroke="#bbb" stroke-width="1"/>`).join('')
}
function svgFull(color: string, fs: number, mode: 'A' | 'B'): string {
  const base = mode === 'A' ? HAND_BASE_A : HAND_BASE_B
  const hand = Array.from({ length: GROUPS }, (_, i) =>
    `<text x="150" y="${base(i)}" font-family="serif" font-size="${fs}" fill="${color}">${LABEL} ${i + 1}</text>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fdfdfa"/>${printedLayer()}${hand}</svg>`
}
function svgHandOnly(color: string, fs: number, mode: 'A' | 'B'): string {
  const base = mode === 'A' ? HAND_BASE_A : HAND_BASE_B
  const hand = Array.from({ length: GROUPS }, (_, i) =>
    `<text x="150" y="${base(i)}" font-family="serif" font-size="${fs}" fill="${color}">${LABEL} ${i + 1}</text>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${hand}</svg>`
}
const svgPrintOnly = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fdfdfa"/>${printedLayer()}</svg>`

/** 由「只有手写」的渲染图得到 GT mask（非白即手写）+ r 像素膨胀容纳抗锯齿 */
async function groundTruth(png: Buffer, dilate = 2): Promise<Uint8Array> {
  const g = await sharp(png).grayscale().raw().toBuffer()
  const n = W * H
  let cur = new Uint8Array(n)
  for (let i = 0; i < n; i++) cur[i] = g[i] < 200 ? 1 : 0
  for (let d = 0; d < dilate; d++) {
    const next = new Uint8Array(n)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let v = cur[y * W + x]
        if (v) { next[y * W + x] = 1; continue }
        for (let dy = -1; dy <= 1 && !v; dy++) {
          const ny = y + dy
          if (ny < 0 || ny >= H) continue
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx
            if (nx < 0 || nx >= W) continue
            if (cur[ny * W + nx]) { v = 1; break }
          }
        }
        next[y * W + x] = v
      }
    cur = next
  }
  return cur
}

async function toRaw(mask: HandwritingMask): Promise<Uint8Array> {
  const { alignMask } = await import('/workspace/projects/server/src/image/handwriting-mask')
  return new Uint8Array(await alignMask(mask, W, H))
}

function score(det: Uint8Array, gt: Uint8Array, printInk?: Uint8Array) {
  let inter = 0, uni = 0, detN = 0, gtN = 0, soft = 0, hit = 0
  for (let i = 0; i < det.length; i++) {
    const d = det[i] > 127 ? 1 : 0
    if (d && gt[i]) inter++
    if (d || gt[i]) uni++
    if (d) { detN++; if (printInk && printInk[i]) hit++ }
    if (gt[i]) gtN++
    if (det[i] > 8 && det[i] < 247) soft++
  }
  return {
    iou: uni ? inter / uni : 0,
    recall: gtN ? inter / gtN : 0,
    precision: detN ? inter / detN : 0,
    printHit: detN ? hit / detN : 0,
    softRatio: det.length ? soft / det.length : 0,
    coverage: detN / det.length,
  }
}
const pct = (v: number) => `${(v * 100).toFixed(1)}%`

async function main() {
  console.log('=== 去手写 mask 质量（生产代码直测）===\n')
  const printInk = await groundTruth(await sharp(Buffer.from(svgPrintOnly())).png().toBuffer(), 2)

  const pos: Array<[string, string, number, 'A' | 'B']> = [
    ['黑笔A 空白区', '#222222', 42, 'A'],
    ['铅笔A 空白区', '#5a5a5a', 42, 'A'],
    ['蓝笔A 空白区', '#1a3fd6', 42, 'A'],
    ['黑笔B 压字', '#222222', 42, 'B'],
  ]
  console.log('【正例】'.padEnd(16) + '召回'.padEnd(9) + '误擦'.padEnd(9) + 'IoU'.padEnd(9) + '覆盖'.padEnd(9) + '软像素')
  for (const [name, color, fs, mode] of pos) {
    const full = await sharp(Buffer.from(svgFull(color, fs, mode))).jpeg({ quality: 96 }).toBuffer()
    const gt = await groundTruth(await sharp(Buffer.from(svgHandOnly(color, fs, mode))).png().toBuffer(), 2)
    const chroma = await maskFromColorThreshold(full)
    const dark = await maskFromDarkInk(full)
    const union = await unionMasks(chroma, dark)
    const s = score(await toRaw(union), gt, printInk)
    console.log(
      name.padEnd(16) + pct(s.recall).padEnd(9) + pct(s.printHit).padEnd(9) +
      pct(s.iou).padEnd(9) + pct(s.coverage).padEnd(9) + pct(s.softRatio),
    )
    console.log(`   └ 深色路径诊断 ${JSON.stringify(dark.debug)}`)
  }

  // ── 反例（误擦 = 毁图，覆盖率必须 ≈0）─────────────────────────────────────
  const negs: Array<[string, string]> = [
    ['纯印刷正文', `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>` +
      Array.from({ length: 16 }, (_, i) => `<text x="80" y="${120 + i * 62}" font-family="serif" font-size="${PRINT_FS}" fill="#111">纯印刷体测试文本第 ${i + 1} 行，不含任何手写内容，用于验证不会误擦。</text>`).join('') + `</svg>`],
    ['大号印刷标题', `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>` +
      Array.from({ length: 5 }, (_, i) => `<text x="80" y="${160 + i * 200}" font-family="serif" font-size="64" fill="#111">第 ${i + 1} 大题 标题</text>`).join('') + `</svg>`],
    ['标题+正文混合', `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>` +
      Array.from({ length: 7 }, (_, i) =>
        `<text x="80" y="${100 + i * 150}" font-family="serif" font-size="34" fill="#111">第 ${i + 1} 大题 选择题</text>` +
        `<text x="80" y="${130 + i * 150}" font-family="serif" font-size="22" fill="#111">下列关于本题的说法中，正确的一项是，请根据题干内容作答。</text>` +
        `<text x="80" y="${158 + i * 150}" font-family="serif" font-size="22" fill="#111">A. 选项甲　B. 选项乙　C. 选项丙　D. 选项丁</text>`).join('') + `</svg>`],
    ['特大标题+正文', `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>` +
      Array.from({ length: 5 }, (_, i) =>
        `<text x="70" y="${120 + i * 220}" font-family="serif" font-size="46" fill="#111">第 ${i + 1} 大题 解答题</text>` +
        `<text x="70" y="${160 + i * 220}" font-family="serif" font-size="22" fill="#111">本题共两小问，请写出必要的推理过程与计算步骤。</text>` +
        `<text x="70" y="${192 + i * 220}" font-family="serif" font-size="22" fill="#111">解：（1）由题意可得，设未知数为 x，则方程为 2x+3=11。</text>`).join('') + `</svg>`],
    ['整页手写', `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>` +
      Array.from({ length: 13 }, (_, i) => `<text x="60" y="${100 + i * 85}" font-family="serif" font-size="52" fill="#222">整页手写第 ${i + 1} 行内容</text>`).join('') + `</svg>`],
  ]
  console.log('\n【反例】覆盖率必须 ≈0%')
  for (const [name, svg] of negs) {
    const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 96 }).toBuffer()
    const union = await unionMasks(await maskFromColorThreshold(buf), await maskFromDarkInk(buf))
    const raw = await toRaw(union)
    const cov = raw.reduce((a, v) => a + (v > 127 ? 1 : 0), 0) / raw.length
    const dark = await maskFromDarkInk(buf)
    console.log(`  ${name.padEnd(16)} 覆盖=${pct(cov).padStart(7)}   ${JSON.stringify(dark.debug)}`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
