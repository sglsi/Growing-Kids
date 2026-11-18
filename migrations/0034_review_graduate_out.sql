-- ============================================================
-- 0034 已毕业题目一次性移出复习本（P-033 · C）
-- ------------------------------------------------------------
-- 背景：
--   0034 之前，五档走完（review_count = 5）只把 next_review_at 置空，
--   in_review_book 仍为 true ⇒ 「已掌握」的题**留在复习本里**但不再到期，
--   界面上看不出它已经掌握，家长只能自己记着哪题该移出。
--
--   P-033（C）已让 review() 在毕业时自动出本（见 timeline.service.ts 的
--   `const graduated = adv.review_count >= REVIEW_STAGES`）。本迁移只处理**存量**：
--   把历史已毕业、却仍挂在复习本里的题按新口径一次性出本。
--
-- 为什么保留 review_count / last_reviewed_at：
--   与 removeFromReviewBook 的既有约定一致——移出不等于抹掉历史。
--   题目若被重新加入复习本，仍是「连续成功 5 次」的状态，不必从头再来。
--
-- 幂等：只命中 in_review_book = true 的行，重复执行影响 0 行。
-- ============================================================

-- 放行前先跑这条看影响面（本条只读，可先执行）：
--   select count(*) from timeline_items
--    where in_review_book and deleted_at is null and review_count >= 5;

update timeline_items
   set in_review_book     = false,
       added_to_review_at = null,
       updated_at         = now()
 where in_review_book = true
   and deleted_at is null
   -- ⚠️ 与 server/src/timeline/review.ts 的 REVIEW_STAGES 保持一致（当前 = 5 档）
   and review_count >= 5;

-- 注：派生表（question_objects / question_figures / question_inline_figures）不涉本迁移，
--     无需重建；本迁移只改 timeline_items 的两个普通列。
