-- ============================================================
-- 0025 年级属性（users / timeline_items / library_docs）
-- ------------------------------------------------------------
-- 提案：`method/proposals/P-005-年级属性与按年级检索.md`（L1）
-- 台账：`D-008`
-- 方法论：C-资源（跨年级混杂 = 与学习无关的外在负荷）；M10/M11 约束（见提案单）
--
-- 为什么是四列而不是一张 grades 表：
--   年级是**用户自报的单值属性**，12 个固定取值，没有元数据、不需要层级查询。
--   单开一张表只会让每次检索多一次 join，且「相邻年级」要自己算 —— 收益为零。
--   连续编号（1..12）本身就是为了让「相邻」= `grade ± 1`，不需要查表。
--
-- 三个业务列的分工（⚠️ 语义不同，不要合并）：
--   · users.grade                  —— 用户**当前**年级，可改（升学/留级/跳级/休学）
--   · users.grade_confirmed_year   —— 用户最后一次确认年级所属的**学年起始年**
--                                     （2026 = 2026-09 ~ 2027-08 学年）。
--                                     用途只有一个：判断「要不要提示升年级」。
--                                     没有它就无法区分「刚设过」与「一年没动过」。
--   · timeline_items.grade / library_docs.grade
--                                  —— 题目/资料的年级**快照**，写入时取用户当时的年级。
--                                     ⚠️ 升学时**不改旧记录**：历史归属必须稳定，
--                                     否则「去年那道五年级题」会随用户升入六年级，
--                                     检索口径年年漂移，且无法回溯。
--
-- 为什么必须允许 NULL（三处都允许）：
--   现网已有存量题目与资料，它们没有年级。若设 not null default 6 之类，
--   等于**批量伪造标签**，会让「按年级检索」从第一天起就不可信。
--   NULL 的语义是「未标注」，检索时按兜底可见处理（见 timeline.service 注释）。
--
-- 特性：全幂等（add column if not exists / create index if not exists）。
-- ⚠️ 迁移用低权 migrator（server/.env.migrate），不要用 owner 跑。
-- ============================================================

-- ------------------------------------------------------------
-- 1) 用户当前年级
-- ------------------------------------------------------------
-- 1..12 连续编号：1-6 小学、7-9 初中、10-12 高中。
-- 「相邻」直接是 grade ± 1，跨学段（6→7、9→10）天然连续，不需要特殊处理。
alter table public.users
  add column if not exists grade smallint check (grade is null or (grade between 1 and 12));

alter table public.users
  add column if not exists grade_confirmed_year smallint
    check (grade_confirmed_year is null or (grade_confirmed_year between 2000 and 2200));

comment on column public.users.grade is
  '用户当前年级 1-12（1-6 小学 / 7-9 初中 / 10-12 高中）。NULL = 未选择，检索不按年级过滤。';

comment on column public.users.grade_confirmed_year is
  '最后一次确认年级所属学年的起始年（2026 = 2026-09~2027-08）。仅用于判断是否提示升年级，不参与检索。';

-- ------------------------------------------------------------
-- 2) 题目年级快照（timeline_items 是题目/图片的统一收件箱）
-- ------------------------------------------------------------
alter table public.timeline_items
  add column if not exists grade smallint check (grade is null or (grade between 1 and 12));

comment on column public.timeline_items.grade is
  '题目年级快照（1-12），创建时取用户当时的年级。NULL = 未标注（存量数据）。升学不改写历史值。';

-- 按年级检索的主查询形状：user_id + grade + 未软删
create index if not exists idx_timeline_items_user_grade
  on public.timeline_items (user_id, grade) where deleted_at is null;

-- ------------------------------------------------------------
-- 3) 资料库年级快照
-- ------------------------------------------------------------
alter table public.library_docs
  add column if not exists grade smallint check (grade is null or (grade between 1 and 12));

comment on column public.library_docs.grade is
  '资料年级快照（1-12），上传时取用户当时的年级。NULL = 未标注。';

create index if not exists idx_library_docs_user_grade
  on public.library_docs (user_id, grade) where deleted_at is null;

-- ------------------------------------------------------------
-- 口径备忘（给后来改这块的人）
-- ------------------------------------------------------------
-- ① 年级**不进**复习间隔表：`REVIEW_INTERVALS = [1,3,7,14,28]` 与年级完全无关
--    （20a M8：排程用分段常数即可；把年级接进去等于做自适应难度，属 X）。
-- ② 年级**不进**结果指标分组：唯一够格指标仍是「到期首次作答正确率（按档位）」
--    （0021 + M15）。多一个分组维度就会稀释口径，让「档位曲线」不再可比。
-- ③ 年级**不由系统推断**：不得根据正确率/题目难度反推孩子年级 ——
--    那是「测量能力水平」，被 20a M10 明确禁止。本列只接受用户自报。
-- ============================================================
