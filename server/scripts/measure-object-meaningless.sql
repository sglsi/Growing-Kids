-- D-047 存量「题干无实义」只读度量与排除清单（纯 SELECT，零写入）
--
-- 背景（2026-11-13 只读实测）：656,898 个 question_objects 里有相当一批对象的
-- stem_text 其实是**题号**或**公式/答案区的数字碎片**，被切题边界误当成题干入库。
-- 随机抽样 24 条无一例外（`19.` / `28.` / `5.50` / `0.307` / `0.231/10` / `30.（1）`）。
-- 它们 stem_text 非空 ⇒ 既有三道入库闸（空题干 / 对象超长 / 解析串题号）都拦不住，
-- validateStoredObject() 也只查「非空」，于是以 link_status='ok' 一路入库、占候选位。
--
-- 判据（与 question-objects-build.mjs::isStemMeaningless 同口径）：
--   ① 不含汉字（[一-龥]）② 不含拉丁字母（[a-zA-Z]）③ 整串只能由空白/数字/常用标点数学符号构成
-- 第 ③ 条是白名单，**专门用来排除编码损坏的乱码题干**——它们原文是真题目
-- （实测有 `2.3 ֪ʶ����…` 这类 GBK 乱码），若只按①②判会被误标，故必须再过白名单。
--
-- 用法（L3，只读）：
--   scp server/scripts/measure-object-meaningless.sql ubuntu@42.192.36.120:/tmp/
--   ssh ubuntu@42.192.36.120 'sudo -n -u postgres psql -d gk -f /tmp/measure-object-meaningless.sql'

\echo '=== 1) 总览：命中规模与占比 ==='
WITH bad AS (
  SELECT id, source_type, link_status
  FROM question_objects
  WHERE btrim(stem_text) !~ '[一-龥]'
    AND btrim(stem_text) !~ '[a-zA-Z]'
    AND btrim(stem_text) ~ '^[[:space:]0-9.,;:+*/=^%()\[\]{}<>|_、。，．；：！？…—－×÷·~√△∵∴°℃①-⑩-]+$'
)
SELECT
  (SELECT count(*) FROM question_objects)                                   AS total_objects,
  count(*)                                                                   AS hit_total,
  count(*) FILTER (WHERE link_status = 'ok')                                 AS hit_ok,
  count(*) FILTER (WHERE link_status <> 'ok')                                AS hit_already_marked,
  round(100.0 * count(*) / NULLIF((SELECT count(*) FROM question_objects), 0), 2) AS pct_of_all
FROM bad;

\echo '=== 2) 按来源类型分布 ==='
WITH bad AS (
  SELECT source_type, count(*) AS n
  FROM question_objects
  WHERE btrim(stem_text) !~ '[一-龥]'
    AND btrim(stem_text) !~ '[a-zA-Z]'
    AND btrim(stem_text) ~ '^[[:space:]0-9.,;:+*/=^%()\[\]{}<>|_、。，．；：！？…—－×÷·~√△∵∴°℃①-⑩-]+$'
  GROUP BY 1
)
SELECT source_type, n, round(100.0 * n / SUM(n) OVER (), 2) AS pct_of_hits
FROM bad ORDER BY n DESC;

\echo '=== 3) 随机抽 30 条（人工复核用；确定性排序便于复现） ==='
SELECT
  left(replace(btrim(stem_text), chr(10), ' / '), 48) AS stem_preview,
  length(btrim(stem_text))                           AS len,
  source_type,
  object_index
FROM question_objects
WHERE btrim(stem_text) !~ '[一-龥]'
  AND btrim(stem_text) !~ '[a-zA-Z]'
  AND btrim(stem_text) ~ '^[[:space:]0-9.,;:+*/=^%()\[\]{}<>|_、。，．；：！？…—－×÷·~√△∵∴°℃①-⑩-]+$'
ORDER BY md5(id)
LIMIT 30;

\echo '=== 4) 编码损坏排除量（第③条白名单挡下的，不得标记） ==='
SELECT count(*) AS excluded_as_encoding_broken
FROM question_objects
WHERE btrim(stem_text) !~ '[一-龥]'
  AND btrim(stem_text) !~ '[a-zA-Z]'
  AND btrim(stem_text) !~ '^[[:space:]0-9.,;:+*/=^%()\[\]{}<>|_、。，．；：！？…—－×÷·~√△∵∴°℃①-⑩-]+$';
