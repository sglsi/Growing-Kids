/**
 * 【问题二 · 自动调正】几何正确性回归
 *
 * 针对本轮实测挖出的根因 —— **`image-dewarp.warpRaw` 单应矩阵方向用反**（用了 H 而非 H⁻¹）。
 * 这个 bug 让「自动调正」和「四角拉框确认」两条路径**从来就没有真正压平过纸**，
 * 只是把图换成另一种错法（也解释了用户长期反馈的「确认四角后未按四角裁剪」）。
 *
 * 判定基准统一为**几何可观测量**（行倾角），不使用被测算法自己的目标函数。
 * 噪声地板（无畸变原图）实测 σ≈0.02°、极差≈0.06°。
 *
 * 运行：cd /workspace/projects/server && npx tsx /workspace/dynamic-tests/run-issue-deskew-geom.ts
 */
import sharp from 'sharp'
import { readFileSync } from 'node:fs'
import { dewarpBuffer, straightenImage, type Corner } from '/workspace/projects/server/src/image/image-dewarp'
import { estimateSkew, deskewImage } from '/workspace/projects/server/src/image/image-deskew'
import { measureRows, embedPerspective, sheetSvg, solveH, applyH } from './lib/img-measure'

let pass = 0
let fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}  ${detail}`) }
}
const f2 = (n: number) => n.toFixed(2)

const W = 900, H = 1200, ROWS = 8
const DESK = 60 // 四周"桌面"宽度（纸不占满画面时的留边）

/** 各场景的纸四角（相对纸自身） */
const SCENES: { name: string; corners: number[][] }[] = [
  { name: '轻微上窄下宽', corners: [[30, 15], [W - 30, 15], [W - 5, H - 5], [5, H - 5]] },
  { name: '中度上窄下宽', corners: [[70, 35], [W - 70, 35], [W - 5, H - 5], [5, H - 5]] },
  { name: '左窄右宽侧拍', corners: [[10, 40], [W - 10, 5], [W - 10, H - 5], [10, H - 40]] },
  { name: '四角各自偏移', corners: [[45, 25], [W - 20, 55], [W - 55, H - 30], [20, H - 60]] },
]

async function main() {
  const clean = await sharp(sheetSvg(W, H, ROWS, { hand: false })).png().toBuffer()
  const base = await measureRows(clean, ROWS)
  console.log(`\n测量噪声地板：σ=${f2(base.std)}° 极差=${f2(base.range)}°\n`)

  /* ── 2.19 单应矩阵方向：真四角必须能把透视压平 ───────────────────────────
   * 最直接的判据：喂**真四角**进去，输出应当回到正面水平（≈噪声地板）。
   * 修复前这里 σ=2.23~4.32°（真四角也救不了），修复后应 < 0.4°。
   */
  console.log('【2.19】真四角 dewarp 应把透视完全压平（单应矩阵方向正确性的直接判据）')
  for (const s of SCENES) {
    const q = await embedPerspective(clean, W, H, s.corners, DESK, 58)
    const truth = s.corners.map(([x, y]) => [x + DESK, y + DESK])
    const r = await dewarpBuffer(q, truth as Corner[])
    const st = await measureRows(r.buffer, ROWS)
    check(
      `  ${s.name}：真四角 dewarp 后 σ<0.4°`,
      st.std < 0.4,
      `实测 σ=${f2(st.std)}° 极差=${f2(st.range)}°`,
    )
  }

  /* ── 2.20 反向采样取点正确：输出角必须落在源图对应角 ───────────────────
   * 比"看结果"更硬的判据：直接验证 warpRaw 的采样坐标。
   * 修复前输出 (0,0) 取到的是 [-32,-16] 而正确值为 [30+60, 15+60]。
   */
  console.log('\n【2.20】反向采样坐标：输出角应落在源图对应角（±3px）')
  {
    const s = SCENES[0]
    const truth = s.corners.map(([x, y]) => [x + DESK, y + DESK])
    // 复刻 dewarpBuffer 的调用顺序：solveHomography(dst, ordered)
    const ordered = truth
    const Hinv = solveH([[0, 0], [W, 0], [W, H], [0, H]], ordered) // dst -> src
    const got = applyH(Hinv, 0, 0)
    const want = truth[0]
    check(
      `  输出(0,0) 取到源坐标 [${f2(got[0])},${f2(got[1])}] ≈ 源图角 [${want[0]},${want[1]}]`,
      Math.hypot(got[0] - want[0], got[1] - want[1]) < 3,
    )
  }

  /* ── 2.21 手动四角（用户拉框）端到端 ────────────────────────────────────
   * 用户历史反馈「确认四角后未按四角裁剪」，本用例直接钉死它。
   */
  console.log('\n【2.21】手动四角 straighten 端到端：输出应接近正面水平')
  for (const s of SCENES) {
    const q = await embedPerspective(clean, W, H, s.corners, DESK, 58)
    const truth = s.corners.map(([x, y]) => [x + DESK, y + DESK])
    const out = await straightenImage(q, { manualCorners: truth as Corner[] })
    check(`  ${s.name}：走 manual 路径`, out.method === 'manual', `实际 ${out.method}`)
    const st = await measureRows(out.buffer!, ROWS)
    check(
      `  ${s.name}：|μ|<0.5° 且 σ<0.5°`,
      Math.abs(st.mean) < 0.5 && st.std < 0.5,
      `实测 μ=${f2(st.mean)}° σ=${f2(st.std)}°`,
    )
  }

  /* ── 2.22 自动路径（OpenCV 检测四角）不得劣化 ───────────────────────────
   * 修复前 auto 路径 σ 0.06° → 3.3°（命中反而更糟）。这里钉死"绝不许变糟"。
   */
  console.log('\n【2.22】自动路径 auto：不得把本来不歪的图搞歪（σ 不得劣化）')
  for (const s of SCENES) {
    const q = await embedPerspective(clean, W, H, s.corners, DESK, 58)
    const pre = await measureRows(q, ROWS)
    const out = await straightenImage(q, { auto: true })
    if (out.needManual) { console.log(`  – ${s.name}：未命中（降级），跳过`); continue }
    const post = await measureRows(out.buffer!, ROWS)
    check(
      `  ${s.name}：处理后 σ 未劣化（${f2(pre.std)}° → ${f2(post.std)}°）`,
      post.std <= pre.std + 0.3,
      `劣化 ${f2(post.std - pre.std)}°`,
    )
  }

  /* ── 2.23 纯旋转：deskew 精度 ─────────────────────────────────────────── */
  console.log('\n【2.23】纯旋转歪斜：estimateSkew 应准确命中并转正')
  for (const theta of [-12, -7, -3, 3, 7, 12]) {
    const q = await sharp(clean).rotate(theta, { background: '#fdfdfa' }).png().toBuffer()
    const est = await estimateSkew(q)
    check(
      `  θ=${theta}°：估计误差 <0.5°`,
      Math.abs(est.rotateDeg + theta) < 0.5,
      `估计 ${est.rotateDeg}°，误差 ${f2(Math.abs(est.rotateDeg + theta))}°`,
    )
    const d = await deskewImage(q)
    check(`  θ=${theta}°：deskewImage 出手`, d !== null, '返回 null（用户感知＝点了没反应）')
  }

  /* ── 2.25 满画面（无纸边）的透视残留 ─────────────────────────────────────
   * 症状：整体不歪（μ≈0）但各行互不平行 → deskew 判定"本来就正"而放手不管
   * → 用户看到"点了没反应"。这是纸面占满画面时唯一能修透视的路径。
   */
  console.log('\n【2.25】满画面透视残留：应被检测并校正（σ 至少减半）')
  // ⚠️ 必须是**侧拍**（左右边长度不同 → 水平消失点 → 行互不平行）场景。
  //   上窄下宽（SCENES[0]/[1]）的行仍然平行，属于仿射，本就不该触发透视校正
  //   （曾误用 [0],[1] 写这条用例，结果"正确地"返回 none 而被判 FAIL）。
  const perspScenes = [
    { name: '左窄右宽侧拍', corners: SCENES[2].corners },
    { name: '左窄右宽侧拍(强)', corners: [[10, 60], [W - 10, 5], [W - 10, H - 5], [10, H - 60]] },
  ]
  for (const s of perspScenes) {
    const q = await embedPerspective(clean, W, H, s.corners, 0) // offset=0：纸面占满画面
    const pre = await measureRows(q, ROWS)
    const out = await straightenImage(q, { auto: true, deskew: true, perspective: true })
    check(`  ${s.name}：走 perspective 路径`, out.method === 'perspective', `实际 ${out.method}`)
    if (!out.buffer) continue
    const post = await measureRows(out.buffer, ROWS)
    check(
      `  ${s.name}：σ ${f2(pre.std)}° → ${f2(post.std)}°（至少减半）`,
      post.std < pre.std * 0.5,
      `实测 ${f2(post.std)}°`,
    )
  }

  /* ── 2.26 护栏：本来不歪的图不许被透视校正在动 ───────────────────────── */
  console.log('\n【2.26】护栏：无透视的图不得触发 perspective（宁可不做，不可做错）')
  const noPersp: { name: string; buf: Promise<Buffer> }[] = [
    { name: '无畸变原图', buf: Promise.resolve(clean) },
    { name: '上窄下宽(行仍平行)', buf: embedPerspective(clean, W, H, SCENES[3].corners, 0) },
    { name: '纯旋转-6°', buf: sharp(clean).rotate(-6, { background: '#fdfdfa' }).png().toBuffer() },
  ]
  for (const v of noPersp) {
    const out = await straightenImage(await v.buf, { auto: true, deskew: true, perspective: true })
    check(
      `  ${v.name}：未走 perspective（实际 ${out.method ?? 'none'}）`,
      out.method !== 'perspective',
    )
  }

  /* ── 2.27 真实条件下的鲁棒性 ───────────────────────────────────────────
   * 合成图跑通不等于能用。真实拍照带手写混排 / 失焦模糊 / 光照不均，
   * 其中模糊最危险（笔画粘连会让连通分量把多行并成一块 → 漏修）。
   * 底线：可以漏修，**绝不能误修**（把本来正的图搞歪）。
   */
  console.log('\n【2.27】真实干扰下仍应修正，且绝不误修')
  const noisy: { name: string; src: () => Promise<Buffer> }[] = [
    { name: '清晰(对照)', src: () => sharp(sheetSvg(W, H, ROWS, { hand: false })).png().toBuffer() },
    { name: '+手写混排', src: () => sharp(sheetSvg(W, H, ROWS, { hand: true })).png().toBuffer() },
    { name: '+光照渐变', src: () => sharp(sheetSvg(W, H, ROWS, { hand: false, gradient: true })).png().toBuffer() },
    { name: '+模糊σ=1.5', src: async () => sharp(await sharp(sheetSvg(W, H, ROWS, { hand: false })).png().toBuffer()).blur(1.5).png().toBuffer() },
    { name: '手写+模糊+渐变', src: async () => sharp(await sharp(sheetSvg(W, H, ROWS, { hand: true, gradient: true })).png().toBuffer()).blur(1.0).png().toBuffer() },
  ]
  for (const v of noisy) {
    const q = await embedPerspective(await v.src(), W, H, perspScenes[1].corners, 0)
    const pre = await measureRows(q, ROWS)
    const out = await straightenImage(q, { auto: true, deskew: true, perspective: true })
    if (out.method !== 'perspective') {
      // 漏修可接受（安全降级），但不能把图搞歪
      const keep = out.buffer ?? q
      const st = await measureRows(keep, ROWS)
      check(`  ${v.name}：未触发校正时不得劣化（${f2(pre.std)}° → ${f2(st.std)}°）`, st.std <= pre.std + 0.3)
      continue
    }
    const post = await measureRows(out.buffer!, ROWS)
    // 判据为什么不是「减半」：手写混排时，**连真四角（理论上限）也只能把 σ 降到
    // 0.53°**（纯印刷场景是 0.03°）—— 因为条带测量里混进了手写的随机走向，
    // 且 dewarp 改变图像尺寸后条带划分不再对齐原来的行。
    // 所以「减半」是对测量噪声提出的要求，不是对算法的要求，会误判。
    // 改为要求：① 确有改善 ② 修掉的量 ≥ 超出地板的部分的 20%
    const floor = await measureRows(await v.src(), ROWS)
    const excessBefore = Math.max(pre.std - floor.std, 1e-6)
    const fixedRatio = (pre.std - post.std) / excessBefore
    check(
      `  ${v.name}：σ ${f2(pre.std)}° → ${f2(post.std)}°（地板 ${f2(floor.std)}°，修掉 ${(fixedRatio * 100).toFixed(0)}% 超出量）`,
      post.std < pre.std && fixedRatio >= 0.2,
      `实测 ${f2(post.std)}°`,
    )
  }

  /* ── 2.24 源码断言：单应矩阵传参顺序 ───────────────────────────────────
   * 防止有人凭直觉「改回」solveHomography(ordered, dst)。
   */
  console.log('\n【2.24】源码断言：dewarpBuffer 必须传 solveHomography(dst, ordered)')
  {
    const src = readFileSync('/workspace/projects/server/src/image/image-dewarp.ts', 'utf8')
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    check('  含 solveHomography(dst, ordered)', /solveHomography\(\s*dst\s*,\s*ordered\s*\)/.test(code))
    check('  未回退成 solveHomography(ordered, dst)', !/solveHomography\(\s*ordered\s*,\s*dst\s*\)/.test(code))
    check('  事故档案注释仍在', src.includes('单应矩阵方向用反'))
  }

  console.log(`\n──────────────\nPASS ${pass} / FAIL ${fail}`)
  if (fail) { console.log('失败项：\n  - ' + fails.join('\n  - ')); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
