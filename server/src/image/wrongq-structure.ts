/**
 * 错题区域提取 · P1 文档结构感知（#129）
 * ------------------------------------------------------------------
 * 解决 R3（无文档结构感知）与 R4（题号 OCR 噪声）：
 *
 *   ① **大节/小类区间树**：OCR 文本行匹配节标题（【预习案】/第三部分/X案）与小类标题
 *      （罗马数字行 Ⅰ./Ⅱ./IL. + 指令行 根据…/选词填空/阅读…），切出「节 → 小类」区间；
 *   ② **编号规则判定**：每个大节内检查小类边界的题号衔接——首题重起 1 → 分段编号
 *      （各小类独立题号空间，正面 汉译英1–18 与 探究案1–17 各自重号）；
 *      首题紧接上节末题 +1 → 统一编号（背面 检测案 1–23 跨小类连号）；
 *   ③ **序列自纠**（§4.5 结构约束）：编号空间内按阅读序走查 1,2,3…n——
 *      缺号 → 邻区借裸数字区补认（背面 "23" 独立成区被旧实现漏产）；
 *      误读 → 按期望序号修正糊读形态（背面 "M9." 实为 19，旧实现产出双 9）；
 *      重号 → 丢弃后出现者并标记；
 *   ④ **跨页边界**：页首无标题的内容归"前页续"小节，起始缺号记 crossPage（不静默合并），
 *      编号空间冲突处标 suspect 交人工。
 *
 * 二遍编排：一遍出常规单元 → 结构/编号/自纠诊断 → 把补认与修正的题号作为强制头
 * 二遍重跑切分（保证注入单元的盒与锚点由同一套平铺逻辑产出，不做事后凑框）。
 */
import type { LayoutContext } from './wrongq-layout'
import { colsAtY } from './wrongq-layout'
import type { LocalOcrTextRegion } from '../ocr/ocr.types'
import type { QuestionUnit, HeaderRegion } from './wrongq-segment'
import { detectHeaderRegions, detectQuestionUnits, enhanceHeadersWithLayout } from './wrongq-segment'
import type { ParsedNumber } from '../ocr/ocr-hierarchy'

/** 小类（罗马数字/指令行标题）区间 */
export interface DocSubsection {
  /** 稳定 id（"节下标.小类下标"） */
  id: string
  /** 标题文本 */
  title: string
  /** 显式解析出的罗马序号；无罗马前缀为 null */
  roman: number | null
  /** roman 是否由前序 header 推断（页首续接小节） */
  romanInferred: boolean
  /** 区间顶（header region 顶；页首续接为 0） */
  y0: number
  /** 区间底（下一 header 顶 / 页底） */
  y1: number
  /** 页首无 header 的续接小节（跨页延续） */
  fromPrevPage: boolean
  /**
   * 标题所在栏（#144 双栏感知归属）：header region 的 x 中心经栏结构归类。
   *
   * 为什么需要（p1 实测根因）：三栏作业页的中列是学生答案区、左右两列各是一套
   * 独立编号练习（左=重点单词1-29，右=词形变换1-12/重点短语1-10）。旧实现
   * 只按 y 纵向带归属——右栏小类标题（词形变换 y0=298）把左栏 2-19 题一并
   * 吃进它的编号空间，repairSequence 随即将左栏条目当"重号"丢弃 23 个。
   * 带上列信息后，单元优先归属同栏小类，跨栏续接（如右栏顶部的 28/29 续接
   * 左栏单词表）才回落到旧行为。
   * 页首续接小节无标题区域，col=null 表示不设栏约束。
   */
  col: number | null
}

/** 大节（【预习案】/第三部分/X案）区间 */
export interface DocSection {
  id: string
  /** 大节标题（页首合成节为 ''） */
  title: string
  y0: number
  y1: number
  subsections: DocSubsection[]
  /** 编号规则：segmented=小类各自重号；unified=跨小类连号 */
  numbering: 'segmented' | 'unified'
  /** 本页首个 header 之前还有内容（跨页续接或页眉） */
  fromPrevPage: boolean
}

/** 一页的文档结构 */
export interface DocStructure {
  sections: DocSection[]
}

/** 单个编号空间的序列诊断 */
export interface SpaceDiag {
  /** 空间 key（节 id 或 节id.小类id） */
  space: string
  sectionTitle: string
  subsectionTitle: string
  numbering: 'segmented' | 'unified'
  /** 走查后确认存在的题号（升序） */
  seq: number[]
  /** 无法恢复的缺号 */
  gaps: number[]
  /** 跨页续接导致的起始缺号（非错误） */
  crossPageGap: boolean
  /** 丢弃的重号 */
  duplicates: number[]
  /** 误读修正（unitId: from→to） */
  repairs: Array<{ unitId: number; from: number; to: number }>
  /** 邻区补认注入的题号 */
  injected: number[]
}

export interface StructureDiag {
  headers: HeaderRegion[]
  spaces: SpaceDiag[]
}

const ROMAN_STR = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ', 'Ⅸ', 'Ⅹ', 'Ⅺ', 'Ⅻ']

/**
 * 构建「大节 → 小类」区间树。
 *
 * 页首处理：若本页第一个 header 就是小类（背面第一行即是 "II.选词填空。"，
 * 其 Ⅰ.形式填空 的 2–8 题从上一页续来），在其前插入"前页续"小节——
 * 罗马序号取首个 header 序号 - 1（推断），编号空间与后续小节同属一个合成大节。
 *
 * #144：小类记录所在栏 col（见 DocSubsection.col）——双栏作业页左右两列
 * 各是独立编号练习，仅按 y 归属会把左栏条目错吃进右栏小类的编号空间。
 */
export function buildDocStructure(headers: HeaderRegion[], ctx: LayoutContext, regions: LocalOcrTextRegion[]): DocStructure {
  const pageH = ctx.h
  const hs = [...headers].sort((a, b) => a.y0 - b.y0 || a.y1 - b.y1)
  const sections: DocSection[] = []
  let curSec: DocSection | null = null
  let curSub: DocSubsection | null = null
  let prevRoman: number | null = null
  const closeSub = (y1: number) => { if (curSub) curSub.y1 = y1 }
  const closeSec = (y1: number) => { closeSub(y1); if (curSec) curSec.y1 = y1 }
  for (const hd of hs) {
    if (hd.kind === 'section') {
      closeSec(hd.y0)
      curSec = { id: `s${sections.length}`, title: hd.title, y0: hd.y0, y1: pageH, subsections: [], numbering: 'segmented', fromPrevPage: false }
      sections.push(curSec)
      curSub = null
      prevRoman = null
    } else {
      if (!curSec) {
        // 页首无大节 header：合成"跨页续接"大节（背面整页属检测案，但案名在上页）
        curSec = { id: `s${sections.length}`, title: '', y0: 0, y1: pageH, subsections: [], numbering: 'segmented', fromPrevPage: true }
        sections.push(curSec)
        prevRoman = null
      }
      closeSub(hd.y0)
      // 罗马序号消歧：IL→III 主/II 备——前序存在时取大于前序的解释（序号只增不减）
      let roman = hd.roman
      if (roman != null && prevRoman != null && roman <= prevRoman && hd.romanAlt != null && hd.romanAlt > prevRoman) {
        roman = hd.romanAlt
      }
      curSub = {
        id: `${curSec.id}.${curSec.subsections.length}`,
        title: hd.title,
        roman: roman != null && roman >= 1 && roman <= 12 ? roman : null,
        romanInferred: false,
        y0: hd.y0,
        y1: pageH,
        fromPrevPage: false,
        col: colOfHeader(hd, ctx, regions),
      }
      curSec.subsections.push(curSub)
      if (roman != null) prevRoman = roman
    }
  }
  if (!sections.length) {
    sections.push({ id: 's0', title: '', y0: 0, y1: pageH, subsections: [], numbering: 'segmented', fromPrevPage: false })
  }
  // 页首续接小节：本页第一个 header 是小类（或页首有内容无任何 header）时插入
  const first = sections[0]
  const firstSubY0 = first.subsections[0]?.y0 ?? pageH
  if (firstSubY0 > 0) {
    const inferred = first.subsections[0]?.roman
    const roman = inferred != null && inferred >= 2 ? inferred - 1 : null
    first.subsections.unshift({
      id: `${first.id}.lead`,
      title: '',
      roman,
      romanInferred: roman != null,
      y0: 0,
      y1: firstSubY0,
      fromPrevPage: true,
      col: null, // 续接小节跨栏承接，不设栏约束
    })
  }
  return { sections }
}

/** header 所在栏：region 盒 x 中心经 colsAtY 归类（越界取最近栏） */
function colOfHeader(hd: HeaderRegion, ctx: LayoutContext, regions: LocalOcrTextRegion[]): number | null {
  const r = regions[hd.idx]
  if (!r) return null
  const b = (r.box as number[]) || [0, 0, 0, 0]
  const cx = (Math.min(b[0], b[2]) + Math.max(b[0], b[2])) / 2
  return colOfX(cx, colsAtY(ctx, hd.y0))
}

/**
 * 页面是否存在多栏结构（分区栏任一带多栏，或全局兜底栏多栏）。
 * p2 实测：colSections 整页单栏（栏缝持续性校验未过）但全局 cols 是双栏——
 * 此时仍应按全局栏做列感知，否则左右两列独立编号练习会被 y 序交错。
 */
function hasMultiCol(ctx: LayoutContext | undefined): boolean {
  if (!ctx) return false
  if (ctx.colSections?.some((s) => s.cols.length > 1)) return true
  return (ctx.cols?.length ?? 0) > 1
}

/**
 * 某 (x,y) 的栏归属：优先覆盖该 y 且多栏的分区栏；否则用全局兜底栏。
 * 与 colOfHeader 同一套口径，保证 header 与单元的 col 可比。
 */
function colAtPoint(ctx: LayoutContext, x: number, y: number): number {
  const secs = ctx.colSections
  if (secs && secs.length) {
    if (y < secs[0].y0) return colOfX(x, secs[0].cols.length > 1 ? secs[0].cols : fallbackCols(ctx))
    for (const s of secs) {
      if (y <= s.y1) return colOfX(x, s.cols.length > 1 ? s.cols : fallbackCols(ctx))
    }
    return colOfX(x, secs[secs.length - 1].cols.length > 1 ? secs[secs.length - 1].cols : fallbackCols(ctx))
  }
  return colOfX(x, fallbackCols(ctx))
}

function fallbackCols(ctx: LayoutContext): Array<[number, number]> {
  return ctx.cols?.length ? ctx.cols : [[0, ctx.w]]
}

/** 阅读序：多栏页面列主序（先左栏后右栏，栏内按 y），单栏页面保持行带序（旧行为） */
export function readingOrder(units: QuestionUnit[], medH: number, ctx?: LayoutContext): QuestionUnit[] {
  const withA = units.filter((u) => u.anchor)
  const noA = units.filter((u) => !u.anchor)
  if (ctx && hasMultiCol(ctx)) {
    const arr = [...withA].sort((a, b) => {
      const ca = colAtPoint(ctx, a.anchor!.x, a.anchor!.y)
      const cb = colAtPoint(ctx, b.anchor!.x, b.anchor!.y)
      if (ca !== cb) return ca - cb
      return a.anchor!.y - b.anchor!.y || a.anchor!.x - b.anchor!.x
    })
    return [...arr, ...noA]
  }
  const arr = [...withA].sort((a, b) => a.anchor!.y - b.anchor!.y || a.anchor!.x - b.anchor!.x)
  const bandGap = Math.max(8, medH * 0.8)
  const rows: QuestionUnit[][] = []
  for (const u of arr) {
    const row = rows[rows.length - 1]
    if (row && Math.abs(u.anchor!.y - row[row.length - 1].anchor!.y) <= bandGap) row.push(u)
    else rows.push([u])
  }
  for (const row of rows) {
    if (row.length > 1) row.sort((a, b) => a.anchor!.x - b.anchor!.x)
  }
  return [...rows.flat(), ...noA]
}

/**
 * 把单元挂到结构树上（按题号锚点 y + 栏），回填 sec2/sub2/label/numbering。
 *
 * #144 双栏感知：节按 y 取（不变）；节内小类优先取「同栏且 y0 ≤ 锚点 y」的
 * 最后一个，无同栏候选才回落旧行为（纯 y 归属）。跨栏续接（右栏顶部的题续接
 * 左栏练习）因此落回上方小类，而左右两列独立练习不再互相污染编号空间。
 */
export function assignUnitsToStructure(units: QuestionUnit[], st: DocStructure, ctx?: LayoutContext): void {
  for (const u of units) {
    const y = u.anchor?.y ?? (u.box.y0 + u.box.y1) / 2
    // 取最后一个 y0 ≤ y 的大节；节内取最后一个 y0 ≤ y 的小类，无则第一个
    let si = -1
    for (let i = 0; i < st.sections.length; i++) if (st.sections[i].y0 <= y) si = i
    if (si < 0) si = 0
    const sec = st.sections[si]
    if (!sec.subsections.length) { u.sec2 = si; u.sub2 = -1; u.numbering = sec.numbering; continue }
    let bi = -1
    if (ctx && u.anchor) {
      const ucol = colAtPoint(ctx, u.anchor.x, u.anchor.y)
      for (let i = 0; i < sec.subsections.length; i++) {
        const sub = sec.subsections[i]
        if (sub.y0 <= y && sub.col != null && sub.col === ucol) bi = i
      }
    }
    if (bi < 0) {
      bi = 0
      for (let i = 0; i < sec.subsections.length; i++) if (sec.subsections[i].y0 <= y) bi = i
    }
    const sub = sec.subsections[bi]
    u.sec2 = si
    u.sub2 = bi
    u.numbering = sec.numbering
    u.label = makeLabel(sec, sub, u.number.num)
  }
}

/**
 * Fix C（#144）：清除「前页续」误判。
 *
 * 旧逻辑：本页第一个 header 低于页顶即插入 fromPrevPage 续接小节。但页首
 * 下方留白/页眉占位会让首 header 的 y0 > 0，此时插入的续接声明是伪的——
 * 该空间首个题号往往是 1（本页新起），基线报告问题③的「前页续 N」误判
 * 即源于此。修正：仅当续接小节的第一个单元题号 > 1（真缺 1 号，确为跨页
 * 延续）或一个单元都没有（无从证伪，保守保留）时才保留声称。
 */
export function clearFalseLeadClaims(st: DocStructure, units: QuestionUnit[], ctx: LayoutContext): void {
  const order = readingOrder(units, ctx.medH, ctx)
  for (const sec of st.sections) {
    sec.subsections.forEach((sub, subIdx) => {
      if (!sub.fromPrevPage) return
      const si = Number(sec.id.slice(1))
      const mine = order.filter((u) => u.sec2 === si && u.sub2 === subIdx)
      if (mine.length && mine[0].number.num === 1) {
        sub.fromPrevPage = false
        sub.romanInferred = false
        sub.roman = null
      }
    })
  }
}

/** 规范题号标签：节标题·小类标题 题号（跨页续接节显示"前页续"） */
function makeLabel(sec: DocSection, sub: DocSubsection, num: number | null): string {
  const roman = sub.roman != null && !sub.romanInferred ? ROMAN_STR[sub.roman - 1] : ''
  let title = (roman ? `${roman}.` : '') + (sub.title || (sub.fromPrevPage ? '前页续' : ''))
  title = title.replace(/[\s.、．,，:：;；]+$/, '')
  if (title.length > 12) title = `${title.slice(0, 12)}…`
  const parts = [sec.title, title].filter(Boolean)
  return `${parts.join('·')} ${num ?? '?'}`
}

/**
 * 编号规则判定（§4.4）：每个大节内检查相邻小类的题号衔接。
 *   首题 = 1 且上节末题 ≥ 1 → 分段编号（各自重号）；
 *   首题 = 上节末题 + 1 → 统一编号（跨小类连号）；
 *   无法判定的小类边界不计票；两式都出现时取多数，平局保守取分段。
 */
export function determineNumbering(st: DocStructure, units: QuestionUnit[], ctx: LayoutContext): void {
  const order = readingOrder(units, ctx.medH, ctx)
  const posOf = new Map<QuestionUnit, number>()
  order.forEach((u, i) => posOf.set(u, i))
  for (const sec of st.sections) {
    let seg = 0
    let uni = 0
    for (let i = 1; i < sec.subsections.length; i++) {
      const a = unitsOf(sec, i - 1, posOf)
      const b = unitsOf(sec, i, posOf)
      if (!a.length || !b.length) continue
      const lastA = a[a.length - 1].number.num
      const firstB = b[0].number.num
      if (lastA == null || firstB == null) continue
      if (firstB === 1 && lastA >= 1) seg++
      else if (firstB === lastA + 1) uni++
    }
    sec.numbering = uni > 0 && seg === 0 ? 'unified' : seg > 0 && uni === 0 ? 'segmented' : uni > seg ? 'unified' : 'segmented'
  }
}

/** 某大节某小类的单元（按阅读序） */
function unitsOf(sec: DocSection, subIdx: number, posOf: Map<QuestionUnit, number>): QuestionUnit[] {
  const secIdx = Number(sec.id.slice(1))
  return [...posOf.keys()]
    .filter((u) => u.sec2 === secIdx && u.sub2 === subIdx)
    .sort((a, b) => (posOf.get(a) ?? 0) - (posOf.get(b) ?? 0))
}

/** 取区域轴对齐包围盒 */
function rb(r: LocalOcrTextRegion) {
  const b = (r.box as number[]) || [0, 0, 0, 0]
  const xs = [b[0], b[2]].map((v) => (v == null ? 0 : v))
  const ys = [b[1], b[3]].map((v) => (v == null ? 0 : v))
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

/** x 中心落在哪一栏；越界取最近的一栏 */
function colOfX(cx: number, cols: Array<[number, number]>): number {
  for (let i = 0; i < cols.length; i++) if (cx >= cols[i][0] && cx < cols[i][1]) return i
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < cols.length; i++) {
    const d = Math.min(Math.abs(cx - cols[i][0]), Math.abs(cx - cols[i][1]))
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}

/**
 * 在 [yFrom, yTo] 纵向范围内找"裸数字区"（整区文本恰为期望题号）——
 * 缺号补认的邻区重认（§4.5）。防护：非杂散标记（≥0.55medH 高）、题号位
 * （位于所在栏左端 35% 内，排除页眉得分/行内孤立数字）、未被占用。
 */
function findBareRegion(
  want: number,
  yFrom: number,
  yTo: number,
  regions: LocalOcrTextRegion[],
  ctx: LayoutContext,
  medH: number,
  used: Set<number>,
  skip: Set<number>,
): number | null {
  const s = String(want)
  if (!/^\d{1,2}$/.test(s)) return null
  for (let ri = 0; ri < regions.length; ri++) {
    if (used.has(ri) || skip.has(ri)) continue
    if ((regions[ri].text || '').trim() !== s) continue
    const b = rb(regions[ri])
    if (b.y1 - b.y0 < Math.round(medH * 0.55)) continue
    if (b.y1 < yFrom || b.y0 > yTo) continue
    const cx = (b.x0 + b.x1) / 2
    const colsY = ctx.cols
    const ci = colOfX(cx, colsY)
    const [c0, c1] = colsY[ci] ?? [0, ctx.w]
    if (cx > c0 + (c1 - c0) * 0.35) continue
    return ri
  }
  return null
}

/**
 * 误读判别：题号头签名是否为目标序号的糊读形态。
 *
 * 签名须含 ≥1 个前缀糊字符（字母/标点吃掉题号首位，如 "M9." = 19 的 1 被 M 吃掉）——
 * 裸题号（"9."）不算误读，走重号丢弃，避免把真实的重复题号改写成臆造序号。
 *   - 两位数捕获值：≡ 目标 mod 100 且小于目标（"N19."→19 之外的两位残缺）；
 *   - 单位数捕获值：≡ 目标末位 且 目标 ≥10（"M9."→19、"X3."→23）。
 */
function misreadNum(sig: string | undefined, expected: number): number | null {
  if (!sig || expected < 10) return null
  const m = sig.match(/^[A-Za-z\W_]{1,2}(\d{1,2})/)
  if (!m) return null
  const got = Number(m[1])
  if (got >= 10) return expected % 100 === got && got < expected ? expected : null
  return got === expected % 10 && got < expected ? expected : null
}

export interface RepairResult {
  /** 二遍强制头：regionIdx → 修正/补认的题号 */
  forceHeads: Map<number, ParsedNumber>
  /** 二遍降级为内容的 region（重号单元） */
  dropRegions: Set<number>
  diag: SpaceDiag[]
}

/**
 * 编号空间序列自纠（§4.5 结构约束 + §4.4 单元挂靠的编号基础）。
 *
 * 每个编号空间（unified → 整大节；segmented → 各小类）按阅读序走查：
 *   - 命中期望序号 → 接受；
 *   - 大于期望 → 中间缺号：邻区找裸数字区补认（记 injected），找不到记 gaps；
 *   - 小于期望 → 重号或误读：签名匹配期望的糊读形态 → 修正（relabel）；
 *     否则丢弃后出现者（记 duplicates）；
 *   - 收尾继续向后找裸数字区（独立成区的题号被旧实现漏产，如背面 "23"）。
 */
export function repairSequence(
  st: DocStructure,
  units: QuestionUnit[],
  regions: LocalOcrTextRegion[],
  ctx: LayoutContext,
): RepairResult {
  const medH = ctx.medH
  const order = readingOrder(units, medH, ctx)
  const forceHeads = new Map<number, ParsedNumber>()
  const dropRegions = new Set<number>()
  const diag: SpaceDiag[] = []
  const usedBare = new Set<number>()
  const skip = new Set<number>()
  for (const h of detectHeaderRegions(regions)) skip.add(h.idx)

  for (let si = 0; si < st.sections.length; si++) {
    const sec = st.sections[si]
    const spaces = sec.numbering === 'unified'
      ? [{ subs: sec.subsections.map((_, i) => i), key: sec.id, subIdx: -1 }]
      : sec.subsections.map((_, i) => ({ subs: [i], key: `${sec.id}.${i}`, subIdx: i }))
    for (const sp of spaces) {
      const seq = order.filter((u) => u.sec2 === si && sp.subs.includes(u.sub2 ?? -1))
      const d: SpaceDiag = {
        space: sp.key,
        sectionTitle: sec.title,
        subsectionTitle: sp.subIdx >= 0 ? sec.subsections[sp.subIdx]?.title ?? '' : '(整节连号)',
        numbering: sec.numbering,
        seq: [],
        gaps: [],
        crossPageGap: false,
        duplicates: [],
        repairs: [],
        injected: [],
      }
      // 编号空间自本大节首个小类起；该小类若标了 fromPrevPage（页首续接），
      // 起始缺号属跨页延续而非错误（unified 空间的 sp.subs[0] 即首个小类）。
      const leadFromPrev = !!sec.subsections[sp.subs[0]]?.fromPrevPage
      let expected = 1
      let lastY = sec.subsections[sp.subs[0]]?.y0 ?? 0
      const spaceBot = sec.subsections[sp.subs[sp.subs.length - 1]]?.y1 ?? ctx.h
      for (const u of seq) {
        const n = u.number.num
        if (n == null) continue
        const uy = u.anchor?.y ?? u.box.y0
        if (n === expected) {
          d.seq.push(n)
          expected++
          lastY = uy
          continue
        }
        if (n > expected) {
          for (let M = expected; M < n; M++) {
            const ri = findBareRegion(M, lastY, uy, regions, ctx, medH, usedBare, skip)
            if (ri != null) {
              usedBare.add(ri)
              forceHeads.set(ri, { kind: 'arabic', num: M, raw: String(M) })
              d.injected.push(M)
              d.seq.push(M)
            } else {
              d.gaps.push(M)
              if (M === 1 && leadFromPrev) d.crossPageGap = true
            }
          }
          d.seq.push(n)
          expected = n + 1
          lastY = uy
          continue
        }
        // n < expected：重号或误读
        const fixed = misreadNum(u.headSig, expected)
        if (fixed != null && u.regionIdx != null && u.regionIdx >= 0) {
          forceHeads.set(u.regionIdx, { kind: 'arabic', num: fixed, raw: String(fixed) })
          d.repairs.push({ unitId: u.id, from: n, to: fixed })
          d.seq.push(fixed)
          expected = fixed + 1
          lastY = uy
        } else {
          d.duplicates.push(n)
          if (u.regionIdx != null && u.regionIdx >= 0) dropRegions.add(u.regionIdx)
        }
      }
      // 收尾：最后单元之后继续找裸数字区（独立题号区漏产）
      for (let M = expected; M <= expected + 12; M++) {
        const ri = findBareRegion(M, lastY, spaceBot, regions, ctx, medH, usedBare, skip)
        if (ri == null) break
        usedBare.add(ri)
        forceHeads.set(ri, { kind: 'arabic', num: M, raw: String(M) })
        d.injected.push(M)
        d.seq.push(M)
        lastY = rb(regions[ri]).y1
      }
      diag.push(d)
    }
  }
  return { forceHeads, dropRegions, diag }
}

/**
 * P1 主编排：文档结构感知下的题目单元切分。
 *
 * 一遍（常规切分）→ 结构树 + 编号规则 → 序列自纠 → 二遍（注入补认/修正题号头）
 * → 终态结构归属与标签。无注入/修正时二遍省略。
 *
 * ②（#141）：layoutBlocks 为 3.x 版面模型（PP-StructureV3）的标题类块先验。
 * 自研文本规则在英语作业册上标题识别全空（实测 4/4 页 sections=0），传入后由
 * enhanceHeadersWithLayout 做保守融合（只增不删），补出 "Unit1…"/"Section B…"/
 * "重点单词》" 等大节/小类边界。不传则退化为纯文本规则路径（旧行为）。
 */
export function analyzeQuestionUnits(
  ctx: LayoutContext,
  regions: LocalOcrTextRegion[],
  layoutBlocks?: Array<{ type: string; box: number[]; text?: string }>,
): { units: QuestionUnit[]; structure: DocStructure; diag: StructureDiag } {
  const textHeaders = detectHeaderRegions(regions)
  const { headers, extraSkip } = layoutBlocks?.length
    ? enhanceHeadersWithLayout(textHeaders, layoutBlocks, regions)
    : { headers: textHeaders, extraSkip: [] }
  const skip = new Set(headers.map((h) => h.idx))
  for (const i of extraSkip) skip.add(i)
  // 结构边界 = 大节 + 小类标题的 y（§4.4：页面切成「节 → 小类」区间，
  // 内容段与单元底边都不得跨边界——小类边界同样封顶，见 wrongq-segment）
  const sectionCuts = headers.map((h) => h.y0)
  const units1 = detectQuestionUnits(ctx, regions, { skipRegions: skip, sectionCuts })
  const st = buildDocStructure(headers, ctx, regions)
  if (!units1.length) {
    return { units: [], structure: st, diag: { headers, spaces: [] } }
  }
  assignUnitsToStructure(units1, st, ctx)
  determineNumbering(st, units1, ctx)
  // Fix C（#144）：序列走查前先清除「前页续」误判（首题号为 1 的续接小节）
  clearFalseLeadClaims(st, units1, ctx)
  const rep = repairSequence(st, units1, regions, ctx)
  let units = units1
  if (rep.forceHeads.size || rep.dropRegions.size) {
    units = detectQuestionUnits(ctx, regions, {
      skipRegions: skip,
      sectionCuts,
      forceHeads: rep.forceHeads,
      dropRegions: rep.dropRegions,
    })
  }
  // 终态：结构归属 + 标签；编号规则在修正后的序号上复判（确认/加固）
  assignUnitsToStructure(units, st, ctx)
  determineNumbering(st, units, ctx)
  clearFalseLeadClaims(st, units, ctx)
  // 复验序列（诊断用；不再注入）
  const diagSpaces = rep.diag
  return { units, structure: st, diag: { headers, spaces: diagSpaces } }
}
