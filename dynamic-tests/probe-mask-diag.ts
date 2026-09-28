/**
 * 探针 P3：诊断「候选墨迹占比 > 90%」这个反常现象。
 *
 * 上一轮扫描显示：把 share_guard 放宽到 0.9 仍全部触发，说明
 * candidateInk / inkTotal > 0.9 —— 几乎**整页墨迹**都被判成手写候选。
 * 这在物理上不合理（手写只占一半版面），说明中间某个量算错了。
 *
 * 本探针逐层打印：字高估计、种子数、候选数、占比，并**分区统计**
 * （印刷行区 / 手写行区 / 横线区 各自的种子与候选密度），定位污染源。
 */
import sharp from 'sharp'

const W = 900, H = 1200, PRINT_FS = 22
const GROUPS = 7, ROW_H = 140
const PRINT_BASE = (i: number) => 100 + i * ROW_H
const RULE_Y = (i: number) => 118 + i * ROW_H
const HAND_BASE_A = (i: number) => 178 + i * ROW_H

function printedLayer(): string {
  return Array.from({ length: GROUPS }, (_, i) =>
    `<text x="80" y="${PRINT_BASE(i)}" font-family="serif" font-size="${PRINT_FS}" fill="#111">一、填空题 第 ${i + 1} 题：请根据题意把答案写在下面的横线上。</text>` +
    `<line x1="80" y1="${RULE_Y(i)}" x2="820" y2="${RULE_Y(i)}" stroke="#bbb" stroke-width="1"/>`,
  ).join('')
}
const LABEL = '解答：36厘米'
function svgFull(color: string, fs: number): string {
  const hand = Array.from({ length: GROUPS }, (_, i) =>
    `<text x="150" y="${HAND_BASE_A(i)}" font-family="serif" font-size="${fs}" fill="${color}">${LABEL} ${i + 1}</text>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fdfdfa"/>${printedLayer()}${hand}</svg>`
}
function svgHandOnly(color: string, fs: number): string {
  const hand = Array.from({ length: GROUPS }, (_, i) =>
    `<text x="150" y="${HAND_BASE_A(i)}" font-family="serif" font-size="${fs}" fill="${color}">${LABEL} ${i + 1}</text>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${hand}</svg>`
}
function svgPrintOnly(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fdfdfa"/>${printedLayer()}</svg>`
}

function maxFilterU16Row(src: Uint16Array, w: number, h: number, r: number): Uint16Array {
  const out = new Uint16Array(src.length)
  if (r <= 0) { out.set(src); return out }
  for (let y = 0; y < h; y++) {
    const base = y * w
    for (let x = 0; x < w; x++) {
      let m = 0
      const x0 = x - r < 0 ? 0 : x - r
      const x1 = x + r >= w ? w - 1 : x + r
      for (let nx = x0; nx <= x1; nx++) { const v = src[base + nx]; if (v > m) m = v }
      out[base + x] = m
    }
  }
  return out
}
function maxFilter(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return src
  const tmp = new Uint8Array(src.length)
  for (let y = 0; y < h; y++) {
    const base = y * w
    for (let x = 0; x < w; x++) {
      let m = 0
      const x0 = x - r < 0 ? 0 : x - r, x1 = x + r >= w ? w - 1 : x + r
      for (let nx = x0; nx <= x1; nx++) { const v = src[base + nx]; if (v > m) m = v }
      tmp[base + x] = m
    }
  }
  const out = new Uint8Array(src.length)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 0
      const y0 = y - r < 0 ? 0 : y - r, y1 = y + r >= h ? h - 1 : y + r
      for (let ny = y0; ny <= y1; ny++) { const v = tmp[ny * w + x]; if (v > m) m = v }
      out[y * w + x] = m
    }
  }
  return out
}

async function main() {
  const src = await sharp(Buffer.from(svgFull('#222222', 42))).jpeg({ quality: 96 }).toBuffer()
  const handOnly = await sharp(Buffer.from(svgHandOnly('#222222', 42))).png().toBuffer()
  const printOnly = await sharp(Buffer.from(svgPrintOnly())).png().toBuffer()

  const gray = await sharp(src).resize(W, H, { fit: 'fill' }).grayscale().raw().toBuffer()
  const w = W, h = H

  // Otsu
  const hist = new Int32Array(256)
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0, wB = 0, maxVar = -1, thr = 127
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (wB === 0) continue
    const wF = gray.length - wB; if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB, mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > maxVar) { maxVar = between; thr = t }
  }
  console.log(`Otsu 阈值 = ${thr}`)

  const ink = new Uint8Array(w * h)
  let inkTotal = 0
  for (let i = 0; i < gray.length; i++) if (gray[i] < thr) { ink[i] = 1; inkTotal++ }
  console.log(`inkTotal = ${inkTotal}  (${(inkTotal / (w * h) * 100).toFixed(2)}% 全图)`)

  // GT 分区：手写墨迹 / 印刷墨迹（含横线）
  const gh = await sharp(handOnly).grayscale().raw().toBuffer()
  const gp = await sharp(printOnly).grayscale().raw().toBuffer()
  const handInk = new Uint8Array(w * h)
  const printInk = new Uint8Array(w * h)
  let handN = 0, printN = 0
  for (let i = 0; i < w * h; i++) {
    if (gh[i] < 200) { handInk[i] = 1; handN++ }
    if (gp[i] < 200) { printInk[i] = 1; printN++ }
  }
  let overlap = 0
  for (let i = 0; i < w * h; i++) if (handInk[i] && printInk[i]) overlap++
  console.log(`GT 手写墨迹 = ${handN}  印刷墨迹 = ${printN}  重叠 = ${overlap}  ink中既非两者 = ${inkTotal - handN - printN + overlap}`)

  // 行投影 + 字高
  const rowProfile = new Int32Array(h)
  for (let y = 0; y < h; y++) { let c = 0; for (let x = 0; x < w; x++) if (ink[y * w + x]) c++; rowProfile[y] = c }
  let maxRow = 0
  for (let y = 0; y < h; y++) if (rowProfile[y] > maxRow) maxRow = rowProfile[y]
  const bandTh = Math.max(2, maxRow * 0.25)
  const bandsAll: Array<{ y0: number; len: number }> = []
  { let run = 0, start = 0
    for (let y = 0; y <= h; y++) {
      const on = y < h && rowProfile[y] >= bandTh
      if (on) { if (run === 0) start = y; run++ }
      else if (run > 0) { bandsAll.push({ y0: start, len: run }); run = 0 }
    } }
  console.log(`行投影 maxRow=${maxRow}  bandTh=${bandTh.toFixed(1)}  文本带数=${bandsAll.length}`)
  console.log(`  带高分布 = ${bandsAll.map((b) => b.len).sort((a, b) => a - b).join(',')}`)
  const lens = bandsAll.map((b) => b.len).sort((a, b) => a - b)
  const glyphH = Math.max(6, lens[lens.length >> 1] || 8)
  console.log(`  glyphH(中位) = ${glyphH}`)

  // runLen
  const runLen = new Uint16Array(w * h)
  for (let x = 0; x < w; x++) {
    let y = 0
    while (y < h) {
      if (!ink[y * w + x]) { y++; continue }
      let y0 = y
      while (y < h && ink[y * w + x]) y++
      const L = y - y0
      for (let k = y0; k < y; k++) runLen[k * w + x] = L
    }
  }

  // 分区统计 runLen
  const stat = (sel: Uint8Array, name: string) => {
    let n = 0, s = 0, mx = 0
    const arr: number[] = []
    for (let i = 0; i < w * h; i++) {
      if (!ink[i] || !sel[i]) continue
      n++; s += runLen[i]; if (runLen[i] > mx) mx = runLen[i]
      arr.push(runLen[i])
    }
    arr.sort((a, b) => a - b)
    console.log(`  ${name.padEnd(10)} n=${String(n).padStart(6)}  平均runLen=${(s / Math.max(1, n)).toFixed(1)}  中位=${arr[arr.length >> 1] || 0}  P90=${arr[Math.floor(arr.length * 0.9)] || 0}  max=${mx}`)
  }
  console.log('\n分区 runLen 统计（未做多尺度）：')
  stat(handInk, '手写区')
  stat(printInk, '印刷区')

  // 多尺度影响
  console.log('\n多尺度后 runLen（best = 跨尺度最大）：')
  for (const scales of [[2], [2, 4], [2, 4, 8], [2, 4, 8, 16]]) {
    const best = new Uint16Array(w * h)
    for (const S of scales) {
      const span = maxFilterU16Row(runLen, w, h, S)
      for (let i = 0; i < best.length; i++) if (span[i] > best[i]) best[i] = span[i]
    }
    const tallTh = glyphH * 1.5
    let seedHand = 0, seedPrint = 0
    for (let i = 0; i < w * h; i++) {
      if (!ink[i]) continue
      const t = best[i] / glyphH
      const conf = Math.round(Math.max(0, Math.min(1, (t - 1.1) / 0.5)) * 255)
      if (conf < 64) continue
      if (handInk[i]) seedHand++
      else if (printInk[i]) seedPrint++
    }
    console.log(`  scales=[${scales}] tallTh=${tallTh.toFixed(1)}  种子落在手写区=${seedHand}  种子落在印刷区=${seedPrint}  ` +
      `印刷区种子占比=${((seedPrint / Math.max(1, seedHand + seedPrint)) * 100).toFixed(1)}%`)
  }

  // 生长膨胀后
  console.log('\n生长膨胀后候选分布（scales=[2,4,8,16], grow=0.5*glyphH）：')
  const best = new Uint16Array(w * h)
  for (const S of [2, 4, 8, 16]) {
    const span = maxFilterU16Row(runLen, w, h, S)
    for (let i = 0; i < best.length; i++) if (span[i] > best[i]) best[i] = span[i]
  }
  const seedConf = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    if (!ink[i]) continue
    const t = best[i] / glyphH
    seedConf[i] = Math.round(Math.max(0, Math.min(1, (t - 1.1) / 0.5)) * 255)
  }
  const growR = Math.max(3, Math.round(glyphH * 0.5))
  const grown = maxFilter(seedConf, w, h, growR)
  let candHand = 0, candPrint = 0, candOther = 0, candTotal = 0
  for (let i = 0; i < w * h; i++) {
    if (!ink[i]) continue
    if (grown[i] < 64) continue
    candTotal++
    if (handInk[i]) candHand++
    else if (printInk[i]) candPrint++
    else candOther++
  }
  console.log(`  growR=${growR}  候选总数=${candTotal}  share=${(candTotal / inkTotal).toFixed(3)}`)
  console.log(`    落在手写区=${candHand} (${((candHand / candTotal) * 100).toFixed(1)}%)`)
  console.log(`    落在印刷区=${candPrint} (${((candPrint / candTotal) * 100).toFixed(1)}%)`)
  console.log(`    落在其它(抗锯齿/重叠)=${candOther} (${((candOther / candTotal) * 100).toFixed(1)}%)`)
  console.log(`  手写区召回 = ${((candHand / handN) * 100).toFixed(1)}%   印刷区误伤 = ${((candPrint / printN) * 100).toFixed(1)}%`)
}
main().catch((e) => { console.error(e); process.exit(1) })
