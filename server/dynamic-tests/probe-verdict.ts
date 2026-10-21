/**
 * 【完成度核查】verdict 判定 —— 单测 + 像素级检测 + 主路径端到端 + 真实样本回归
 *
 * 被检链路（错题提取五阶段中的「批改标记检测 + 判定」）：
 *   ① `detectRedMarks`       红墨 mask → 连通域 → 形态分类（wrongq-mark.ts）
 *   ② `groupWritingClusters` 邻近红笔聚成「书写簇」（wrongq-mark.ts）
 *   ③ `decideLocal`          证据融合 → wrong / correct / unknown（wrongq-decide.ts）
 *   ④ `analyzeQuestionUnits` OCR 题号 → 题目单元（wrongq-structure.ts）
 *   ⑤ `buildEvidenceBlocks`  单元优先判定（wrongq-evidence.ts，P0 主路径）
 *
 * 判定内核双路径（wrongq.ts 编排）：
 *   - **主路径**（有全页 OCR，生产默认）：analyzeQuestionUnits → buildEvidenceBlocks
 *     （订正词/条目级标记证据 → 仅带证据的单元产 wrong 块，对勾不产块）
 *   - **兜底路径**（无 OCR，如离线脚本）：groupWritingClusters → buildBlocks → decideLocal
 * 两条路都必须测——只测兜底会漏掉生产实际走的主路径。
 *
 * 五组验证：
 *   A1. decideLocal 判定表单测（闸门/书写簇/划线/订正/VLM 融合语义）
 *   A2. fuseVlm 融合单测（一致提置信/不一致改写/多报新增块）
 *   A3. isCorrectionWord / isStrikeMark 词级门单测（#R5 修复的回归钉）
 *   B.  像素级兜底链路（合成红笔 fixture → detectRedMarks → groupWritingClusters
 *       → buildBlocks → decideLocal）
 *   C.  像素级主链路（合成题页 + OCR regions → detectRedMarks →
 *       analyzeQuestionUnits → buildEvidenceBlocks：题号归属 + P0 保守策略）
 *   D.  真实样本回归（docs/design/test-wrongq-sample.png：数学页含小数题号 +
 *       大红勾，专测 #R5 两项修复：小数幻影题号 / 勾类笔迹绕过 tick 排除）
 *
 * 运行（Windows，仓库根）：
 *   node node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/cli.mjs server/dynamic-tests/probe-verdict.ts
 *
 * ⚠️ 探针必须放在 `server/` 下：被检模块依赖 sharp，而 sharp 只装在 server/node_modules
 *    （根 node_modules 没有）。放在根 dynamic-tests/ 会 MODULE_NOT_FOUND。
 */
import { readFileSync } from 'fs'
import sharp from 'sharp'
import { buildLayoutContext } from '../src/image/wrongq-layout'
import { detectRedMarks, groupWritingClusters } from '../src/image/wrongq-mark'
import { decideLocal, fuseVlm, type VlmItem } from '../src/image/wrongq-decide'
import { buildBlocks } from '../src/image/wrongq-block'
import { analyzeQuestionUnits } from '../src/image/wrongq-structure'
import { findQuestionTokens } from '../src/image/wrongq-segment'
import {
  buildEvidenceBlocks,
  groupRedComponents,
  isCorrectionWord,
  isStrikeMark,
} from '../src/image/wrongq-evidence'
import type { MarkKind, RedMark, WritingCluster, WrongqBlock, WrongqVerdict } from '../src/image/wrongq.types'
import type { LocalOcrTextRegion } from '../ocr/ocr.types'

const W = 900
const H = 1200

// ══════════════════════════════════════════════════════════════════════
// A1. decideLocal 纯函数单测
// ══════════════════════════════════════════════════════════════════════
interface Case {
  name: string
  want: WrongqVerdict
  marks?: RedMark[]
  clusters?: WritingCluster[]
  medH?: number
  /** 期望的 suspect（形态猜测必须标存疑；簇强证据不标） */
  wantSuspect?: boolean
}

let seq = 0
function mk(kind: MarkKind, x0: number, y0: number, side: number, n: number): RedMark {
  seq += 1
  return { id: seq, kind, box: { x0, y0, x1: x0 + side, y1: y0 + side }, n } as RedMark
}
function mkBox(kind: MarkKind, x0: number, y0: number, x1: number, y1: number, n: number): RedMark {
  seq += 1
  return { id: seq, kind, box: { x0, y0, x1, y1 }, n } as RedMark
}
function mkCluster(parts: number, ink: number, cw: number, ch: number, markIds: number[] = []): WritingCluster {
  return {
    id: 900 + parts,
    parts,
    ink,
    box: { x0: 0, y0: 0, x1: cw, y1: ch },
    markIds,
  } as unknown as WritingCluster
}

const medH = 30
/** 一块 = 一个待判定区域。clusterId 必须挂上，否则 decideLocal 的簇分支永不进入 */
function oneBlock(clusterId?: number, markIds: number[] = []): WrongqBlock[] {
  return [{
    id: 0,
    box: { x0: 0, y0: 0, x1: 400, y1: 60 },
    normBox: [0, 0, 400, 60],
    col: 0,
    markIds,
    clusterId,
    verdict: 'unknown',
    confidence: 0,
  } as unknown as WrongqBlock]
}

/** 用例要在函数里构造：簇的 markIds 依赖 mark 的真实 id（mk 自增序列） */
function buildCases(): Case[] {
  seq = 0
  // 成片书写订正：9 个书写域（均不过划线门：长边 30 < 2.2×medH=66）
  const wordMarks = Array.from({ length: 9 }, (_, i) => mkBox('correction', i * 13, 0, i * 13 + 26, 28, 170))
  // 划线订正·证据强：1 条长划（n=1800）+ 8 个碎点，parts=9 → strong
  const lineStrong = [mkBox('cross', 0, 0, 200, 20, 1800), ...Array.from({ length: 8 }, (_, i) => mk('unknown', 10 + i * 20, 30, 4, 13))]
  // 划线订正·证据弱：1 条长划（n=800）+ 5 个碎点，parts=6，lineOnly → suspect
  const lineWeak = [mkBox('cross', 0, 0, 200, 20, 800), ...Array.from({ length: 5 }, (_, i) => mk('unknown', 10 + i * 20, 30, 4, 20))]
  return [
    {
      name: '教师红笔订正（9 个书写域，成片）→ 错（强证据不存疑）',
      want: 'wrong', medH, wantSuspect: false,
      marks: wordMarks,
      clusters: [mkCluster(9, wordMarks.reduce((s, m) => s + m.n, 0), 120, 60, wordMarks.map((m) => m.id))],
    },
    {
      name: '划线订正·证据强（parts≥8，划线主导）→ 错（不存疑）',
      want: 'wrong', medH, wantSuspect: false,
      marks: lineStrong,
      clusters: [mkCluster(9, lineStrong.reduce((s, m) => s + m.n, 0), 200, 20, lineStrong.map((m) => m.id))],
    },
    {
      name: '划线订正·证据弱（lineOnly 且不强）→ 错 + 存疑',
      want: 'wrong', medH, wantSuspect: true,
      marks: lineWeak,
      clusters: [mkCluster(6, lineWeak.reduce((s, m) => s + m.n, 0), 200, 20, lineWeak.map((m) => m.id))],
    },
    {
      name: '墨迹稀薄如长划线（parts=4，密度<0.01）→ 错 + 存疑',
      want: 'wrong', medH, wantSuspect: true,
      clusters: [mkCluster(4, 30, 300, 12)],
    },
    {
      name: '孤立红叉（过尺寸闸门）→ 错 + 存疑（形态猜测）',
      want: 'wrong', medH, wantSuspect: true,
      marks: [mk('cross', 100, 100, 30, 60)],
    },
    {
      name: '红圈圈错（过闸门）→ 错 + 存疑',
      want: 'wrong', medH, wantSuspect: true,
      marks: [mk('circle', 100, 100, 20, 90)],
    },
    {
      name: '仅对勾（过闸门）→ 对 + 存疑',
      want: 'correct', medH, wantSuspect: true,
      marks: [mk('tick', 100, 100, 26, 55)],
    },
    {
      name: '订正与对勾共存 → 以订正为准判错',
      want: 'wrong', medH, wantSuspect: true,
      marks: [mk('correction', 100, 100, 30, 400), mk('tick', 140, 100, 26, 55)],
    },
    {
      name: '无任何红笔 → unknown + 存疑',
      want: 'unknown', medH, wantSuspect: true,
      marks: [],
    },
    {
      name: '极小书写碎片（不过闸门）→ unknown（不硬猜）',
      want: 'unknown', medH, wantSuspect: true,
      marks: [mk('cross', 100, 100, 4, 3), mk('tick', 120, 100, 3, 2)],
    },
  ]
}

function runDecideCases(): boolean {
  console.log('=== A1. decideLocal 判定表单测 ===')
  let pass = 0
  const cases = buildCases()
  for (const c of cases) {
    const blocks = oneBlock(c.clusters?.[0]?.id, (c.marks ?? []).map((m) => m.id))
    const out = decideLocal(blocks, c.marks ?? [], c.medH ?? 0, c.clusters ?? [])
    const b = out[0]
    const ok = b.verdict === c.want && (c.wantSuspect === undefined || !!b.suspect === c.wantSuspect)
    if (ok) pass++
    console.log(
      `${ok ? '✅' : '❌'} ${c.name}：verdict=${b.verdict} conf=${b.confidence.toFixed(2)} suspect=${!!b.suspect}` +
      (ok ? '' : `\n     期望 verdict=${c.want} suspect=${c.wantSuspect}`),
    )
  }
  console.log(`\n单测 ${pass}/${cases.length} 通过\n`)
  return pass === cases.length
}

// ══════════════════════════════════════════════════════════════════════
// A2. fuseVlm 融合单测
// ══════════════════════════════════════════════════════════════════════
function runFuseCases(): boolean {
  console.log('=== A2. fuseVlm 融合单测 ===')
  const base = (): WrongqBlock[] => [{
    id: 0,
    box: { x0: 100, y0: 100, x1: 280, y1: 150 },
    normBox: [0.1, 0.1, 0.18, 0.05],
    col: 0,
    markIds: [],
    verdict: 'wrong',
    confidence: 0.6,
    evidence: [],
    source: 'local',
  } as unknown as WrongqBlock]
  const items: Array<{ name: string; vlm: VlmItem[]; check: (bs: WrongqBlock[]) => string | null }> = [
    {
      name: 'VLM 与本地一致 → 置信提至 0.85，source=fused',
      vlm: [{ box: [0.1, 0.1, 0.18, 0.05], verdict: 'wrong' }],
      check: (bs) => (bs.length === 1 && bs[0].confidence >= 0.85 && bs[0].source === 'fused' && !bs[0].suspect ? null : `conf=${bs[0]?.confidence} source=${bs[0]?.source} suspect=${bs[0]?.suspect}`),
    },
    {
      name: 'VLM 与本地不一致 → 改写 verdict + 标存疑',
      vlm: [{ box: [0.1, 0.1, 0.18, 0.05], verdict: 'correct' }],
      check: (bs) => (bs.length === 1 && bs[0].verdict === 'correct' && bs[0].suspect === true ? null : `verdict=${bs[0]?.verdict} suspect=${bs[0]?.suspect}`),
    },
    {
      // ⚠️ fuseVlm 末尾按 col 排序，新增块 col=-1 会排到 index 0——按 source 找块，别按下标
      name: 'VLM 多报（本地无证据）→ 新增块 + 存疑（宁可多报）',
      vlm: [{ box: [0.7, 0.7, 0.1, 0.05], verdict: 'correct', reason: '第 3 题答对' }],
      check: (bs) => {
        const nb = bs.find((b) => b.source === 'vlm')
        return bs.length === 2 && nb && nb.verdict === 'correct' && nb.suspect === true ? null : `blocks=${bs.length} vlm块=${nb ? `${nb.verdict}/suspect=${nb.suspect}` : '无'}`
      },
    },
  ]
  let pass = 0
  for (const it of items) {
    const bs = base()
    const err = it.check(fuseVlm(bs, it.vlm, 1000, 1000))
    if (!err) pass++
    console.log(`${err ? '❌' : '✅'} ${it.name}${err ? `：${err}` : ''}`)
  }
  console.log(`\n融合 ${pass}/${items.length} 通过\n`)
  return pass === items.length
}

// ══════════════════════════════════════════════════════════════════════
// A3. isCorrectionWord / isStrikeMark 词级门单测（#R5 修复回归钉）
// ══════════════════════════════════════════════════════════════════════
function runWordGateCases(): boolean {
  console.log('=== A3. isCorrectionWord / isStrikeMark 词级门单测 ===')
  const mH = 24
  const mkGeo = (kind: MarkKind, x1: number, y1: number, n: number): RedMark =>
    ({ id: ++seq, kind, box: { x0: 0, y0: 0, x1, y1 }, n, fill: n / ((x1 + 1) * (y1 + 1)), aspect: (x1 + 1) / (y1 + 1) }) as RedMark
  const cases: Array<{ name: string; mark: RedMark; wantWord: boolean; wantStrike: boolean }> = [
    // 词级订正词：n=500 ≥ 0.35×576=202，fill≈0.5，aspect 1.2
    { name: '订正词（词级墨+填充）→ 词✓  strike✗（不重复计入）', mark: mkGeo('unknown', 30, 26, 500), wantWord: true, wantStrike: false },
    // 薄斜线碎片：41×7，n=60 → fill 0.21 < 0.22 且 aspect 5.9 ≥ 1.4 → 勾/斜类（GT：单笔斜线=答对类）
    { name: '薄斜线碎片（fill 0.21）→ 词✗  strike✗（勾/斜类）', mark: mkGeo('unknown', 40, 6, 60), wantWord: false, wantStrike: false },
    // 粗头大红勾（#R5 实测形态）：n=303 ≥ 202，fill 0.11 < 0.22，aspect 1.47
    { name: '粗头大红勾（n=303/fill 0.11/aspect 1.47）→ 词✗  strike✗（几何救回）', mark: mkGeo('correction', 62, 42, 303), wantWord: false, wantStrike: false },
    // 粗红叉：n=260 ≥ 202 且 fill 0.38 ≥ 0.22 → 词级门分不出叉/词（已知语义极限，
    // 组级靠 parts≥2 或非勾类孤立允许捕获——见 D 组孤立 ⊖/叉的行为）
    { name: '粗红叉（词级门无判别力）→ 词✓  strike✗（组级路径捕获）', mark: mkGeo('cross', 25, 25, 260), wantWord: true, wantStrike: false },
    // 大对勾但 kind=tick（classifyMark 正常分类时）
    { name: '对勾（kind=tick）→ 词✗  strike✗（kind 排除）', mark: mkGeo('tick', 29, 17, 200), wantWord: false, wantStrike: false },
    // 划线横杠（aspect 8 薄）→ underline
    { name: '划线横杠（underline）→ 词✗  strike✗', mark: mkGeo('underline', 79, 6, 200), wantWord: false, wantStrike: false },
  ]
  let pass = 0
  for (const c of cases) {
    const gotWord = isCorrectionWord(c.mark, mH)
    const gotStrike = isStrikeMark(c.mark, mH)
    const ok = gotWord === c.wantWord && gotStrike === c.wantStrike
    if (ok) pass++
    console.log(
      `${ok ? '✅' : '❌'} ${c.name}：词=${gotWord} strike=${gotStrike}` +
      (ok ? '' : `（期望 词=${c.wantWord} strike=${c.wantStrike}）`),
    )
  }
  // 小数防护回归（#R5）：题号行内的小数不得产幻影 token
  const tokCases: Array<{ text: string; wantNums: number[] }> = [
    { text: '1. 计算：3.5 × 1.2 + 0.8 = ?', wantNums: [1] },
    { text: '2. 一个圆的半径是 3cm，它的面积是多少？', wantNums: [2] },
    { text: '3. 解方程：2x + 6 = 18，x = ?', wantNums: [3] },
    { text: '10. 圆周率 3.14 是吗', wantNums: [10] },
    { text: '4. 下列哪个数是质数？', wantNums: [4] },
  ]
  for (const t of tokCases) {
    const nums = findQuestionTokens(t.text).map((x) => x.num.num)
    const ok = JSON.stringify(nums) === JSON.stringify(t.wantNums)
    if (ok) pass++
    console.log(`${ok ? '✅' : '❌'} 题号扫描「${t.text}」→ ${JSON.stringify(nums)}（期望 ${JSON.stringify(t.wantNums)}）`)
  }
  const total = cases.length + tokCases.length
  console.log(`\n词级门 ${pass}/${total} 通过\n`)
  return pass === total
}

// ══════════════════════════════════════════════════════════════════════
// B. 像素级兜底链路：detectRedMarks → groupWritingClusters → buildBlocks → decideLocal
// ══════════════════════════════════════════════════════════════════════
function printedPage(lines: string[]): string {
  const t = lines
    .map((s, i) => `<text x="60" y="${90 + i * 40}" font-family="serif" font-size="22" fill="#111">${s}</text>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fdfdfa"/>${t}</svg>`
}

/**
 * 红色对勾。⚠️ 形态敏感性：classifyMark 的 tick 判据是 aspect>1.5——
 * 真实教师对勾就是「宽 > 高」（短笔下撇 + 长笔斜上挑），此比例按实测形态画。
 * 若把勾画成近正方形（aspect≈0.8），会落进 cross 区间——那是画错，不是产品错。
 */
function svgTick(x: number, y: number, s: number): string {
  return `<path d="M${x} ${y} L${x + s * 0.4} ${y + s * 0.45} L${x + s} ${y - s * 0.1}" stroke="#d40000" stroke-width="${Math.max(2, s / 8)}" fill="none" stroke-linecap="round"/>`
}
function svgCross(x: number, y: number, s: number): string {
  return `<path d="M${x} ${y} L${x + s} ${y + s} M${x + s} ${y} L${x} ${y + s}" stroke="#d40000" stroke-width="${Math.max(2, s / 8)}" fill="none" stroke-linecap="round"/>`
}
/** 红笔书写一小串字（订正） */
function svgCorrection(x: number, y: number, fs: number): string {
  return `<text x="${x}" y="${y}" font-family="serif" font-size="${fs}" fill="#d40000">应为 25</text>`
}
/** 红笔订正：逐字分开排（1.15 倍字距），保持多连通域（模拟真实手写订正的部件分离） */
function svgCorrectionSpaced(x: number, y: number, fs: number): string {
  return ['应', '为', '2', '5']
    .map((g, i) => `<text x="${x + i * fs * 1.15}" y="${y}" font-family="serif" font-size="${fs}" fill="#d40000">${g}</text>`)
    .join('')
}

interface Fixture {
  name: string
  svg: string
  /** 检出红笔符号数区间（连通域粒度：订正词组会被拆成多个组件，故给区间） */
  marks?: [number, number]
  clusters?: [number, number]
  /** 期望的块级判定集合（去重；空数组 = 不得出现任何 wrong/correct 块） */
  wantVerdicts: WrongqVerdict[]
  /** 期望出现的标记种类（OR 组：任一组内有一个即算中；classifyMark 勾/叉/圈区间重叠，粗叉会落 circle） */
  wantKinds?: MarkKind[][]
  /** 期望所有块都标存疑 */
  wantSuspectBlocks?: boolean
}

const PRINTED3 = ['一、选择题：下列计算正确的是（ ）', 'A. 2+3=6    B. 5-1=4    C. 7×2=15', '二、填空题：正方形边长 5 厘米，面积是____平方厘米。']

const FIXTURES: Fixture[] = [
  {
    name: '对勾卷（3 勾，无订正）',
    svg: printedPage(PRINTED3).replace('</svg>', `${svgTick(640, 72, 26)}${svgTick(640, 112, 26)}${svgTick(640, 152, 26)}</svg>`),
    marks: [3, 3], clusters: [0, 0],
    wantVerdicts: ['correct'],
    wantKinds: [['tick']],
  },
  {
    // 三个标记纵向 128px 间距（远 > 簇门 2×0.5×medH≈24）→ 各自独立
    name: '叉 + 勾混批（2 叉 1 勾，间距充分）',
    svg: printedPage(PRINTED3).replace('</svg>', `${svgCross(640, 72, 26)}${svgCross(640, 200, 26)}${svgTick(640, 340, 26)}</svg>`),
    marks: [3, 3], clusters: [0, 0],
    wantVerdicts: ['wrong', 'correct'],
    wantKinds: [['cross', 'circle'], ['tick']],
  },
  {
    // 两处红笔订正（y=85 与 y=155，间距足够远 → 各自成簇）
    name: '教师订正卷（两处红笔书写）',
    svg: printedPage(PRINTED3).replace('</svg>', `${svgCorrection(620, 85, 34)}${svgCorrection(620, 155, 34)}</svg>`),
    marks: [2, 10], clusters: [2, 2],
    wantVerdicts: ['wrong'],
    wantKinds: [['correction']],
  },
  {
    name: '空白印刷页（无红笔）',
    svg: printedPage(PRINTED3),
    marks: [0, 0], clusters: [0, 0],
    wantVerdicts: [],
  },
  {
    // 密排连打：3 个标记纵向 40px 间距 < 簇门 → 并成一簇（兜底路径设计行为：
    // 无 OCR 时按"成片红笔"聚合，判错但标存疑交人工）
    name: '密排连打（3 标记纵向 40px）→ 并簇判错 + 存疑',
    svg: printedPage(PRINTED3).replace('</svg>', `${svgCross(640, 72, 26)}${svgCross(640, 112, 26)}${svgTick(640, 152, 26)}</svg>`),
    marks: [3, 3], clusters: [1, 1],
    wantVerdicts: ['wrong'],
    wantSuspectBlocks: true,
  },
]

async function runPixelCases(): Promise<boolean> {
  console.log('=== B. 像素级兜底链路（detectRedMarks → groupWritingClusters → buildBlocks → decideLocal）===')
  let pass = 0
  for (const f of FIXTURES) {
    const buf = await sharp(Buffer.from(f.svg)).png().toBuffer()
    const ctx = await buildLayoutContext(buf)
    const det = await detectRedMarks(ctx.flatBuf, ctx, { chromaMin: 14 })
    const clusters = groupWritingClusters(det.marks, ctx.medH)
    // 与生产兜底路径同一条链：簇非空 → 只由簇建块；否则全标记建块
    const blocks = buildBlocks(det.marks, ctx, 0.85, clusters)
    decideLocal(blocks, det.marks, ctx.medH, clusters)

    const kinds: Record<string, number> = {}
    for (const m of det.marks) kinds[m.kind] = (kinds[m.kind] ?? 0) + 1
    const kindDesc = Object.entries(kinds).map(([k, v]) => `${k}×${v}`).join(',') || '无'
    const verdictSet = [...new Set(blocks.map((b) => b.verdict))].sort()
    const inRange = (n: number, r?: [number, number]) => !r || (n >= r[0] && n <= r[1])
    const okMark = inRange(det.marks.length, f.marks)
    const okClu = inRange(clusters.length, f.clusters)
    const okVerdict =
      verdictSet.length === f.wantVerdicts.length &&
      f.wantVerdicts.every((v) => verdictSet.includes(v))
    const okKinds = !f.wantKinds || f.wantKinds.every((grp) => det.marks.some((m) => grp.includes(m.kind)))
    const okSuspect = f.wantSuspectBlocks === undefined || (blocks.length > 0 && blocks.every((b) => !!b.suspect))
    const ok = okMark && okClu && okVerdict && okKinds && okSuspect
    if (ok) pass++
    const markDetail = det.marks
      .map((m) => `${m.kind}[${m.box.x1 - m.box.x0 + 1}×${m.box.y1 - m.box.y0 + 1} n=${m.n} f=${m.fill.toFixed(2)} a=${m.aspect.toFixed(2)}]`)
      .join(' ')
    console.log(
      `${ok ? '✅' : '❌'} ${f.name}\n` +
      `     marks=${det.marks.length}（期望 ${f.marks ? `${f.marks[0]}~${f.marks[1]}` : '不限'}）${kindDesc}${markDetail ? `\n     ${markDetail}` : ''}` +
      `\n     clusters=${clusters.length}（期望 ${f.clusters ? `${f.clusters[0]}~${f.clusters[1]}` : '不限'}）` +
      ` | blocks=${blocks.length} 判定=${verdictSet.join(',') || '（无块）'}（期望 ${f.wantVerdicts.join(',') || '无 wrong/correct'}）` +
      ` | medH=${ctx.medH.toFixed(1)} | 家具排除 ${det.furnitureCount} 个`,
    )
  }
  console.log(`\n像素级 ${pass}/${FIXTURES.length} 通过\n`)
  return pass === FIXTURES.length
}

// ══════════════════════════════════════════════════════════════════════
// C. 像素级主链路：detectRedMarks → analyzeQuestionUnits → buildEvidenceBlocks
// ══════════════════════════════════════════════════════════════════════
/**
 * 合成题页 + OCR regions（模拟侧车全页 OCR 输出）：
 *   Q1「1. 3 × 4 + 5 = ?」答案行有红笔订正（"应为 25"）→ 应产 wrong 块
 *   Q2「2. 25 - 8 = ?」有红叉                        → 应产 wrong 块（条目级标记）
 *   Q3「3. 6 × 7 = ?」只有红勾                      → P0 保守：不产块（答对=红勾）
 *   Q4「4. 9 + 9 = ?」干净                          → 不产块
 */
async function runMainPath(): Promise<boolean> {
  console.log('=== C. 像素级主链路（analyzeQuestionUnits + buildEvidenceBlocks）===')
  const qLines = ['1. 3 × 4 + 5 = ?', '2. 25 - 8 = ?', '3. 6 × 7 = ?', '4. 9 + 9 = ?']
  const svg =
    printedPage(qLines).replace(
      '</svg>',
      `${svgCorrectionSpaced(620, 85, 26)}${svgCross(640, 118, 26)}${svgTick(640, 158, 26)}</svg>`,
    )
  // OCR regions：与印刷行同位置的文本框（题号在行首）
  const regions: LocalOcrTextRegion[] = qLines.map((t, i) => ({
    text: t,
    box: [60, 90 + i * 40 - 20, 60 + t.length * 13, 90 + i * 40 + 2],
    score: 0.95,
  }))

  const buf = await sharp(Buffer.from(svg)).png().toBuffer()
  const ctx = await buildLayoutContext(buf)
  const det = await detectRedMarks(ctx.flatBuf, ctx, { chromaMin: 14 })
  const an = analyzeQuestionUnits(ctx, regions)
  const blocks = buildEvidenceBlocks(det.marks, an.units, ctx, ctx.medH, an.structure)

  const unitNums = an.units.map((u) => u.number.num)
  const okUnits = an.units.length === 4 && [1, 2, 3, 4].every((n) => unitNums.includes(n))
  const labels = blocks.map((b) => b.questionLabel ?? '')
  const okCount = blocks.length === 2
  const okVerdict = blocks.every((b) => b.verdict === 'wrong')
  const okConf = blocks.every((b) => b.confidence >= 0.8)
  const okAttach = labels.some((l) => l.includes('1')) && labels.some((l) => l.includes('2'))
  const ok = okUnits && okCount && okVerdict && okConf && okAttach

  console.log(
    `${okUnits ? '✅' : '❌'} 题目单元 ${an.units.length} 个（期望 4）：${an.units.map((u) => `${u.number.num}@(${u.anchor ? Math.round(u.anchor.x) : '?'},${u.anchor ? Math.round(u.anchor.y) : '?'})"${u.label}"`).join(' | ')}`,
  )
  for (const b of blocks) {
    console.log(
      `    块#${b.id} "${b.questionLabel}" verdict=${b.verdict} conf=${b.confidence.toFixed(2)} box=[${b.box.x0},${b.box.y0},${b.box.x1},${b.box.y1}]\n` +
      `      ${b.evidence.map((e) => `· ${e}`).join('\n      ')}`,
    )
  }
  console.log(
    `${ok ? '✅' : '❌'} 主路径：块数 ${blocks.length}（期望 2：Q1 订正 + Q2 红叉；Q3 红勾/Q4 干净不产块）` +
    ` | 判定 ${blocks.map((b) => b.verdict).join(',') || '（无）'} | 归属标签 ${labels.join(' / ') || '（无）'}`,
  )
  console.log(`\n主路径 ${ok ? '通过' : '未通过'}\n`)
  return ok
}

// ══════════════════════════════════════════════════════════════════════
// D. 真实样本回归（docs/design/test-wrongq-sample.png）
// ══════════════════════════════════════════════════════════════════════
/**
 * GT 语义（样本图实读）：5 道选择题；Q1 答案行有个「圆圈+横杠」标记（81×31/n=640），
 * Q2 题干行一个红勾、Q3 一个红勾（均 63×43/n=303 粗头勾），Q4/Q5 干净。
 * 按 GT 口径「答对=红勾」+ 标定词级门：Q1 的 ⊖ 过词级门（fill 0.25/n=640）且非
 * 勾类形态 → 按订正词判 Q1 错（#128 标定行为， conf 0.9 + 未经 VLM 语义确认）；
 * Q2/Q3 的红勾 → 不产块（勾类笔迹，strike 与 correction 双路均排除）。
 *
 * 本夹具专测 #R5 两项修复：
 *   ① Q1 题干「3.5 × 1.2 + 0.8」的小数不得产幻影题号（否则 units 1/2/3 全灭）
 *   ② 粗头大红勾（n=303 被 classifyMark 贴成 correction 类）不得进证据（双路排除）
 */
async function runRealSample(): Promise<boolean> {
  console.log('=== D. 真实样本回归（test-wrongq-sample.png，数学页+大红勾）===')
  const buf = readFileSync('docs/design/test-wrongq-sample.png')
  const ctx = await buildLayoutContext(buf)
  const det = await detectRedMarks(ctx.flatBuf, ctx, { chromaMin: 14 })
  const regions: LocalOcrTextRegion[] = [
    { text: '1. 计算：3.5 × 1.2 + 0.8 = ?', box: [60, 158, 480, 178], score: 0.9 },
    { text: 'A. 4.2  B. 5.0  C. 5.2  D. 4.8', box: [60, 206, 470, 226], score: 0.9 },
    { text: '2. 一个圆的半径是 3cm，它的面积是多少？', box: [60, 275, 600, 300], score: 0.9 },
    { text: 'A. 9.42  B. 18.84  C. 28.26  D. 12.56', box: [60, 324, 480, 344], score: 0.9 },
    { text: '3. 解方程：2x + 6 = 18，x = ?', box: [60, 394, 420, 417], score: 0.9 },
    { text: '4. 下列哪个数是质数？', box: [60, 511, 340, 536], score: 0.9 },
    { text: 'A. 9  B. 15  C. 17  D. 21', box: [60, 560, 400, 580], score: 0.9 },
    { text: '5. 正方体的棱长扩大 2 倍，体积扩大几倍？', box: [60, 629, 570, 653], score: 0.9 },
    { text: 'A. 2  B. 4  C. 6  D. 8', box: [60, 678, 400, 698], score: 0.9 },
  ]
  const an = analyzeQuestionUnits(ctx, regions)
  const blocks = buildEvidenceBlocks(det.marks, an.units, ctx, ctx.medH, an.structure)
  const groups = groupRedComponents(det.marks, ctx.medH)

  const unitNums = an.units.map((u) => u.number.num).sort((a, b) => (a ?? 0) - (b ?? 0))
  const okUnits = an.units.length === 5 && JSON.stringify(unitNums) === JSON.stringify([1, 2, 3, 4, 5])
  const okBlocks =
    blocks.length === 1 &&
    blocks[0].verdict === 'wrong' &&
    (blocks[0].questionLabel ?? '').includes('1') &&
    blocks[0].confidence >= 0.8
  const ok = okUnits && okBlocks

  console.log(
    `${okUnits ? '✅' : '❌'} 题目单元 ${an.units.length} 个（期望 5，题号 1-5 齐全）：${an.units.map((u) => `${u.number.num}@(${u.anchor ? Math.round(u.anchor.x) : '?'},${u.anchor ? Math.round(u.anchor.y) : '?'})`).join(' ')}`,
  )
  for (const m of det.marks) {
    console.log(
      `    标记 ${m.kind} [${m.box.x0},${m.box.y0},${m.box.x1},${m.box.y1}] ${m.box.x1 - m.box.x0 + 1}×${m.box.y1 - m.box.y0 + 1} n=${m.n} f=${m.fill.toFixed(2)} a=${m.aspect.toFixed(2)} 词级门=${isCorrectionWord(m, ctx.medH)} strike=${isStrikeMark(m, ctx.medH)}`,
    )
  }
  console.log(
    `    证据组 ${groups.length} 个：${groups.map((g) => `parts=${g.parts} corr=${g.correction} strike=${g.strike}`).join(' | ') || '（无）'}`,
  )
  for (const b of blocks) {
    console.log(`    块 "${b.questionLabel}" ${b.verdict} conf=${b.confidence.toFixed(2)} :: ${b.evidence[0]}`)
  }
  console.log(
    `${okBlocks ? '✅' : '❌'} 判定块 ${blocks.length} 个（期望 1：仅 Q1 的 ⊖；Q2/Q3 红勾不产块）${blocks.map((b) => ` "${b.questionLabel}"→${b.verdict}`).join('')}`,
  )
  console.log(`\n真实样本 ${ok ? '通过' : '未通过'}\n`)
  return ok
}

async function main() {
  const a = runDecideCases() && runFuseCases() && runWordGateCases()
  const b = await runPixelCases()
  const c = await runMainPath()
  const d = await runRealSample()
  const ok = a && b && c && d
  console.log(ok ? '✅ verdict 判定：五组验证全部通过' : '❌ verdict 判定：存在未通过项（见上）')
  process.exit(ok ? 0 : 1)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
