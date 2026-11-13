-- ============================================================
-- T0 硬门判定 · 只读探针（D-044）
-- ------------------------------------------------------------
-- 用途：给「T0 是否通过」的判定提供可复跑的现网读数，不代替判定本身。
-- 只读边界：纯 SELECT + information_schema + to_regclass，
--           **零写入、零 DDL、零 DML、零产图、零下发**。
-- 用法（L3，User=gk）：
--   scp server/scripts/measure-t0-gate.sql ubuntu@42.192.36.120:/tmp/
--   ssh ubuntu@42.192.36.120 'sudo -n chmod 644 /tmp/measure-t0-gate.sql && \
--     sudo -n -u gk -H bash /tmp/run-t0.sh /tmp/measure-t0-gate.sql /tmp/t0-gate.out && \
--     sudo -n cat /tmp/t0-gate.out'
--
-- 🔴 纪律：
--   · 本探针只回答「有没有已落地的获批实施 / 结果指标有没有出数」，
--     不测量任何效果，不计算召回率/准确率，不作成功证据。
--   · 结果指标 definition 唯一：`0021 review_events` 到期首次作答正确率，
--     每档 >=30 样本；本探针只报行数，不等于「指标已出数」。
--   · `curriculum_topics` 若存在，说明 0032 已上生产（D-039 只在开发库执行，
--     预期 false）；`schema_migrations.filename` 由 migrate.mjs:258 实证。
--   · 不直接引用可能不存在的表做 count：用 to_regclass 只报存在性。
-- ============================================================

SET statement_timeout = '120s';

SELECT json_build_object(
  'probe',                        't0-gate-v1',
  'measured_at',                  now(),
  -- ① 结果指标（唯一够格）：0 行即从未出数
  'result_metric_rows',           (SELECT count(*) FROM review_events),
  'result_metric_distinct_users', (SELECT count(DISTINCT user_id) FROM review_events),
  -- ② 是否有「已落地的获批实施」：预期全部为否 / 零
  'curriculum_topics_present',    (to_regclass('public.curriculum_topics') IS NOT NULL),
  'migration_0032_registered',    (SELECT count(*) FROM schema_migrations WHERE filename LIKE '%0032%'),
  'question_figures_present',     (to_regclass('public.question_figures') IS NOT NULL),
  'inline_figures_rows',          (SELECT count(*) FROM question_inline_figures),
  'inline_figures_engines',       (
    SELECT coalesce(jsonb_agg(DISTINCT engine_version ORDER BY engine_version), '[]'::jsonb)
      FROM question_inline_figures
  ),
  -- ③ 分母链条（与 measure-feedback-readiness.sql 交叉）
  'timeline_items_rows',          (SELECT count(*) FROM timeline_items),
  'users_total',                  (SELECT count(*) FROM users),
  'answer_cache_rows',            (SELECT count(*) FROM answer_cache),
  'query_log_like_tables',        (
    SELECT coalesce(jsonb_agg(table_name ORDER BY table_name), '[]'::jsonb)
      FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name ~* 'query|log|event|stat'
  )
)::text;
