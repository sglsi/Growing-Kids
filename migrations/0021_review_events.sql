-- ============================================================
-- 0021 复习作答事件（review_events）
-- ------------------------------------------------------------
-- 为什么要这张表（GK-OPS-22 §6，本次是流程自检查出的空洞）：
--   OPS-22 §6 规定「**唯一够格判断机制是否奏效**」的结果指标是
--     **到期首次作答正确率（按档位分组）**
--   ——理由是到期那一次作答天然满足 L1（隔了 N 天）+ L2（无提示）。
--   而 0019 迁移只加了四个**状态列**（review_count / last_reviewed_at /
--   next_review_at / review_lapses），它们是**累计值，不是流水**：
--     · 答对 ⇒ review_count +1；答错 ⇒ review_count 归零、review_lapses +1
--   ⇒ 事后只能看到「这题现在在第几档、累计错过几次」，
--     看不到「每一次到期时，第一次作答到底对没对」。
--
--   具体到指标，缺的是这一件事：
--     一个到期周期里孩子可能答错后又重做一次（同一次会话内重试很常见），
--     若把重试也算进去，正确率会被**系统性高估**——
--     这正是 20a M3「当次正确率是误导指标」要防的东西。
--     所以必须能识别出「该到期日的**第一次**作答」。
--
--   ⇒ 结论：不加这张表，OPS-22 §9 P2 的验收判据（结果指标首次出数）
--     永远无法达成；而任何用「复习次数 / 档位分布」凑出来的数字都是代理指标，
--     按 20a §5.5 三条纪律**不得作为成功证据**。
--
-- 设计取舍：
--   ① **只写不读**（本期）：后端在作答时顺带记一行，不新增任何面向用户的接口，
--      也不改动任何学习行为 ⇒ 按 OPS-22 §2 的分档属于 **L0**（不动机制）。
--   ② **不引入埋点 SDK / 不上报任何外部系统**：只落在自己的库里，
--      不外发（本项目的未成年人数据红线，见 OPS-18 合规类条目）。
--   ③ **due_on 单独存 date**：让「该到期日的首次作答」可以用一个窗口函数取出来，
--      不必在时间比对上做时区体操（跨端时区坑见 0019 注释与 review.ts）。
--   ④ **允许 due_on 为空**：未排程 / 已毕业的题被手动复习时没有到期日，
--      这类作答照样记（不丢数据），但在算指标时**排除**（它不构成"到期"作答）。
--
-- 特性：全幂等（create table/index if not exists）。
-- ============================================================

create table if not exists review_events (
  id            varchar(36) primary key default gen_random_uuid(),
  -- ⚠️ RLS 未启用且 service_role 绕过 RLS ⇒ 每个查询都必须 .eq('user_id', userId)
  user_id       varchar(36) not null references users(id) on delete cascade,
  item_id       varchar(36) not null references timeline_items(id) on delete cascade,
  -- 作答结果：与 review.ts 的 ReviewResult 逐字一致（'correct' | 'wrong'）
  result        varchar(8)  not null check (result in ('correct', 'wrong')),
  -- 作答前后的档位（0..5）：档位是「隔了多久」的替身，按档位分组就是按间隔分组
  stage_before  int         not null,
  stage_after   int         not null,
  -- 这次作答**属于哪个到期日**（取作答当时 next_review_at 的日期；null = 非到期作答）
  -- ⚠️ 刻意存 date 而不是 timestamptz：分组键要的是「哪一天」，时区会毁掉分组稳定性
  due_on        date,
  -- 作答当时该题是否已逾期（next_review_at < 今天 00:00）
  is_overdue    boolean     not null default false,
  occurred_at   timestamptz not null default now()
);

-- 算指标的主查询形状：按 (item_id, due_on) 分组取最早一条
create index if not exists idx_review_events_item_due
  on review_events (item_id, due_on, occurred_at);

-- 单用户自己的作答流水（排查 / 后续导出）
create index if not exists idx_review_events_user_time
  on review_events (user_id, occurred_at desc);

-- ------------------------------------------------------------
-- 指标口径（OPS-22 §6 唯一够格的结果指标）
-- ------------------------------------------------------------
-- 到期首次作答正确率（按档位分组）：
--
--   with first_attempt as (
--     select distinct on (item_id, due_on)
--            user_id, item_id, due_on, stage_before, result
--       from review_events
--      where due_on is not null
--        -- ⚠️ 只算「到期当天或之后」的作答：提前复习不满足 L1（隔了 N 天）的前提，
--        --    混进去会让「间隔有效」这个结论失去依据（20a §4.1 的延迟判据）
--        and due_on <= (occurred_at at time zone 'Asia/Shanghai')::date
--      order by item_id, due_on, occurred_at asc   -- 同一次到期里的**第一次**作答
--   )
--   select stage_before as 档位,
--          count(*) as 到期作答数,
--          round(100.0 * count(*) filter (where result = 'correct') / count(*), 1) as 首次正确率百分比
--     from first_attempt
--    group by stage_before
--    order by stage_before;
--
-- 为什么必须是「第一次」而不是「最后一次」或「任意一次」（这一步最容易做错）：
--   同一个到期日里孩子答错后立刻重做，是很常见的行为。
--   若把重试也算进分母，正确率会被**系统性高估**——
--   实测同一个样本：总作答正确率 50%（1 错 1 对），到期首次作答正确率 **0%**。
--   后者才是 20a M3「当次正确率是误导指标」要的那条；前者是它批判的对象。
--
-- ⚠️ 软删不级联（有意的设计）：题目进回收站是软删（deleted_at），
--    review_events **不会**被删 —— 否则「把题删了」就能改写历史指标，
--    而这正是代理指标最容易被人为优化的地方。只有硬删（cascade）才连带清除。
--
-- ⚠️ 出数门槛（别拿噪声当结论）：
--   每档样本 < 30 时只能看趋势、不能下结论；档位 4/5 天然样本最少（能走到那一步的题本就不多）。
--   这一点写进 GK-QA-21 §2.5，避免"有数字就等于有效"的误用。
-- ============================================================
