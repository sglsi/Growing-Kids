/**
 * 三大自有图像功能（去手写 / 自动调正 / 智能高清）实现链路检查 + 修复验证。
 *
 * 背景：用户连续五轮反馈「这三个功能点击后还是不能使用」，并明确它们**不是 AI 功能、
 * 是程序自有功能**。本轮做全链路体检，实测暴露并修复了 4 个真实缺陷：
 *
 *   ① 自动调正：唯一的检测路径（Canny 找纸张外框）在「纸面占满画面」这一最常见
 *      场景下恒不命中 → 后端原样返回原图 → 用户看到「点了没反应」。
 *      → 新增文本行投影倾斜估计（image-deskew.ts）作为兜底。
 *   ② 去手写：色域阈值只认蓝/红等彩色笔；黑笔/铅笔与印刷体同为近黑 → 覆盖率 0
 *      → 原样返回原图。→ 新增深色墨迹检测（maskFromDarkInk），与色域法取并集。
 *   ③ 去手写底层：sharp 对 `raw:{channels:1}` 做任何操作后输出都是 **3 通道**，
 *      老代码按单通道索引 → mask 纵向错位 / 覆盖率失真。→ 新增 alignMask 统一取通道 0。
 *   ④ 反馈闭环：三个功能都有「安全地原样返回」的分支，此前前端一律当成功静默替换
 *      → 用户永远拿不到原因。→ 后端带 debug.notice，前端弹窗告知。
 *
 * 运行：cd push-ready/server && npx tsx /workspace/dynamic-tests/run-issue-three-features.ts
 */
import * as fs from 'fs'
import * as path from 'path'
import sharp from 'sharp'
import { straightenImage } from '../server/src/image/image-dewarp'
import { estimateSkew, deskewImage } from '../server/src/image/image-deskew'
import { enhanceImage } from '../server/src/image/image-superres'
import {
  maskFromColorThreshold, maskFromDarkInk, unionMasks, alignMask,
  inpaint, blendWithMask, unmodifiedRegionSimilarity,
} from '../server/src/image/handwriting-mask'

const ROOT = path.resolve(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`) }
}

/* ============================ 测试素材 ============================ */

const W = 900, H = 1200
const PRINT_FS = 22

// ⚠️ 版面必须保证「题目」与「作答区」分离（实测教训）：
//   旧版面行距仅 78px 却用 44px 字号作答，手写在物理上必然压住上面的题目文字，
//   于是"手写行"被印刷行吞并，行级判据无从分离 —— 这既不是真实试卷的样子，
//   也会让测试只测到"压字"这一极端分支。现按每组 140px 重排，留出作答区。
const GROUPS = 7
const ROW_H = 140
const PRINT_BASE = (i: number) => 100 + i * ROW_H
const RULE_Y = (i: number) => 118 + i * ROW_H
const HAND_BASE = (i: number) => 178 + i * ROW_H

function printedLayer(): string {
  return Array.from({ length: GROUPS }, (_, i) =>
    `<text x="80" y="${PRINT_BASE(i)}" font-family="serif" font-size="${PRINT_FS}" fill="#111">` +
    `一、填空题 第 ${i + 1} 题：请根据题意把答案写在下面的横线上。` +
    `</text><line x1="80" y1="${RULE_Y(i)}" x2="820" y2="${RULE_Y(i)}" stroke="#bbb" stroke-width="1"/>`,
  ).join('')
}

/** 试卷：印刷正文（小字、成行）+ 写在横线下方作答区的手写答案（可指定笔色与字号） */
function sheet(handColor: string, handFs: number, handText = '解答：36 厘米'): Buffer {
  const hand = Array.from({ length: GROUPS }, (_, i) =>
    `<text x="150" y="${HAND_BASE(i)}" font-family="serif" font-size="${handFs}" fill="${handColor}">${handText} ${i + 1}</text>`).join('')
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#fdfdfa"/>${printedLayer()}${hand}</svg>`)
}

/** 压字作答（困难场景）：手写直接压在题目文字上 —— 已知边界，应主动放弃 */
function sheetOverlap(handColor: string, handFs: number): Buffer {
  const hand = Array.from({ length: GROUPS }, (_, i) =>
    `<text x="150" y="${PRINT_BASE(i) + 8}" font-family="serif" font-size="${handFs}" fill="${handColor}">解答：36 厘米 ${i + 1}</text>`).join('')
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#fdfdfa"/>${printedLayer()}${hand}</svg>`)
}

/** 纯印刷（无手写） */
function purePrinted(): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#fff"/>
    ${Array.from({ length: 16 }, (_, i) => `<text x="80" y="${120 + i * 62}" font-family="serif" font-size="${PRINT_FS}" fill="#111">纯印刷体测试文本第 ${i + 1} 行，不含任何手写内容，用于验证不会误擦。</text>`).join('')}
  </svg>`)
}

/** 只有文字行的图（用于倾斜估计的符号验证） */
function textPage(): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#fff"/>
    ${Array.from({ length: 14 }, (_, i) => `<text x="80" y="${120 + i * 70}" font-family="serif" font-size="30" fill="#111">这是一行印刷体测试文字 ${i + 1} 用于倾斜检测</text>`).join('')}
  </svg>`)
}

const jpg = (svg: Buffer, blur = 0) => {
  const p = sharp(svg)
  return (blur > 0 ? p.blur(blur) : p).jpeg({ quality: 93 }).toBuffer()
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

/**
 * 手写墨迹的 ground truth：渲染一张**只有手写**的图，取深色像素并膨胀 2px
 * （容纳抗锯齿），得到"原本有笔迹"的像素集合。
 */
async function inkGroundTruth(color: string, fs2: number): Promise<Uint8Array> {
  const hand = Array.from({ length: GROUPS }, (_, i) =>
    `<text x="150" y="${HAND_BASE(i)}" font-family="serif" font-size="${fs2}" fill="${color}">解答：36 厘米 ${i + 1}</text>`).join('')
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#fff"/>${hand}</svg>`)
  const g = await sharp(svg).png().grayscale().raw().toBuffer()
  let cur = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) cur[i] = g[i] < 200 ? 1 : 0
  for (let d = 0; d < 2; d++) {
    const nx = new Uint8Array(W * H)
    for (let y = 0; y < H; y++) {
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
    }
    cur = nx
  }
  return cur
}

/**
 * 残笔率：GT 手写区内，输入是深色、输出**仍是深色**的像素比例。
 * 这是用户真正感知的"擦干净了没有"——mask 召回再高，填充源错了也白搭。
 */
async function residualRatio(before: Buffer, after: Buffer, gt: Uint8Array): Promise<number> {
  const a = await sharp(before).resize(W, H, { fit: 'fill' }).grayscale().raw().toBuffer()
  const b = await sharp(after).resize(W, H, { fit: 'fill' }).grayscale().raw().toBuffer()
  let n = 0, remain = 0
  for (let i = 0; i < W * H; i++) {
    if (!gt[i]) continue
    n++
    if (a[i] < 150 && b[i] < 150) remain++
  }
  return n ? remain / n : 0
}

/**
 * 接缝梯度：所有**相邻且 mask 值不同**的像素对上，输出亮度的梯度。
 * 硬 mask 只有边界一圈样本（每处梯度 = 整段跳变）；
 * 软 mask 的整个羽化带都是样本（每处 ≈ 跳变/feather）—— 这正是羽化的价值所在。
 * 故必须测"每一步的梯度"，而不是"跨二值边界的总差"（后者测不出羽化，见 2.17）。
 */
async function seamGradient(out: Buffer, mask: { width: number; height: number; data: Buffer; coverage: number; source: string }) {
  const o = await sharp(out).resize(W, H, { fit: 'fill' }).grayscale().raw().toBuffer()
  const m = await alignMask(mask as never, W, H)
  const diffs: number[] = []
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (x + 1 < W && m[i] !== m[i + 1]) diffs.push(Math.abs(o[i] - o[i + 1]))
      if (y + 1 < H && m[i] !== m[i + W]) diffs.push(Math.abs(o[i] - o[i + W]))
    }
  }
  if (!diffs.length) return { mean: 0, p99: 0, n: 0 }
  diffs.sort((a, b) => a - b)
  return {
    mean: diffs.reduce((s, v) => s + v, 0) / diffs.length,
    p99: diffs[Math.floor(diffs.length * 0.99)],
    n: diffs.length,
  }
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
  /* ==================== 一、自动调正（几何纠偏 + 倾斜兜底） ==================== */
  console.log('\n=== 一、自动调正 ===')
  const deskewSrc = read('server/src/image/image-deskew.ts')
  const dewarpSrc = read('server/src/image/image-dewarp.ts')
  ok('1.1 新增 image-deskew.ts（文本行倾斜估计模块）', fs.existsSync(path.join(ROOT, 'server/src/image/image-deskew.ts')))
  ok('1.2 导出 estimateSkew / deskewImage', /export async function estimateSkew/.test(deskewSrc) && /export async function deskewImage/.test(deskewSrc))
  ok('1.3 倾斜估计走"投影轮廓"而非纸张外框', /projectionScore/.test(deskewSrc) && /Σhist²/.test(deskewSrc))

  const flatPage = await jpg(textPage())
  for (const deg of [5, -7]) {
    const tilted = await sharp(flatPage).rotate(deg, { background: '#ffffff' }).jpeg({ quality: 93 }).toBuffer()
    const est = await estimateSkew(tilted)
    const residual = Math.abs(deg + est.rotateDeg)
    ok(
      `1.4 真实倾斜 ${deg}° → 估计 ${est.rotateDeg}°，施加后残差 ${residual.toFixed(2)}° ≤ 0.5°`,
      residual <= 0.5,
      `(置信 ${est.confidence.toFixed(2)})`,
    )
  }
  ok('1.5 正图不做无谓旋转（deskewImage 返回 null）', (await deskewImage(flatPage)) === null)

  // 关键场景：纸面占满画面（无纸张外框）—— 老实现 100% 失效
  const sheetFlat = await jpg(sheet('#222222', 44), 0.8)
  const sheetTilt = await sharp(sheetFlat).rotate(-4.5, { background: '#e8e8e4' }).jpeg({ quality: 93 }).toBuffer()
  const tiltRes = await straightenImage(sheetTilt, { auto: true })
  ok(
    '1.6 ★ 纸面占满画面的倾斜图：不再"原样返回"，走 skew 兜底成功纠偏',
    tiltRes.needManual === false && tiltRes.method === 'skew',
    `(method=${tiltRes.method}, rotate=${tiltRes.rotateDeg}°, ${tiltRes.width}x${tiltRes.height})`,
  )
  ok('1.7 纠偏方向正确（旋转角与倾斜反号，残差 ≤0.5°）', Math.abs((tiltRes.rotateDeg ?? 0) - 4.5) <= 0.5)

  const upright = await straightenImage(sheetFlat, { auto: true })
  ok('1.8 本来就正的图：不做改动（needManual=true，交给 notice 提示）', upright.needManual === true && upright.method === 'none')

  const manual = [[0.08, 0.06], [0.9, 0.11], [0.93, 0.94], [0.05, 0.9]].map(([x, y]) => [x * W, y * H]) as any
  const manualRes = await straightenImage(sheetFlat, { manualCorners: manual, auto: true })
  ok('1.9 手动四角仍优先于自动路径（method=manual）', manualRes.method === 'manual' && manualRes.needManual === false)

  ok('1.10 image-dewarp 已接入 skew 兜底', /opts\.deskew !== false/.test(dewarpSrc) && /deskewImage/.test(dewarpSrc))
  // 逐项断言而非整串匹配：新增路径（如 perspective）时不必改这条用例，
  // 而漏掉某个已有路径仍会被抓出来。
  {
    const union = /method\?: ([^;\n]+)/.exec(dewarpSrc)?.[1] ?? ''
    for (const m of ['manual', 'auto', 'curved', 'skew', 'perspective', 'none']) {
      ok(`1.11 StraightenOutput.method 含 '${m}'`, union.includes(`'${m}'`))
    }
  }

  /* ==================== 二、去手写（深色笔迹 + 通道修复） ==================== */
  console.log('\n=== 二、去手写 ===')
  const maskSrc = read('server/src/image/handwriting-mask.ts')
  const segSrc = read('server/src/image/handwriting-segmenter.ts')
  ok('2.1 新增 maskFromDarkInk（深色墨迹检测）', /export async function maskFromDarkInk/.test(maskSrc))
  ok('2.2 新增 unionMasks（色域 ∪ 深色）', /export async function unionMasks/.test(maskSrc))
  ok('2.3 分割流程已取并集（不再只靠色域阈值）', /maskFromDarkInk/.test(segSrc) && /unionMasks/.test(segSrc))

  // ③ 通道修复：sharp 对单通道 raw 操作后实际输出 3 通道
  const probe = Buffer.alloc(100 * 80, 0)
  for (let i = 0; i < probe.length; i++) probe[i] = i % 7 === 0 ? 255 : 0
  const rawOut = await sharp(probe, { raw: { width: 100, height: 80, channels: 1 } }).resize(50, 40, { fit: 'fill' }).raw().toBuffer()
  ok('2.4 复现隐患：sharp 单通道 raw → 输出实为 3 通道', rawOut.length === 50 * 40 * 3, `(len=${rawOut.length})`)
  const aligned = await alignMask({ width: 100, height: 80, data: probe, coverage: 0.1, source: 'threshold' }, 50, 40)
  ok('2.5 alignMask 修复：返回严格单通道且长度 = w*h', aligned.length === 50 * 40, `(len=${aligned.length})`)

  const cases: [string, string, number][] = [
    ['黑色中性笔(大字)', '#222222', 44],
    ['铅笔灰(大字)', '#5a5a5a', 44],
  ]
  for (const [name, color, fs_] of cases) {
    const img = await jpg(sheet(color, fs_), 0.6)
    const chroma = await maskFromColorThreshold(img)
    const dark = await maskFromDarkInk(img)
    const union = await unionMasks(chroma, dark)
    ok(
      `2.6 ★ ${name}：色域法 ${(chroma.coverage * 100).toFixed(2)}% → 深色法 ${(dark.coverage * 100).toFixed(2)}%（从 0 救回来）`,
      chroma.coverage < 0.001 && union.coverage > 0.005,
      `(并集 ${(union.coverage * 100).toFixed(2)}%)`,
    )
  }

  {
    const img = await jpg(sheet('#1a3fd6', 40), 0.6)
    const chroma = await maskFromColorThreshold(img)
    const dark = await maskFromDarkInk(img)
    const union = await unionMasks(chroma, dark)
    ok('2.7 蓝色圆珠笔：色域法有效，并集 ≥ 任一单路', chroma.coverage > 0.005 && union.coverage >= Math.max(chroma.coverage, dark.coverage) - 1e-9,
      `(色域 ${(chroma.coverage * 100).toFixed(2)}% 深色 ${(dark.coverage * 100).toFixed(2)}% 并集 ${(union.coverage * 100).toFixed(2)}%)`)
  }

  // 反例：宁可漏，不可错擦印刷体
  const pureImg = await jpg(purePrinted(), 0.6)
  ok('2.8 纯印刷体（无手写）：覆盖率 ≈ 0，绝不误擦', (await maskFromDarkInk(pureImg)).coverage < 0.001)
  const bigTitle = await jpg(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#fff"/>
    ${Array.from({ length: 5 }, (_, i) => `<text x="80" y="${160 + i * 200}" font-family="serif" font-size="64" fill="#111">第 ${i + 1} 大题 标题</text>`).join('')}
  </svg>`), 0.6)
  ok('2.9 大号印刷标题：护栏拦下，覆盖率 ≈ 0', (await maskFromDarkInk(bigTitle)).coverage < 0.001)
  const allHand = await jpg(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#fff"/>
    ${Array.from({ length: 14 }, (_, i) => `<text x="80" y="${110 + i * 78}" font-family="serif" font-size="52" fill="#222">整页手写第 ${i + 1} 行内容</text>`).join('')}
  </svg>`), 0.6)
  ok('2.10 整页手写（极端）：护栏拦下，绝不整页擦除', (await maskFromDarkInk(allHand)).coverage < 0.001)

  // 已知边界（显式断言，而非悄悄忽略）：手写**压在印刷文字上**时，
  // 手写行被印刷行吞并 → 行级判据无从分离。此时主动放弃是**正确行为**：
  // 即便强行检出，擦除也会连带毁掉被压住的印刷内容。
  {
    const ov = await jpg(sheetOverlap('#222222', 42), 0.6)
    const darkOv = await maskFromDarkInk(ov)
    ok('2.10b ★ 压字作答（已知边界）：主动放弃，覆盖率 ≈ 0 —— 宁可不擦也不毁题',
      darkOv.coverage < 0.001,
      `(${JSON.stringify(darkOv.debug)})`)
  }

  // 软 mask：羽化后应存在中间灰阶（硬二值 mask 是可见接缝的第一大成因）
  {
    const img = await jpg(sheet('#222222', 42), 0.6)
    const dark = await maskFromDarkInk(img)
    let soft = 0
    for (let i = 0; i < dark.data.length; i++) if (dark.data[i] > 8 && dark.data[i] < 247) soft++
    const softRatio = soft / dark.data.length
    ok('2.10c ★ mask 为软 mask（存在中间灰阶，非硬 0/255）', softRatio > 0.005,
      `(软像素 ${(softRatio * 100).toFixed(2)}%)`)
  }

  // 端到端：mask → inpaint → blend，且非手写区像素必须原样保留
  {
    const img = await jpg(sheet('#222222', 44), 0.6)
    const mask = await unionMasks(await maskFromColorThreshold(img), await maskFromDarkInk(img))
    ok('2.11 端到端：黑笔手写 mask 覆盖 > 0.5%', mask.coverage > 0.005, `(${(mask.coverage * 100).toFixed(2)}%)`)
    const merged = await blendWithMask(img, await inpaint(img, 'adaptive', mask), mask)
    const d = await meanDiff(img, merged)
    const sim = await unmodifiedRegionSimilarity(img, merged, mask)
    ok('2.12 端到端：确实改了图（改动像素 > 0.5%）', d.changedRatio > 0.005, `(${(d.changedRatio * 100).toFixed(2)}%)`)
    ok('2.13 端到端：非手写区像素原样保留（一致性 > 99%）', sim.similarity > 0.99, `(${(sim.similarity * 100).toFixed(2)}%)`)
  }

  // ────────────────────────────────────────────────────────────────────
  // 以下 2.14~2.17 是第七轮「修复环节」实测暴露的三个缺陷的**防复发断言**。
  // 它们的共同点：mask 指标（召回/误擦）**全部达标**，但用户看到的图仍然是脏的/花的。
  // 只测 mask 会完全漏掉这类问题 —— 必须测端到端产出。
  // ────────────────────────────────────────────────────────────────────

  // 2.14 ★ 残笔率：修复环节曾把**手写墨迹本身**当成"可信印刷结构"取作填充源，
  //      于是"拿墨迹补墨迹"，越擦越黑。实测黑笔残笔率高达 40.44%、铅笔 37.05%
  //      （蓝笔因 chroma≈142 天然被排除，只有 0.05%，掩盖了这个 bug 很久）。
  //      铁律：填充源只能来自已知区域（mask 之外）—— Criminisi / Telea / Navier-Stokes 一脉。
  for (const [label, color] of [['黑笔', '#222222'], ['铅笔', '#5a5a5a'], ['蓝笔', '#1a3fd6']] as const) {
    const img = await jpg(sheet(color, 42), 0.6)
    const gt = await inkGroundTruth(color, 42)
    const mask = await unionMasks(await maskFromColorThreshold(img), await maskFromDarkInk(img))
    const merged = await blendWithMask(img, await inpaint(img, 'adaptive', mask), mask)
    const remain = await residualRatio(img, merged, gt)
    ok(`2.14 ★ ${label}端到端残笔率 < 1%（防"拿墨迹补墨迹"复发）`, remain < 0.01,
      `(${(remain * 100).toFixed(2)}%)`)
  }

  // 2.15 ★ 判据一致性：structuralExtend 曾硬编码 `luma <= 170`，而 classifyMaskRegions
  //      用的是 DEFAULT_PRINT_CRITERION(190)。同一概念两套定义 → 印刷横线(#bbb,
  //      luma≈187) 被分类判为"压字区"，延拓阶段却一个"结构"都找不到 → 静默降级。
  {
    // ⚠️ 必须剥掉注释再匹配：源码注释里刻意保留了 "上一版硬编码 luma <= 170" 这段
    //    故障记录（那是宝贵的事故档案），裸匹配会把注释当成残留代码而误报 FAIL。
    const srcText = read('server/src/image/handwriting-mask.ts')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    ok('2.15 ★ 印刷体判据全局唯一（延拓不再硬编码 170）',
      !/luma\s*<=\s*170/.test(srcText) &&
      /criterion\.chromaMax/.test(srcText) && /criterion\.lumaMax/.test(srcText))
    ok('2.15b ★ mask 携带紧种子 seed（源排除区，与膨胀后的修复范围分离）',
      /seed\?:\s*Buffer/.test(srcText) && /mask\.seed/.test(srcText))
  }

  // 2.16 ★ 结构接回：手写压住印刷横线时，必须把线接回来，而不是留一段白缺口。
  //      旧实现只做半径 ~11px 的近场最近邻搜索 → 300px 长的缺口只接得回两端各 11px
  //      （实测接回率 0.71%）。现按"该行在 mask 外的结构密度"判定贯穿线后整体延拓。
  //      ⚠️ 判据不能用"两端都看得到且颜色接近"—— 实测那样会把整块手写区填成灰色
  //      补丁（接缝均值 0.38 → 21.73）。线的本质是**同行连续**，不是两端可见。
  {
    const RY = 118
    // ⚠️ 半像素 y：stroke-width=1 落在整数 y 上会被抗锯齿摊成两行各 220 亮度，
    //    既不像真实印刷线，也会让 luma 判据集体失效。落 x.5 才得到锐利 187。
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect width="${W}" height="${H}" fill="#fdfdfa"/>
      <line x1="80" y1="${RY + 0.5}" x2="820" y2="${RY + 0.5}" stroke="#bbb" stroke-width="1"/>
    </svg>`)
    const img = await sharp(svg).png().toBuffer()
    const data = Buffer.alloc(W * H, 0)
    for (let y = RY - 10; y <= RY + 10; y++) for (let x = 300; x < 600; x++) data[y * W + x] = 255
    const m = { width: W, height: H, data, coverage: (21 * 300) / (W * H), source: 'manual' } as const
    const recover = async (png: Buffer) => {
      const g = await sharp(png).resize(W, H, { fit: 'fill' }).grayscale().raw().toBuffer()
      let hit = 0
      for (let x = 310; x < 590; x++) {
        let best = 255
        for (let y = RY - 2; y <= RY + 2; y++) best = Math.min(best, g[y * W + x])
        if (best < 245) hit++ // 相对判据：纸≈253，线≈187
      }
      return hit / 280
    }
    const maskedOut = await blendWithMask(img, await inpaint(img, 'masked', m), m)
    const adaptOut = await blendWithMask(img, await inpaint(img, 'adaptive', m), m)
    const rM = await recover(maskedOut), rA = await recover(adaptOut)
    ok('2.16 ★ 压字横线被接回（adaptive > 90%，而 masked ≈ 0）', rA > 0.9 && rM < 0.05,
      `(masked ${(rM * 100).toFixed(1)}% → adaptive ${(rA * 100).toFixed(1)}%)`)
  }

  // 2.18 ★ **模糊鲁棒性**（本轮最重要的发现，务必守住）：
  //      墨迹密度护栏用绝对阈值 0.30 时，拍照模糊会让笔画变粗、密度上升 20~50%，
  //      于是真实手写被整片误杀：黑笔 blur=1.0 时覆盖率 **6.71% → 0%**（功能消失）。
  //      这正是"测试图正常、用户拍的照片没反应"的成因。改用基线众数判据后守住。
  {
    const sharpCov = (await maskFromDarkInk(await jpg(sheet('#222222', 42), 0))).coverage
    for (const blur of [0.6, 1.0]) {
      const cov = (await maskFromDarkInk(await jpg(sheet('#222222', 42), blur))).coverage
      ok(`2.18 ★ 拍照模糊 blur=${blur} 时覆盖率不崩（仍 ≥ 清晰图的 80%）`,
        cov >= sharpCov * 0.8,
        `(清晰 ${(sharpCov * 100).toFixed(2)}% → 模糊 ${(cov * 100).toFixed(2)}%)`)
    }
    // 同时守住反例：大号印刷标题在模糊下也绝不能被放行
    const bigTitle = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect width="${W}" height="${H}" fill="#fdfdfa"/>
      ${Array.from({ length: 4 }, (_, i) => `<text x="80" y="${120 + i * 260}" font-family="serif" font-size="46" fill="#111">第三章 综合运算 ${i + 1}</text>`).join('')}
      ${Array.from({ length: 4 }, (_, i) => Array.from({ length: 5 }, (_, k) => `<text x="80" y="${170 + i * 260 + k * 34}" font-family="serif" font-size="${PRINT_FS}" fill="#111">这里是正常的印刷正文内容第 ${i * 5 + k + 1} 行，用于提供正文基准密度。</text>`).join('')).join('')}
    </svg>`)
    for (const blur of [0, 0.6]) {
      const cov = (await maskFromDarkInk(await jpg(bigTitle, blur))).coverage
      ok(`2.18b ★ 大号印刷标题 blur=${blur} 仍被拦下（覆盖 ≈ 0）`, cov < 0.001,
        `(${(cov * 100).toFixed(2)}%)`)
    }
  }

  // 2.17 ★ 接缝：接回逻辑若失控会把整块区域填成灰补丁。这里守住上界。
  //      度量用「mask 值发生变化处的输出亮度梯度」而非"跨二值边界的总差"——
  //      羽化的价值是把跳变摊到 feather 个像素上，只有梯度才是正确的可观测量。
  {
    const img = await jpg(sheet('#222222', 42), 0.6)
    const mask = await unionMasks(await maskFromColorThreshold(img), await maskFromDarkInk(img))
    const merged = await blendWithMask(img, await inpaint(img, 'adaptive', mask), mask)
    const seam = await seamGradient(merged, mask)
    ok('2.17 ★ 接缝梯度 p99 < 10（修复区不是一块可见补丁）', seam.p99 < 10,
      `(均值 ${seam.mean.toFixed(2)} / p99 ${seam.p99})`)
  }

  /* ==================== 三、智能高清 ==================== */
  console.log('\n=== 三、智能高清 ===')
  const src = await jpg(sheet('#222222', 44), 1.1) // 模拟拍照模糊
  const sr = await enhanceImage(src, { scale: 2, mode: 'classical' })
  const sm = await sharp(sr.buffer).metadata()
  ok('3.1 输出为 2 倍尺寸', sm.width === W * 2 && sm.height === H * 2, `(${sm.width}x${sm.height})`)
  const pureUp = await sharp(src).resize(sm.width!, sm.height!, { kernel: 'lanczos3' }).jpeg({ quality: 95 }).toBuffer()
  const sPure = await sharpness(pureUp)
  const sSr = await sharpness(sr.buffer)
  const gain = ((sSr - sPure) / sPure) * 100
  ok('3.2 ★ 锐度显著高于"单纯放大"（增益 > 15%）', gain > 15, `(+${gain.toFixed(1)}%：${sPure.toFixed(3)} → ${sSr.toFixed(3)})`)
  const dsr = await meanDiff(pureUp, sr.buffer)
  ok('3.3 相对纯放大确有像素改动（改动像素 > 1%）', dsr.changedRatio > 0.01, `(${(dsr.changedRatio * 100).toFixed(2)}%)`)

  /* ==================== 四、反馈闭环（终结"点了没反应"） ==================== */
  console.log('\n=== 四、反馈闭环 ===')
  const typesSrc = read('server/src/image/image.types.ts')
  const svcSrc = read('server/src/image/image.service.ts')
  const apiSrc = read('src/services/api.ts')
  const editorSrc = read('src/components/image-editor.tsx')

  ok('4.1 image.types.ts 定义 ImageNotice', /export interface ImageNotice/.test(typesSrc))
  ok('4.2 ImageProcessResult.debug 允许携带 notice', /notice\?:\s*ImageNotice/.test(typesSrc))
  // 三处 no-op 分支
  const eraseBlock = svcSrc.slice(svcSrc.indexOf('未检测到手写，原图返回') - 400, svcSrc.indexOf('未检测到手写，原图返回') + 400)
  ok('4.3 去手写"未检出手写"分支带 notice', /notice:/.test(eraseBlock) && /未检测到可擦除的手写/.test(eraseBlock))
  const straightBlock = svcSrc.slice(svcSrc.indexOf('请前端拉出试卷四角后提交 auto') - 400, svcSrc.indexOf('请前端拉出试卷四角后提交 auto') + 400)
  ok('4.4 自动调正"未识别到歪斜"分支带 notice', /notice:/.test(straightBlock) && /未能自动识别到歪斜/.test(straightBlock))
  ok('4.5 智能高清"OCR 回退原图"分支带 notice', /ocrFallback[\s\S]{0,400}?notice:/.test(svcSrc) && /高清处理未通过内容校验/.test(svcSrc))
  ok('4.6 前端 ImageProcessResult 类型含 debug.notice', /ImageProcessResult/.test(apiSrc) && /notice\?:\s*\{\s*level/.test(apiSrc))
  ok('4.7 ★ 前端成功路径读取 notice 并弹窗（不再只弹 toast）', /debug\?\.notice/.test(editorSrc) && /showModal/.test(editorSrc.slice(editorSrc.indexOf('debug?.notice') - 200, editorSrc.indexOf('debug?.notice') + 600)))

  /* ==================== 五、两线同步 ==================== */
  console.log('\n=== 五、两线同步（push-ready ↔ demo） ===')
  for (const f of ['src/services/api.ts', 'src/components/image-editor.tsx']) {
    ok(`5.x ${f} 两线一致`,
      fs.existsSync(path.join(ROOT, 'server/src', f)) &&
      fs.existsSync(path.join(ROOT, 'demo', f)) &&
      read(path.join('server/src', f)) === read(path.join('demo', f)))
  }

  console.log(`\n结果：PASS ${pass} / FAIL ${fail}`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
