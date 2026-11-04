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

/**
 * 对一份正文做最终判定。
 * exact 的三个前提缺一不可：① 题干本身能提出 ≥3 个长锚点；② 共现 ≥3 个且命中率 ≥40%；
 * ③ 正文里确实有【答案】/【解析】段。任一不满足 ⇒ 降级，由调用方按 topic/none 呈现。
 */
export function judge(question: string, text: string): Judgement {
  const h = countAnchorHits(question, text)
  const sec = locateSolution(text, question)
  const enoughAnchors = h.total >= MATCH_MIN_LONG_ANCHORS
    && h.hit >= MATCH_MIN_LONG_ANCHORS
    && h.ratio >= MATCH_MIN_LONG_RATIO
  return {
    exact: enoughAnchors && !!sec,
    ...(enoughAnchors && sec ? { solution: sec.excerpt } : {}),
    anchorsHit: h.hit,
    anchorsTotal: h.total,
    hasSolutionSection: !!sec,
  }
}
