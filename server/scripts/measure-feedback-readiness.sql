-- ============================================================
-- T0-3 · review_events「0 行」出数条件只读定性算子（D-040 / D-036 / P-025 Q3①）
-- ------------------------------------------------------------
-- 背景（D-036 实证，勿重复排查）：
--   埋点代码在 server/src/timeline/timeline.service.ts:1018 已实现；
--   生产 /opt/gk/server/dist/timeline/timeline.service.js 含同一特征串（构建 2026-11-04）；
--   近 7 天 journalctl 无「复习事件写入失败」⇒ 已排除「缺代码」与「写入报错」。
--   ⇒ 0 行是**出数条件**问题，本算子只做只读定性，排除/保留三个假设，不下结论。
--
-- 用法（L3，纯 SELECT，零写入）：
--   scp server/scripts/measure-feedback-readiness.sql ubuntu@42.192.36.120:/tmp/gk-t0-feedback.sql
--   ssh ubuntu@42.192.36.120 'set -a; . /opt/gk/server/.env.migrate; set +a; \
--     psql "$DATABASE_URL" -t -A -q -f /tmp/gk-t0-feedback.sql'
--   # 旁证（日志侧，非 SQL）：
--   ssh ubuntu@42.192.36.120 'journalctl -u gk-api --since "7 days ago" --no-pager \
--     | grep -c "复习事件写入失败"'
--
-- 🔴 纪律：
--   · 纯 SELECT + information_schema + pg_stat_user_tables，**零写入、零 DDL、零 DML**。
--   · **不新增任何 query 采集、不改埋点、不改前端、不做真登录**（测试期禁真登录）。
--   · 不承诺出数；出数受真实使用与发布状态约束，不是纯工程可交付项。
--   · 本节全部是**代理/诊断读数**，不得作为机制有效的证据；
--     唯一够格结果指标＝0021 到期首次作答正确率（每档 ≥30 样本），当前 0 行。
--   · timeline_items 的 review_count / last_reviewed_at / next_review_at /
--     review_lapses / in_review_book 已于 2026-11-13 只读实证存在（information_schema
--     回查列名清单），故 H_a 直接构造到期与作答痕迹统计；同时仍输出列名清单可复核。
--   · pg_stat 读数只是**旁证**：可 reset / 轮转 / 被 autovacuum 改写，
--     n_tup_ins=2 且 n_tup_del=2 只说明「见过写入与删除」，不得据此断言人为清空。
-- ============================================================

SET statement_timeout = '120s';

-- H_a · 假设「没有真实到期作答」：看分母链条是否存在
SELECT json_build_object(
  'section',                    'H_a_no_real_due_attempt',
  'operator_version',           't0-feedback-v1',
  'review_events_rows',         (SELECT count(*) FROM review_events),
  'review_events_last_event',   (SELECT max(occurred_at) FROM review_events),
  'timeline_items_rows',        (SELECT count(*) FROM timeline_items),
  'questions_rows',             (SELECT count(*) FROM questions),
  'answer_cache_rows',          (SELECT count(*) FROM answer_cache),
  'users_total',                (SELECT count(*) FROM users),
  'ti_with_due',                (SELECT count(*) FROM timeline_items WHERE next_review_at IS NOT NULL),
  'ti_overdue_now',             (SELECT count(*) FROM timeline_items WHERE next_review_at < now()),
  'ti_ever_reviewed',           (SELECT count(*) FROM timeline_items WHERE review_count > 0),
  'ti_last_reviewed_at',        (SELECT max(last_reviewed_at) FROM timeline_items),
  'ti_in_review_book',          (SELECT count(*) FROM timeline_items WHERE in_review_book),
  'timeline_items_columns',     (
    SELECT coalesce(jsonb_agg(column_name ORDER BY ordinal_position), '[]'::jsonb)
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'timeline_items'
  ),
  'questions_columns',          (
    SELECT coalesce(jsonb_agg(column_name ORDER BY ordinal_position), '[]'::jsonb)
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'questions'
  )
)::text;

-- H_b · 假设「路径未触达」：是否存在真实 query 日志表 / 作答入口痕迹
SELECT json_build_object(
  'section',                    'H_b_path_not_reached',
  'operator_version',           't0-feedback-v1',
  'query_like_tables',          (
    SELECT coalesce(jsonb_agg(table_name ORDER BY table_name), '[]'::jsonb)
      FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name ~* 'query|log|event|stat'
  ),
  'review_events_distinct_users', (SELECT count(DISTINCT user_id) FROM review_events),
  'timeline_items_distinct_users', (SELECT count(DISTINCT user_id) FROM timeline_items),
  'questions_distinct_users',      (SELECT count(DISTINCT user_id) FROM questions)
)::text;

-- H_c · 假设「数据被清空」：只能作旁证，pg_stat 会被 reset / 轮转，不能作定论
SELECT json_build_object(
  'section',                    'H_c_data_cleared',
  'operator_version',           't0-feedback-v1',
  'stat_n_tup_ins',             (SELECT coalesce(sum(n_tup_ins), 0) FROM pg_stat_user_tables WHERE relname = 'review_events'),
  'stat_n_tup_del',             (SELECT coalesce(sum(n_tup_del), 0) FROM pg_stat_user_tables WHERE relname = 'review_events'),
  'stat_n_live_tup',            (SELECT coalesce(sum(n_live_tup), 0) FROM pg_stat_user_tables WHERE relname = 'review_events'),
  'caveat',                     'pg_stat 可 reset/轮转，仅旁证；不得据此断言数据曾被清空'
)::text;
