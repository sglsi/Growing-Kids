-- 0022_netdisk_index.sql
-- 百度网盘学习资料索引（「资料库搜题」第一顺位检索源）。
--
-- 背景（思傅 2026-11-03 报障 + 需求）：
--   网盘 /学生 目录下有上千份教辅（PDF/DOC/DOCX），用户希望能从里面「搜到以前的内容」，
--   并且顺序是「先网盘、再 ima」。此前网盘只有写（归档副本），完全没有读通道。
--
-- 为什么不是「把全量正文灌进库」：
--   实测 /学生 采样 120 次目录列举即见 1318 个文件 / 252GB，其中 PDF 623 个，
--   大量扫描版；按 26s/页 OCR 全量不可行。所以这里只落**元数据**，
--   正文按需抽取（命中候选才下载 + 抽文字层）落在 text_content，抽一次就缓存。
--
-- 字段口径：
--   fs_id          网盘文件唯一 id（同一账号内稳定），与 user_id 组成唯一键
--   dir_path       父目录，拼 path 用于展示
--   text_status    pending=未抽 / ok=已抽 / none=无文字层（扫描版，需 OCR，暂不抽）/
--                  skipped=类型不支持（mp4/rar/zip）/ too_big=超过抽取上限
--   text_content   正文（截断到 TEXT_NETDISK_MAX_CHARS，够做关键词匹配即可，不当正文库用）
--
-- ⚠️ 全文检索故意不建 GIN/tsvector：PG 默认分词对中文无效，zhparser 未装；
--    正文匹配走 ilike，但只在「文件名已命中的少量候选」里做，不全表扫。

create table if not exists netdisk_files (
  id              varchar(36) primary key default gen_random_uuid(),
  user_id         varchar(36) not null references users(id) on delete cascade,
  fs_id           bigint not null,
  path            text not null,
  dir_path        text,
  name            text not null,
  ext             varchar(12),
  is_dir          boolean not null default false,
  size_bytes      bigint,
  mtime           timestamp with time zone,
  text_content    text,
  text_status     varchar(16) not null default 'pending',
  text_updated_at timestamp with time zone,
  synced_at       timestamp with time zone not null default now(),
  created_at      timestamp with time zone not null default now()
);

-- 同一用户同一 fs_id 只留一行：递归列举可重复执行，靠它做 upsert
create unique index if not exists netdisk_files_user_fs_idx
  on netdisk_files (user_id, fs_id);

-- 「按文件名检索」是主路径，走这个索引
create index if not exists netdisk_files_user_name_idx
  on netdisk_files (user_id, name);

-- 抽正文时按状态筛待办
create index if not exists netdisk_files_user_text_idx
  on netdisk_files (user_id, text_status)
  where is_dir = false;

comment on table netdisk_files is '百度网盘学习资料索引（元数据 + 按需抽取的正文缓存）';
