-- ============================================================
-- T0-1 · 独立盲测样本固化算子（D-040，P-025 前后对照协议 v1.0 / P5 样本分离）
-- ------------------------------------------------------------
-- 用途：从 question_objects 确定性抽出一批「只用于最终验收、永不用于调参」的样本。
--       样本集一旦固化，任何阈值/词表/算子的调整都不得在它上面试，
--       只能在**另一份调参样本**上做；最终验收只用本集合。
--
-- 用法（L3，纯 SELECT，零写入）：
--   scp server/scripts/measure-blind-sample.sql ubuntu@42.192.36.120:/tmp/gk-t0-blind.sql
--   ssh ubuntu@42.192.36.120 'set -a; . /opt/gk/server/.env.migrate; set +a; \
--     psql "$DATABASE_URL" -t -A -q -f /tmp/gk-t0-blind.sql' > .tmp/t0-blind-sample/sample-v1.jsonl
--   sha256sum .tmp/t0-blind-sample/sample-v1.jsonl
--
-- 🔴 纪律：
--   · 纯 SELECT + WITH，**零写入、零临时表、零 setseed**（用 md5(id) 确定性排序，可复算）。
--   · 输出每行一个 JSON；**不输出完整题干原文**，只给 sha256 + 前 60 字摘要，
--     避免真实题干落仓库 / 外传；需要看原文时按 (source_id, object_index) 回库只读查。
--   · 与 D-034 40 条人工复核清单**物理分离**：排除该清单涉及的 20 个 source_id
--     （来源：docs/reports/P-020-40条人工复核清单.md 中 docId 去重，20 份）。
--   · 🔴 question_objects **无学科 / 学段 / 年级字段**（migrations/0026 实测）⇒
--     本算子**不按 9 科分层**，分层只用题干质量 × 是否含解析；学科为事后人工标注字段，
--     不得冒称「按课标学科分层」，也不得据此外推多科目覆盖度。
--   · 这批是**代理样本**，不是结果指标。唯一够格的结果指标仍是 0021
--     review_events 的「到期首次作答正确率（每档 ≥30 样本）」，当前 0 行。
-- ============================================================

SET work_mem = '128MB';
SET statement_timeout = '300s';

WITH excluded_sources AS (
  SELECT * FROM (VALUES
    ('01257d4b-2673-4b1d-aaac-e906d5cb80a0'),
    ('1903e20c-6f40-40e2-89ea-77b44e2c4445'),
    ('1b26c142-6aa3-4e10-947e-3c5266136e74'),
    ('2cfc181b-91fd-4a64-ba4f-bce080ff4afa'),
    ('2fe35a1a-9b65-4d6b-8b62-0be4c78c7d3f'),
    ('3aaa2f28-1905-4ed6-9285-dcd5d9380b9b'),
    ('3fa09b56-0721-44da-aa3f-155e59099751'),
    ('41674ee5-24c0-43fe-8e83-2f38a83b08f9'),
    ('4321722e-9f92-4dd4-a529-de37508edc1b'),
    ('4a26c1e9-6a4a-483c-a5c9-76b1de058a54'),
    ('4e7f10ea-489d-4e6d-9da8-3016ec9decb8'),
    ('51a8aa7d-ee62-4f31-ab9d-92c851547dbb'),
    ('56774719-3676-4666-ab15-146afece1b97'),
    ('5bb8bde7-4c0c-4436-b328-6633a5ddc606'),
    ('5d0f2322-feb9-4931-ad14-1ed9ea67a83b'),
    ('6b3944e8-3620-4cdd-9f74-41a911aea53a'),
    ('896882ee-04e7-4b5f-bdde-df824feffea2'),
    ('8fe5c5ad-d78a-4a5a-ae78-8e6196b029cf'),
    ('e106cb26-e944-4d98-aa57-8a506b3db385'),
    ('eae70026-03fb-4bbe-91de-e0d2fc9091c3')
  ) AS v(source_id)
),
base AS (
  SELECT q.id,
         q.source_type,
         q.source_id,
         q.object_index,
         q.has_solution,
         q.stem_text,
         length(regexp_replace(q.stem_text, '[^A-Za-z0-9一-龥]', '', 'g')) AS norm_len
    FROM question_objects q
   WHERE q.link_status = 'ok'
     AND position(chr(65533) IN q.stem_text) = 0
     AND q.source_id NOT IN (SELECT source_id FROM excluded_sources)
),
stratified AS (
  SELECT *,
         CASE
           WHEN norm_len >= 30 AND has_solution     THEN 'S1_long_with_solution'
           WHEN norm_len >= 30 AND NOT has_solution THEN 'S2_long_no_solution'
           WHEN norm_len BETWEEN 10 AND 29 AND has_solution     THEN 'S3_mid_with_solution'
           WHEN norm_len BETWEEN 10 AND 29 AND NOT has_solution THEN 'S4_mid_no_solution'
           ELSE 'X_excluded'
         END AS stratum
    FROM base
   WHERE norm_len >= 10
),
ranked AS (
  SELECT *,
         row_number() OVER (PARTITION BY stratum ORDER BY md5(id), id) AS rn
    FROM stratified
   WHERE stratum <> 'X_excluded'
)
SELECT json_build_object(
  'sample_set_id',  't0-blind-v1',
  'stratum',        stratum,
  'rank_in_stratum', rn,
  'sample_id',      md5('t0-blind-v1:' || id),
  'source_type',    source_type,
  'source_id',      source_id,
  'object_index',   object_index,
  'norm_len',       norm_len,
  'has_solution',   has_solution,
  'stem_sha256',    encode(sha256(convert_to(stem_text, 'UTF8')), 'hex'),
  'stem_head',      left(regexp_replace(stem_text, '\s+', ' ', 'g'), 60),
  'subject_label',  null
)::text
  FROM ranked
 WHERE rn <= 50
 ORDER BY stratum, rn;
