/**
 * 阶段 A — 题目单元切分（本地题号定界的整题框）
 * ------------------------------------------------------------------
 * 背景：原红笔锚点建块（wrongq-block.buildBlocks）以"红笔簇"为中心收紧成**紧框**，
 * 框的只是"错误处那一条"。本模块把"题目边界"从红墨重定义为**题号行**。
 *
 * 核心方法（借鉴作业帮/小猿等主流错题本：先版面/朝向校正 → 再"题号到题号"语义聚类）：
 *   1. **朝向已在校正阶段用 OCR 投票解决**（见 image-orient），本模块假定传入的
 *      `ctx.flatBuf` 与 `regions` 已是正立坐标系。
 *   2. **以 OCR region 为原子单元**（而非投影行）：每个 region 自带真实包围盒，天然携带
 *      单题的纵向位置；即使多道题被 OCR 排进同一视觉行，也能在 region 粒度上区分。
 *   3. **扫描每个 region 文本里的【全部】题号**（不限行首）：一行内嵌 `11./12.` 也会各自
 *      成为独立题头；单 region 含多题号时，按视觉行/栏把该 region 拆成多个子段。
 *   4. **题号容错**：OCR 偶会把题号糊进单词（如 `7heath...` 实为 `7.`），用"行首数字后紧跟
 *      字母/汉字"的兜底规则补检；同时排除 `2026.04` 这类年份（数字≥1000）误当题号。
 *   5. **阅读顺序分组**：按 (栏, y) 排序后，每个题号开一个新单元，其后无题号的续行并入本单元，
 *      直到下一个题号。单元边界 = [本题号 y0, 下一题号 y0) × 满栏宽。
 *
 * P1（#129）文档结构感知的三处切分加固（均两页 GT 实测驱动）：
 *   A. **标题行识别**（detectHeaderRegions）：`【预习案】`/`Ⅱ.汉译英。`/`IL.阅读…` 等
 *      大节/小类标题行不再参与题号扫描——旧实现把 `Ⅱ.` 当题号"二"产出伪单元，
 *      且小类标题后的内容会跨节污染上一题单元盒。
 *   B. **行感知切分**：token 的纵向位置按"视觉行"估计（region 高/1.3medH 估行数），
 *      替代字符占比线性切 Y——实测背面 "…are 17." 题号在行尾（字符占比 90%），
 *      比例切分把它切成 4px 细条，平铺后 6px 被 sliver 过滤丢掉整道题（缺 17）。
 *   C. **同栏并排行 x 切分**：词汇区网格 "11.…自愿做12." 左右两格题号被 OCR 并成一个
 *      region，旧平铺按 (栏,y) 顺序把右格题号挤成 4px sliver 丢弃（缺 12）；
 *      现按"锚点近 + 题号头 x 远"识别并排行，行内按内容间隙 x 切分各自成题。
 *
 * 输出 `QuestionUnit[]` 供阶段 B（wrongq-evidence）把红墨锚点映射到题目单元、取满框。
 */
import { type LayoutContext, colsAtY, sectionIndexAtY, effectiveColsAtY } from './wrongq-layout'
import type { LocalOcrTextRegion } from '../ocr/ocr.types'
import type { ParsedNumber } from '../ocr/ocr-hierarchy'

/** 一个题目单元 = 同栏内 [题号 y0, 下一题号 y0) × 满栏宽 */
export interface QuestionUnit {
  id: number
  /** 所属栏索引（0 起，section 内局部） */
  col: number
  /** 所属 section 索引（0 起；混合版面下不同 section 栏结构不同） */
  sec: number
  /** 解析出的题号 */
  number: ParsedNumber
  /** 整题框：满栏宽 × [题号, 下一题号) */
  box: { x0: number; y0: number; x1: number; y1: number }
  /** 占位（几何以 box 为准） */
  rows: number[]
  /**
   * 题号锚点（#128 红墨归属评分用）：题号在页面像素坐标系中的估计位置。
   *
   * 为什么需要它（P0 实测根因）：单元盒在多题号 region 上会错位——
   * "行中多题号按字符占比切 Y 轴" 使 Q10/Q11/Q12 的盒整体偏移，
   * 订正词按"盒包含/IoU"归属会全数错判（Q12 订正落进 Q10 盒内）。
   * 改判"题号锚点"：锚点是题号字身的估计位置（region 内按字符占比估算），
   * 与订正词的墨量加权中心做带权距离评分（上方 1.0 / 下方 0.7，
   * 同分按到锚点的水平距离破平），对盒错位免疫。
   * 无锚点（未能定位题号）时为 undefined，调用方不得做归属。
   */
  anchor?: { x: number; y: number }
  // ------------------------------------------------------------------
  // P1（#129）文档结构字段（由 wrongq-structure.analyzeQuestionUnits 回填）
  // ------------------------------------------------------------------
  /** 所属大节（DocStructure.sections 下标） */
  sec2?: number
  /** 所属小类（该大节 subsections 下标） */
  sub2?: number
  /** 所在编号空间的编号规则 */
  numbering?: 'segmented' | 'unified'
  /** 规范题号标签（如 "预习案·Ⅱ.汉译英 18"；跨页续接节为 "前页续 2"） */
  label?: string
  /** 题号经过序列自纠（误读修正/缺号补认，见 wrongq-structure.repairSequence） */
  repaired?: boolean
  /** 内容横向并集（行聚类判别"并排网格"用，非裁图框） */
  cx0?: number
  cx1?: number
  /** 题号头签名：token 前至多 2 字符 + token raw（误读判别用，如 "M9."） */
  headSig?: string
  /** 题号头来源 region 下标（-1 = 无；列拆分时指原始 region） */
  regionIdx?: number
}

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'
const ROMAN: Record<string, number> = {
  'Ⅰ': 1, 'Ⅱ': 2, 'Ⅲ': 3, 'Ⅳ': 4, 'Ⅴ': 5,
  'Ⅵ': 6, 'Ⅶ': 7, 'Ⅷ': 8, 'Ⅸ': 9, 'Ⅹ': 10,
}
/** 罗马数字串（标签用） */
const ROMAN_STR = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ', 'Ⅸ', 'Ⅹ', 'Ⅺ', 'Ⅻ']

/** 中文数字（≤99）→ 阿拉伯；无法解析返回 null */
function cjkToNum(s: string): number | null {
  if (!s) return null
  if (/^\d+$/.test(s)) return Number(s)
  const digits = [...s]
  if (digits.some((d) => !'一二三四五六七八九十'.includes(d))) return null
  const idxTen = digits.indexOf('十')
  if (idxTen === -1) {
    let total = 0
    for (const d of digits) total = total * 10 + ('一二三四五六七八九十'.indexOf(d) + 1)
    return total > 0 ? total : null
  }
  const hi = idxTen === 0 ? 1 : '一二三四五六七八九十'.indexOf(digits[idxTen - 1]) + 1
  const lo = idxTen === digits.length - 1 ? 0 : '一二三四五六七八九十'.indexOf(digits[idxTen + 1]) + 1
  return hi * 10 + lo
}

function romanToNum(s: string): number {
  return ROMAN[s] ?? 0
}

/**
 * 罗马数字（含 OCR 糊读变体）→ 序号。
 *
 * 为什么需要"含糊读"（P1 实测）：小类标题的罗马序号是 OCR 重灾区——
 *   - `IL.`（背面阅读节）= `III.`（L 是 I 的糊读）→ 主解释 3，备选 2；
 *   - `II.` 被糊成 `11.`（设计文档 §4.5 预留）→ 2；`III.` → `111.` → 3；
 *   - unicode `Ⅰ-Ⅹ` 直接映射（可叠加：`ⅠⅠ` = 2）。
 * 返回 alt 供结构树按"前序序号"消歧（IL 在前序为 2 时取 3）。
 */
export function parseRomanLoose(s: string): { num: number | null; alt: number | null } {
  const t = s.trim()
  if (!t) return { num: null, alt: null }
  // unicode 罗马：单字符直接取值，多字符相加（ⅠⅠ = 2）
  if (/^[Ⅰ-Ⅹ]+$/.test(t)) {
    let v = 0
    for (const ch of t) v += romanToNum(ch)
    return { num: v > 0 && v <= 12 ? v : null, alt: null }
  }
  // IL / LI / ll / Il / lI（含至少一个 L/l，排除纯 II/ii）：III 或 II 的糊读——主 3 备 2。
  // 大小写不敏感（实测背面阅读标题 OCR 给全大写 "IL."，旧实现要求大小写混出才会触发，
  // 导致落进 ascii 路径被 L→I 替换解析成 2 且无 alt，label 显示 Ⅱ 实为 Ⅲ）。
  if (/^[ILil]{2}$/.test(t) && /[Ll]/.test(t)) return { num: 3, alt: 2 }
  // II / ii：II 的标准/糊读形态
  if (/^[Ii]{2}$/.test(t)) return { num: 2, alt: null }
  // 数字罗马：11 → II，111 → III
  if (/^1[il1]?$/.test(t)) return { num: t.length === 3 ? 3 : 2, alt: null }
  // ascii 罗马（I/V/X，标准加减法）
  const up = t.toUpperCase().replace(/L/g, 'I')
  if (!/^[IVX]+$/.test(up)) return { num: null, alt: null }
  const vals: Record<string, number> = { I: 1, V: 5, X: 10 }
  let v = 0
  for (let i = 0; i < up.length; i++) {
    const cur = vals[up[i]]
    const nxt = i + 1 < up.length ? vals[up[i + 1]] : 0
    v += cur < nxt ? -cur : cur
  }
  return { num: v > 0 && v <= 12 ? v : null, alt: null }
}

interface QToken {
  idx: number
  num: ParsedNumber
}

/**
 * 扫描整段文本里的【全部】题号（不限行首），按出现顺序返回其字符下标与解析结果。
 * 出现重叠/歧义时按"具体优先"顺序匹配：括号中文 > 中文 > 圈码 > 罗马 > 括号阿拉伯 > 裸阿拉伯 > 行首糊字 > 行尾裸数字。
 * 数字 ≥1000（年份/大数）一律排除，避免 `2026.04` 被误当题号；两位年份尾巴
 * （"in 1961." 被截成 "61.d"，num>20 且题号后仅跟一个孤立字母到文本尾）同样排除。
 * 行尾裸数字（无标点，如 "make it 14"）在前面有题干内容时算题号，孤立数字不算。
 */
export function findQuestionTokens(text: string): QToken[] {
  const toks: QToken[] = []
  let i = 0
  while (i < text.length) {
    const _i0 = i // 防御：保证本轮必然推进，杜绝零宽匹配导致死循环
    const rest = text.slice(i)
    let m: RegExpMatchArray | null
    let num: ParsedNumber
    if ((m = rest.match(/^[（(]\s*([一二三四五六七八九十]{1,3})\s*[）)]/))) {
      num = { kind: 'paren-cjk', num: cjkToNum(m[1]), raw: m[0].trim() }
    } else if ((m = rest.match(/^([一二三四五六七八九十]{1,3})\s*[、，,．.]/))) {
      num = { kind: 'cjk', num: cjkToNum(m[1]), raw: m[0].trim() }
    } else if ((m = rest.match(/^[①-⑳]/))) {
      num = { kind: 'circled', num: CIRCLED.indexOf(m[0]) + 1, raw: m[0] }
    } else if ((m = rest.match(/^[Ⅰ-Ⅹ]+\s*\./))) {
      num = { kind: 'cjk', num: romanToNum(m[0].replace(/[\s.]/g, '')), raw: m[0].trim() }
    } else if ((m = rest.match(/^[（(]\s*(\d{1,2})\s*[）)]/))) {
      // 选项字母后的括号数字（如 "C.(5)"）不是题号；跳过但仍推进 i 避免死循环
      if (/(?<![（(])[A-E]\s*[.、，,．.)）]/.test(text.slice(0, i))) { i += m[0].length; continue }
      num = { kind: 'arabic', num: Number(m[1]), raw: m[0].trim() }
    } else if ((m = rest.match(/^(\d{3,})(?!\d)\s*[.、.．.)）]/))) {
      // 3 位及以上数字 + 分隔符（961. / 1961.）是年份/大数，不是题号（#124 实测：
      // 探究案 "the worst ___ in 1961." 被 OCR 成 "n961.d"，误产出题号 961）。
      // 整体跳过（仍推进 i 避免死循环）。
      i += m[0].length
      continue
    } else if ((m = rest.match(/^(\d{1,2})(?!\d)\s*[.、.．.)）]/))) {
      // 分隔符不含逗号 → "5,000"/"1,500" 千分位自然不匹配；
      // 另排除选项字母引导的数字（"C.5." 的 5、"B.4." 的 4 等选择题选项标注）；跳过但仍推进 i
      if (/(?<![（(])[A-E]\s*[.、，,．.)）]/.test(text.slice(0, i))) { i += m[0].length; continue }
      // 年份尾巴防护（#124 实测）："in 1961." 被 OCR 截成 "61.d"——题号后只跟一个
      // 孤立字母即到文本尾，是数字串截断的残留形态而非题号。真实题号后要么直接是
      // 题干内容（多字符），要么无尾巴；"10.hm"（下划线糊化，两个字符）不受影响。
      // 仅 num>20 才启用：保护小题号带单字糊尾的真实题号（如 "10.h"）。
      if (Number(m[1]) > 20 && /^[A-Za-z]$/.test(rest.slice(m[0].length))) { i += m[0].length; continue }
      num = { kind: 'arabic', num: Number(m[1]), raw: m[0].trim() }
    } else if ((m = rest.match(/^(\d{1,2})(?!\d)\s+([a-z]{1,5})(?![A-Za-z])/))) {
      // F1 行中裸题号 + 空格 + 短小写词（#R1 gt-back 实测）："...the winds make it
      // 14 homd d to control."——手写题号嵌在句流里，题号后常跟一个被手写墨渍
      // 糊化的短词。多重防护（任一命中即跳过）：
      //  ① 前导数字："1,500 people" 的 "00"/"0" 尾巴、"in 1961" 截断出的 "61"
      //  ② o'clock："3 o'clock" 点钟表达不是题号
      //  ③ 单元/章节词："Unit 1" "Page 3" "Lesson 2" 的编号不是题号
      //  ④ num>20 且前接介词 in/on/at…：年份残片（"in 61 the…"）
      //  ⑤ 选项字母前缀（同分隔符规则，#124）
      //  ⑥ 后接计量单位词："20 years ago" 类数量表达（p2 实测 FP）
      //  ⑦ 前接约数词 about/around…："about 20 students" 类约数表达
      // 仅小写开头词："Unit 1 Reading" 类标题专名不误伤；糊词 OCR 普遍小写。
      const head = text.slice(0, i)
      const tail = rest.slice(m[1].length)
      if (
        /\d$/.test(head) ||
        /^\s*o'?clock/i.test(tail) ||
        /(?:unit|section|part|lesson|book|grade|class|page|line|activity|project|topic|module|step|stage)\s*$/i.test(head) ||
        (Number(m[1]) > 20 && /\b(?:in|on|at|since|by|for|before|after|during|until)\s*$/i.test(head)) ||
        /\b(?:about|around|nearly|almost|approximately)\s*$/i.test(head) ||
        /^\s+(?:years?|months?|weeks?|days?|hours?|minutes?|seconds?|times?|percent|dollars?|cents?|miles?|meters?|metres?|kilometers?|kilometres?|kilos?|kilograms?)\b/i.test(tail) ||
        /(?<![（(])[A-E]\s*[.、，,．.)）]/.test(head)
      ) {
        i += m[1].length
        continue
      }
      num = { kind: 'arabic', num: Number(m[1]), raw: m[1] }
    } else if (i === 0 && (m = rest.match(/^(\d{1,3})(?=[A-Za-z\u4e00-\u9fff])/))) {
      num = { kind: 'arabic', num: Number(m[1]), raw: m[0].trim() } // 行首被糊进单词：7heat
    } else if ((m = rest.match(/^(\d{1,2})$/))) {
      // 行尾裸题号（#124 实测）：嵌入句里的题号常位于 region 文本末尾且无标点
      // （"...put it out?Becayse 13" / "the winds make it 14"），旧实现漏产 token
      // 导致背面 13/14 无题目单元。仅当前面有题干内容（字母/汉字，可带一个
      // 逗号/分号+空白，如 "...the winds were strong, 9"）时采纳——
      // 光秃秃的孤立数字（页眉得分 "26"、选项区 "9"）不采纳：snapTol≈1.5 行高，
      // 伪单元会把无题号的红笔块吸附成错误题号。逗号放宽（#R1 gt-back R52 实测）
      // 不波及千分位："5,000" 的 "00"/"0" 尾巴前面是数字而非字母，仍被拒。
      if (/(?<![（(])[A-E]\s*[.、，,．.)）]/.test(text.slice(0, i)) || !/[A-Za-z\u4e00-\u9fff]\s*[,，;；]?\s*$/.test(text.slice(0, i))) {
        i += m[0].length; continue
      }
      num = { kind: 'arabic', num: Number(m[1]), raw: m[0].trim() }
    } else {
      i++
      continue
    }
    const raw = m[0]
    if (num.kind !== 'none' && !(num.num != null && num.num >= 1000)) {
      toks.push({ idx: i, num })
    }
    i += raw.length
    if (i <= _i0) i = _i0 + 1 // 兜底：绝不许 i 原地踏步
  }
  return toks
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

// ----------------------------------------------------------------------
// P1：文档结构标题行识别（大节/小类）
// ----------------------------------------------------------------------

/** 文档结构标题行（大节/小类）的识别结果 */
export interface HeaderRegion {
  /** 来源 region 在 regions 数组中的下标 */
  idx: number
  kind: 'section' | 'subsection'
  /** 小类罗马序号（主解释）；无罗马前缀为 null */
  roman: number | null
  /** 罗马序号备选解释（糊读消歧用，如 IL → III 主 / II 备） */
  romanAlt: number | null
  /** 标题文本（已去罗马前缀与首尾标点） */
  title: string
  y0: number
  y1: number
}

/**
 * 小类"指令行"模式（无罗马前缀时的标题形态）：根据…/用…填空/选词填空/阅读…/汉译英…
 * F3 修复（#R3 gt-front 实测）：「汉译英。」/「英译汉」不在旧模式里（旧 `翻译` 二字不匹配
 * "汉译英"），导致汉译英节整节落入「音标写单词」编号空间，两节题号交错后大批误判重号
 * 丢弃（dups=[1,2,4,6,2,4,6,8,10,12,14]，真值 6 题仅命中 1）。
 */
const INSTRUCTION_RE =
  /(根据|按照|用[^，。；;]{0,14}填空|选词|阅读|翻译|汉译英|英译汉|译成|写作|完成句子|仿写|改写|回答问题|判断|连线|匹配|仿照)/
/** 英文指令行（罗马前缀后的英文标题，防 "I. am a student." 类句子被误判） */
const INSTRUCTION_EN_RE = /(reading|choose|choosing|cloze|fill|translat|writ|complet|match|answer|put)/i

/** 大节标题模式：【X案】/ 第X部分 / 独立一行以"案/卷"结尾的短行 */
const SECTION_RES: RegExp[] = [
  /^【\s*([^】\s]{1,12})\s*】$/,
  /^第\s*([一二三四五六七八九十\d]{1,3})\s*[部分编章]$/,
  /^([\u4e00-\u9fff]{1,8})\s*[案卷]$/,
]

/** 清标题：去首尾空白与常见尾标点 */
function cleanTitle(s: string): string {
  return s.replace(/^[\s.、．,，:：;；]+/, '').replace(/[\s.、．,，:：;；]+$/, '').trim()
}

/**
 * ② 3.x 版面模型标题增强（PP-StructureV3 blocks → 页眉候选）。
 *
 * 动机（#141 实测）：自研文本规则在英语作业册 4 页上标题识别**全空**——
 * "Unit1TheChangingWorld"（无空格粘连）/ "Section B How do changes influence us?" /
 * "重点单词》"（OCR 把【】装饰误识为 》）均不匹配 SECTION_RES/罗马/指令正则。
 * 而 3.x 版面模型（PP-DocLayout_plus-L）的 paragraph_title 块在这些页上
 * 4/3/3/5 个全部命中真实标题——是结构层最可靠的标题先验。
 *
 * 保守融合原则（保无回归）：
 *   - 只增不删：文本规则已识别的 header 全部保留；模型块与其 y 重叠则跳过（去重）；
 *   - 分类尽量走与文本路径**同一套规则**（SECTION_RES/罗马/小类形态），
 *     仅补两类真实缺失模式：英文大节前缀（Unit/Section/Part…）与短中文标签；
 *   - 模型弱头兜底（规则全不命中但模型明确标 title）：文本 ≤36 字符、≤3 行、
 *     不以题号开头才收——防词条行/题干被误当标题制造伪边界。
 */
export function enhanceHeadersWithLayout(
  headers: HeaderRegion[],
  blocks: Array<{ type: string; box: number[]; text?: string }>,
  regions: LocalOcrTextRegion[],
): { headers: HeaderRegion[]; extraSkip: number[] } {
  /** 3.x 版面模型的标题类标签（PP-DocLayout_plus-L 标签集） */
  const TITLE_LABELS = new Set(['paragraph_title', 'doc_title', 'header'])
  /**
   * 英文大节前缀（作业册常见：Unit1 / Section A / Part II / Module 3）。
   * `\b` 改负向小写前瞻：OCR 常把 "Unit1 The..." 识成无空格粘连 "Unit1The..."，
   * `\b` 在 "1T" 间不成立会漏判；`(?![a-z])` 同时排除 "Partly"（part+ly 小写）误报。
   */
  const EN_SECTION_RE = /^(unit|section|part|module|lesson|book|grade)\s*[\dIVXAB]{0,4}(?![a-z])/i
  /** 标题装饰符（OCR 常把【】/»/〉 误识为 》>〉） */
  const TITLE_DECOR_RE = /[】》>»〉\]）)]+$/
  /** 题号行开头（弱头兜底的排除条件） */
  const QNUM_HEAD_RE = /^\s*\d{1,2}\s*[.、．)]/

  const out = [...headers]
  const takenIdx = new Set(headers.map((h) => h.idx))
  const extraSkip: number[] = []
  // 文本规则已覆盖的 y 区间（模型块与其重叠 → 去重保留文本头）
  const covered = headers.map((h) => [h.y0, h.y1] as const)

  for (const b of blocks) {
    if (!TITLE_LABELS.has(b.type)) continue
    const [bx0, by0, bx1, by1] = b.box
    if (!(by1 > by0) || !(bx1 > bx0)) continue
    // 块内文本行（中心点落入 bbox，容差 2px）
    const inner: number[] = []
    regions.forEach((r, i) => {
      const [x0, y0, x1, y1] = r.box
      const cx = (x0 + x1) / 2
      const cy = (y0 + y1) / 2
      if (cx >= bx0 - 2 && cx <= bx1 + 2 && cy >= by0 - 2 && cy <= by1 + 2) inner.push(i)
    })
    if (!inner.length || inner.some((i) => takenIdx.has(i))) continue
    if (covered.some(([y0, y1]) => by0 < y1 + 4 && by1 > y0 - 4)) continue
    const text = cleanTitle(inner.map((i) => regions[i].text).join('').replace(TITLE_DECOR_RE, ''))
    if (!text || text.length > 48) continue
    // 分类（与文本路径同规则 + 两类补充模式）
    let kind: 'section' | 'subsection' | null = null
    let roman: number | null = null
    let romanAlt: number | null = null
    for (const re of SECTION_RES) {
      const m = text.match(re)
      if (m) {
        kind = 'section'
        break
      }
    }
    if (!kind && EN_SECTION_RE.test(text)) kind = 'section'
    if (!kind) {
      const rm = text.match(/^([Ⅰ-Ⅻ]{1,5}|[IVXilL]{1,5}|1[il1]?)\s*[.、．]?\s*(.+)$/)
      if (rm) {
        const r0 = parseRomanLoose(rm[1])
        const title = cleanTitle(rm[2])
        if (r0.num != null && looksLikeSubTitle(title, /^\d/.test(rm[1]))) {
          kind = 'subsection'
          roman = r0.num
          romanAlt = r0.alt
        }
      }
    }
    if (!kind && looksLikeSubTitle(text, false)) kind = 'subsection'
    // 模型弱头兜底：模型明确标了 title 但规则全不命中——严形态才收
    if (!kind && text.length <= 36 && inner.length <= 3 && !QNUM_HEAD_RE.test(text)) {
      kind = 'subsection'
    }
    if (!kind) continue
    out.push({ idx: inner[0], kind, roman, romanAlt, title: text, y0: by0, y1: by1 })
    for (const i of inner) {
      takenIdx.add(i)
      extraSkip.push(i)
    }
  }
  out.sort((a, b) => a.y0 - b.y0 || a.y1 - b.y1)
  return { headers: out, extraSkip }
}

/**
 * 识别一页 OCR 文本行里的【文档结构标题行】。
 *
 * 为什么需要（P1，R3 根因）：系统原先不认识「大节（预习案/探究案/检测案）→
 * 小类（罗马数字/指令行）→ 题号」的层级——`Ⅱ.汉译英。` 被题号扫描器当成题号"二"
 * 产出伪单元，小类标题区的内容还会跨节污染上一题的单元盒。
 *
 * 判定（尽量通用，不锁死样本页形态）：
 *   - **大节**：`【预习案】` 括号行 / `第三部分` / 独立短行以"案/卷"结尾；
 *   - **小类**：罗马前缀（unicode/ascii/糊读 IL·11/数字罗马）+ 短标题，
 *     或无罗马但匹配指令行模式（根据…/用…填空/阅读…/选词填空/汉译英…）的短行；
 *   - 防护：标题总长 ≤48；题干（长行）不混入；拉丁字母标题须匹配英文指令模式
 *     （排除 "I. am a student." 类句子）；数字罗马（11.）须指令行佐证
 *     （排除把题号 11 误判成小类 II）。
 */
export function detectHeaderRegions(regions: LocalOcrTextRegion[]): HeaderRegion[] {
  const out: HeaderRegion[] = []
  regions.forEach((r, idx) => {
    const t = (r.text || '').trim()
    if (!t || t.length > 48) return
    const b = rb(r)
    if (b.x1 <= b.x0 || b.y1 <= b.y0) return
    // ① 大节
    for (const re of SECTION_RES) {
      const m = t.match(re)
      if (m) {
        out.push({ idx, kind: 'section', roman: null, romanAlt: null, title: cleanTitle(m[1]), y0: b.y0, y1: b.y1 })
        return
      }
    }
    // ② 小类：罗马前缀 + 标题
    const rm = t.match(/^([Ⅰ-Ⅹ]{1,5}|[IVXilL]{1,5}|1[il1]?)\s*[.、．]?\s*(.+)$/)
    if (rm) {
      const r0 = parseRomanLoose(rm[1])
      const title = cleanTitle(rm[2])
      const fromDigits = /^\d/.test(rm[1])
      if (r0.num != null && title && looksLikeSubTitle(title, fromDigits)) {
        out.push({ idx, kind: 'subsection', roman: r0.num, romanAlt: r0.alt, title, y0: b.y0, y1: b.y1 })
        return
      }
    }
    // ③ 小类：无罗马的指令行（罗马被 OCR 整丢的兜底）
    if (t.length <= 40 && !/^\s*[\d（(]/.test(t) && INSTRUCTION_RE.test(t)) {
      const title = cleanTitle(t)
      if (title && title.length <= 36) {
        out.push({ idx, kind: 'subsection', roman: null, romanAlt: null, title, y0: b.y0, y1: b.y1 })
      }
    }
  })
  out.sort((a, b) => a.y0 - b.y0 || a.y1 - b.y1)
  return out
}

/** 小类标题形态判定：CJK 主导允许"指令模式或短名词短语"；拉丁主导必须指令模式 */
function looksLikeSubTitle(title: string, fromDigits: boolean): boolean {
  if (fromDigits) return INSTRUCTION_RE.test(title) && title.length <= 24 // 数字罗马须指令行佐证
  const latin = (title.match(/[A-Za-z]/g) || []).length
  const cjk = (title.match(/[\u4e00-\u9fff]/g) || []).length
  if (latin > cjk) return INSTRUCTION_EN_RE.test(title)
  return INSTRUCTION_RE.test(title) || title.length <= 12
}

interface Span {
  col: number
  sec: number
  /** 所在版面带（colSections 区间）的栏几何快照——跨带合并的判据：
   *  几何相同（如单栏页被空白/横线切成多条带）视为同一版面，内容可跨带挂靠；
   *  几何不同（单栏↔双栏的混合版面）必须切断，栏索引不可比。 */
  colsKey: string
  y0: number
  y1: number
  /** 该段内容的横向范围（用于单元取框：跨栏内容不应被单栏宽斩断） */
  x0: number
  x1: number
  text: string
  isHead: boolean
  num: ParsedNumber
  /** 题号锚点 x（仅 head 段有效）：region 内按字符占比估算的题号左缘 */
  ax?: number
  /** 题号锚点 y（仅 head 段有效）：所在视觉行的行心 */
  ay?: number
  /** 题号头签名（仅 head）：token 前至多 2 字符 + raw */
  sig?: string
  /** 来源 region 下标 */
  ri: number
}

/** detectQuestionUnits 的可选控制（P1 二遍注入用） */
export interface DetectUnitsOpts {
  /** 不作题号/内容扫描的 region（文档结构标题行） */
  skipRegions?: Set<number>
  /** 强制作为题号头的 region → 指定题号（缺号补认/误读修正的二遍注入） */
  forceHeads?: Map<number, ParsedNumber>
  /** 强制降级为内容的 region（重号单元的丢弃） */
  dropRegions?: Set<number>
  /**
   * 结构标题（大节 + 小类）的 y 位置：内容段不得跨这些边界并入上一题，
   * 单元底边也不得伸过这些边界（平铺 GAP_CAP 桥接会把标题区吞进上一题框）。
   */
  sectionCuts?: number[]
}

/**
 * 从 OCR 区域中切出题目单元。
 *
 * @param ctx   版面上下文（提供 w/h/medH/cols，与裁图坐标系一致）
 * @param regions  OCR 侧车返回的 text_regions（坐标需已处于 ctx.flatBuf 像素空间）
 * @param opts   P1 结构感知控制（标题行跳过 / 二遍注入 / 大节边界）
 */
export function detectQuestionUnits(ctx: LayoutContext, regions: LocalOcrTextRegion[], opts?: DetectUnitsOpts): QuestionUnit[] {
  if (!ctx || !ctx.cols || !ctx.cols.length) return []
  if (!regions || !regions.length) return []
  const medH = ctx.medH || 24
  const PAD = Math.max(2, Math.round(medH * 0.3)) // 首行上方留白，避免首字被切
  const MAX_UNIT_H = Math.max(140, Math.round(medH * 22)) // 单元高度上限，防单框吞整页
  // 主流错题本（小猿/作业帮）头号失败模式：题间留白不足会把多题粘连成一道错框。
  // 故以"题号头 → 下一题号头"为单元，且聚合时遇到【大纵向间隙】（如阅读篇章与上一题的留白）
  // 立即终止，把篇章归为中性的"非题目"段，绝不跨无题号区串联吞段。
  const GAP_SPLIT = Math.round(medH * 2.5) // 题块间大间隙阈值：超过则上一题到此为止
  const GAP_CAP = Math.round(medH * 2.5) // 单元底边最多向外延展的间隙（桥接小题空行，不吞篇章）
  const sectionCuts = opts?.sectionCuts ?? []

  // ①-0 编号风格预投票（P1 实测加固）：圈码 ①-⑳ 在试题卷里绝大多数是【选项/子项标记】
  //   （背面 Q23 题干 "①Helping each other. ②Learning valuable lessons. …"），不是题号。
  //   仅当全文不存在任何其他风格的题号候选（阿拉伯/中文/括号/部分大题）时，才允许圈码
  //   充当题号（极少数纯圈码编号的卷子）；否则一律降级为内容。
  //   旧实现把圈码当题号头：不仅产出幻影单元（背面底部 ①/② 被走查按重号丢弃），还会把
  //   同行真正的题号区挤成被吸收内容（"23" 曾因此退化为 repair 补认才捞回）。
  const styleVote = new Map<string, number>()
  const bumpVote = (k: string) => styleVote.set(k, (styleVote.get(k) ?? 0) + 1)
  for (let ri = 0; ri < regions.length; ri++) {
    if (opts?.skipRegions?.has(ri) || opts?.dropRegions?.has(ri)) continue
    const t = (regions[ri].text || '').trim()
    if (!t) continue
    const b = rb(regions[ri])
    if (b.x1 <= b.x0 || b.y1 <= b.y0) continue
    if (b.y1 - b.y0 < Math.round(medH * 0.55)) continue // 杂散标记不当风格样本
    const forcedV = opts?.forceHeads?.get(ri)
    const toksV: QToken[] = forcedV ? [{ idx: 0, num: forcedV }] : findQuestionTokens(t)
    for (const tk of toksV) bumpVote(tk.num.kind)
  }
  const circledAsHead =
    (styleVote.get('circled') ?? 0) > 0 &&
    ['arabic', 'cjk', 'paren-cjk', 'part'].every((k) => (styleVote.get(k) ?? 0) === 0)

  // ① 把每个 region 展开成 1~N 个 span：region 内出现多个题号时，按视觉行/栏拆分
  const spans: Span[] = []
  regions.forEach((r, ri) => {
    if (opts?.skipRegions?.has(ri)) return // 文档结构标题行：不当题号也不当内容
    const t = (r.text || '').trim()
    if (!t) return
    const b = rb(r)
    if (b.x1 <= b.x0 || b.y1 <= b.y0) return
    // 杂散标记防护（P1 实测）：物理高度不足 0.55×medH 的 region 不是文本行——
    // 正面词汇区页眉 "13T" 仅 7px，旧实现把它当题号 13 的头并吞掉第 1 题。
    if (b.y1 - b.y0 < Math.round(medH * 0.55)) return
    const cyMid = (b.y0 + b.y1) / 2
    // R2 修复（#R2）：colSections 对照片噪点栏缝漏判时按 region 分居实证回落全局栏
    const colsY = effectiveColsAtY(ctx, regions, cyMid)
    const col = colOfX((b.x0 + b.x1) / 2, colsY)
    const sec = sectionIndexAtY(ctx, cyMid)
    const sy0 = b.y0
    const H = b.y1 - b.y0 + 1
    // 强制头（二遍注入的补认/修正题号）视为位于 region 行首的合成 token
    const forced = opts?.forceHeads?.get(ri)
    const dropped = opts?.dropRegions?.has(ri)
    const toksRaw: QToken[] = forced ? [{ idx: 0, num: forced }] : dropped ? [] : findQuestionTokens(t)
    // 圈码降级（见上方 ①-0 风格预投票）：非纯圈码文档的圈码 token 是选项/子项标记，
    // 不当题号头。二遍注入的强制头豁免——修复逻辑已按编号空间风格判定。
    const toks: QToken[] = circledAsHead || forced
      ? toksRaw
      : toksRaw.filter((tk) => tk.num.kind !== 'circled')
    // 选项区防护：一行含 ≥2 个「A./B./C./D./E.」引导子项 → 整行是选择题选项，整段跳过。
    // 判定须收紧为【大写 A–E + 边界(行首/空格/括号) + 分隔符】，否则英语正文里的
    // "e)"(OCR 把 experience) 糊成) 或 "In" 里的 I 会被误判成选项字母，
    // 导致整条含题号的题干 region 被错误丢弃（实测 q4 因此消失）。
    const optLead = (t.match(/(^|[\s(（])[A-E]\s*[.、.．.)）]/g) || []).length
    if (optLead >= 2 && !forced) return
    // 圈码选项排列防护（仅纯圈码编号文档需要，见 ①-0）：单行含 ≥3 个圈码
    // （如 "C.①④②③"）→ 视为选项序列而非多道题，整段不作 head
    // （避免拆成 N 个 0 高度 sliver 退化框）。混合文档里圈码已被预投票降级，此处恒不触发。
    const circledCount = toks.filter((tk) => tk.num.kind === 'circled').length
    const isCircledChoice = circledCount >= 3
    // 视觉行数（行距 ≈1.3×medH）：token 的纵向位置按行估计，替代字符占比线性切 Y
    const k = Math.max(1, Math.round(H / Math.max(1, medH * 1.3)))
    const lineH = H / k
    const len = Math.max(1, t.length)
    const lineOf = (idx: number) => Math.min(k - 1, Math.max(0, Math.floor((idx / len) * k)))
    /** 同行两个 token 之间的横向边界：优先取二者之间的栏左缘，否则取字符占比中点 */
    const splitX = (iA: number, iB: number) => {
      const xA = b.x0 + (iA / len) * (b.x1 - b.x0)
      const xB = b.x0 + (iB / len) * (b.x1 - b.x0)
      const cA = colOfX(xA, colsY)
      const cB = colOfX(xB, colsY)
      if (cB > cA) return colsY[cB][0]
      return b.x0 + ((iA + iB) / 2 / len) * (b.x1 - b.x0)
    }
    const cuts = [0, ...toks.map((tk) => tk.idx), t.length]
    for (let kk = 0; kk < cuts.length - 1; kk++) {
      const a = cuts[kk]
      const c = cuts[kk + 1]
      const segText = t.slice(a, c).trim()
      if (!segText) continue
      // 多圈码排列：整段当作内容（非 head），不开启新单元
      const isHead = !isCircledChoice && kk > 0 // 首个 cut 之后的段都以题号开头
      const tok = isHead ? toks[kk - 1] : null
      // 段纵向范围：token 所在视觉行顶 → 下一 token 视觉行顶（或 region 底）
      const lineA = tok ? lineOf(tok.idx) : 0
      const nextTok = toks[kk]
      const lineB = nextTok && lineOf(nextTok.idx) > lineA ? lineOf(nextTok.idx) : k
      const y0 = Math.round(sy0 + lineA * lineH)
      const y1 = Math.round(sy0 + lineB * lineH)
      // 段横向范围：同行多 token 时按栏边界/字符占比 x 切分（词汇区网格实测）。
      // 单 token 且不在 region 行首时（背面 cloze "…Even 12." 的 12 在行尾），
      // 段界取题号自身的字符占比 x——否则中段题号会继承整个 region 的宽度，
      // 与同栏邻题做并排 x 切分时排序颠倒、边界错位。
      let x0 = b.x0
      let x1 = b.x1
      const tokX = (idx: number) => b.x0 + (idx / len) * (b.x1 - b.x0)
      if (tok) {
        const prevTok = kk >= 2 ? toks[kk - 2] : null
        if (prevTok && lineOf(prevTok.idx) === lineA) x0 = Math.round(splitX(prevTok.idx, tok.idx))
        else x0 = Math.round(tokX(tok.idx)) // 无前邻 token：段自题号处起
        if (nextTok && lineOf(nextTok.idx) === lineA) x1 = Math.round(splitX(tok.idx, nextTok.idx))
      } else if (nextTok && lineOf(nextTok.idx) === 0) {
        x1 = Math.round(tokX(nextTok.idx)) // 题号前的引导内容段：右界到下一题号
      }
      // 题号锚点（#128）：x 按字符占比落在 region 横向进度上；y 取所在视觉行行心
      const ax = b.x0 + (a / len) * (b.x1 - b.x0)
      const ay = sy0 + (lineA + 0.5) * lineH
      const num = isHead && tok ? tok.num : { kind: 'none' as const, num: null, raw: '' }
      const sig = isHead && tok ? (t.slice(Math.max(0, tok.idx - 2), tok.idx) + tok.num.raw).slice(0, 8) : undefined
      spans.push({
        col, sec,
        colsKey: JSON.stringify(colsY),
        y0: Math.min(y0, y1 - 1), y1,
        x0: Math.min(x0, x1 - 1), x1,
        text: segText, isHead, num,
        ax: isHead ? ax : undefined,
        ay: isHead ? ay : undefined,
        sig, ri,
      })
    }
  })
  if (!spans.length) return []

  // ② 按阅读顺序排序（section → 栏 → 纵向）；混合版面下跨 section 必须用 sec 区分，
  //    否则上下 section 同为 col 0 会被误并成同一单元而跨区粘连。
  spans.sort((p, q) => (p.sec - q.sec) || (p.col - q.col) || (p.y0 - q.y0) || (p.y1 - q.y1))

  // ③ 分组：题号开新单元；其后无题号续行并入；题号之前的引导语（preamble）直接丢弃
  //    （避免把页眉/标题糊成巨型单元；丢弃后这些区域的红笔会回落紧框兜底）
  interface RawUnit {
    col: number
    sec: number
    /** 题号头所在版面带的栏几何快照（见 Span.colsKey） */
    colsKey: string
    yTop: number
    yBot: number
    num: ParsedNumber
    noHeadH: number
    /** 本题所有内容的横向并集（含题号行与续行） */
    minX: number
    maxX: number
    /** 题号锚点（来自 head 段；无则为 undefined） */
    ax?: number
    ay?: number
    /** 题号头签名（误读判别用） */
    sig?: string
    /** 来源 region 下标 */
    ri: number
  }
  const raws: RawUnit[] = []
  let cur: RawUnit | null = null
  let preamble = true
  // 连续无题号内容高度预算：一旦某单元从其题号底往下连续吞了超过「单题内容高度上限」的纯内容
  // （典型就是阅读理解大段篇章），即判定进入共享篇章，立即收口，绝不把整篇短文吞进一个框。
  const CONTENT_BUDGET = Math.round(medH * 8) // 单题内容高度上限（约 8 行）
  for (const sp of spans) {
    if (sp.isHead) {
      if (cur) raws.push(cur)
      cur = { col: sp.col, sec: sp.sec, colsKey: sp.colsKey, yTop: sp.y0, yBot: sp.y1, num: sp.num, noHeadH: 0, minX: sp.x0, maxX: sp.x1, ax: sp.ax, ay: sp.ay, sig: sp.sig, ri: sp.ri }
      preamble = false
    } else if (!preamble) {
      if (!cur) continue
      // 捕获为局部常量：后续闭包（sectionCuts.some）内 TS 不为 let 变量收窄
      const c: RawUnit = cur
      // 跨栏或跨版面（栏几何不同：单栏↔双栏等混合版面）：上一单元到此为止，本段归入
      // 中性区，不并入任何题。栏几何相同的相邻带（单栏页被空白/横线切成多条带，实测
      // 背面底部 [1743,1804] 带）不算跨版面——Q23 的题干行与选项行压在该带上，
      // 旧实现按 sec 切断把它们丢成中性内容，红笔落在选项上时归属不到题。
      if (c.colsKey !== sp.colsKey || c.col !== sp.col) { raws.push(c); cur = null; continue }
      // 跨大节/小类边界（P1）：文档结构标题把页面切成区间，内容段不得跨边界并入上一题
      if (sectionCuts.some((y) => sp.y0 >= y && c.yTop < y)) { raws.push(c); cur = null; continue }
      // 大纵向间隙（篇章/留白）：上一题到此为止，本段归入中性区，不并入任何题，避免吞段
      if (sp.y0 - c.yBot > GAP_SPLIT) { raws.push(c); cur = null; continue }
      const grow = Math.max(0, sp.y1 - c.yBot)
      // 内容预算超限：进入共享篇章，收口本题，后续内容中性丢弃直到下一个题号头
      if (c.noHeadH + grow > CONTENT_BUDGET) { raws.push(c); cur = null; continue }
      c.yBot = Math.max(c.yBot, sp.y1)
      c.noHeadH += grow
      c.minX = Math.min(c.minX, sp.x0)
      c.maxX = Math.max(c.maxX, sp.x1)
    }
    // sp.isHead==false 且 preamble（cur 为 null）→ 丢弃引导语
  }
  if (cur) raws.push(cur)

  // ④ 计算单元边界并【无缝平铺】（P1：行感知——同栏并排网格行按 x 切分，不再互相挤压）
  raws.sort((a, b) => (a.col - b.col) || (a.yTop - b.yTop) || (a.yBot - b.yBot))
  const units: QuestionUnit[] = []
  let prevBot = -1
  let prevCol = -1
  let i = 0
  while (i < raws.length) {
    // 行分组：同栏相邻 raw 若"锚点近（≤1.2medH）且题号头 x 相距远（≥3medH）"→ 并排同行
    // （词汇区网格左右两格；上下续行的两道题锚点 x 相近，不会误并）
    let j = i
    while (j + 1 < raws.length && raws[j + 1].col === raws[i].col && sideBySide(raws[j], raws[j + 1], medH)) j++
    const row = raws.slice(i, j + 1)
    const ru0 = row[0]
    // R2 修复（#R2）：同 span 构建口径——单栏带漏判双栏时按 region 实证回落全局栏，
    // 否则单元横向取框会拿通栏宽、把另一栏内容框进本题（p3 巨型单元根因）。
    const secCols = effectiveColsAtY(ctx, regions, ru0.yTop)
    // 横向取框 = 本题内容实际覆盖的栏并集，而非死取「落点那一栏」。
    //
    // 为什么必须这么做（用户反馈根因）：一道题的正文若横向跨越了栏分隔线（探究案 那种
    // "从左至右贯穿整页"的题目），取单栏宽会把它的右半边生生斩掉（用户描述为
    // "右边的内容被分栏斩断了"）。此处以内容自身边界为准：内容在一栏内 → 即该栏（与旧行为一致）；
    // 内容跨栏 → 取跨过的所有栏的并集，右半边自然被纳入。
    const padX = Math.max(0, Math.round(medH * 0.3))
    // G1 修复（#R3 gt-front / p3 实测）：栏重叠判定必须用【未加 pad 的内容边界】。
    // padX 会把贴栏缝的内容衬到邻栏右缘——p3 题21 内容左界 519 + pad 9 = 510，
    // 恰好够到左栏 [0,510] 的右缘 510（`b < cMin` 不成立）→ 左栏被判重叠，
    // 单元框吃进全宽 [0,1079]（U17「21」与 U19-24「重点句型2-7」实测；
    // gt-front U0 音标区同理，R19 右溢 15px + pad 即够到 524）。pad 只做最终框外扩。
    const rawMin = Math.min(...row.map((r) => r.minX))
    const rawMax = Math.max(...row.map((r) => r.maxX))
    const cMin = Math.max(0, Math.round(rawMin) - padX)
    const cMax = Math.min(ctx.w - 1, Math.round(rawMax) + padX)
    let uX0 = Infinity, uX1 = -Infinity
    for (const [a, b] of secCols) {
      if (b < rawMin || a > rawMax) continue
      uX0 = Math.min(uX0, a)
      uX1 = Math.max(uX1, b)
    }
    if (uX0 === Infinity) { const c = secCols[ru0.col] ?? [0, ctx.w]; uX0 = c[0]; uX1 = c[1] }
    // 内容本身可能溢出最后一个栏 → 再取一次并集，确保内容一定被框住
    uX0 = Math.min(uX0, cMin)
    uX1 = Math.max(uX1, cMax + 1)
    const cx0 = Math.max(0, Math.round(uX0))
    const cx1 = Math.min(ctx.w, Math.round(uX1))
    // 下一行（同栏）的题号顶
    let nextTop: number | null = null
    for (let k2 = j + 1; k2 < raws.length; k2++) {
      if (raws[k2].col === ru0.col) { nextTop = raws[k2].yTop; break }
    }
    const rowTop = Math.min(...row.map((r) => r.yTop))
    const rowBot = Math.max(...row.map((r) => r.yBot))
    let top = Math.max(0, Math.round(rowTop) - PAD)
    if (prevCol === ru0.col && prevBot >= 0) top = Math.max(top, prevBot + 1)
    let bot: number
    // 行底边 = 内容底边 + 留白，但至多桥接 GAP_CAP 的小间隙（小题空行）；
    // 若下一同行题号很远（中间是篇章/留白），则停在内容外 GAP_CAP 处，不吞段。
    if (nextTop != null) bot = Math.min(Math.round(nextTop) - 1, Math.round(rowBot) + PAD + GAP_CAP)
    else bot = Math.min(ctx.h - 1, Math.round(rowBot) + PAD)
    // 结构边界封顶（P1）：底边不得伸过下一个【大节/小类】标题——标题 region 已跳过
    // （不当内容也不当题号），GAP_CAP 桥接会把标题区吞进上一题框
    // （正面 汉译英17 的框曾伸进【探究案】标题区、背面 Q8 曾吞掉选词填空开头）。
    for (const y of sectionCuts) if (y > rowTop && y - 1 < bot) bot = y - 1
    if (bot - top + 1 > MAX_UNIT_H) bot = top + MAX_UNIT_H - 1
    bot = Math.min(ctx.h - 1, bot)
    if (bot < top) bot = top
    prevBot = bot
    prevCol = ru0.col
    // 退化 sliver 过滤：region 按字符占比拆段时，文本含重复题号（如 "15...15."）会切出
    // 几个 px 高的零内容段（#124 实测：正面 15 题产出 [0,1644,1462,1647] 高 3px 的假单元），
    // 造成同题号重复 unit。低于半行高且非页面唯一内容的一律丢弃。
    const minH = Math.max(4, Math.round(medH * 0.5))
    if (bot - top + 1 < minH && raws.length > 1) { i = j + 1; continue }
    if (row.length === 1) {
      const ru = row[0]
      units.push({
        id: units.length,
        col: ru.col,
        sec: ru.sec,
        number: ru.num,
        box: { x0: cx0, y0: top, x1: Math.max(cx0, cx1 - 1), y1: bot },
        rows: [0],
        anchor: ru.ax != null && ru.ay != null ? { x: ru.ax, y: ru.ay } : undefined,
        cx0: ru.minX, cx1: ru.maxX,
        headSig: ru.sig, regionIdx: ru.ri,
      })
    } else {
      // 并排行：按内容横向间隙 x 切分（间隙内有栏边界则优先用栏边界）
      const sorted = [...row].sort((a, b) => a.minX - b.minX || a.yTop - b.yTop)
      const bounds: number[] = [cx0]
      for (let m = 0; m < sorted.length - 1; m++) {
        let bd = Math.round((sorted[m].maxX + sorted[m + 1].minX) / 2)
        for (const [a2, b2] of secCols) if (a2 > sorted[m].maxX && a2 < sorted[m + 1].minX) bd = a2
        bounds.push(Math.max(bounds[m], Math.min(bd, cx1)))
      }
      bounds.push(cx1)
      for (let m = 0; m < sorted.length; m++) {
        const ru = sorted[m]
        units.push({
          id: units.length,
          col: ru.col,
          sec: ru.sec,
          number: ru.num,
          box: { x0: bounds[m], y0: top, x1: Math.max(bounds[m], bounds[m + 1] - 1), y1: bot },
          rows: [0],
          anchor: ru.ax != null && ru.ay != null ? { x: ru.ax, y: ru.ay } : undefined,
          cx0: ru.minX, cx1: ru.maxX,
          headSig: ru.sig, regionIdx: ru.ri,
        })
      }
    }
    i = j + 1
  }
  return units
}

/**
 * 并排判定（平铺行分组用）：锚点近 + 内容横向并集不重叠且间距 ≥3×medH。
 * 上下续行的两道题内容 x 会重叠（都从左边距起）→ 不会误并（背面 Q11/Q12 实测）。
 *
 * P1 补充第二条通路（#129 实测）：同 section 同栏的两个题号**纵向区间重叠**时，
 * 物理上必然是并排（顺序题的纵向区间不会交叠）——版面把网格行误判成单栏时
 * （正面词汇区顶部 y<370），Q3/Q4 同栏且内容 x 因跨栏 region 错并而交叠，
 * 仅靠内容间隙认不出并排，会被平铺的 prevBot/nextTop 挤压成 sliver 丢弃
 * （正面缺 4）。此时按「锚点 x 分居 ≥3×medH」认定左右两格并排。
 */
function sideBySide(
  a: { sec: number; ay?: number; ax?: number; yTop: number; yBot: number; minX: number; maxX: number },
  b: { sec: number; ay?: number; ax?: number; yTop: number; yBot: number; minX: number; maxX: number },
  medH: number,
): boolean {
  if (a.sec !== b.sec) return false
  if (a.ay == null || b.ay == null) return false
  if (Math.abs(a.ay - b.ay) > medH * 1.2) return false
  const gap = Math.max(a.minX - b.maxX, b.minX - a.maxX)
  if (gap >= medH * 3) return true
  // 纵向区间重叠 ≥ 较小带的一半 且 锚点 x 分居 ≥3×medH → 并排网格行
  const ov = Math.min(a.yBot, b.yBot) - Math.max(a.yTop, b.yTop)
  const minBand = Math.min(a.yBot - a.yTop, b.yBot - b.yTop)
  const dx = a.ax != null && b.ax != null ? Math.abs(a.ax - b.ax) : 0
  return ov >= 0.5 * minBand && dx >= medH * 3
}

/**
 * 给定 (col, y)，返回 y 落入的题目单元；无则 undefined（调用方回落紧框兜底）。
 *
 * @param snapTol 吸附容差：y 未直接落入任何单元时，允许归到同栏「距离最近」的单元（桥接单元
 *   之间的行间空隙 / PAD 留白）。传 0 表示不吸附（严格命中）。建议 1~2 倍字高。
 */
export function findUnitForY(
  units: QuestionUnit[],
  col: number,
  y: number,
  snapTol = 0,
): QuestionUnit | undefined {
  let snap: QuestionUnit | undefined
  let snapD = Infinity
  for (const u of units) {
    if (u.col !== col) continue
    if (y >= u.box.y0 && y <= u.box.y1) return u
    if (snapTol > 0) {
      const d = y < u.box.y0 ? u.box.y0 - y : y - u.box.y1
      if (d <= snapTol && d < snapD) { snapD = d; snap = u }
    }
  }
  return snap
}
