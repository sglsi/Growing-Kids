/**
 * B2 / P-034 §3.5：导出「辅助强度」三档的唯一映射（纯题 / 提示 / 详解）。
 *
 * 为什么单独放一个零依赖文件：Word 汇总导出（`document.service.ts`）与
 * 复习本合成导出（`pdf.service.ts`）是两条独立管线，任何一边自己写
 * `if (count > 2)` 都会让「同一道题两份卷子提示不一样」。这里只做映射，
 * 不读库、不调 AI、不依赖任何 service。
 *
 * 档位映射（固定，不是自适应，禁止对外叫「精准难度」）：
 *   review_count = 0     → 纯题：无答案、无提示（保住 L2 提取强度）
 *   review_count = 1..2  → 提示：题干 + 一句方法指向提示
 *   review_count >= 3    → 详解：题干 + 错因 / 原因 / 建议（仍不含正确答案与解析）
 *
 * K1 合规：提示文本只来自已存的人工/规则错因建议 `error_analysis.suggestion`。
 * 没有就留白——不生成、不猜测、不拿相邻题的建议顶替。
 * 与「练习卷 / 答疑解惑」两档正交：本函数只在练习卷分支调用；
 * 答疑卷恒为详解（现有行为），避免做成四档。
 */

export type ReviewHintLevel = 'none' | 'hint' | 'detail'

export interface ReviewErrorAnalysisLike {
  label?: string | null
  reason?: string | null
  suggestion?: string | null
}

export interface ReviewHint {
  level: Exclude<ReviewHintLevel, 'none'>
  heading: string
  /** 绝不含正确答案 / 解析 / 答案图 */
  lines: string[]
}

const trim = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * `review_count` 的真相源是 `timeline_items.review_count` 列（0019 迁移后）；
 * `content.review_count` 只作迁移前遗留数据的兼容兜底，由调用方负责选值。
 */
export function reviewHintFor(
  reviewCount: number | null | undefined,
  errorAnalysis: ReviewErrorAnalysisLike | null | undefined,
): ReviewHint | null {
  const count =
    typeof reviewCount === 'number' && Number.isFinite(reviewCount) ? Math.max(0, Math.floor(reviewCount)) : 0

  // 0 档（新录入 / 做错归零）：保持纯题，一点提示都不给。
  if (count === 0) return null

  // 没有已存建议 ⇒ 无提示。宁可留白，也不把错因 label 当方法提示塞给孩子。
  const suggestion = trim(errorAnalysis?.suggestion)
  if (!suggestion) return null

  if (count <= 2) {
    return { level: 'hint', heading: '提示：', lines: [suggestion] }
  }

  const lines: string[] = []
  const label = trim(errorAnalysis?.label)
  const reason = trim(errorAnalysis?.reason)
  if (label) lines.push(`错因：${label}`)
  if (reason) lines.push(`原因：${reason}`)
  lines.push(`建议：${suggestion}`)
  return { level: 'detail', heading: '提示：', lines }
}
