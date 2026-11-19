-- ============================================================
-- 0035 暂停语义 + 毕业档数可选（P-034 · §3.1 / §3.2）
-- ------------------------------------------------------------
-- 两件事，都只加列、不改既有数据、不删行：
--
-- ① 暂停（§3.1）：
--    家长点「暂停这题」= 临时移出复习本，**保留** review_count / next_review_at，
--    与「系统判定毕业出本」区分开（毕业是 count 到顶，暂停是 count 未到顶的主动动作）。
--    暂停态用 review_paused=true 标记（in_review_book 仍置 false，不占待办）。
--    恢复时清标记、按保留的 next_review_at 继续，档位不白费。
--
-- ② 毕业档数可选（§3.2，L2 升格——本次实施，待补 OPS-22 评审）：
--    users.review_graduate_stages：2（快节奏）/ 5（标准，默认）。
--    只影响**之后的**毕业判定；已毕业存量题（review_count 已到旧阈值）不回溯重判。
--    ⚠️ 默认 5 与 REVIEW_STAGES 常量、M15 口径、0034 迁移保持一致。
--
-- 幂等：全部 add column if not exists / alter 带默认值，重复执行影响 0 行。
-- ============================================================

-- ① 暂停态：只加两个可空列，不动 in_review_book 的既有值
alter table timeline_items
  add column if not exists review_paused boolean not null default false;

alter table timeline_items
  add column if not exists review_paused_at timestamp with time zone;

-- 暂停题的检索索引（「查看已暂停」入口按 user + paused 取）
create index if not exists timeline_items_user_paused_idx
  on timeline_items (user_id, review_paused)
  where review_paused = true and deleted_at is null;

-- ② 毕业档数：用户级设置，默认 5 = 标准档
alter table users
  add column if not exists review_graduate_stages int not null default 5;

-- 口径约束：只允许 2 或 5。老数据（列不存在时）已被 default 5 覆盖，
-- 加约束不会失败；非法值由应用层 normalizeGraduateStages 拦截，这里只做最后一道防线。
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_review_graduate_stages_check'
  ) then
    alter table users
      add constraint users_review_graduate_stages_check
      check (review_graduate_stages in (2, 5));
  end if;
end $$;

-- 注：派生表（question_objects / question_figures / question_inline_figures）不涉本迁移，
--     且本迁移只加普通列与索引，无需重建派生表。
