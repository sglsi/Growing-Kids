/**
 * P-028 / D-045：知识点讲解标签「事先声明」的前端镜像。
 *
 * 🔴 与 `server/src/curriculum/curriculum.constants.ts` 的
 *    `CURRICULUM_TAG_DISCLAIMER` **逐字一致**，M44 静态断言防漂移。
 *    按项目惯例前端不跨端 import 后端模块，故保留镜像；服务端响应带
 *    `disclaimer` 时优先用服务端值，缺失（旧包 / 降级）时用本镜像兜底，
 *    绝不出现「先给标签、后给声明」或干脆没有声明。
 * 🔴 常驻且不可关闭：用户开关只控制「是否显示标签内容」，不控制本声明。
 *    改文案必须两端同步；本常量不进检索 result，故不触发 CACHE_VERSION bump。
 */
export const CURRICULUM_TAG_DISCLAIMER =
  '以下是系统根据题干字面给出的「可能涉及」的知识点提示，仅供参考，不是本题答案、不是课标认定，也不作为判定结论。'
