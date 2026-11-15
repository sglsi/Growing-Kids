-- 0033 资料库无限层级文件夹（D-068 / P-030）
--
-- 目标：让家长把资料按自己习惯的目录分类存放，层级不限深度。
-- 设计要点：
--  · 用 parent_id 自引用表达「无限层级」，NULL = 根目录下的文件夹。
--  · library_docs.folder_id = NULL 表示「未归类 / 根目录」，**不是**删除标记。
--  · 只软删文件夹（deleted_at），且外键用 on delete set null：
--    任何情况下硬删文件夹都不会连带删掉用户的资料文件。
--  · 移动文件夹时的「不能挂到自己子树下」由应用层循环引用检查负责，
--    不在数据库里写递归约束（PG 递归 CHECK 不允许，触发器会显著增加复杂度）。
--  · 所有查询在应用层必须带 .eq('user_id', userId)（本库无 RLS，见 check-isolation）。

create table if not exists library_folders (
  id          varchar(36) primary key default gen_random_uuid(),
  user_id     varchar(36) not null references users(id) on delete cascade,
  parent_id   varchar(36) references library_folders(id) on delete set null,
  name        varchar(128) not null,
  created_at  timestamp with time zone not null default now(),
  deleted_at  timestamp with time zone
);

create index if not exists library_folders_user_parent_idx
  on library_folders (user_id, parent_id)
  where deleted_at is null;

alter table library_docs
  add column if not exists folder_id varchar(36) references library_folders(id) on delete set null;

create index if not exists library_docs_user_folder_idx
  on library_docs (user_id, folder_id)
  where deleted_at is null;

comment on column library_folders.parent_id is
  '父文件夹 id；NULL = 根级文件夹。层级不限深度，应用层需防循环引用。';
comment on column library_docs.folder_id is
  '所属文件夹 id；NULL = 未归类（显示在根目录）。删除文件夹不删除资料。';
