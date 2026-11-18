/**
 * 练习卷「做题空间」判定（D-088）。
 *
 * 用户诉求：应用题留出做题空间，填空 / 选择可少留或不留。
 *
 * 真实数据里很多题只有裁剪图、没有题干文字，机器无从判断题型；因此策略是：
 *   1. 有明确题型信号（题号标签或题干）时按信号走：选择 / 填空少留，应用题多留；
 *   2. 无信号（纯图片题）默认按应用题留一定空间——宁可多留一张可写的地方，
 *      也不要让孩子没处下笔。若家长知道题型，可在题号标签里写「选择 3」「填空 7」，
 *      下次合成会自动少留。
 *
 * 纯函数、零依赖：可在验证器里直接契约断言。
 */

export type PracticeKind = 'application' | 'fill' | 'choice'

/** A4 上预留的空白高度（pt）。选择 / 填空 24pt ≈ 一行答案，应用题 96pt ≈ 三行书写。 */
export const PRACTICE_SPACE_PT: Record<PracticeKind, number> = {
  application: 96,
  fill: 24,
  choice: 24,
}

/** 题号标签里带题型词时，优先级最高（比 OCR 题干更可信，因为是家长手输的）。 */
export function detectPracticeKind(label: string, stem: string): PracticeKind {
  const compact = `${label || ''} ${stem || ''}`.replace(/\s+/g, '')

  if (/选择题|单项选择|多项选择|单项选择题|多项选择题/.test(compact)) return 'choice'
  if (/填空题|填空/.test(compact)) return 'fill'
  if (/判断题|判断正误|trueorfalse/i.test(compact)) return 'fill'

  // 两个以上 A./B./C./D. 选项标记 = 选择题（单个字母可能是单位或编号）
  const options = compact.match(/(?:A|B|C|D)[．.、:：]/g) || []
  if (options.length >= 2) return 'choice'

  // 下划线 / 全角下划线填空槽
  if (/_{3,}|＿{3,}/.test(compact)) return 'fill'
  if (/（\s*）|\(\s*\)/.test(compact) && compact.length <= 30) return 'fill'

  if (/应用题|解决问题|解答题|计算题|证明题|简答题|作文题|解决问题/.test(compact)) return 'application'

  // 没有信号：保留书写空间（纯裁剪图最常见）
  return 'application'
}

/** 取该题应插入的空白高度；题型不明时按应用题处理。 */
export function practiceSpacePoints(label: string, stem: string): number {
  return PRACTICE_SPACE_PT[detectPracticeKind(label, stem)]
}
