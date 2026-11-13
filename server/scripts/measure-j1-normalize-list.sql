-- ============================================================
-- P-025 J1 · 只读归一候选清单（D-042 实施，2026-11-13）
-- ------------------------------------------------------------
-- 用途：给「题目归一 / 去重」提供只读候选分组清单，作为将来 J1 实施的
--       输入材料。**不写库、不建表、不归一回写、不删重**。
--
-- 用法：
--   psql "$DATABASE_URL" -t -A -q -f server/scripts/measure-j1-normalize-list.sql
--   输出 1 行 JSON，由报告脚本解析。
--
-- 🔴 纪律：
--   · 纯 SELECT；归一口径与 measure-baseline.sql **逐字一致**
--     ＝ regexp_replace(stem_text, '[^A-Za-z0-9一-龥]', '', 'g')；
--     该文件是前后同口径真相源，本算子不得改动它、也不得另立口径。
--   · 只输出 md5(n) 作为组标识 + 聚合计数，**不输出归一后题干原文、
--     不输出 source_id / user_id、不输出完整 stem_text**。
--   · 这些是**诊断 / 代理指标**，按 20a §5.5 不得作成功证据；
--     不计算召回率 / 准确率，不宣称去重复收益，不外推到全库结论。
--   · 本清单只描述「有哪些重复组」，**不构成去重授权**；
--     J1 归一写库仍锁，须另立提案 + 过前后对照协议 v1.0。
-- ============================================================

SET work_mem = '128MB';
SET statement_timeout = '300s';

WITH g AS (
  SELECT md5(n) AS group_hash, length(n) AS norm_len, count(*) AS c,
         count(*) FILTER (WHERE q.has_solution) AS with_solution,
         count(*) FILTER (WHERE q.link_status = 'rejected') AS rejected
    FROM question_objects q,
    LATERAL (SELECT regexp_replace(q.stem_text, '[^A-Za-z0-9一-龥]', '', 'g') AS n) x
   WHERE n <> ''
   GROUP BY 1, 2
)
SELECT json_build_object(
  'section', 'j1_normalize_list',
  'measured_at', now(),
  'normalizer', 'keep only [A-Za-z0-9 and CJK]; identical to measure-baseline.sql',
  'total_rows', (SELECT count(*) FROM question_objects),
  'groups_all', count(*),
  'groups_duplicate', count(*) FILTER (WHERE c > 1),
  'duplicate_rows', coalesce(sum(c - 1) FILTER (WHERE c > 1), 0),
  'by_size', (
    SELECT jsonb_object_agg(bucket, cnt) FROM (
      SELECT CASE WHEN c = 2 THEN 'size_2'
                  WHEN c BETWEEN 3 AND 5 THEN 'size_3_5'
                  WHEN c BETWEEN 6 AND 10 THEN 'size_6_10'
                  ELSE 'size_11_plus' END AS bucket, count(*) AS cnt
        FROM g WHERE c > 1 GROUP BY 1
    ) s
  ),
  'by_norm_len', (
    SELECT jsonb_object_agg(bucket, cnt) FROM (
      SELECT CASE WHEN norm_len < 6 THEN 'norm_lt6'
                  WHEN norm_len < 30 THEN 'norm_6_29'
                  ELSE 'norm_ge30' END AS bucket, count(*) AS cnt
        FROM g WHERE c > 1 GROUP BY 1
    ) s
  ),
  'ge30_duplicate_groups', count(*) FILTER (WHERE c > 1 AND norm_len >= 30),
  'ge30_duplicate_rows', coalesce(sum(c - 1) FILTER (WHERE c > 1 AND norm_len >= 30), 0),
  'groups_with_solution', count(*) FILTER (WHERE c > 1 AND with_solution > 0),
  'groups_with_rejected', count(*) FILTER (WHERE c > 1 AND rejected > 0),
  'top20_groups', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'group_hash', group_hash, 'rows', c, 'norm_len', norm_len,
             'with_solution', with_solution)), '[]'::jsonb)
      FROM (SELECT group_hash, c, norm_len, with_solution FROM g
             WHERE c > 1 ORDER BY c DESC, group_hash LIMIT 20) t
  )
)::text
FROM g;
