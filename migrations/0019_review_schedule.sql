-- ============================================================
-- 0019 复习排程（C4 · 分散练习）
-- ------------------------------------------------------------
-- 背景（GK-SRS-20 §5.2 C4）：
--   此前复习本只有 in_review_book + added_to_review_at，
--   「下次什么时候该复习」由前端的 created_at + content.review_count 现算——
--   这带来三个实证问题：
--     ① 基准错了：间隔从**题目创建时间**起算，不是从**进入复习本**起算。
--        一道 60 天前录入、今天才加入复习本的错题，一进本就显示「全部阶段已逾期」；
--     ② 落不了地：没有任何列可以按「到期」查询/排序 ⇒ 只能按加入时间倒序，
--        等于把间隔决策交给时间顺序（SRS-20 原话）；
--     ③ 计不到内容里：review_count 存在 content JSON 里，无法建索引、无法聚合。
--
--   分散练习是全项目效应量最高的机制（d = 0.85，Cepeda 2006/2008、Donoghue & Hattie 2021），
--   而准则 M8 明确：**必须有排程是硬要求，不必有智能排程**（递增 vs 固定间隔 g = 0.034, p = .59）。
--   故本迁移只加「能存下排程」的四列，不做自适应算法。
--
-- 特性：全幂等（add column if not exists / create index if not exists / 回填带条件）。
-- ============================================================

-- ------------------------------------------------------------
-- 1) 排程状态列
-- ------------------------------------------------------------
alter table timeline_items
  -- 连续成功复习次数（= 已走过的间隔档位，0..5；答错归零）
  add column if not exists review_count      int not null default 0,
  -- 最近一次实际复习时间（答对/答错都写）
  add column if not exists last_reviewed_at  timestamp with time zone,
  -- 下次到期时间（null = 未排程或已毕业）
  add column if not exists next_review_at    timestamp with time zone,
  -- 累计答错次数（用于后续 C2/C3 判断「反复错」，本期只记账不参与排程）
  add column if not exists review_lapses     int not null default 0;

-- ------------------------------------------------------------
-- 2) 回填 review_count：把 content.review_count 搬到独立列
--    正则守卫：历史数据可能是字符串/脏值，直接 ::int 会整条迁移失败。
--    ⚠️ content 里那份**保留不删**：多端旧版本仍可能读它，删了会让旧包白屏；
--       新代码一律以列为准（见 timeline.types.ts 的 @deprecated 注释）。
-- ------------------------------------------------------------
update timeline_items
   set review_count = (content->>'review_count')::int
 where content ? 'review_count'
   and (content->>'review_count') ~ '^[0-9]{1,3}$'
   and (content->>'review_count')::int between 0 and 5
   and review_count = 0;

-- ------------------------------------------------------------
-- 3) 回填 next_review_at：给「已在复习本、还没排程」的条目补上到期时间
-- ------------------------------------------------------------
-- 为什么不直接「加入时间 + 1 天」：
--   复习本里现有条目大多已加入很久，按原公式算出来**全部逾期**，
--   孩子一打开就是几十上百题的待办雪崩——这既违反「单次复习量可承受」（SRS-20 A4），
--   也会在第一次接触新功能时就把人劝退。
--
-- 故做一次性**分摊**：按加入时间先后轮流铺到未来 7 天，每人每天约 N/7 题。
-- 这是权宜之计而非排程算法本身；7 天后各自回到正常间隔推进。
-- 依据「宁可错晚、不可错早」（SRS-20 §4.3 第二条纠正）：晚几天复习的损失
-- 远小于早几天，故分摊到未来是安全方向。
with pending as (
  select id,
         row_number() over (
           partition by user_id
           order by coalesce(added_to_review_at, created_at) asc, id asc
         ) as rn
    from timeline_items
   where in_review_book = true
     and deleted_at is null
     and next_review_at is null
     and review_count < 5          -- 已走完 5 档的视为毕业，不再排程
)
update timeline_items t
   set next_review_at = date_trunc('day', now()) + ((p.rn - 1) % 7) * interval '1 day'
  from pending p
 where t.id = p.id;

-- ------------------------------------------------------------
-- 4) 到期查询索引（部分索引：只覆盖复习本里未删除的行）
--    「今日该复习」= user_id 等值 + next_review_at <= 今天末，正是这个索引的形状。
-- ------------------------------------------------------------
create index if not exists timeline_due_idx
  on timeline_items (user_id, next_review_at)
  where in_review_book and deleted_at is null;

-- ------------------------------------------------------------
-- 5) 校验（执行后可手动核对）
-- ------------------------------------------------------------
-- select count(*) filter (where in_review_book)                        as in_book,
--        count(*) filter (where in_review_book and next_review_at is null) as unscheduled,
--        count(*) filter (where in_review_book and next_review_at <= now())  as due,
--        count(*) filter (where review_count >= 5)                     as graduated
--   from timeline_items where deleted_at is null;
