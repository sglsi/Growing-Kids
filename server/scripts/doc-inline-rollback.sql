-- P-022 / D-032：Q5 30 份小批量试点的「一键下线」预案
--
-- 🔴 默认只读：不带参数执行时只打印核对结果，绝不删除。
--    真正下线：psql -v GK_ROLLBACK_APPLY=1 -v GK_PILOT_IDS="'id1','id2'" -f doc-inline-rollback.sql
-- 🔴 作用域只限 .doc 来源的试点行；docx 的 273,037 行 / 5,153 份一律不碰。
-- 🔴 只删派生表（question_inline_figures / question_inline_done），
--    绝不改 netdisk_files / question_objects / question_figures / text_content。
-- 🔴 无 RLS：所有语句都带 user_id 约束，且以 netdisk_files.ext='doc' 二次限定。
-- 🔴 图本体（figures/<2>/<sha>.webp）是内容寻址 + ref_count，不下发即不可达，
--    物理清理属另案，不在本预案内。

\pset pager off
\set ON_ERROR_STOP on

\echo '=== ROLLBACK PRECHECK (read-only) ==='
SELECT 'pilot_docs' AS k, count(DISTINCT n.id)::text AS v
  FROM netdisk_files n
 WHERE n.ext = 'doc' AND n.id::text = ANY(ARRAY[:GK_PILOT_IDS]::text[])
UNION ALL
SELECT 'inline_fig_rows', count(*)::text
  FROM question_inline_figures q
  JOIN netdisk_files n ON n.id = q.source_id AND n.user_id = q.user_id
 WHERE n.ext = 'doc' AND n.id::text = ANY(ARRAY[:GK_PILOT_IDS]::text[])
UNION ALL
SELECT 'inline_done_rows', count(*)::text
  FROM question_inline_done d
  JOIN netdisk_files n ON n.id = d.source_id AND n.user_id = d.user_id
 WHERE n.ext = 'doc' AND n.id::text = ANY(ARRAY[:GK_PILOT_IDS]::text[])
UNION ALL
SELECT 'docx_rows_untouched', count(*)::text
  FROM question_inline_figures q
  JOIN netdisk_files n ON n.id = q.source_id AND n.user_id = q.user_id
 WHERE n.ext = 'docx';

\echo '=== ROLLBACK SCOPE DETAIL ==='
SELECT n.id, n.name, count(*) AS rows
  FROM question_inline_figures q
  JOIN netdisk_files n ON n.id = q.source_id AND n.user_id = q.user_id
 WHERE n.ext = 'doc' AND n.id::text = ANY(ARRAY[:GK_PILOT_IDS]::text[])
 GROUP BY n.id, n.name ORDER BY n.id;

\if :{?GK_ROLLBACK_APPLY}
  \echo '=== APPLY MODE: deleting pilot rows ONLY ==='
  BEGIN;
  DELETE FROM question_inline_figures q
   USING netdisk_files n
   WHERE n.id = q.source_id AND n.user_id = q.user_id
     AND n.ext = 'doc' AND n.id::text = ANY(ARRAY[:GK_PILOT_IDS]::text[]);
  DELETE FROM question_inline_done d
   USING netdisk_files n
   WHERE n.id = d.source_id AND n.user_id = d.user_id
     AND n.ext = 'doc' AND n.id::text = ANY(ARRAY[:GK_PILOT_IDS]::text[]);
  COMMIT;
  \echo '=== POST-ROLLBACK CHECK: .doc inline rows must be 0 ==='
  SELECT count(*)::text AS doc_inline_rows_left
    FROM question_inline_figures q
    JOIN netdisk_files n ON n.id = q.source_id AND n.user_id = q.user_id
   WHERE n.ext = 'doc';
\else
  \echo '=== DRY RUN: pass -v GK_ROLLBACK_APPLY=1 to actually delete ==='
\endif
