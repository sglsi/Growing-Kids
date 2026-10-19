/**
 * 【端到端】去手写全链路验证：mask → inpaint → blend 的真实产出质量
 *
 * mask 的 IoU/召回只是中间指标，用户真正感知的是四件事：
 *   ① 残笔率：擦完之后，原来有手写的区域还剩多少深色像素（越低越"干净"）
 *   ② 接缝可见度：修复区与原图的交界是否存在突变（软 mask 应显著低于硬 mask）
 *   ③ 非手写区一致性：不该动的地方必须一个像素都没动
 *   ④ 结构接回：手写压住印刷横线时，横线是否被接回（adaptive 相对 masked 的价值）
 *
 * ── 关于接缝度量的口径（踩过的坑，务必保留）───────────────────────────────
 * 最初把"接缝"定义为「mask 值介于 0 与 255 之间的过渡带像素的最大亮度跳变」。
 * 这个口径**不可比**：硬 mask 已二值化、中间灰阶像素数为 0，于是永远得 0 分，
 * 看起来"比软 mask 的 223 好"，纯粹是统计样本为空的假象。
 * 正确口径必须对硬/软 mask 使用**同一空间定义**：先把 mask 二值化，
 * 再取「跨边界像素对」（一侧在 mask 内、一侧在 mask 外）的亮度差。
 *
 * 运行：cd /workspace/projects/server && npx tsx /workspace/dynamic-tests/probe-erase-e2e.ts
 */
import sharp from 'sharp'
import {
  maskFromColorThreshold,
  maskFromDarkInk,
  unionMasks,
  inpaint,
  blendWithMask,
  unmodifiedRegionSimilarity,
  type HandwritingMask,
} from '/workspace/projects/server/src/image/handwriting-mask'

const W = 900, H = 1200, PRINT_FS = 22
const GROUPS = 7, ROW_H = 140
const PRINT_BASE = (i: number) => 100 + i * ROW_H
// ⚠️ 半像素 y：SVG 中 stroke-width=1 的线若落在整数 y 上，会被抗锯齿**摊成两行**
//    （实测各 220 亮度），既不像真实印刷线，也会让依赖 luma 阈值的判据集体失效。
//    落在 x.5 上才能得到锐利的 1px 线（实测 187）。这是 fixture 自身的真实性问题。
const RULE_Y = (i: number) => 118.5 + i * ROW_H
const HAND_BASE = (i: number) => 178 + i * ROW_H
const LABEL = '解答：36厘米'

function printedLayer(): string {
  return Array.from({ length: GROUPS }, (_, i) =>
    `<text x="80" y="${PRINT_BASE(i)}" font-family="serif" font-size="${PRINT_FS}" fill="#111">一、填空题 第 ${i + 1} 题：请根据题意把答案写在下面的横线上。</text>` +
    `<line x1="80" y1="${RULE_Y(i)}" x2="820" y2="${RULE_Y(i)}" stroke="#bbb" stroke-width="1"/>`).join('')
}
function svgFull(color: string, fs: number): string {
  const hand = Array.from({ length: GROUPS }, (_, i) =>
    `<text x="150" y="${HAND_BASE(i)}" font-family="serif" font-size="${fs}" fill="${color}">${LABEL} ${i + 1}</text>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fdfdfa"/>${printedLayer()}${hand}</svg>`
}
function svgHandOnly(color: string, fs: number): string {
  const hand = Array.from({ length: GROUPS }, (_, i) =>
    `<text x="150" y="${HAND_BASE(i)}" font-family="serif" font-size="${fs}" fill="${color}">${LABEL} ${i + 1}</text>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${hand}</svg>`
}

/** GT：手写墨迹（膨胀 2 容纳抗锯齿） */
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

/** 二值化 mask（模拟改造前的硬 mask） */
function harden(m: HandwritingMask): HandwritingMask {
  const d = Buffer.alloc(m.data.length)
  for (let i = 0; i < d.length; i++) d[i] = m.data[i] > 127 ? 255 : 0
  return { ...m, data: d }
}

/**
 * ⭐ 接缝可见度（硬/软 mask **同口径**）。
 *
 * 定义：遍历所有**相邻像素对**，只要两者的 mask 值不同（说明处在不透明度发生变化
 * 的位置），就记录输出图在这一对像素上的亮度梯度。取均值与 p99。
 *
 * ── 为什么必须是"梯度"而不是"跨二值边界的差"（口径踩坑记录）──────────────
 * 第一版把 mask 二值化后测"内 vs 外"的亮度差。这个口径对硬/软都用同一条二值
 * 边界，看似公平，实则**测不出羽化的价值**：羽化的作用不是缩小总跳变（总跳变
 * 由"笔迹色 vs 纸色"决定，改不了），而是把这一跳变**摊到 feather 个像素上**，
 * 让每一像素的梯度变小。所以正确的可观测量是**每一步的梯度**。
 *
 * 于是样本集合天然不同（这正是物理事实）：
 *   硬 mask：只有边界 1 圈样本，每处梯度 = 整段跳变；
 *   软 mask：整个羽化带都是样本，每处梯度 ≈ 跳变 / feather。
 * 均值越低 = 融合越柔和。
 */
async function seamScore(out: Buffer, mask: HandwritingMask): Promise<{ mean: number; p99: number; n: number }> {
  const o = await sharp(out).resize(W, H, { fit: 'fill' }).grayscale().raw().toBuffer()
  const { alignMask } = await import('/workspace/projects/server/src/image/handwriting-mask')
  const m = await alignMask(mask, W, H)

  const diffs: number[] = []
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      // 与右邻、下邻比较（避免重复计数）
      if (x + 1 < W && m[i] !== m[i + 1]) diffs.push(Math.abs(o[i] - o[i + 1]))
      if (y + 1 < H && m[i] !== m[i + W]) diffs.push(Math.abs(o[i] - o[i + W]))
    }
  }
  if (!diffs.length) return { mean: 0, p99: 0, n: 0 }
  diffs.sort((a, b) => a - b)
  const sum = diffs.reduce((s, v) => s + v, 0)
  return { mean: sum / diffs.length, p99: diffs[Math.floor(diffs.length * 0.99)], n: diffs.length }
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`
const fx = (v: number) => v.toFixed(2)

async function main() {
  console.log('=== 去手写端到端产出质量 ===\n')
  console.log('笔色'.padEnd(10) + '残笔率'.padEnd(10) + '非手写一致性'.padEnd(14) + '硬mask接缝(均值/p99)'.padEnd(22) + '软mask接缝(均值/p99)')

  for (const [name, color, fs] of [['黑笔', '#222222', 42], ['铅笔', '#5a5a5a', 42], ['蓝笔', '#1a3fd6', 42]] as const) {
    const img = await sharp(Buffer.from(svgFull(color, fs))).jpeg({ quality: 96 }).toBuffer()
    const gt = await gtMask(await sharp(Buffer.from(svgHandOnly(color, fs))).png().toBuffer())

    const soft = await unionMasks(await maskFromColorThreshold(img), await maskFromDarkInk(img))
    if (soft.coverage <= 0) { console.log(`${name.padEnd(10)} 未检出（跳过）`); continue }

    // 软 mask 链路
    const mergedSoft = await blendWithMask(img, await inpaint(img, 'adaptive', soft), soft)
    // 硬 mask 链路（对照）
    const hard = harden(soft)
    const mergedHard = await blendWithMask(img, await inpaint(img, 'adaptive', hard), hard)

    // 残笔率：GT 手写区内，输出仍为深色的像素比例
    const outG = await sharp(mergedSoft).resize(W, H, { fit: 'fill' }).grayscale().raw().toBuffer()
    const inG = await sharp(img).resize(W, H, { fit: 'fill' }).grayscale().raw().toBuffer()
    let gtN = 0, remain = 0
    for (let i = 0; i < W * H; i++) {
      if (!gt[i]) continue
      gtN++
      if (inG[i] < 150 && outG[i] < 150) remain++
    }
    const sim = await unmodifiedRegionSimilarity(img, mergedSoft, soft)
    const sHard = await seamScore(mergedHard, hard)
    const sSoft = await seamScore(mergedSoft, soft)

    console.log(
      name.padEnd(10) + pct(remain / gtN).padEnd(10) + pct(sim.similarity).padEnd(14) +
      `${fx(sHard.mean)} / ${fx(sHard.p99)} (n=${sHard.n})`.padEnd(26) + `${fx(sSoft.mean)} / ${fx(sSoft.p99)} (n=${sSoft.n})`,
    )
  }

  // ── ④ 结构接回验证：手写压住印刷横线时，横线是否被接回来 ──────────────
  // 用人工 mask 覆盖横线中段（模拟"手写压在印刷线上"），对比 masked 与 adaptive。
  console.log('\n=== 结构接回验证（人工 mask 压住横线中段）===\n')
  {
    const RY = Math.round(RULE_Y(0))
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fdfdfa"/>${printedLayer()}</svg>`
    const img = await sharp(Buffer.from(svg)).png().toBuffer()
    const data = Buffer.alloc(W * H, 0)
    for (let y = RY - 10; y <= RY + 10; y++)
      for (let x = 300; x < 600; x++) data[y * W + x] = 255
    const m: HandwritingMask = { width: W, height: H, data, coverage: (21 * 300) / (W * H), source: 'manual' }

    const maskedOut = await blendWithMask(img, await inpaint(img, 'masked', m), m)
    const adaptOut = await blendWithMask(img, await inpaint(img, 'adaptive', m), m)

    // 在被盖住的线段位置上统计"明显暗于纸张"的像素比例 = 接回率。
    // 判据用**相对背景**：纸张 luma≈253，线为 187，取 245 作界（不写死绝对阈值，
    // 免得 fixture 换个底色就失效）。
    const lineRecovered = async (png: Buffer) => {
      const g = await sharp(png).resize(W, H, { fit: 'fill' }).grayscale().raw().toBuffer()
      let n = 0, hit = 0
      for (let x = 310; x < 590; x++) {
        let best = 255
        for (let y = RY - 2; y <= RY + 2; y++) best = Math.min(best, g[y * W + x])
        n++
        if (best < 245) hit++
      }
      return hit / n
    }
    console.log(`masked   接回率 ${pct(await lineRecovered(maskedOut))}`)
    console.log(`adaptive 接回率 ${pct(await lineRecovered(adaptOut))}`)
    console.log('\n接回率 = 被 mask 盖住的横线位置上仍为深色的像素比例（越高 = 横线被接回得越好）')
  }

  console.log('\n残笔率 = 原手写区中仍为深色的像素比例（越低越干净）')
  console.log('接缝   = 跨 mask 边界像素对的亮度差 均值/p99（越低越看不出补丁）')
}
main().catch((e) => { console.error(e); process.exit(1) })
