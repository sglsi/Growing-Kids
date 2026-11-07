/**
 * P-014 / D-017：检索前输入合格性判定 —— **前端镜像**
 *
 * 依据 `GK-SRS-20a M10` / `M11`。项目惯例：小程序端不跨端 import `server/src/shared/`，
 * 故本文件是 `server/src/shared/input-guard.ts` 的逐字镜像；M36 有静态断言钉住
 * 常量与正则逐字一致，改一处必须同时改两处。
 *
 * 用途：在 `pages/recognize` 的录入卡片里，对整页 / 多小问 / 非题目文本给出
 * 「请单独录入要查的小问」的引导，避免用户拿整页文本去搜答案。
 * 🔴 只提示、不拦截保存；只读、不改用户原文任何一个字符。
 */

/** 超过这个长度视作整页（真实样本：17,035 字英语卷 / 1,028 字选词填空整段） */
export const INPUT_GUARD_MAX_CHARS = 1200
/** 短于这个长度视作题目片段，不足以支撑 ≥3 个长锚点的判定 */
export const INPUT_GUARD_MIN_CHARS = 25
/** 行首数字题号出现 ≥2 次视作多小问连排 */
export const INPUT_GUARD_MAX_ITEM_MARKS = 1

export const INPUT_GUARD_MESSAGE = '这段内容像是整页试卷或多道小题连在一起，请把要查的那道小题单独录入后再搜答案'
export const INPUT_GUARD_NOT_QUESTION_MESSAGE = '这段内容不像一道完整的题目，请补全题干或设问后再搜答案'

/** 覆盖真实 OCR 里出现的题号：`1）` / `（2）` / `( )1.` / `3.` / `16、` */
const ITEM_START = /(?:^|\n)[ \t]*(?:[（(]\s*[）)]\s*)?(?:(?:[（(]\s*)?\d{1,3}\s*[）)]|\d{1,3}\s*[．.、]|\d{1,3}\s*[)）])[ \t]*/g
/** 设问 / 题干信号：中文设问词、问号、选择题选项、填空横线 */
const ASK_HINT = /[?？]|下列|以下|正确的是|错误的是|不正确|是否|能否|求|证明|说明|多少|最小值|最大值|取值范围|周长|面积|填空|选择|选项|计算|化简|解方程/
const OPTION_HINT = /(?:^|[^\w])(?:[A-D]\s*[．.、)）])/g

export interface InputProfile {
  len: number
  itemMarks: number
  hasQuestionSignal: boolean
}

/** 结构画像：不联网、不改字符，可离线重跑 */
export function profileInput(raw: string): InputProfile {
  const q = String(raw || '').replace(/\r\n?/g, '\n')
  ITEM_START.lastIndex = 0
  const itemMarks = (q.match(ITEM_START) || []).length
  OPTION_HINT.lastIndex = 0
  const optionMarks = (q.match(OPTION_HINT) || []).length
  const hasQuestionSignal =
    ASK_HINT.test(q) || optionMarks >= 2 || /_{3,}|（\s*）|\(\s*\)/.test(q)
  return { len: q.length, itemMarks, hasQuestionSignal }
}

export type GuardReason = '' | 'too_long' | 'multi_item' | 'not_a_question'

export interface GuardResult {
  ok: boolean
  reason: GuardReason
  /** 用户可见提示；ok 时为空串 */
  message: string
  profile: InputProfile
}

/**
 * 判定「这段文本能不能作为一道题送进资料库检索」。
 * 判定顺序即拒绝优先级：整页 → 多小问 → 非题目文本；任一命中即不放行。
 */
export function guardQuestionInput(raw: string): GuardResult {
  const profile = profileInput(raw)
  if (profile.len > INPUT_GUARD_MAX_CHARS) {
    return { ok: false, reason: 'too_long', message: INPUT_GUARD_MESSAGE, profile }
  }
  if (profile.itemMarks > INPUT_GUARD_MAX_ITEM_MARKS) {
    return { ok: false, reason: 'multi_item', message: INPUT_GUARD_MESSAGE, profile }
  }
  if (profile.len < INPUT_GUARD_MIN_CHARS || !profile.hasQuestionSignal) {
    return { ok: false, reason: 'not_a_question', message: INPUT_GUARD_NOT_QUESTION_MESSAGE, profile }
  }
  return { ok: true, reason: '', message: '', profile }
}

/**
 * 切题候选护栏（P-014 §⑥）：将来若真做切题，只有同时满足「≥25 字 + 有设问」
 * 的候选才允许送检索。当前生产链路并不自动切题，此函数供 M36 与后续提案复用，
 * 用来挡住「作文要求」那类短碎片被判 `exact`。
 */
export function isEligibleStem(s: string): boolean {
  const t = String(s || '').trim()
  return t.length >= INPUT_GUARD_MIN_CHARS && ASK_HINT.test(t)
}
