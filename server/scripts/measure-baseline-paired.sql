-- ============================================================
-- T0-2 · 前后对照「配对差分」补充算子（D-040，P-025 协议 P1/P3/P7）
-- ------------------------------------------------------------
-- 🔴 本文件**不修改也不替代** server/scripts/measure-baseline.sql。
--    measure-baseline.sql 是「前后同口径」的真相源，一个字都不能改；
--    本算子只补它缺的一块：按**同一分层**输出可配对的分母与计数，
--    供实施前后做「同组相减 / 配对差分」，而不是拿两次中位数之差当结论
--    （D-030 双峰陷阱、P-025 协议 P3）。
--
-- 用法（与基线同环境、同时间段口径，前后两次必须都是同一份文件）：
--   scp server/scripts/measure-baseline-paired.sql ubuntu@42.192.36.120:/tmp/gk-t0-paired.sql
--   ssh ubuntu@42.192.36.120 'set -a; . /opt/gk/server/.env.migrate; set +a; \
--     psql "$DATABASE_URL" -t -A -q -f /tmp/gk-t0-paired.sql' > paired-$(date +%s).jsonl
--
-- 🔴 纪律：
--   · 纯 SELECT + information_schema，零写入、零物化、零临时表。
--   · 归一口径镜像 shared/question-match.ts::normalizeForMatch()
--     ＝ 只保留 汉字 / A-Za-z / 0-9；ANCHOR_LEN=6 / ANCHOR_STEP=3。
--   · 分层与 measure-blind-sample.sql 的 S1–S4 **逐字一致**，
--     否则配对无意义；改任一份必须同步另一份并另建 D 号。
--   · 输出的 value 全是**代理/诊断指标**，按 20a §5.5 不得作为成功证据。
--   · operator_version 是固定常量，前后不一致即判定口径漂移，作废重跑。
-- ============================================================

SET work_mem = '128MB';
SET statement_timeout = '300s';

WITH base AS (
  SELECT q.link_status,
         q.has_solution,
         q.stem_text,
         length(regexp_replace(q.stem_text, '[^A-Za-z0-9一-龥]', '', 'g')) AS norm_len
    FROM question_objects q
),
stratified AS (
  SELECT *,
         CASE
           WHEN norm_len >= 30 AND has_solution     THEN 'S1_long_with_solution'
           WHEN norm_len >= 30 AND NOT has_solution THEN 'S2_long_no_solution'
           WHEN norm_len BETWEEN 10 AND 29 AND has_solution     THEN 'S3_mid_with_solution'
           WHEN norm_len BETWEEN 10 AND 29 AND NOT has_solution THEN 'S4_mid_no_solution'
           ELSE 'X_short_lt10'
         END AS stratum
    FROM base
),
agg AS (
  SELECT stratum,
         count(*)                                                        AS rows_total,
         count(*) FILTER (WHERE norm_len < 6)                              AS norm_lt6,
         count(*) FILTER (WHERE norm_len < 10)                             AS norm_lt10,
         count(*) FILTER (WHERE stem_text !~ '[一-龥]')                     AS no_han,
         count(*) FILTER (WHERE position(chr(65533) IN stem_text) > 0)     AS has_fffd,
         count(*) FILTER (WHERE has_solution)                              AS has_solution,
         count(*) FILTER (WHERE link_status = 'rejected')                  AS rejected,
         round(avg(norm_len)::numeric, 2)                                  AS mean_norm_len
    FROM stratified
   GROUP BY stratum
),
unpivoted AS (
  SELECT stratum, 'rows_total'     AS metric, rows_total::numeric     AS value FROM agg
  UNION ALL SELECT stratum, 'norm_lt6',       norm_lt6::numeric               FROM agg
  UNION ALL SELECT stratum, 'norm_lt10',      norm_lt10::numeric              FROM agg
  UNION ALL SELECT stratum, 'no_han',         no_han::numeric                 FROM agg
  UNION ALL SELECT stratum, 'has_fffd',       has_fffd::numeric               FROM agg
  UNION ALL SELECT stratum, 'has_solution',   has_solution::numeric           FROM agg
  UNION ALL SELECT stratum, 'rejected',       rejected::numeric               FROM agg
  UNION ALL SELECT stratum, 'mean_norm_len',  mean_norm_len                   FROM agg
)
SELECT json_build_object(
  'section',           'paired',
  'operator_version',  't0-paired-v1',
  'stratum',           stratum,
  'metric',            metric,
  'value',             value
)::text
  FROM unpivoted
 ORDER BY stratum, metric;

-- ② 反馈闭环分母（与 measure-baseline.sql ③ 同口径，便于一次跑完）
SELECT json_build_object(
  'section',                    'feedback_denominator',
  'operator_version',           't0-paired-v1',
  'feedback_review_events',     (SELECT count(*) FROM review_events),
  'feedback_timeline_items',    (SELECT count(*) FROM timeline_items),
  'feedback_questions',         (SELECT count(*) FROM questions),
  'feedback_answer_cache',      (SELECT count(*) FROM answer_cache),
  'feedback_query_log_tables',  (
    SELECT coalesce(jsonb_agg(table_name ORDER BY table_name), '[]'::jsonb)
      FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name ~* 'query|log|event|stat'
  )
)::text;
