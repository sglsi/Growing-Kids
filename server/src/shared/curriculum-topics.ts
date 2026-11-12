/**
 * 国家课标自建多科目知识点维度表 · 共享契约（P-027 / D-039）
 * ==================================================================
 * 对应表：`curriculum_topics`（migrations/0032_curriculum_topics.sql，唯一真相源）。
 *
 * 🔴 三条不许越的线（改这块之前先读）：
 *   ① **本模块不接入检索链路**。`question-reference.ts` 的 `TOPIC_TERMS` /
 *      `sharedSignals()` 一行未动。把多科目术语直接并进 `sharedSignals()` 会
 *      放大假共现（RQ2 实测命中 ≥3 词 2.3%→5.8%）、破 `P-025 T4` 契约 sha
 *      零改动口径、并可能触发 `CACHE_VERSION` bump ⇒ 须另立独立提案并过 T0。
 *   ② **判定层零改动**。`question-match.ts` 六条 P0 硬闸、`strict=1`、
 *      第二层准入与本表无关；本表只作参考例题层的**数据字典**。
 *   ③ **不宣称**。`domain`/`topic` 是官方课标可核验的框架名，`term` 是本项目
 *      自建的通用检索术语（不是课标条文、不是知识点官方定义、不是答案）。
 *      表中 `framework_verified=false` 的行表示框架名未逐科核对官方文本。
 *
 * 为什么单独一张表而不用 `question_objects` 加字段：
 *   题库 656,898 行来自 OCR 教辅，给全量回填知识点必然要「自动打标」，
 *   而 D-034 已证明未经人工复核的对象级判断会给出错图/错标。维度表解耦后，
 *   「对象 ↔ 知识点」映射是**可独立定义、可独立验收**的算子（另立提案）。
 *
 * 本文件是**纯函数 + 常量**，零依赖、不查库、不发请求；运行时数据由调用方
 * 从 `curriculum_topics` 表 SELECT 后传入。全局只读字典，服务端不暴露写端点。
 */

/** 学段，与 `shared/grade.ts` 的 `GradeStage` 逐字一致（M26 守 12 档年级字典） */
export type CurriculumStage = '小学' | '初中' | '高中'

/** 项目库学科 → 国家课标学科名的对齐口径 */
export interface SubjectStandard {
  /** `subjects.types.ts` 的 `DEFAULT_SUBJECTS.name`，逐字一致 */
  projectName: string
  /** 义务教育阶段对应课标学科名 */
  standardCee: string
  /** 普通高中阶段对应课标学科名 */
  standardHigh: string
  /** 义务教育段是否有教材〔2025〕1号日常修订版（地方转载清单口径，见 D-039） */
  ceeHas2025Revision: boolean
}

/**
 * 仅收录项目库 `DEFAULT_SUBJECTS` 中**有对应国家课标**的 9 门学科。
 *
 * ⚠️ 刻意不收录：
 *   - `生活`（项目库科目，但无对应国家课标，D-039 判为不引入）；
 *   - 科学 / 信息科技 / 体育与健康 / 艺术 / 劳动 / 日语 / 俄语
 *     （教材〔2025〕1号文件中的科目，与本项目库科目无关，思傅明确不引入）。
 *
 * ⚠️ 学科名归一（生物→生物学、政治→道德与法治/思想政治）只用于**课标对齐**，
 *    不改动 `subjects` 表的用户数据、不改前端学科选择器。
 */
export const SUBJECT_STANDARD_MAP: Readonly<Record<string, SubjectStandard>> = Object.freeze({
  chinese:   { projectName: '语文', standardCee: '语文',       standardHigh: '语文',     ceeHas2025Revision: true },
  math:      { projectName: '数学', standardCee: '数学',       standardHigh: '数学',     ceeHas2025Revision: true },
  english:   { projectName: '英语', standardCee: '英语',       standardHigh: '英语',     ceeHas2025Revision: true },
  physics:   { projectName: '物理', standardCee: '物理',       standardHigh: '物理',     ceeHas2025Revision: false },
  chemistry: { projectName: '化学', standardCee: '化学',       standardHigh: '化学',     ceeHas2025Revision: true },
  biology:   { projectName: '生物', standardCee: '生物学',     standardHigh: '生物学',   ceeHas2025Revision: false },
  history:   { projectName: '历史', standardCee: '历史',       standardHigh: '历史',     ceeHas2025Revision: true },
  geography: { projectName: '地理', standardCee: '地理',       standardHigh: '地理',     ceeHas2025Revision: true },
  politics:  { projectName: '政治', standardCee: '道德与法治', standardHigh: '思想政治', ceeHas2025Revision: true },
})

/** `curriculum_topics` 一行的只读视图（列名与 migration 逐字对应） */
export interface CurriculumTopicRow {
  subject_code: string
  subject_name: string
  standard_name: string
  stage: CurriculumStage
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

/** 允许的学科 code；M43 断言它与 migration 的 `distinct subject_code` 逐字一致 */
export function allowedSubjectCodes(): string[] {
  return Object.keys(SUBJECT_STANDARD_MAP)
}

/** 类型守卫：宁可降级为 false，不抛错（与 `normalizeGrade` 同源口径） */
export function isAllowedSubjectCode(code: unknown): code is string {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(SUBJECT_STANDARD_MAP, code)
}

/** 按学段取对应国家课标学科名；非法 code 返回 null，不造「未知」噪声 */
export function standardNameFor(code: unknown, stage: CurriculumStage): string | null {
  if (!isAllowedSubjectCode(code)) return null
  const s = SUBJECT_STANDARD_MAP[code]
  return stage === '高中' ? s.standardHigh : s.standardCee
}

/**
 * 取检索术语（去重、保序）。
 *
 * ⚠️ 返回值**不得**直接塞进 `sharedSignals()`：本函数只供未来独立提案的
 *    「参考例题层」算子做只读分析 / 词表构建，不参与当前任何在线判定。
 */
export function termsForSubject(
  rows: readonly CurriculumTopicRow[],
  code: unknown,
  stage?: CurriculumStage,
): string[] {
  if (!isAllowedSubjectCode(code) || !Array.isArray(rows)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (!r || r.subject_code !== code) continue
    if (stage && r.stage !== stage) continue
    const t = String(r.term || '').trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/** 按学段取全部术语（跨科合并，去重、保序） */
export function termsForStage(rows: readonly CurriculumTopicRow[], stage: CurriculumStage): string[] {
  if (!Array.isArray(rows)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rows) {
    if (!r || r.stage !== stage) continue
    const t = String(r.term || '').trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/** 按官方框架分组（domain → topic 列表），供「讲通知识点」的后续提案消费 */
export function frameworksForSubject(
  rows: readonly CurriculumTopicRow[],
  code: unknown,
  stage?: CurriculumStage,
): { domain: string; topics: string[] }[] {
  if (!isAllowedSubjectCode(code) || !Array.isArray(rows)) return []
  const map = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!r || r.subject_code !== code) continue
    if (stage && r.stage !== stage) continue
    const d = String(r.domain || '').trim()
    if (!d) continue
    if (!map.has(d)) map.set(d, new Set())
    const t = String(r.topic || '').trim()
    if (t) map.get(d)!.add(t)
  }
  return [...map.entries()].map(([domain, topics]) => ({ domain, topics: [...topics] }))
}
