/**
 * 题目层级推断（纯本地规则，不依赖 VLM）
 * ------------------------------------------------------------------
 * 背景：VLM 输出的 items 常常漏填 parent_index —— 尤其当"一道大题含若干小题"时，
 * 它只把 1./2./3. 各小题平铺输出，既不标 parent_index 也不带大题题干，
 * 于是子题脱离上下文、无法作答（用户反馈的"无本之木"BUG）。
 *
 * 本模块的作用是**兜底**：只对"尚未标注 parent_index"的题做推断，
 * 已由模型正确标注的一律尊重、不覆盖。全部规则基于中小学试卷的编号约定，
 * 纯字符串匹配，零网络、零模型调用。
 *
 * 编号约定（中小学试卷主流）：
 *   大题（父题）：一、/ 二、/ 十一、 ；（一）（二） ；第一部分 / 第二大题
 *   小题（子题）：1. 2. 3. ；（1）（2） ；① ② ③
 */
import type { RecognizedItem } from './ocr.types'

/** 题号类型 */
export type NumKind =
  /** 中文数字：一、 二、 */
  | 'cjk'
  /** 括号中文数字：（一）（二） */
  | 'paren-cjk'
  /** 部分/大题：第一部分、第二大题 */
  | 'part'
  /** 阿拉伯数字：1. 2) （3） */
  | 'arabic'
  /** 圈码：① ② ③ */
  | 'circled'
  /** 无题号 */
  | 'none'

export interface ParsedNumber {
  kind: NumKind
  /** 阿拉伯数字题号的数值；其他类型为 null */
  num: number | null
  /** 匹配到的题号原文，便于调试 */
  raw: string
}

const CJK = '一二三四五六七八九十'
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩'

/** 把中文数字（≤99）转阿拉伯数字，无法解析返回 null */
function cjkToNum(s: string): number | null {
  if (!s) return null
  if (/^\d+$/.test(s)) return Number(s)
  const digits = [...s]
  if (digits.some((d) => !CJK.includes(d))) return null
  // 十位是可选的：十一 → 11，十 → 10，三 → 3
  const idxTen = digits.indexOf('十')
  if (idxTen === -1) {
    let total = 0
    for (const d of digits) total = total * 10 + (CJK.indexOf(d) + 1)
    return total > 0 ? total : null
  }
  const hi = idxTen === 0 ? 1 : CJK.indexOf(digits[idxTen - 1]) + 1
  const lo = idxTen === digits.length - 1 ? 0 : CJK.indexOf(digits[idxTen + 1]) + 1
  return hi * 10 + lo
}

/**
 * 解析题干开头的题号。
 * 注意：必须取"开头"的题号，避免把题面中间出现的"（1）"误判为本题题号。
 */
export function parseQuestionNumber(text: string): ParsedNumber {
  const s = (text || '').trim()
  if (!s) return { kind: 'none', num: null, raw: '' }

  // 第一部分 / 第二大题
  let m = s.match(/^第\s*([一二三四五六七八九十\d]{1,3})\s*(?:部分|大题|卷)/)
  if (m) return { kind: 'part', num: cjkToNum(m[1]), raw: m[0] }

  // （一）(二)
  m = s.match(/^[（(]\s*([一二三四五六七八九十]{1,3})\s*[）)]/)
  if (m) return { kind: 'paren-cjk', num: cjkToNum(m[1]), raw: m[0] }

  // 一、 二， 十一.
  m = s.match(/^([一二三四五六七八九十]{1,3})\s*[、，,．.]\s*/)
  if (m) return { kind: 'cjk', num: cjkToNum(m[1]), raw: m[0] }

  // ① ② ③
  if (CIRCLED.includes(s[0])) return { kind: 'circled', num: CIRCLED.indexOf(s[0]) + 1, raw: s[0] }

  // （1） (2)  → 括号阿拉伯数字
  m = s.match(/^[（(]\s*(\d{1,2})\s*[）)]/)
  if (m) return { kind: 'arabic', num: Number(m[1]), raw: m[0] }

  // 1. 2、 3)  → 裸阿拉伯数字
  m = s.match(/^(\d{1,2})\s*[、，,．.)）]\s*/)
  if (m) return { kind: 'arabic', num: Number(m[1]), raw: m[0] }

  return { kind: 'none', num: null, raw: '' }
}

/** 大题级（父题）编号 */
export function isMajorKind(k: NumKind): boolean {
  return k === 'cjk' || k === 'paren-cjk' || k === 'part'
}

/** 小题级（子题）编号 */
export function isMinorKind(k: NumKind): boolean {
  return k === 'arabic' || k === 'circled'
}

const isMajor = isMajorKind
const isMinor = isMinorKind

/**
 * 从大题题干中抽取"完成 1-3 题"这类显式子题范围。
 * 命中时只有落在该范围内的题号才被判为该大题的子题 —— 很强的约束，能避免跨大题误挂。
 */
export function parseDeclaredRange(text: string): [number, number] | null {
  const s = text || ''
  const patterns = [
    /完成\s*第?\s*(\d{1,2})\s*[-–—~至到]\s*第?\s*(\d{1,2})\s*题/,
    /完成\s*第?\s*(\d{1,2})\s*[、，,]\s*第?\s*(\d{1,2})\s*题/,
    /回答\s*第?\s*(\d{1,2})\s*[-–—~至到]\s*第?\s*(\d{1,2})\s*题/,
    /第\s*(\d{1,2})\s*[-–—~至到]\s*(\d{1,2})\s*题/,
  ]
  for (const re of patterns) {
    const m = s.match(re)
    if (m) {
      const a = Number(m[1])
      const b = Number(m[2])
      if (a > 0 && b >= a) return [a, b]
    }
  }
  return null
}

/** 题干是否带有"下面还有子题"的引导语 */
export const SUB_HINT =
  /(完成|回答|阅读下面|阅读下列|阅读下面的文字|阅读下列材料|根据材料|结合[材文]|按要求|请回答|回答下列)/

export interface InferOptions {
  /** 调试用：返回每题的题号解析结果 */
  debug?: boolean
}

export interface InferResult {
  items: RecognizedItem[]
  /** 每题的题号解析（与 items 同序），debug 用 */
  parsed: ParsedNumber[]
  /** 新推断出的父子关系数量 */
  inferred: number
}

/**
 * 推断父子关系（只填未标注的 parent_index）。
 *
 * 主规则（存在大题级编号时）：
 *   - 遇到大题级编号 → 成为当前父题，并抽取其声明的子题范围（"完成 1-3 题"）；
 *   - 其后的小题级编号，若题号从 1（或声明范围起点）开始连续递增、且落在声明范围内 → 判为子题；
 *   - 遇到下一个大题级编号 → 切换父题。
 *
 * 次规则（全篇无大题级编号，但出现圈码时）：
 *   - ①②③ 紧跟在一道非圈码题之后 → 该题视为父题。
 *
 * 安全边界（宁可不挂，也不误挂）：
 *   - 已标注 parent_index 的题不覆盖；
 *   - 全篇只有阿拉伯数字编号时（很多试卷用 1./2./3. 作大题号）不建立父子，避免把大题互挂；
 *   - 小题号不连续 / 不从 1 开头 / 超出声明范围 → 不挂。
 */
export function inferHierarchy(items: RecognizedItem[], opts: InferOptions = {}): InferResult {
  const parsed = items.map((it) => parseQuestionNumber(it.question_content || it.stem || ''))
  const parentOf: (number | null)[] = items.map((it) =>
    typeof it.parent_index === 'number' && it.parent_index >= 0 ? it.parent_index : null,
  )
  const hasMajor = parsed.some((p) => isMajor(p.kind))
  let inferred = 0

  if (hasMajor) {
    // 按大题切段：每段的边界是"下一个大题级编号"
    const majorIdx = parsed.map((p, i) => (isMajor(p.kind) ? i : -1)).filter((i) => i >= 0 && parentOf[i] === null)
    const segs = majorIdx.map((s, k) => ({
      parent: s,
      start: s + 1,
      end: k + 1 < majorIdx.length ? majorIdx[k + 1] : items.length,
    }))

    for (const seg of segs) {
      // 子题编号类型取段内众数：材料段落常用 ①②③ 标号（只有 1–2 个），
      // 真正的小题往往连续多个，众数能把它俩分开，避免材料标号挤掉真小题。
      const counts = new Map<NumKind, number>()
      for (let i = seg.start; i < seg.end; i++) {
        if (!isMinor(parsed[i].kind)) continue
        counts.set(parsed[i].kind, (counts.get(parsed[i].kind) || 0) + 1)
      }
      const parentText = items[seg.parent].question_content || items[seg.parent].stem || ''
      const range = parseDeclaredRange(parentText)

      if (!counts.size) {
        // 段内没有任何编号：若父题带"完成/阅读下面"引导语，紧跟其后的无号行视为被拆散的小问
        for (let i = seg.start; i < seg.end; i++) {
          if (parentOf[i] !== null) continue
          if (parsed[i].kind !== 'none') continue
          if (!SUB_HINT.test(parentText)) break
          parentOf[i] = seg.parent
          inferred++
        }
        continue
      }

      let subKind: NumKind = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
      // 父题显式声明"完成 1-3 题"时，只认阿拉伯数字编号（圈码是材料段落标号）
      if (range) subKind = 'arabic'

      // localParent：最近一个"独立成题"的下标（初始为段的大题）。
      // 试卷里常见三层结构：「三、实验题」>「17. 某实验」>「（1）（2）」，
      // 数据模型只有两层，故让（1）（2）挂到 17 题而非「三、实验题」——
      // 17 题的题面才是它们真正的题干，挂到 section 标题等于没挂。
      let localParent = seg.parent
      // expect 为 null 表示"下一个编号未知，由遇到的第一项定起点"
      // （跨页试卷常见：某 section 的小题从 11 开始，不是从 1 开始）
      let expect: number | null = range ? range[0] : null

      for (let i = seg.start; i < seg.end; i++) {
        if (parentOf[i] !== null) continue // 已由模型标注，尊重
        const p = parsed[i]
        if (p.kind !== subKind) continue
        const n = p.num
        if (n === null) continue

        if (range) {
          // 有显式声明范围：严格按范围 + 连续性，不连续就不挂（宁可不挂也不误挂）
          if (n < range[0] || n > range[1] || n !== expect) continue
          parentOf[i] = seg.parent
          inferred++
          expect = n + 1
          continue
        }

        if (expect === null) {
          // 序列起点：无论编号是 1 还是 11，都作为该父题的第一个子题
          parentOf[i] = localParent
          inferred++
          expect = n + 1
          continue
        }
        if (n === expect) {
          parentOf[i] = localParent
          inferred++
          expect = n + 1
          continue
        }
        // 断档：说明上一序列结束，本题开启新序列（如 1,2,3 之后出现 17.）。
        // 它自身仍属于本 section → 挂到大题；并成为后续小题的父题。
        parentOf[i] = seg.parent
        inferred++
        localParent = i
        expect = null
      }
    }
  } else {
    // 次规则：只有圈码时，圈码紧跟的前一道非圈码题视为父题
    let cur = -1
    let expect = 1
    for (let i = 0; i < items.length; i++) {
      if (parentOf[i] !== null) continue
      const p = parsed[i]
      if (p.kind === 'circled' && cur >= 0 && p.num === expect) {
        parentOf[i] = cur
        inferred++
        expect = p.num! + 1
        continue
      }
      if (p.kind !== 'none') {
        cur = i
        expect = 1
      }
    }
  }

  const out = items.map((it, i) => {
    const pi = parentOf[i]
    const next: RecognizedItem = { ...it }
    if (pi !== null) {
      next.parent_index = pi
      next.level = 2
    } else {
      next.parent_index = null
      if (typeof next.level !== 'number') next.level = 1
    }
    return next
  })

  return { items: out, parsed: opts.debug ? parsed : [], inferred }
}

/**
 * 层级回填：保证"大题含若干小题"时，子题一定携带所属大题的题干。
 *
 * 背景（用户反馈 BUG）：识别结果原本是扁平 items，模型会只把 1./2./3. 各小题分别输出，
 * 而把"三、阅读理解…"这类大题题干整段丢弃，导致小题脱离上下文无法作答（无本之木）。
 *
 * 处理（就地修改 items）：
 * - 子题（parent_index 指向有效父题）继承父题题干到 stem；
 * - 若子题 question_content 尚未包含该题干，则前置拼接，使子题独立可读；
 * - 顶层题补 stem = 自身题面，便于前端统一按 stem 展示。
 */
export function linkHierarchy(items: RecognizedItem[]): void {
  if (!items.length) return
  const n = items.length
  // 保存"原始题面"：后续子题拼接会改写 question_content，必须留一份未拼接的底稿
  const origQ = items.map((it) => (it.question_content || '').trim())
  const pi: (number | null)[] = items.map((it, i) => {
    const p = typeof it.parent_index === 'number' ? it.parent_index : null
    return p !== null && p >= 0 && p < n && p !== i ? p : null
  })

  // 按层级深度升序处理：必须先定完父题的完整题面，子题才能继承到正确的题干。
  // （否则会出现「三、实验题 > 17.某题 > （1）」里，（1）拿到的是 section 题干而非 17 题题面。）
  const depth = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    let d = 0
    let cur = i
    let guard = 0
    while (pi[cur] !== null && guard++ < n) {
      d++
      cur = pi[cur]!
    }
    depth[i] = d
  }
  const order = [...Array(n).keys()].sort((a, b) => depth[a] - depth[b])

  // 顶层题：stem = 自身题面（模型已给的保留）
  for (const i of order) {
    if (pi[i] === null && !items[i].stem) items[i].stem = origQ[i]
  }

  for (const i of order) {
    if (pi[i] === null) continue
    const p = pi[i]!
    const child = items[i]
    // stem = 所属父题**自身**的题面（而非父题被上级拼接后的全文）
    child.stem = origQ[p] || child.stem
    child.level = 2
    // 拼接时用父题**处理完毕后**的完整题面，把整条链路的上下文都带下来
    const parentQ = (items[p].question_content || '').trim()
    const q = origQ[i]
    if (!q) {
      child.question_content = parentQ
    } else if (parentQ && !q.includes(parentQ)) {
      // 父题全文可能很长，取前 200 字做包含判断（模型可能已改写/截断题干）
      const probe = parentQ.slice(0, 200)
      child.question_content = q.includes(probe) ? q : `${parentQ}\n${q}`
    } else {
      child.question_content = q
    }
  }

  // 未标注 level 的题统一视为顶层题
  for (let i = 0; i < n; i++) {
    if (typeof items[i].level !== 'number') items[i].level = 1
    if (items[i].parent_index === undefined) items[i].parent_index = null
  }
}
