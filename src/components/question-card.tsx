// ============================================================
// ⚠️ 已废弃：本组件在 v4 中被 review-item-card 取代
//
// 原因：v4 统一了「最近题目 / 复习本 / 资料图片」为单一 TimelineItem 模型，
// 旧 QuestionCard 只支持题目（QuestionWithSubject），无法渲染 kind=image 条目。
// 新组件：@/components/review-item-card（支持图/题混排 + 选择态 + 长按）
//
// 应用本包时可直接删除本文件：
//   rm src/components/question-card.tsx
// 下方保留一个转发导出，仅为避免遗漏引用时报「模块不存在」这种难懂的错。
// ============================================================
export { default } from '@/components/review-item-card'
