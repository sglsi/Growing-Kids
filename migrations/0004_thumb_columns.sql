-- ============================================================
-- 0004_thumb_columns.sql
-- 作用：给 library_docs 补齐 thumb_key / width / height / file_hash
--       使其与 timeline_items 字段对齐，支持缩略图与内容去重
-- 依据：复习本与项目设计.md §11.3 策略 2（缩略图）+ 策略 4（去重）
-- 特性：幂等（add column if not exists），可反复执行
--
-- 背景：timeline_items 早就有这几列（schema.ts:54/56/57/59），但 library_docs
--       没有，导致资料库图片无法享受压缩/缩略图/去重，是存储的盲区。
-- ============================================================

-- 1) 资料库：补缩略图与去重字段
alter table library_docs
  add column if not exists thumb_key  text,
  add column if not exists width      integer,
  add column if not exists height     integer,
  add column if not exists file_hash  varchar(64);

-- 2) 资料库去重索引（与 timeline_hash_idx 对齐）
create index if not exists library_hash_idx
  on library_docs (user_id, file_hash);

-- 3) documents（生成文档）补 file_hash，便于去重与孤儿回收
alter table documents
  add column if not exists file_hash  varchar(64);

create index if not exists documents_hash_idx
  on documents (user_id, file_hash);

comment on column library_docs.thumb_key is '缩略图对象 key（WebP，宽<=400）';
comment on column library_docs.file_hash is 'sha256，用于内容去重与 blob_objects 关联';
