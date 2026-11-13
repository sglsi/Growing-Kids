/**
 * P-028 / D-045 · Q2①：知识点讲解标签的**仅字面匹配**算子。
 *
 * 🔴 这是纯展示层函数，零依赖、不查库、不发请求、不参与检索链路：
 *    · 不并入 `TOPIC_TERMS`、不进 `sharedSignals()` / `MIN_SHARED_SIGNALS` 共现；
 *    · 不进 `note` 判定路径、不进缓存键、不改变候选集合与顺序；
 *    · 不做语义匹配、不做向量召回、不做「对象↔知识点」自动打标。
 * 🔴 结果一律读作「可能涉及」，不得表述为「本题知识点 / 课标认定 / 已核实」。
 *    `framework_verified` 只随字典透传，不参与匹配强弱判断。
 * 🔴 不宣称：不计算召回率/准确率，不据此宣称适配度或命中提升。
 */

/** `GET /api/curriculum/topics` 返回行（列裁剪，与 0032 migration 逐字对应） */
export interface CurriculumTopicRow {
  subject_code: string
  subject_name: string
  standard_name: string
  stage: '小学' | '初中' | '高中'
  grade_min: number
  grade_max: number
  domain: string
  topic: string
  term: string
  standard_version: string
  standard_doc: string
  source_url: string
  framework_verified: boolean
  term_origin: 'project'
  version_note: string
}

export interface CurriculumTopicsPayload {
  available: boolean
  topics: CurriculumTopicRow[]
  disclaimer: string
  reason?: 'table_unavailable' | 'unexpected_row_count' | 'invalid_rows'
}

/** 一条「可能涉及」的标签，供卡片展示 */
export interface CurriculumTag {
  term: string
  domain: string
  topic: string
  subjectName: string
  stage: string
  frameworkVerified: boolean
}

/** 展示上限：与参考例题 Top 1~3 的呈现习惯一致，不参与任何排序 */
export const MAX_CURRICULUM_TAGS = 3
/** 过短的术语会大面积误命中（如「的」「数」），字面匹配阶段直接排除 */
const MIN_TERM_LEN = 2

/**
 * 题干字面匹配：只保留题干里**确实出现**的字典 `term`。
 *
 * 排序只影响「展示哪几个词」：更长的术语更具体，优先；同长按字典原有顺序（稳定）。
 * 🔴 这个排序**不是检索排序**，不改变参考例题候选集合与顺序（P-028 D2 判据）。
 */
export function matchCurriculumTags(
  stem: string,
  rows: readonly CurriculumTopicRow[] | null | undefined,
  limit = MAX_CURRICULUM_TAGS,
): CurriculumTag[] {
  const text = String(stem || '')
  if (!text || !Array.isArray(rows) || rows.length === 0 || limit <= 0) return []

  const candidates: { row: CurriculumTopicRow; term: string; pos: number }[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (!r) continue
    const term = String(r.term || '').trim()
    if (term.length < MIN_TERM_LEN || seen.has(term)) continue
    const pos = text.indexOf(term)
    if (pos < 0) continue
    seen.add(term)
    candidates.push({ row: r, term, pos })
  }

  // 长词优先（更具体），同长按题干出现位置，最后按字典顺序稳定收敛
  candidates.sort((a, b) =>
    b.term.length - a.term.length || a.pos - b.pos || a.term.localeCompare(b.term, 'zh-CN'),
  )

  return candidates.slice(0, limit).map(({ row, term }) => ({
    term,
    domain: String(row.domain || ''),
    topic: String(row.topic || ''),
    subjectName: String(row.subject_name || ''),
    stage: String(row.stage || ''),
    frameworkVerified: row.framework_verified === true,
  }))
}
