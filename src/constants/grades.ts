/**
 * 年级字典（前端镜像）
 * ==================================================================
 * ⚠️ **唯一真相源在后端**：`server/src/shared/grade.ts` 的 `GRADES`。
 * 这里是一份镜像，`label` 必须与后端**逐字一致** ——
 * `server/scripts/verify/modules/26-grade.mjs` 有一条断言直接比对两处字符串，
 * 因为「后端叫初三、前端叫九年级」会让家长在两个页面看到不同说法。
 *
 * 为什么不在前端 import 后端文件：前后端 tsconfig 与打包边界不同，
 * 跨目录 import 会把 server 源码拖进小程序包（体积与编译都受影响）。
 * 所以选择「两份常量 + 一条断言」，而不是「一份跨端 import」。
 *
 * 数值口径（与 0025 迁移 / P-005 提案单一致）：
 *   1–6 小学，7–9 初中，10–12 高中；连续编号使「相邻年级 = ±1」。
 */

export const GRADE_MIN = 1
export const GRADE_MAX = 12

export type GradeStage = '小学' | '初中' | '高中'

export interface GradeOption {
  value: number
  label: string
  stage: GradeStage
}

export const GRADES: GradeOption[] = [
  { value: 1, label: '一年级', stage: '小学' },
  { value: 2, label: '二年级', stage: '小学' },
  { value: 3, label: '三年级', stage: '小学' },
  { value: 4, label: '四年级', stage: '小学' },
  { value: 5, label: '五年级', stage: '小学' },
  { value: 6, label: '六年级', stage: '小学' },
  { value: 7, label: '初一', stage: '初中' },
  { value: 8, label: '初二', stage: '初中' },
  { value: 9, label: '初三', stage: '初中' },
  { value: 10, label: '高一', stage: '高中' },
  { value: 11, label: '高二', stage: '高中' },
  { value: 12, label: '高三', stage: '高中' },
]

/**
 * Picker 的选项文本：第 0 项是「暂不选择」（= null）。
 * ⚠️ 索引与 `GRADES` 差 1 —— 取值时用 `toGrade(index)`，不要直接拿索引当年级。
 */
export const GRADE_PICKER_LABELS: string[] = ['暂不选择', ...GRADES.map((g) => g.label)]

/** Picker 选中索引 → 年级值（0 ⇒ null） */
export function toGrade(index: number): number | null {
  const v = GRADES[index - 1]?.value
  return typeof v === 'number' ? v : null
}

/** 年级值 → Picker 选中索引（null / 非法 ⇒ 0） */
export function toGradeIndex(grade?: number | null): number {
  if (typeof grade !== 'number') return 0
  const i = GRADES.findIndex((g) => g.value === grade)
  return i >= 0 ? i + 1 : 0
}

/** 年级展示名；未设置 / 非法值返回空串（调用方自行决定是否显示占位文案） */
export function gradeLabel(grade?: number | null): string {
  if (typeof grade !== 'number') return ''
  return GRADES.find((g) => g.value === grade)?.label ?? ''
}
