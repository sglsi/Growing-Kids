-- 0027_netdisk_text_flat.sql
-- P-011 / D-014 · P2：让「资料正文」真正参与召回。
--
-- 背景（`docs/reports/资料库正文召回-检索侧四步方案评审.md` §3）：
--   P-008 已经把 10,454 份正文 / 9,450 万字抽进 `netdisk_files.text_content`，
--   但 `searchLocal()` 只查 `name/path ilike`。实测 `AB=6`：文件名 0 命中、正文 196 命中。
--   更隐蔽的一层：题干 keys 是**去标点**的（normalizeForMatch），而正文含标点 ⇒
--   直接拿 key 去 `text_content ilike '%平行四边形ABCD%'` 永远 0 命中。
--
-- 做法：加一列 `text_flat` = 归一化的正文（只留汉字 / 字母 / 数字），
--   由 `scripts/netdisk-text-flat-build.mjs` 离线回填；运行时新抽的正文由
--   `netdisk-search.service.ts#saveCache` 同步写这一列。
--   归一化口径**唯一真相源** `src/shared/public-library.ts#flatText()`
--   （内部调 `question-match.ts#normalizeForMatch`），禁止在别处另写正则。
--
-- 🔴 为什么不用 SQL 的 regexp_replace 生成：PG 的 `[^一-龥]` 范围受 collation 影响，
--    与 JS 的 `\u4e00-\u9fa5` 不能保证逐字一致；口径一漂就回到「正文 0 命中」。
--    JS 侧先剥 U+0000（PG text 不接受 NUL，教训 L）再归一化，写回纯 ASCII + 汉字。
--
-- 🔴 本迁移只加列 + 索引，**不写任何数据**；回填由脚本 `--apply` 完成（默认 dry-run）。
--    `text_flat` 是派生列，可由 `text_content` 完全重建。

-- 0024 已装过；这里再幂等声明一次，保证 `--only 0027` 单独跑也不缺扩展
create extension if not exists pg_trgm;

alter table netdisk_files
  add column if not exists text_flat text;

comment on column netdisk_files.text_flat is
  'P2 正文召回列：normalizeForMatch(text_content)，只留汉字/字母/数字。派生列，由 netdisk-text-flat-build.mjs 回填；运行时缓存写入同步更新。';

-- 正文通道只用 ≥4 字长锚点做 `ilike '%锚点%'`，B-tree 用不上 ⇒ GIN trigram。
-- partial：只索引「已抽到正文」的行（现网 10,454 / 78,430），不碰目录与未抽行。
--
-- ⚠️ 上线前必量（报告 §4 P1-3「先量构建耗时、索引体积、单查延迟，达标才全量」）：
--    select pg_size_pretty(pg_relation_size('netdisk_files_text_flat_trgm_idx'));
--    explain analyze select fs_id from netdisk_files where text_flat ilike '%平行四边形%' limit 300;
--  若索引 > 1GB 或单次 > 1s：保留列、DROP 本索引，改用 `NETDISK_TEXT_LIMIT` 收紧
--  候选上限并配合 `NETDISK_TEXT_RECALL=0` 回退；不得靠放宽判定来补偿召回。
--  🔴 L3 是 4 核 4G / 60G：长索引构建放在低峰窗口，先迁移再换 dist（QA-16 §6.1.1）。
create index if not exists netdisk_files_text_flat_trgm_idx
  on netdisk_files using gin (text_flat gin_trgm_ops)
  where is_dir = false and text_status = 'ok' and text_flat is not null;

-- 回填脚本按「已抽正文但还没归一化」筛待办，避免每次全表扫
create index if not exists netdisk_files_text_flat_todo_idx
  on netdisk_files (user_id, text_status)
  where is_dir = false and text_status = 'ok' and text_flat is null;
