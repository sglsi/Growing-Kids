-- 0023_content_index.sql
-- 让「搜索」跑在本地索引上，而不是每次都去网盘现搜。
--
-- 背景（思傅 2026-11-03）：
--   「能不能将网盘中的内容在本程序中建一个索引，搜索只在本库中进行，
--     具体要读取内容了可进网盘读取。」
--   上一版是实时搜网盘（method=search），每次 3~7s，而且网盘返回的候选子集
--   不稳定 ⇒ 同一题连搜排序会变（R-工程-10）。改成「本地索引 + 按需读正文」
--   之后：搜索是纯 SQL（毫秒级、结果稳定、断网也能用），只有命中候选要看正文
--   时才下载。
--
-- 两部分改动：
--   ① netdisk_files 加 last_seen_at —— 区分「文件还在」与「已从网盘删掉」。
--      全量遍历结束后，本轮没见到的旧记录 last_seen_at 落后 ⇒ 标 deleted_at 语义。
--   ② library_docs 加正文列 —— 我们自己的资料库以前只能按文件名搜，
--      「我记得里面讲过浮力」这类检索做不到。

-- ---------- ① 网盘索引：可判定「已删除」 ----------
alter table netdisk_files
  add column if not exists last_seen_at timestamp with time zone not null default now();

-- 遍历时按目录取子项
create index if not exists netdisk_files_user_dir_idx
  on netdisk_files (user_id, dir_path)
  where is_dir = false;

-- 只搜「还在的」文件
create index if not exists netdisk_files_user_seen_idx
  on netdisk_files (user_id, last_seen_at desc)
  where is_dir = false;

comment on column netdisk_files.last_seen_at is
  '最近一次全量/增量遍历见到此文件的时间。落后于本轮索引开始时间 ⇒ 视作已在网盘删除';

-- ---------- ② 自有资料库：正文 ----------
alter table library_docs
  add column if not exists text_content text,
  add column if not exists text_status varchar(16) not null default 'pending',
  add column if not exists text_updated_at timestamp with time zone;

comment on column library_docs.text_status is
  'pending=未抽 / ok=已抽 / none=无文字层（扫描版，需 OCR）/ skipped=类型不支持 / too_big=超上限';

create index if not exists library_docs_user_text_idx
  on library_docs (user_id, text_status)
  where deleted_at is null;

-- ⚠️ 同样不建 GIN/tsvector：PG 默认分词对中文无效、未装 zhparser。
--    正文匹配走 ilike，但只在「本用户的少量资料」里做（单用户量级 10²~10³），
--    不像网盘那样有上万份，全扫可接受。
