-- ============================================================
-- 前后对照协议 v1.0 · 只读基线测量算子（P-025 / D-036）
-- ------------------------------------------------------------
-- 用途：在「任何借鉴项实施前」与「实施后」用**同一份文件**测同一组指标，
--       保证前后同口径、可复算、可审计。
--
-- 用法：
--   psql "$DATABASE_URL" -t -A -q -f server/scripts/measure-baseline.sql
--   输出 3 行 JSON（质量 / 去重 / 计数），由报告脚本按行解析。
--
-- 🔴 纪律：
--   · 纯 SELECT + information_schema 查询，**零写入**；
--   · 归一口径镜像 shared/question-match.ts::normalizeForMatch()
--     ＝ 只保留 汉字 / A-Za-z / 0-9（正则 [^A-Za-z0-9一-龥] 全剔）；
--   · ANCHOR_LEN=6 / ANCHOR_STEP=3 ⇒ length(n)<6 的行连一个 6 字锚点都切不出；
--   · 这些**都是代理/诊断指标**，不是结果指标。唯一够格的结果指标是
--     0021 review_events 的「到期首次作答正确率（每档 ≥30 样本）」。
--     按 20a §5.5 三条纪律，代理指标**不得作为成功证据**。
--   · 前后两次必须：同一份 SQL、同一环境、同一时间段口径、同一份数据门 SQL 复跑。
--     禁止事后改阈值/改口径再宣称「变好了」（D-034 教训）。
-- ============================================================

SET work_mem = '128MB';
SET statement_timeout = '300s';

-- ① 题干质量（单次顺序扫描，LATERAL 保证每行只算一次归一）
SELECT json_build_object(
  'section', 'quality',
  'qo_total', count(*),
  'quality_norm_empty', count(*) FILTER (WHERE x.n = ''),
  'quality_norm_lt6', count(*) FILTER (WHERE length(x.n) < 6),
  'quality_norm_lt10', count(*) FILTER (WHERE length(x.n) < 10),
  'quality_no_han', count(*) FILTER (WHERE x.n !~ '[一-龥]'),
  'quality_has_fffd', count(*) FILTER (WHERE position(chr(65533) IN q.stem_text) > 0),
  'quality_has_solution', count(*) FILTER (WHERE q.has_solution),
  'quality_link_rejected', count(*) FILTER (WHERE q.link_status = 'rejected')
)::text
FROM question_objects q,
LATERAL (SELECT regexp_replace(q.stem_text, '[^A-Za-z0-9一-龥]', '', 'g') AS n) x;

-- ② 归一后重复度（单次扫描 + 哈希聚合；不物化 stem_text，控制 L3 内存）
SELECT json_build_object(
  'section', 'dedup',
  'dedup_norm_distinct', count(*),
  'dedup_duplicate_rows', coalesce(sum(c - 1), 0),
  'dedup_duplicate_groups', count(*) FILTER (WHERE c > 1),
  'dedup_max_group', coalesce(max(c), 0)
)::text
FROM (
  SELECT regexp_replace(stem_text, '[^A-Za-z0-9一-龥]', '', 'g') AS n, count(*) AS c
    FROM question_objects
   GROUP BY 1
) t
WHERE n <> '';

-- ③ 反馈闭环分母 / 呈现与图形基线 / 数据门
SELECT json_build_object(
  'section', 'counts',
  'measured_at', now(),
  'feedback_review_events', (SELECT count(*) FROM review_events),
  'feedback_timeline_items', (SELECT count(*) FROM timeline_items),
  'feedback_questions', (SELECT count(*) FROM questions),
  'feedback_answer_cache', (SELECT count(*) FROM answer_cache),
  'feedback_query_log_tables', (
    SELECT coalesce(jsonb_agg(table_name ORDER BY table_name), '[]'::jsonb)
      FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name ~* 'query|log|event|stat'
  ),
  'qo_by_source', (
    SELECT jsonb_object_agg(source_type, c)
      FROM (SELECT source_type, count(*) c FROM question_objects GROUP BY source_type) s
  ),
  'qo_by_engine', (
    SELECT jsonb_object_agg(engine_version, c)
      FROM (SELECT engine_version, count(*) c FROM question_objects GROUP BY engine_version) s
  ),
  'figures_whole_question', (SELECT count(*) FROM question_figures),
  'figures_whole_sources', (SELECT count(DISTINCT source_id) FROM question_figures),
  'figures_inline_total', (SELECT count(*) FROM question_inline_figures),
  'health_netdisk_files', (SELECT count(*) FROM netdisk_files),
  'health_doc_convert_done', (SELECT count(*) FROM doc_convert_done),
  'health_users', (SELECT count(*) FROM users)
)::text;
