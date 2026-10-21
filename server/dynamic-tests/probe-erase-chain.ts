/**
 * 【完成度核查】擦除修复（去手写 V2）—— 生产全链路端到端验证
 *
 * 被检链路（image.service.eraseV2 的模块级复现，VLM 本环境不可用故 allowVlm:false）：
 *   ① `buildHandwritingMask(hybrid)`  色域红笔 + 红笔空间先验黑笔（+ 印刷保护闸）
 *   ② `buildEraseMask('word')`        词级判别器三态，**疑罪从无**：只有 state===1 进 mask
 *      （v21.7：word 模式下基础 mask 不并入，最终 mask = 词通道确信手写）
 *   ③ `inpaint('adaptive')`           空白区填底色 / 压印刷区沿邻域结构延拓接回
 *   ④ `blendWithMask`                 只替换 mask 区域，非 mask 区 100% 原样（绝不重排的数学保证）
 *   ⑤ `unmodifiedRegionSimilarity`    验收：非手写区一致性 ≈ 1
 *
 * 指标体系（对齐领域口径：EraseNet / ExamCleaner；旧 probe-mask-quality 同款）：
 *   · 残笔率  = 擦除后 GT 手写区剩余墨迹 / GT 手写总墨   （低 = 擦得干净）
 *   · 误擦率  = 被改动的 GT 印刷像素 / GT 印刷总像素      （低 = 不毁题）
 *   · 插图保留 = 插图 GT 墨迹未改动比例                    （高 = 不伤图）
 *   · 反例    = 纯印刷页 coverage ≈ 0                     （不无中生有）
 *
 * ⚠️ 期望值的两处「非缺陷」口径（v21.8 修复后复标定，均有根因记录）：
 *   ② 压字场景误擦 ≤42%：手写直接压在印刷文字上时，两者并成**同一个连通域**（同色、
 *      笔画宽重叠——T7 根因报告已实证「黑笔手写与手写体印刷字像素级不可分」，
 *      4 组实验证伪了粗细闸门/print 占比/像素级保护），整域必擦 →
 *      连坐损失该域内未手写覆盖的印刷。v21.8 的 CC 级印刷序列保护已把
 *      81%→38%（纯连坐部分 2722px，G16 口径豁免的手写紧邻部分 2784px）。
 *      这是架构性已知缺口（产品决策 T7-①「保持现状」），阈值起回归看护作用。
 *   ④ 插图场景残笔 ≤85%：小手写答案自行成行时成为行内自身参考（自一致），
 *      落在共识门之下 → 疑罪从无保留。这是 v21.5 G16 C2 标定的**既定取舍**
 *      （G15 冻结说明：宁留手写不误擦印刷），非缺陷；阈值看护「不变得更差」。
 *
 * ground-truth 做法：同一 SVG 渲染两遍——full（印刷+手写，送检测器）/
 *   handOnly（只有手写，非白即 GT）。印刷 GT = full 墨 − 手写 GT 墨。
 *
 * ⚠️ fixture 真实性（本机 librsvg 只有单一字体，font-family 全部回落同一默认）：
 *   手写不能用 <text> 渲染（统计上与印刷无异，判别器按疑罪从无保留 → 会误判产品）。
 *   改用**笔画路径**合成：变宽（1.2~4px）+ 变浓（opacity .65~1）+ 抖动 + 倾角，
 *   复现真实手写的 strokeCV / intensityStd / heightCV / spacingCV 信号。
 *
 * 运行（Windows，仓库根）：
 *   node node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/cli.mjs server/dynamic-tests/probe-erase-chain.ts
 *
 * ⚠️ 探针必须放在 `server/` 下：被检模块依赖 sharp，而 sharp 只装在 server/node_modules。
 */
import sharp from 'sharp'
import { buildHandwritingMask } from '../src/image/handwriting-segmenter'
import { buildEraseMask } from '../src/image/erase-mask-policy'
import { inpaint, blendWithMask, unmodifiedRegionSimilarity, type HandwritingMask } from '../src/image/handwriting-mask'
import { buildDocContext } from '../src/image/adaptive-stats'
import { discriminateWords, closeInk3x3, blockStats } from '../src/image/word-level-discriminator'
import { connectedComponents } from '../src/image/image-layout'

const DIAG = process.env.PROBE_ERASE_DIAG === '1'

const W = 900
const H = 1200
const PAPER = '#fdfdfa'

// ── 确定性随机（fixture 可复现）────────────────────────────────────
function makeRnd(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

// ── 合成手写：一"字" = 3~5 条变宽变浓抖动笔画 ─────────────────────
function handGlyph(cx: number, cy: number, size: number, rnd: () => number): string {
  const nStrokes = 3 + Math.floor(rnd() * 3)
  let out = ''
  for (let i = 0; i < nStrokes; i++) {
    const x0 = cx - size / 2 + rnd() * size
    const y0 = cy - size / 2 + rnd() * size
    const x1 = cx - size / 2 + rnd() * size
    const y1 = cy - size / 2 + rnd() * size
    const cxp = (x0 + x1) / 2 + (rnd() - 0.5) * size * 0.7
    const cyp = (y0 + y1) / 2 + (rnd() - 0.5) * size * 0.7
    const w = (1.2 + rnd() * 2.8).toFixed(1)
    const op = (0.65 + rnd() * 0.35).toFixed(2)
    const rot = ((rnd() - 0.5) * 16).toFixed(1)
    out +=
      `<path d="M${x0.toFixed(1)} ${y0.toFixed(1)} Q${cxp.toFixed(1)} ${cyp.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}" ` +
      `stroke="#202020" stroke-opacity="${op}" stroke-width="${w}" fill="none" stroke-linecap="round" ` +
      `transform="rotate(${rot} ${cx.toFixed(1)} ${cy.toFixed(1)})"/>`
  }
  return out
}

/** 一行手写答案：逐字尺寸/位置/倾角抖动（heightCV / spacingCV 信号） */
function handLine(x: number, y: number, nChars: number, fs: number, rnd: () => number): string {
  let out = ''
  for (let i = 0; i < nChars; i++) {
    const fsi = fs * (0.85 + rnd() * 0.3)
    const dy = (rnd() - 0.5) * fs * 0.22
    const dx = i * fs * (1.02 + rnd() * 0.12)
    out += handGlyph(x + dx, y + dy, fsi, rnd)
  }
  return out
}

/** 印刷层：题干预留横线（答案写在横线上方空白区） */
function printedLayer(nGroups: number): string {
  return Array.from({ length: nGroups }, (_, i) => {
    const y = 110 + i * 150
    return (
      `<text x="70" y="${y}" font-family="serif" font-size="22" fill="#111">${i + 1}. 请根据题意把答案写在下面的横线上，注意书写规范。</text>` +
      `<line x1="70" y1="${y + 48.5}" x2="830" y2="${y + 48.5}" stroke="#bbb" stroke-width="1"/>`
    )
  }).join('')
}

/** 红笔层：教师批改（对勾 + 订正词） */
function redLayer(nGroups: number): string {
  let out = ''
  for (let i = 0; i < nGroups; i++) {
    const y = 110 + i * 150
    // 对勾：两段折线
    out += `<path d="M800 ${y + 6} L812 ${y + 22} L838 ${y - 8}" stroke="#d40000" stroke-width="4" fill="none" stroke-linecap="round"/>`
    if (i % 2 === 0) {
      // 订正词：3 条红笔笔画
      const rnd = makeRnd(500 + i)
      for (let k = 0; k < 3; k++) {
        out += handGlyph(430 + k * 34, y + 34, 26, rnd).replaceAll('#202020', '#d40000').replaceAll('stroke-opacity="0.', 'stroke-opacity="0.9')
      }
    }
  }
  return out
}

/** 插图层：线稿示意图（矩形 + 斜线 + 圆）——长直线是插图保护判据的靶子 */
function illustrationLayer(): string {
  return (
    // 示意图外框（长直线，maxRun/charH ≈ 跨字尺度）
    `<rect x="620" y="880" width="220" height="160" fill="none" stroke="#333" stroke-width="2"/>` +
    `<line x1="620" y1="880" x2="840" y2="1040" stroke="#333" stroke-width="2"/>` +
    `<line x1="840" y1="880" x2="620" y2="1040" stroke="#333" stroke-width="2"/>` +
    `<circle cx="700" cy="960" r="26" fill="none" stroke="#333" stroke-width="2"/>` +
    `<text x="640" y="1070" font-family="serif" font-size="18" fill="#111">图 1  几何示意图</text>`
  )
}

interface Fixture {
  name: string
  /** 完整页（印刷 + 手写/红笔/插图） */
  full: string
  /** 仅手写层（GT：非白像素） */
  handOnly: string
  /** 插图 GT 墨迹区（插图层单独渲染后取墨）——无插图传 undefined */
  illusOnly?: string
  /** 断言 */
  expect: {
    /** 残笔率上界（主场景：手写应被擦掉） */
    residualMax?: number
    /** 误擦率上界（印刷必须保住） */
    printDamageMax: number
    /** 插图保留率下界 */
    illusKeepMin?: number
    /** 反例：coverage 必须 ≈ 0 */
    noDetect?: boolean
  }
}

function svgWrap(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${PAPER}"/>${body}</svg>`
}

async function renderPng(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg)).png().toBuffer()
}

/** 取灰度 raw 图 */
async function grayOf(buf: Buffer): Promise<{ data: Buffer; w: number; h: number }> {
  const r = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  // 三通道 → 亮度
  const ch = r.info.channels
  const n = r.info.width * r.info.height
  const g = Buffer.alloc(n)
  for (let i = 0; i < n; i++) {
    const p = i * ch
    g[i] = ch >= 3 ? Math.round(0.299 * r.data[p] + 0.587 * r.data[p + 1] + 0.114 * r.data[p + 2]) : r.data[p]
  }
  return { data: g, w: r.info.width, h: r.info.height }
}

const INK_T = 200 // 墨迹亮度阈值（印刷 #111 / 手写 #202020 / 红 #d40000 均远低于此；纸 253）

interface Metrics {
  coverage: number
  residual: number // 残笔率
  printDamage: number // 误擦率
  illusKeep: number // 插图保留率（无插图 = 1）
  similarity: number // 非手写区一致性
  handInk: number
  printInk: number
}

async function measure(
  full: string,
  handOnly: string,
  illusOnly: string | undefined,
): Promise<{ m: Metrics; mask: HandwritingMask; merged: Buffer }> {
  const fullBuf = await renderPng(full)
  const handBuf = await renderPng(handOnly)
  const gtHand = await grayOf(handBuf)
  const fullG = await grayOf(fullBuf)
  // 印刷 GT = full 墨 − 手写 GT 墨（手写 GT 之外的墨即印刷/插图）
  const printMask = Buffer.alloc(fullG.w * fullG.h)
  let handInk = 0
  let printInk = 0
  for (let i = 0; i < fullG.w * fullG.h; i++) {
    const isHand = gtHand.data[i] < INK_T
    if (isHand) handInk++
    else if (fullG.data[i] < INK_T) { printMask[i] = 1; printInk++ }
  }
  let illusInk = 0
  let illusMask: Uint8Array | undefined
  if (illusOnly) {
    const g = await grayOf(await renderPng(illusOnly))
    illusMask = new Uint8Array(fullG.w * fullG.h)
    for (let i = 0; i < fullG.w * fullG.h; i++) if (g.data[i] < INK_T) { illusMask[i] = 1; illusInk++ }
  }

  // ── 生产链 ──
  const seg = await buildHandwritingMask(fullBuf, '', {}, { allowVlm: false, eraseMode: 'hybrid' })
  const mask = await buildEraseMask(fullBuf, seg.mask, 'word')
  const inpainted = await inpaint(fullBuf, 'adaptive', mask)
  const merged = await blendWithMask(fullBuf, inpainted, mask)
  const sim = await unmodifiedRegionSimilarity(fullBuf, merged, mask)

  // ── 指标 ──
  const resG = await grayOf(merged)
  let residualInk = 0
  for (let i = 0; i < fullG.w * fullG.h; i++) {
    if (gtHand.data[i] < INK_T && resG.data[i] < 235) residualInk++ // 擦完应接近纸色 253
  }
  let printChanged = 0
  for (let i = 0; i < fullG.w * fullG.h; i++) {
    if (!printMask[i]) continue
    if (Math.abs(resG.data[i] - fullG.data[i]) > 12) printChanged++
  }
  let illusKept = 0
  if (illusMask) {
    for (let i = 0; i < fullG.w * fullG.h; i++) {
      if (illusMask[i] && Math.abs(resG.data[i] - fullG.data[i]) <= 12) illusKept++
    }
  }
  return {
    m: {
      coverage: mask.coverage,
      residual: handInk ? residualInk / handInk : 0,
      printDamage: printInk ? printChanged / printInk : 0,
      illusKeep: illusInk ? illusKept / illusInk : 1,
      similarity: sim.similarity,
      handInk,
      printInk,
    },
    mask,
    merged,
  }
}

async function runFixture(f: Fixture): Promise<boolean> {
  const { m, mask } = await measure(f.full, f.handOnly, f.illusOnly)
  const e = f.expect
  const checks: Array<[string, boolean, string]> = [
    ['误擦率', m.printDamage <= e.printDamageMax, `${(m.printDamage * 100).toFixed(2)}% ≤ ${e.printDamageMax * 100}%`],
    ['一致性', m.similarity >= 0.985, `${m.similarity.toFixed(4)} ≥ 0.985`],
  ]
  if (e.residualMax !== undefined) {
    checks.push(['残笔率', m.residual <= e.residualMax, `${(m.residual * 100).toFixed(1)}% ≤ ${e.residualMax * 100}%`])
  }
  if (e.illusKeepMin !== undefined) {
    checks.push(['插图保留', m.illusKeep >= e.illusKeepMin, `${(m.illusKeep * 100).toFixed(1)}% ≥ ${e.illusKeepMin * 100}%`])
  }
  if (e.noDetect) {
    checks.push(['反例零检出', m.coverage <= 0.002, `coverage=${(m.coverage * 100).toFixed(3)}% ≤ 0.2%`])
  }
  const ok = checks.every(([, pass]) => pass)
  const dbg = (mask.debug ?? {}) as Record<string, unknown>
  console.log(
    `${ok ? '✅' : '❌'} ${f.name}\n` +
    `     coverage=${(m.coverage * 100).toFixed(2)}% | 残笔率=${(m.residual * 100).toFixed(1)}% | 误擦率=${(m.printDamage * 100).toFixed(2)}%` +
    ` | 插图保留=${(m.illusKeep * 100).toFixed(1)}% | 一致性=${m.similarity.toFixed(4)}\n` +
    `     词级状态=${JSON.stringify(dbg.wordStates ?? {})} charH=${dbg.wordCharH ?? '?'} 家具保护=${dbg.printGenericProtected ?? 0}px` +
    ` 混合词印刷保护=${JSON.stringify(dbg.mixedPrintProtected ?? {})}` +
    ` | GT：手写 ${m.handInk}px / 印刷 ${m.printInk}px\n` +
    `     ${checks.map(([n, pass, detail]) => `${pass ? '✅' : '❌'} ${n} ${detail}`).join('  ')}`,
  )
  return ok
}

// ══════════════════════════════════════════════════════════════════════
// 诊断模式（PROBE_ERASE_DIAG=1）：逐词 dump + mask 的 GT 构成，定位根因用
// ══════════════════════════════════════════════════════════════════════
async function diagFixture(name: string, full: string, handOnly: string, illusOnly?: string): Promise<void> {
  const fullBuf = await renderPng(full)
  const handBuf = await renderPng(handOnly)
  const gtHand = await grayOf(handBuf)
  const fullG = await grayOf(fullBuf)
  const N = fullG.w * fullG.h
  // GT 类别：0=空白 1=手写 2=印刷 3=插图
  const cat = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    if (gtHand.data[i] < INK_T) cat[i] = 1
    else if (fullG.data[i] < INK_T) cat[i] = 2
  }
  if (illusOnly) {
    const g = await grayOf(await renderPng(illusOnly))
    for (let i = 0; i < N; i++) if (g.data[i] < INK_T) cat[i] = 3
  }

  const seg = await buildHandwritingMask(fullBuf, '', {}, { allowVlm: false, eraseMode: 'hybrid' })
  const mask = await buildEraseMask(fullBuf, seg.mask, 'word')

  // 复现判别器（与 buildEraseMask 同参数）拿逐词记录
  const meta = await sharp(fullBuf).metadata()
  const W = meta.width!, H = meta.height!
  const ctx = await buildDocContext(fullBuf, { width: W, height: H, isGray: false }, { charHFix: true })
  const wres = discriminateWords({ ctx })
  const s = ctx.work.w / W // 工作尺度 → 全尺度

  console.log(`\n──── 诊断：${name} ────`)
  console.log(`work=${wres.w}x${wres.h} scale=${s.toFixed(3)} charH=${wres.debug.charH} nBlocks=${wres.debug.nBlocks} nGraphics=${wres.debug.nGraphics} nRows=${wres.debug.nRows} nWords=${wres.debug.nWords}`)
  console.log(`wordStates=${JSON.stringify(wres.debug.wordStateCount)} labelInkShare=${JSON.stringify(wres.debug.labelInkShare)} lineCCPx=${wres.debug.lineCCPx} lineSavedPx=${wres.debug.lineSavedPx} protectedPx=${wres.debug.protectedPx}`)
  console.log(`行切分：${JSON.stringify(wres.debug.rowsDebug)}`)
  console.log('逐词（state: 0=印刷 1=手写 2=疑虑；bbox 为全尺度）：')
  for (const [i, wd] of wres.words.entries()) {
    // 词 bbox 换算到全尺度后统计 GT 构成
    const fx0 = Math.floor(wd.x0 / s), fx1 = Math.min(W - 1, Math.ceil(wd.x1 / s))
    const fy0 = Math.floor(wd.y0 / s), fy1 = Math.min(H - 1, Math.ceil(wd.y1 / s))
    let nh = 0, np = 0, ni = 0, nb = 0
    for (let y = fy0; y <= fy1; y++) for (let x = fx0; x <= fx1; x++) {
      const c = cat[y * W + x]
      if (c === 1) nh++; else if (c === 2) np++; else if (c === 3) ni++; else nb++
    }
    const f = wd.f
    console.log(
      `  #${i} state=${wd.state} score=${wd.score.toFixed(2)} bbox=(${fx0},${fy0})-(${fx1},${fy1}) nComp=${wd.nComp} ink=${wd.n}` +
      ` | GT 手写${nh} 印刷${np} 插图${ni} 空白${nb}` +
      ` | hCV=${f.heightCV.toFixed(2)} sCV=${f.strokeCV.toFixed(2)} sDev=${f.strokeDev.toFixed(2)} spCV=${f.spacingCV.toFixed(2)} iStd=${f.intensityStd.toFixed(3)} slant=${f.slantDeg.toFixed(1)}`,
    )
  }
  // ── CC 级 dump：对所有 state=1 词做 CC 分解，评估「词内印刷保护」的可分性 ──
  {
    const charH = Number(wres.debug.charH) || 14
    const inkC = closeInk3x3(ctx.work.ink, wres.w, wres.h)
    const ccs = connectedComponents(inkC, wres.w, wres.h, false).comps.filter((c) => c.n >= 4)
    const ccStat = (c: { x0: number; y0: number; x1: number; y1: number; n: number }) => {
      const st = blockStats(c, ctx.work.ink, wres.w, wres.h, charH)
      let sum = 0, cnt = 0
      for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
        if (!ctx.work.ink[y * wres.w + x]) continue
        sum += ctx.work.gray[y * wres.w + x]; cnt++
      }
      return { ...st, meanLuma: cnt ? sum / cnt : 0 }
    }
    const rowsDbg = wres.debug.rowsDebug as Array<{ y0: number; y1: number; baseH: number; baseStroke: number }>
    wres.words.forEach((wd, wi) => {
      if (wd.state !== 1) return
      const inWord = ccs.filter((c) => {
        const cx = (c.x0 + c.x1) / 2, cy = (c.y0 + c.y1) / 2
        return cx >= wd.x0 && cx <= wd.x1 && cy >= wd.y0 && cy <= wd.y1
      })
      if (!inWord.length) return
      const rowInfo = rowsDbg[wd.row]
      console.log(`  CC 分解 #${wi} (state=1, row baseH=${rowInfo?.baseH} baseStroke=${rowInfo?.baseStroke}):`)
      for (const c of inWord) {
        const st = ccStat(c)
        console.log(`    cc(${c.x0},${c.y0})-(${c.x1},${c.y1}) n=${c.n} bh=${st.bh} bw=${st.bw} medRun=${st.medianRun} dens=${st.density.toFixed(2)} luma=${st.meanLuma.toFixed(0)}`)
      }
    })
  }
  // mask 构成（按原图尺度）
  const mb = mask.data
  let mH = 0, mP = 0, mI = 0, mB = 0
  const printHits: Array<[number, number]> = []
  for (let i = 0; i < N; i++) {
    if (mb[i] < 127) continue
    const c = cat[i]
    if (c === 1) mH++; else if (c === 2) { mP++; printHits.push([i % W, (i / W) | 0]) } else if (c === 3) mI++; else mB++
  }
  console.log(`mask 构成：手写${mH}px 印刷${mP}px 插图${mI}px 空白${mB}px（印刷命中 ${printHits.length}px）`)
  // 印刷命中按「与手写 GT 的邻近度」分类：≤10px = 手写正下方/紧邻（G16 口径豁免）；
  // >10px = 与手写无接触的纯连坐损伤（词级盲区的直接证据）
  if (printHits.length) {
    const NEAR = 10
    const near = (x: number, y: number): boolean => {
      for (let dy = -NEAR; dy <= NEAR; dy++) for (let dx = -NEAR; dx <= NEAR; dx++) {
        const ny = y + dy, nx = x + dx
        if (ny < 0 || nx < 0 || ny >= H || nx >= W) continue
        if (cat[ny * W + nx] === 1) return true
      }
      return false
    }
    let nearN = 0
    for (const [x, y] of printHits) if (near(x, y)) nearN++
    console.log(`  其中手写紧邻(≤${NEAR}px，G16 口径豁免) ${nearN}px｜纯连坐(>${NEAR}px) ${printHits.length - nearN}px`)
  }
  if (printHits.length) {
    // 粗略聚类印刷命中位置（按 y 分桶）
    const byY = new Map<number, number>()
    for (const [, y] of printHits) byY.set(y, (byY.get(y) ?? 0) + 1)
    const rows = [...byY.entries()].sort((a, b) => a[0] - b[0])
    let runStart = -1, runEnd = -1, runN = 0
    const segs: string[] = []
    for (const [y, n] of rows) {
      if (runStart < 0) { runStart = y; runEnd = y; runN = n }
      else if (y - runEnd <= 3) { runEnd = y; runN += n }
      else { segs.push(`y${runStart}-${runEnd}:${runN}px`); runStart = y; runEnd = y; runN = n }
    }
    if (runStart >= 0) segs.push(`y${runStart}-${runEnd}:${runN}px`)
    console.log(`  印刷命中分布：${segs.join(' ')}`)
  }
  const merged = await blendWithMask(fullBuf, await inpaint(fullBuf, 'adaptive', mask), mask)
  if (DIAG) {
    const code = '①②③④⑤'.indexOf(name[0]) + 1
    const outDir = 'C:/Users/sglsi/AppData/Local/Temp/erase-diag'
    await sharp(fullBuf).png().toFile(`${outDir}/s${code}-full.png`)
    await sharp(merged).png().toFile(`${outDir}/s${code}-erased.png`)
    await sharp(mask.data, { raw: { width: W, height: H, channels: 1 } }).png().toFile(`${outDir}/s${code}-mask.png`)
  }
  const resG = await grayOf(merged)
  let residualInk = 0, handTotal = 0
  for (let i = 0; i < N; i++) {
    if (cat[i] !== 1) continue
    handTotal++
    if (resG.data[i] < 235) residualInk++
  }
  console.log(`残笔率=${((residualInk / Math.max(1, handTotal)) * 100).toFixed(1)}%  （手写 GT ${handTotal}px，残留 ${residualInk}px）`)
}

async function main() {
  if (DIAG) {
    console.log('=== 擦除链路 · 诊断模式 ===')
    {
      const rnd = makeRnd(42)
      const hand = Array.from({ length: 3 }, (_, i) => handLine(150, 110 + i * 150 + 30, 4, 26, rnd)).join('')
      await diagFixture('① 空白区黑笔作答', svgWrap(printedLayer(3) + hand), svgWrap(hand))
    }
    {
      const rnd = makeRnd(7)
      const hand = Array.from({ length: 3 }, (_, i) => handLine(150, 110 + i * 150 + 2, 4, 26, rnd)).join('')
      await diagFixture('② 压字手写', svgWrap(printedLayer(3) + hand), svgWrap(hand))
    }
    {
      const rnd = makeRnd(99)
      const hand = Array.from({ length: 3 }, (_, i) => handLine(150, 110 + i * 150 + 30, 4, 26, rnd)).join('')
      await diagFixture('③ 学生作答 + 教师红笔', svgWrap(printedLayer(3) + hand + redLayer(3)), svgWrap(hand + redLayer(3)))
    }
    {
      const rnd = makeRnd(2024)
      const hand = Array.from({ length: 4 }, (_, i) => handLine(150, 110 + i * 150 + 30, 4, 26, rnd)).join('')
      await diagFixture('④ 插图保护', svgWrap(printedLayer(5) + hand + illustrationLayer()), svgWrap(hand), svgWrap(illustrationLayer()))
    }
    await diagFixture('⑤ 纯印刷页', svgWrap(printedLayer(4)), svgWrap(''))
    return
  }
  console.log('=== 擦除修复 · 生产全链路验证（hybrid → word → adaptive → blend）===\n')
  const results: boolean[] = []

  // ── ① 主场景：空白区黑笔作答（3 题，答案写在预留横线上方）──
  {
    const rnd = makeRnd(42)
    const hand = Array.from({ length: 3 }, (_, i) => handLine(150, 110 + i * 150 + 30, 4, 26, rnd)).join('')
    results.push(await runFixture({
      name: '① 空白区黑笔作答（主场景）',
      full: svgWrap(printedLayer(3) + hand),
      handOnly: svgWrap(hand),
      expect: { residualMax: 0.55, printDamageMax: 0.03 },
    }))
  }

  // ── ② 压字手写（困难场景：手写压在印刷文字上，误擦必须仍然低）──
  //    期望见文件头「非缺陷口径」：连坐损失限在合并连通域内（v21.8 后 38.3%）
  {
    const rnd = makeRnd(7)
    // 手写中心压在印刷文字行上（y 与印刷基线重合）
    const hand = Array.from({ length: 3 }, (_, i) => handLine(150, 110 + i * 150 + 2, 4, 26, rnd)).join('')
    results.push(await runFixture({
      name: '② 压字手写（困难场景）',
      full: svgWrap(printedLayer(3) + hand),
      handOnly: svgWrap(hand),
      expect: { residualMax: 0.75, printDamageMax: 0.42 },
    }))
  }

  // ── ③ 红笔批改卷（教师对勾 + 订正词）──
  {
    const rnd = makeRnd(99)
    const hand = Array.from({ length: 3 }, (_, i) => handLine(150, 110 + i * 150 + 30, 4, 26, rnd)).join('')
    results.push(await runFixture({
      name: '③ 学生作答 + 教师红笔批改',
      full: svgWrap(printedLayer(3) + hand + redLayer(3)),
      handOnly: svgWrap(hand + redLayer(3)),
      expect: { residualMax: 0.6, printDamageMax: 0.04 },
    }))
  }

  // ── ④ 插图保护（线稿示意图 + 手写作答）──
  //    残笔期望见文件头「非缺陷口径」：小手写答案自一致 → 疑罪从无（既定取舍）
  {
    const rnd = makeRnd(2024)
    const hand = Array.from({ length: 4 }, (_, i) => handLine(150, 110 + i * 150 + 30, 4, 26, rnd)).join('')
    const illus = illustrationLayer()
    results.push(await runFixture({
      name: '④ 插图保护（线稿 + 手写）',
      full: svgWrap(printedLayer(5) + hand + illus),
      handOnly: svgWrap(hand),
      illusOnly: svgWrap(illus),
      expect: { residualMax: 0.85, printDamageMax: 0.04, illusKeepMin: 0.9 },
    }))
  }

  // ── ⑤ 反例：纯印刷页（无任何手写 → 不得检出、不得改动）──
  //    残留 0.23%：一个 24px 印刷碎片越过噪声地板（n≥12）被误判；
  //    距 G16 的 2.0% 天花板尚有一个数量级，阈值看护「不显著变坏」
  {
    results.push(await runFixture({
      name: '⑤ 纯印刷页（反例）',
      full: svgWrap(printedLayer(4)),
      handOnly: svgWrap(''),
      expect: { printDamageMax: 0.005, noDetect: true },
    }))
  }

  const pass = results.filter(Boolean).length
  console.log(`\n${pass === results.length ? '✅' : '❌'} 擦除修复：${pass}/${results.length} 场景通过`)
  process.exit(pass === results.length ? 0 : 1)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
