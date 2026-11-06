/**
 * 「这段资料里是不是这道题」的判定真相源（零依赖，可单编单测）。
 *
 * P-006 / D-009（2026-11-04）：资料库搜题不得把**同主题资料片段**当作这道题的答案。
 * 现状的三层错位：主题词召回 ⇒ bigram 覆盖率衡量「主题相似」⇒ 抽一段上下文塞进 answer。
 * 本文件只负责一件事：**判定 + 定位**，不负责检索、不负责呈现。
 *
 * 设计要点：
 *  - 检索词（找资料）与判定锚点（认原题）**分开**：主题词用于召回，区分性片段用于判定。
 *  - 判定用「题干 6 字滑窗片段」的**多锚点共现**，不用 bigram 覆盖率——
 *    一篇满是「抛物线 / 平行四边形」的专题解析可以是另一道题，但不会同时命中
 *    本道题特有的多个 6 字片段。
 *  - 归一化去掉全部标点/空白，容忍 OCR 与排版的标点差异。
 *  - 宁可判不出（topic），也不冒充（exact）。短题干 / 无解析段一律降级。
 */

/** 初中常见知识点词表：只用于「从题干里挑检索词」，**不得单独作为原题判定锚点** */
export const TOPIC_WORDS: readonly string[] = [
  // 物理
  '浮力', '压强', '密度', '重力', '摩擦力', '杠杆', '滑轮', '机械效率', '机械能', '动能', '势能',
  '电流', '电压', '电阻', '欧姆定律', '电功率', '电功', '焦耳定律', '串联', '并联', '磁场', '电磁感应',
  '光的反射', '光的折射', '凸透镜', '成像', '物态变化', '熔化', '凝固', '汽化', '液化', '升华',
  '比热容', '内能', '热量', '声音', '音调', '响度', '速度', '路程', '参照物', '惯性', '二力平衡',
  // 数学
  '函数', '一次函数', '二次函数', '反比例函数', '方程', '方程组', '不等式', '因式分解', '分式',
  '三角形', '全等', '相似', '四边形', '平行四边形', '矩形', '菱形', '梯形', '圆', '扇形', '切线',
  '勾股定理', '锐角三角函数', '正弦', '余弦', '正切', '概率', '统计', '平均数', '中位数', '方差',
  '数列', '集合', '导数', '圆锥', '圆柱', '体积', '表面积',
  // 化学
  '化学式', '化学方程式', '配平', '相对分子质量', '溶液', '溶质', '溶剂', '溶解度', '酸碱盐',
  '氧化还原', '化合反应', '分解反应', '置换反应', '复分解反应', '金属活动性', 'pH',
  // 生物 / 语文 / 英语（搜题也会遇到）
  '细胞', '光合作用', '呼吸作用', '遗传', '生态系统', '文言文', '古诗', '阅读理解', '完形填空',
]

/** 题干里这些开头的片段做检索词基本是噪声 */
export const NOISE_PREFIX: readonly string[] = [
  '如图', '下列', '关于', '我们', '一个', '如果', '已知', '根据', '请', '求', '计算',
  '的是', '正确', '错误', '说法', '选项', '设', '求证', '试',
]

/** 判定参数（P-006 ⑥ 验收断言锁定） */
export const MATCH_MIN_LONG_ANCHORS = 3
/** 长锚点命中率下限：命中 ≥3 个且覆盖 ≥40% 才算同一道题 */
export const MATCH_MIN_LONG_RATIO = 0.4
const ANCHOR_LEN = 6
const ANCHOR_STEP = 3
const MAX_ANCHORS = 12

/** 归一化：只留汉字 / 字母 / 数字，消除 OCR 与排版的标点、空白差异 */
export function normalizeForMatch(s: string): string {
  return (s || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
}

/** 片段是否「只有主题词 / 噪声前缀」，是则没有区分性 */
export function isTopicOrNoiseSegment(seg: string): boolean {
  if (seg.length < 2) return true
  if (NOISE_PREFIX.some((p) => seg.startsWith(p))) return true
  for (const w of TOPIC_WORDS) {
    // 片段里主题词之外只剩 ≤2 字 ⇒ 这段不区分「哪一道题」
    if (seg.includes(w) && seg.length - w.length <= 2) return true
  }
  // 纯数字 / 纯字母交给数值与变量锚点处理，6 字窗口本身不收
  if (/^\d+$/.test(seg) || /^[A-Za-z]+$/.test(seg)) return true
  return false
}

export interface Distinctive {
  /** 用于 SQL 粗筛的区分性片段（长度 ≥4，避免 ilike 命中一大片） */
  keys: string[]
  /** 用于原题判定的锚点：6 字滑窗 + 数值串 + 字母变量名 */
  anchors: string[]
  /** 其中长度 ≥4 的「长锚点」——判 exact 只认它们 */
  longAnchors: string[]
}

/**
 * 从题干抽「区分性片段」。
 * 与 `extractKeys`（主题召回词）互补：主题词负责把同专题资料找出来，
 * 区分性片段负责判定找出来的到底是不是这道题。
 */
export function extractDistinctive(question: string): Distinctive {
  const q = normalizeForMatch(question)
  const anchors: string[] = []
  const keys: string[] = []
  const push = (arr: string[], s: string) => {
    const k = s.trim()
    if (k.length >= 2 && !arr.includes(k)) arr.push(k)
  }

  // ① 6 字滑窗（步长 3）：题干特有的连续片段是「是不是同一道题」的强信号
  for (let i = 0; i + ANCHOR_LEN <= q.length && anchors.length < MAX_ANCHORS; i += ANCHOR_STEP) {
    const seg = q.slice(i, i + ANCHOR_LEN)
    if (isTopicOrNoiseSegment(seg)) continue
    push(anchors, seg)
  }

  // ② 数值串（≥2 位）与「字母/数字 + 汉字单位」组合：数学题的区分性主要在这里
  //    ⚠️ 只进 anchors（判定用），不进 keys：2~3 字短片段做 ilike 会命中一大片
  for (const m of q.matchAll(/\d{2,}(?:\.\d+)?|[A-Za-z]?\d+[A-Za-z\u4e00-\u9fa5]/g)) {
    push(anchors, m[0])
    if (anchors.length >= MAX_ANCHORS + 6) break
  }

  // ③ 连续大写字母（数学点名 A/B/C/D/M/N、物理单位 N/J/W/V），同样只进 anchors
  for (const m of q.matchAll(/[A-Z]{2,4}/g)) push(anchors, m[0])

  // 粗筛词只收 ≥4 字的长锚点：短词进 SQL 会让候选池爆炸，且正文精确匹配靠长片段
  for (const a of anchors) if (a.length >= 4) push(keys, a)
  const longAnchors = anchors.filter((a) => a.length >= 4)
  return { keys: keys.slice(0, 12), anchors, longAnchors }
}

export interface AnchorHits {
  /** 命中的长锚点数 */
  hit: number
  /** 长锚点总数 */
  total: number
  /** 命中的长锚点（排障用） */
  matched: string[]
  /** 命中率 0~1 */
  ratio: number
}

/** 题干的长锚点在文本里共现了多少个（判定唯一依据，不用 bigram 覆盖率） */
export function countAnchorHits(question: string, text: string): AnchorHits {
  const { longAnchors } = extractDistinctive(question)
  const flat = normalizeForMatch(text)
  const matched = longAnchors.filter((a) => flat.includes(a))
  const total = longAnchors.length
  return {
    hit: matched.length,
    total,
    matched,
    ratio: total === 0 ? 0 : matched.length / total,
  }
}

/** 文本里是否就是这道题（多锚点共现，且达到命中率下限） */
export function isSameQuestion(question: string, text: string): boolean {
  const h = countAnchorHits(question, text)
  return h.total >= MATCH_MIN_LONG_ANCHORS
    && h.hit >= MATCH_MIN_LONG_ANCHORS
    && h.ratio >= MATCH_MIN_LONG_RATIO
}

/** 教辅里的答案 / 解析段标记 */
const SOLUTION_MARKER = /【(?:答案|解析|详解|解答|分析|解)】|(?:^|[\n\r])\s*(?:答案|解析|详解|解答|解)\s*[:：]/g

export interface SolutionSection {
  /** 解析段正文（到下一个标记或 maxChars 截断） */
  excerpt: string
  /** 命中的标记文字（排障用） */
  marker: string
  /** 该段与题干的锚点命中数（用于在多段里挑最接近本题的那一段） */
  anchorsHit: number
}

/**
 * 定位【答案】/【解析】/【详解】段，取代旧的 `snippetFor`（锚点前 60 后 120 字的任意上下文）。
 *
 * 一份教辅里往往连排几十道题、几十个【分析】段：取「与题干锚点共现最多」的那一段，
 * 而不是全文第一个标记，否则抽到的仍是上一题的解析。
 */
export function locateSolution(text: string, question = '', maxChars = 800): SolutionSection | null {
  const marks: { start: number; end: number; label: string }[] = []
  for (const m of text.matchAll(SOLUTION_MARKER)) {
    const at = m.index ?? 0
    marks.push({ start: at, end: at + m[0].length, label: m[0].trim().replace(/^[\n\r\s]+/, '') })
  }
  if (marks.length === 0) return null

  const sections: SolutionSection[] = []
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : Math.min(text.length, marks[i].end + maxChars)
    const excerpt = text.slice(marks[i].end, end).trim().slice(0, maxChars)
    if (!excerpt) continue
    const anchorsHit = question ? countAnchorHits(question, excerpt).hit : 0
    sections.push({ excerpt, marker: marks[i].label, anchorsHit })
  }
  if (sections.length === 0) return null

  // 用户要的是「对推导有意义」的内容，不是只有一个「S=4」。
  // 排序：锚点共现最多 ⇒ 解析类标记优先（【解析】/【详解】/【解答】/【分析】）⇒ 段更长。
  const explanatory = (m: string) => /解析|详解|解答|分析/.test(m) ? 1 : 0
  const rank = (s: SolutionSection) => [s.anchorsHit, explanatory(s.marker), s.excerpt.length]
  let best = sections[0]
  for (const s of sections.slice(1)) {
    const a = rank(s), b = rank(best)
    if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]) || (a[0] === b[0] && a[1] === b[1] && a[2] > b[2])) {
      best = s
    }
  }

  // 结论 + 推导一起给：用户要「能正确解答这道题」，只有【解析】没结论、
  // 或只有「S=4」没过程，对推导都不够。把【答案】段前置拼到最佳解析段前面。
  const answerSection = sections.find((s) => /答案/.test(s.marker) && !explanatory(s.marker))
  const excerpt = answerSection && answerSection !== best
    ? `${answerSection.excerpt}\n${best.excerpt}`.slice(0, maxChars)
    : best.excerpt
  return { ...best, excerpt }
}

export interface Judgement {
  /** 是否认定「找到了这道题 + 定位到它的解析段」 */
  exact: boolean
  /** 解析段（仅 exact 时有值） */
  solution?: string
  /** 长锚点命中数（排障 / 日志用） */
  anchorsHit: number
  /** 长锚点总数 */
  anchorsTotal: number
  /** 是否定位到解析段但没达到原题阈值（topic 也要如实呈现「有资料但没解析」） */
  hasSolutionSection: boolean
}

// ===========================================================================
// P-009 / D-012（2026-11-06）：一题一对象 + 来源位置 + 多因子准入闸门
//
// 为什么加这一层：P-006 的 judge() 把**整份文件**当成一个判定单元。在单题片段上
// 它是对的，但生产正文里一份 docx 常是整本教辅（L3 实测 3.5 万字 / 76 道题 /
// 303 个【答案】标记）。此时「全文锚点共现」会把散落在不同题目里的条件片段凑够
// 3 个，而「文中有任意【解析】段」几乎必然成立 ⇒ 实测 1 道真题判出 3 个 exact，
// 逐条核对全是别的题的解析（单例精确率 0/3）。另发现「条件全同、设问不同」
// （讲义「判断 △AGD 形状」vs 用户「求 △ABC 面积」）也会被当成同题。
//
// 业界（作业帮 CN113505786A「基于空间位置切割拆分，确定待检索的题干内容」、
// TextIn 版面拆题）统一做法是「一道题一个对象」。本层在**纯函数内**用文本标记做
// 等价切分，不依赖版面坐标、不需要重新下载、不写库：
//   ① 切分：按题号 /【例 N】/ 问题 N 找题目起点，按【答案】/【解析】/【分析】
//      找相邻解析段 ⇒ 每个 QuestionObject 自带来源位置（字符区间 + 题号）。
//   ② 多因子：锚点共现**限定在该对象题干内** + 设问意图一致 + 相邻解析段。
//   ③ 闸门：全部达标才放行 exact 且必须带来源位置；任一不达标降级 topic，
//      answer 保持为空。这就是「未达标不放行」，定义与判据见报告 §8。
//
// ⚠️ 本文件仍保持零依赖单文件（M27 用 tsc 单编后 require），不得引入 import。
// ⚠️ judge() 的返回结构 / 阈值字面 / 单题行为**不变**，只是内部委托到本层，
//    否则 P-006 / D-009 的 M27 硬闸会失守。
// ===========================================================================

/** 题目起点标记（行首）：`1．` / `1.` / `1、` / `【例 4】` / `问题一：` / `演练 1` */
const QUESTION_START = /(?:^|\n)[ \t]*(?:(【\s*例\s*\d+\s*】)|(【\s*练习\s*\d+\s*】)|((?:问题|演练)\s*[一二三四五六七八九十\d]+\s*[:：.．]?)|(\d{1,3}\s*[．.、]))/g
/** 非 g 版本，只用于解析段边界检测（避免 lastIndex 在对象循环里串状态） */
const SOLUTION_BOUNDARY_RE = /\n[ \t]*(?:【\s*例\s*\d+\s*】|【\s*练习\s*\d+\s*】|(?:问题|演练)\s*[一二三四五六七八九十\d]+\s*[:：.．]|\d{1,3}\s*[．.、])/

/** 单个题目对象允许的最大题干长度：超出说明切分失败，宁可判不出 */
export const MATCH_MAX_OBJECT_CHARS = 6000
/** 相邻解析段最短有效字数（去掉空白后）：太短的多半是 `【答案】略` */
export const MATCH_MIN_SOLUTION_CHARS = 8
/** 设问意图无法确认时，锚点命中率门槛上调（信息少 ⇒ 要求证据更强） */
export const MATCH_STRICT_ANCHOR_RATIO = 0.55

/** 设问意图类别：条件相同但问的不是一回事，就不该给同一份答案 */
export type AskKind =
  | 'choice' | 'existence' | 'shape' | 'proof' | 'area' | 'angle'
  | 'range' | 'coordinate' | 'ratio' | 'length' | 'value' | 'unknown'

/** 顺序即优先级：`判断…形状并证明` 归 shape，`下列说法正确的是` 归 choice */
const ASK_RULES: readonly [RegExp, AskKind][] = [
  [/下列说法|以下说法|正确的是|错误的是|不正确|符合题意/, 'choice'],
  [/是否存在|是否能|能否|是否/, 'existence'],
  [/形状|是什么三角形|为何种图形|判断.{0,10}(?:形状|三角形|四边形)/, 'shape'],
  [/求证|证明|试证/, 'proof'],
  [/面积/, 'area'],
  [/度数|角度|多少度|为多少度/, 'angle'],
  [/取值范围|最大值|最小值|范围为/, 'range'],
  [/坐标/, 'coordinate'],
  [/之比|比值|比为|∶/, 'ratio'],
  [/长度|的长|周长|线段.{0,6}长/, 'length'],
  [/的值为|为多少|是多少|等于|求.{0,10}(?:值|数)|计算|求/, 'value'],
]

/**
 * 抽「这道题到底在问什么」。只看末尾窗口：中文题干的设问几乎总在最后一句，
 * 拿全文扫关键词会把「已知…面积公式」这类条件误当成设问。
 */
export function extractAsk(text: string): { kind: AskKind; phrase: string } {
  const flat = (text || '').replace(/\s+/g, '')
  const win = flat.length > 80 ? flat.slice(-80) : flat
  for (const [re, kind] of ASK_RULES) {
    const mo = win.match(re)
    if (mo) return { kind, phrase: mo[0] }
  }
  return { kind: 'unknown', phrase: '' }
}

/** 设问一致性：冲突=硬否决，未知=不否决但收紧锚点门槛，相同=放行 */
export function compareAsk(question: string, stem: string): 'same' | 'conflict' | 'unknown' {
  const a = extractAsk(question)
  const b = extractAsk(stem)
  if (a.kind === 'unknown' || b.kind === 'unknown') return 'unknown'
  return a.kind === b.kind ? 'same' : 'conflict'
}

/** 来源位置：让 exact 可追溯到「哪份资料、第几题、原文哪一段」 */
export interface SourceLocation {
  /** 来源文件标识（fs_id / library_docs.id / 'own'），由调用方填 */
  sourceId?: string
  /** 来源文件名（给家长看、可复核），由调用方填 */
  sourceName?: string
  /** 该对象是本文第几个题目（0-based） */
  objectIndex: number
  /** 题号标记原文，如 `1．` / `【例 4】` / 空串（无题号的单题文档） */
  label: string
  /** 对象在原文中的字符区间 [charStart, charEnd) */
  charStart: number
  charEnd: number
  /** 题干区间（用于前端定位，不必回查全文） */
  stemStart: number
  stemEnd: number
}

/** 一题一对象：题干 + 紧跟它的解析段 + 来源位置 */
export interface QuestionObject {
  stem: string
  solution: string
  hasSolution: boolean
  source: SourceLocation
}

/** 把长锚点命中的计算抽出来复用，避免对 76 个对象重复抽题干锚点 */
function hitsWithAnchors(longAnchors: string[], text: string): AnchorHits {
  const flat = normalizeForMatch(text)
  const matched = longAnchors.filter((a) => flat.includes(a))
  const total = longAnchors.length
  return {
    hit: matched.length,
    total,
    matched,
    ratio: total === 0 ? 0 : matched.length / total,
  }
}

/**
 * 把一份正文切成「一题一对象」。
 *
 * 规整教辅（L3 真实语料）：`1．题干…【答案】…【解析】… 2．下一题`；
 * 讲义变体：`【例 4】…`、`问题一：…`；单题片段（自有题库 / ima 高亮）没有题号
 * ⇒ **退化为 1 个对象**，保证 P-006 的老行为不回退。
 */
export function splitQuestionObjects(text: string, source?: { sourceId?: string; sourceName?: string }): QuestionObject[] {
  const src = text || ''
  if (!src.trim()) return []

  // ① 题目起点
  QUESTION_START.lastIndex = 0
  const starts: { at: number; label: string }[] = []
  let mo: RegExpExecArray | null
  while ((mo = QUESTION_START.exec(src)) !== null) {
    starts.push({ at: mo.index + (mo[0].startsWith('\n') ? 1 : 0), label: (mo[0] || '').trim() })
    if (starts.length >= 2000) break
  }

  // ② 解析标记（复用 P-006 的标记集合，避免两套口径漂移）
  SOLUTION_MARKER.lastIndex = 0
  const marks: number[] = []
  while ((mo = SOLUTION_MARKER.exec(src)) !== null) {
    marks.push(mo.index)
    if (marks.length >= 8000) break
  }
  const firstMarkAt = (from: number, to: number): number => {
    for (const at of marks) if (at >= from && at < to) return at
    return -1
  }

  const build = (start: number, end: number, label: string, index: number): QuestionObject => {
    const cut = firstMarkAt(start, end)
    const stemEnd = cut >= 0 ? cut : end
    const location: SourceLocation = {
      ...(source?.sourceId ? { sourceId: source.sourceId } : {}),
      ...(source?.sourceName ? { sourceName: source.sourceName } : {}),
      objectIndex: index,
      label,
      charStart: start,
      charEnd: end,
      stemStart: start,
      stemEnd,
    }
    return {
      stem: src.slice(start, stemEnd),
      solution: cut >= 0 ? src.slice(cut, end) : '',
      hasSolution: cut >= 0,
      source: location,
    }
  }

  if (starts.length === 0) return [build(0, src.length, '', 0)]

  const out: QuestionObject[] = []
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].at
    const end = i + 1 < starts.length ? starts[i + 1].at : src.length
    if (end <= start) continue
    // 起点之前的章节前言（「专题13 …」「一、单选题」）不是题目，不单独成对象
    out.push(build(start, end, starts[i].label, out.length))
  }
  return out.length > 0 ? out : [build(0, src.length, '', 0)]
}

/**
 * 解析段关系校验：与题干共享的「符号指纹」（连续大写字母串、多位数值）。
 * 长锚点对 OCR 标点太敏感，符号指纹在同一章不同题之间也会撞（ABCD、60），
 * 所以它**只作置信分层，不作硬闸**——见报告 §8.4 的残余风险。
 */
function symbolTokens(s: string): string[] {
  const flat = normalizeForMatch(s)
  const out: string[] = []
  for (const m of flat.matchAll(/[A-Z]{2,4}|\d{2,}/g)) if (!out.includes(m[0])) out.push(m[0])
  return out
}

export function solutionLink(question: string, solution: string): {
  anchors: number
  symbols: number
  symbolRatio: number
  score: number
} {
  const anchors = countAnchorHits(question, solution).hit
  const qTokens = symbolTokens(question)
  const sTokens = symbolTokens(solution)
  const symbols = qTokens.filter((t) => sTokens.includes(t)).length
  const symbolRatio = qTokens.length === 0 ? 0 : symbols / qTokens.length
  return { anchors, symbols, symbolRatio, score: anchors * 2 + symbols }
}

/** 多因子明细：排障、验收集统计、置信度分层都读它 */
export interface MatchFactors {
  anchorHit: number
  anchorTotal: number
  anchorRatio: number
  askQuestion: AskKind
  askStem: AskKind
  askMatch: 'same' | 'conflict' | 'unknown'
  adjacentSolution: boolean
  solutionChars: number
  /** 解析段与题干的关系校验（软信号，只影响置信度） */
  solutionLinkScore: number
  /** 解析段里是否出现了下一题的题号：出现=切分错位，该对象不可信 */
  solutionCrossesBoundary: boolean
  requiredRatio: number
  objectCount: number
}

export interface ObjectJudgement extends Judgement {
  /** 是否通过准入闸门（== exact） */
  passed: boolean
  /** 未通过时的人类可读原因（排障；验收集据此统计误判/漏判） */
  rejectReason?: string
  /** 三因子明细 */
  factors: MatchFactors
  /** 0~1，只用于呈现层「请核对」的强弱，不参与放行判定 */
  confidence: number
  /** 放行时必带的来源位置 */
  sourceLocation?: SourceLocation
}

/** 逐个因子判，返回「为什么不放行」——判据集中一处，M31 可逐条验收 */
export function judgeQuestionObject(question: string, obj: QuestionObject, longAnchors: string[], objectCount: number): ObjectJudgement {
  const h = hitsWithAnchors(longAnchors, obj.stem)
  const a = extractAsk(question)
  const b = extractAsk(obj.stem)
  const askMatch = compareAsk(question, obj.stem)
  const solutionChars = obj.solution.replace(/\s+/g, '').length
  const link = obj.hasSolution ? solutionLink(question, obj.solution) : { anchors: 0, symbols: 0, symbolRatio: 0, score: 0 }
  // 解析段里若出现「下一题的题号」，说明题号边界没被识别出来，这个对象里
  // 混进了别人的题 ⇒ 关系不可信，硬否决（对应业界「父子 ID / 位置校验」）。
  // ⚠️ 必须用独立的非 g 正则：QUESTION_START 带 g，.test() 会推进 lastIndex，
  //    在「对 76 个对象循环判定」时会串状态，导致隔一个对象漏检。
  const solutionCrossesBoundary = obj.hasSolution && SOLUTION_BOUNDARY_RE.test(obj.solution)
  const adjacentSolution = obj.hasSolution
    && solutionChars >= MATCH_MIN_SOLUTION_CHARS
    && obj.stem.length <= MATCH_MAX_OBJECT_CHARS
    && !solutionCrossesBoundary
  const requiredRatio = askMatch === 'same' ? MATCH_MIN_LONG_RATIO : MATCH_STRICT_ANCHOR_RATIO

  const factors: MatchFactors = {
    anchorHit: h.hit, anchorTotal: h.total, anchorRatio: h.ratio,
    askQuestion: a.kind, askStem: b.kind, askMatch,
    adjacentSolution, solutionChars,
    solutionLinkScore: link.score, solutionCrossesBoundary,
    requiredRatio, objectCount,
  }

  let rejectReason = ''
  if (h.total < MATCH_MIN_LONG_ANCHORS) rejectReason = '题干提不出 ≥3 个长锚点，没有判定能力'
  else if (obj.stem.length > MATCH_MAX_OBJECT_CHARS) rejectReason = '题目对象超长，切分失败不可信'
  else if (askMatch === 'conflict') rejectReason = `设问冲突：题干问「${a.kind}」、资料问「${b.kind}」`
  else if (h.hit < MATCH_MIN_LONG_ANCHORS || h.ratio < requiredRatio) rejectReason = `对象内锚点共现不足：${h.hit}/${h.total}（要求 ≥${requiredRatio}）`
  else if (solutionCrossesBoundary) rejectReason = '解析段混入下一题的题号，题目边界不可信'
  else if (!adjacentSolution) rejectReason = '该题干后没有紧邻的有效解析段'

  const passed = rejectReason === ''
  const sec = passed ? locateSolution(obj.solution, question) : null
  const solution = sec ? sec.excerpt : (passed ? obj.solution.slice(0, 800) : undefined)
  // 置信度分层：三因子硬闸决定「放不放行」，关系校验只决定「有多可信」。
  // 低置信仍可 exact（否则会误杀大量正例），由调用方在 note 里提示核对。
  const confidence = passed
    ? Math.min(1, Number((0.6 + Math.min(0.25, link.score * 0.05) + (askMatch === 'same' ? 0.15 : 0)).toFixed(2)))
    : 0

  return {
    exact: passed,
    ...(passed && solution ? { solution } : {}),
    anchorsHit: h.hit,
    anchorsTotal: h.total,
    hasSolutionSection: obj.hasSolution,
    passed,
    ...(passed ? {} : { rejectReason }),
    factors,
    confidence,
    ...(passed ? { sourceLocation: obj.source } : {}),
  }
}

/**
 * 统一放行闸门：全文候选对象各自独立判定，只有**通过闸门**的才能进 exact。
 * 多个对象同时通过且分数并列 ⇒ 无法唯一定位 ⇒ 不放行（宁可判不出，也不冒充）。
 */
export function judgeObjects(question: string, text: string, source?: { sourceId?: string; sourceName?: string }): ObjectJudgement {
  const objects = splitQuestionObjects(text, source)
  const longAnchors = extractDistinctive(question).longAnchors
  if (objects.length === 0) {
    return {
      exact: false, anchorsHit: 0, anchorsTotal: longAnchors.length, hasSolutionSection: false,
      passed: false, rejectReason: '正文为空', confidence: 0,
      factors: {
        anchorHit: 0, anchorTotal: longAnchors.length, anchorRatio: 0,
        askQuestion: extractAsk(question).kind, askStem: 'unknown', askMatch: 'unknown',
        adjacentSolution: false, solutionChars: 0,
        solutionLinkScore: 0, solutionCrossesBoundary: false,
        requiredRatio: MATCH_MIN_LONG_RATIO, objectCount: 0,
      },
    }
  }

  const scored = objects.map((o) => judgeQuestionObject(question, o, longAnchors, objects.length))
  // P1 起与结构化链路共用同一个「唯一定位」选择器，避免两套口径漂移
  return selectUnique(scored)
}

/**
 * 统一放行选择器：只有唯一达标的对象能进 exact。
 * 多个对象同时通过且分数并列 ⇒ 无法唯一定位 ⇒ 不放行（宁可判不出，也不冒充）。
 * P0（judgeObjects）与 P1（judgeStoredObjects）必须共用它，M32 有静态断言。
 */
export function selectUnique(scored: ObjectJudgement[]): ObjectJudgement {
  if (scored.length === 0) {
    return {
      exact: false, anchorsHit: 0, anchorsTotal: 0, hasSolutionSection: false,
      passed: false, rejectReason: '没有可判定的题目对象', confidence: 0,
      factors: {
        anchorHit: 0, anchorTotal: 0, anchorRatio: 0,
        askQuestion: 'unknown', askStem: 'unknown', askMatch: 'unknown',
        adjacentSolution: false, solutionChars: 0, solutionLinkScore: 0,
        solutionCrossesBoundary: false, requiredRatio: MATCH_MIN_LONG_RATIO, objectCount: 0,
      },
    }
  }
  const passed = scored.filter((r) => r.passed)
  if (passed.length === 0) {
    // 全部不达标时，返回「最接近」的那个的明细，便于排障与验收集统计
    return scored.slice().sort((x, y) =>
      y.factors.anchorHit - x.factors.anchorHit ||
      y.factors.anchorRatio - x.factors.anchorRatio ||
      y.factors.solutionChars - x.factors.solutionChars)[0]
  }
  passed.sort((x, y) =>
    y.factors.anchorHit - x.factors.anchorHit ||
    y.factors.anchorRatio - x.factors.anchorRatio ||
    y.factors.solutionChars - x.factors.solutionChars)
  if (passed.length > 1) {
    const a = passed[0], b = passed[1]
    if (a.factors.anchorHit === b.factors.anchorHit && a.factors.anchorRatio === b.factors.anchorRatio) {
      return {
        ...a, exact: false, passed: false, solution: undefined,
        rejectReason: '多个题目对象同时达标且无法唯一定位，按「宁可判不出」降级',
        sourceLocation: undefined,
      }
    }
  }
  return passed[0]
}

/**
 * 对一份正文做最终判定（P-006 契约保持不变）。
 *
 * P-009 起内部委托 `judgeObjects()`：整本教辅不再当成一个判定单元，锚点共现
 * 限定在题目对象内。返回结构、阈值字面、单题行为均不变（M27 硬闸）。
 */
export function judge(question: string, text: string): Judgement {
  const r = judgeObjects(question, text)
  const h = countAnchorHits(question, text)
  return {
    exact: r.exact,
    ...(r.exact && r.solution ? { solution: r.solution } : {}),
    anchorsHit: h.hit,
    anchorsTotal: h.total,
    hasSolutionSection: splitQuestionObjects(text).some((o) => o.hasSolution),
  }
}

// ===========================================================================
// P-010 / D-013 · P1：结构化题目对象（入库时预切分）
// ---------------------------------------------------------------------------
// ⚠️ 本文件仍保持零依赖单文件：hash 算法由调用方注入，这里只定义「什么参与指纹」。
//    M27 / M31 的 tsc 单编后 require 契约不破。
//
// 与 P0 的区别不是「判得更准」，而是**判定单元不再由运行时猜**：
//   · P0：judgeObjects() 现场 splitQuestionObjects(text)，对象无稳定身份；
//   · P1：读入库时已经绑定的题干/解析对，先校验版本、正文 hash、内容指纹、
//         结构区间、link_status，再走同一套六条硬闸（selectUnique 共用）。
// 由此得到三项 P0 没有的能力：可复算审计 / 正文变更自动失效 / 误判对象定点排除。
//
// 🔴 诚实边界：纯文本没有版面坐标。若原始文本流本身把别人的解析排在这题后面，
//    结构化切分仍会把它们绑一起。P1 不宣称「已证明解析段归属」（报告 §8.4）。
// ===========================================================================

/** 切分规则版本：改 splitQuestionObjects() / 字段口径必须 bump，否则旧对象不会重建 */
export const OBJECT_ENGINE_VERSION = 'qobj-1'

/** 结构化对象行（列名与 0026 迁移逐字对应） */
export interface StoredQuestionObject {
  source_id: string
  source_name: string | null
  object_index: number
  label: string
  char_start: number
  char_end: number
  stem_start: number
  stem_end: number
  stem_text: string
  solution_text: string | null
  has_solution: boolean
  object_fingerprint: string
  source_revision: string
  link_status: string
  engine_version: string
}

/**
 * 指纹输入：只含「内容 + 位置 + 规则版本」，不含时间、行 ID、文件名。
 * 同一份正文重跑必须得到同一个值，否则幂等 upsert 会把每行都判成新增。
 */
export function objectFingerprintInput(o: {
  source_id: string
  object_index: number
  label: string
  char_start: number
  char_end: number
  stem_start: number
  stem_end: number
  stem_text: string
  solution_text: string | null
  has_solution: boolean
}): string {
  return [
    o.source_id, o.object_index, o.label,
    o.char_start, o.char_end, o.stem_start, o.stem_end,
    o.stem_text || '', o.solution_text || '', o.has_solution ? 1 : 0,
    OBJECT_ENGINE_VERSION,
  ].join('\u0001')
}

/** 正文版本输入：就是正文原文，别加盐，否则构建脚本与运行时算不出同一个值 */
export function sourceRevisionInput(text: string): string {
  return text || ''
}

export interface StructuredJudgement extends ObjectJudgement {
  /** true = 本次真的用了结构化对象；false = 无可用对象，由调用方决定回退还是降级 */
  structured: boolean
  /** 放行对象的稳定指纹，供家长回查与误判定点排除 */
  objectFingerprint?: string
  store: {
    total: number
    usable: number
    rejected: string[]
  }
}

/** 解析段是否混进下一题题号：构建脚本与判定层共用，避免复制正则造成口径漂移 */
export function solutionBoundaryBroken(solution: string): boolean {
  return SOLUTION_BOUNDARY_RE.test(solution || '')
}

/** 入库结构校验：返回空串表示可用，否则返回人类可读的拒绝原因 */
export function validateStoredObject(
  row: StoredQuestionObject,
  opts: { hash: (s: string) => string; expectedRevision: string },
): string {
  if (row.engine_version !== OBJECT_ENGINE_VERSION) return '切分规则版本不一致，需重建'
  if (row.link_status !== 'ok') return '该对象已被标记排除或未通过入库结构校验'
  if (row.source_revision !== opts.expectedRevision) return '来源正文已变化，对象过期'
  if (opts.hash(objectFingerprintInput(row)) !== row.object_fingerprint) return '内容指纹不匹配'
  if (!row.stem_text || !row.stem_text.trim()) return '题干为空'
  if (row.char_start < 0 || row.char_end <= row.char_start) return '对象字符区间不合法'
  if (row.stem_end < row.stem_start || row.stem_end > row.char_end) return '题干区间不合法'
  if (row.has_solution && solutionBoundaryBroken(row.solution_text || '')) {
    return '解析段混入下一题题号，题目边界不可信'
  }
  return ''
}

/** DB 行 → 判定层题目对象；source 位置字段逐字回填，保证 source_location 可追溯 */
export function toQuestionObject(row: StoredQuestionObject): QuestionObject & { fingerprint: string } {
  return {
    stem: row.stem_text,
    solution: row.solution_text || '',
    hasSolution: !!row.has_solution,
    source: {
      ...(row.source_id ? { sourceId: row.source_id } : {}),
      ...(row.source_name ? { sourceName: row.source_name } : {}),
      objectIndex: row.object_index,
      label: row.label,
      charStart: row.char_start,
      charEnd: row.char_end,
      stemStart: row.stem_start,
      stemEnd: row.stem_end,
    },
    fingerprint: row.object_fingerprint,
  }
}

/**
 * 结构化链路的统一放行闸门。
 * 六条硬闸（judgeQuestionObject）与唯一定位（selectUnique）与 P0 完全共用，
 * 额外叠加的是**入库对象的可复算校验**——它只会减少放行，绝不会放宽。
 *
 * @param opts.strict true = 无可用结构化对象时也不回退（上线准启用）；
 *                    false = 返回 structured:false，由调用方回退 P0，保证铺量期功能不倒退
 */
export function judgeStoredObjects(
  question: string,
  rows: StoredQuestionObject[],
  opts: {
    hash: (s: string) => string
    expectedRevision: string
    strict?: boolean
  },
): StructuredJudgement {
  const rejected: string[] = []
  const usable: (QuestionObject & { fingerprint: string })[] = []
  for (const row of rows || []) {
    const why = validateStoredObject(row, opts)
    if (why) rejected.push(`#${row.object_index}: ${why}`)
    else usable.push(toQuestionObject(row))
  }

  const store = { total: (rows || []).length, usable: usable.length, rejected }
  const longAnchors = extractDistinctive(question).longAnchors

  if (usable.length === 0) {
    const reason = store.total === 0
      ? '该来源还没有结构化题目对象'
      : `结构化对象全部不可用（${rejected.length} 条被校验拒绝）`
    const empty = selectUnique([])
    return {
      ...empty,
      anchorsTotal: longAnchors.length,
      factors: { ...empty.factors, anchorTotal: longAnchors.length, askQuestion: extractAsk(question).kind },
      // structured 的语义是「本次由结构化链路负责判定」。
      // strict 时链路负责地给出「不放行」，故为 true（调用方不得再回退 P0）；
      // 非 strict 时为 false，调用方回退 P0，保证铺量期功能不倒退。
      structured: !!opts.strict,
      rejectReason: `${reason}${opts.strict ? '；严格模式不回退全文判定' : ''}`,
      store,
    }
  }

  const scored = usable.map((o) => judgeQuestionObject(question, o, longAnchors, usable.length))
  const picked = selectUnique(scored)
  const winner = picked.passed && picked.sourceLocation
    ? usable.find((o) => o.source.objectIndex === picked.sourceLocation?.objectIndex)
    : undefined
  return {
    ...picked,
    structured: true,
    ...(winner && picked.passed ? { objectFingerprint: winner.fingerprint } : {}),
    store,
  }
}
