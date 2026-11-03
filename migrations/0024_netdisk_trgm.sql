-- 0024_netdisk_trgm.sql
-- 为网盘索引的「按名字/路径模糊搜」加 trigram 索引。
--
-- 背景（2026-11-03 实测）：
--   /学生 目录实际有 3 万级文件（远超最初采样估计），`name ilike '%浮力%'`
--   这种前后都有通配的查询用不上 B-tree，只能全表扫。
--   6 个检索词 × 2 个字段 = 12 个 OR 条件，全表扫 3 万行 ⇒ 单次检索 1.2~2.9s。
--
-- pg_trgm 是 PG 官方扩展、在 PG13+ 标记为 trusted（数据库 owner 即可安装，
-- 不需要超级用户）。GIN(gin_trgm_ops) 能显著加速 `ilike '%x%'`。
--
-- ⚠️ 边界：中文 2 字词（如「浮力」）只产生 1 个 trigram，索引过滤率有限；
--    3 字以上效果明显。所以这里只是加速手段，不是「装了就不慢」。
--    真要更快得上 pg_bigm（CJK 2-gram），但本环境不可用。

create extension if not exists pg_trgm;

-- 文件名与路径分开建：查询里是两个独立的 ilike，合成一个复合索引用不上
create index if not exists netdisk_files_name_trgm_idx
  on netdisk_files using gin (name gin_trgm_ops)
  where is_dir = false;

create index if not exists netdisk_files_path_trgm_idx
  on netdisk_files using gin (path gin_trgm_ops)
  where is_dir = false;
