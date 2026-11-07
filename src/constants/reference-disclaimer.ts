/**
 * P-015 / D-018：事先声明文案的前端镜像。
 *
 * 🔴 与 `server/src/shared/question-reference.ts` 的 `REFERENCE_DISCLAIMER` **逐字一致**，
 *    M37 静态断言防漂移。按项目惯例前端不跨端 import 后端模块，故保留镜像。
 * 🔴 用途：服务端 `reference_disclaimer` 缺失时（旧包 / 异常降级）仍保证「事先声明」，
 *    绝不出现「先给内容、后给声明」或干脆没有声明。改文案必须两端同步 + bump CACHE_VERSION。
 */
export const REFERENCE_DISCLAIMER = '以下不是本题答案：资料库里没有找到与这道题完全一致的原题，下面是解题思路相近的例题（题目与解题过程均来自资料库原题），仅供借鉴解题思路和解题方法。请先自己想一想，再对照例题的方法，不要直接抄写。'

export const REFERENCE_ITEM_HINT = '这是资料库里的另一道题，不是本题答案，仅供借鉴解题思路'
