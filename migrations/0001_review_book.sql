-- ============================================================
-- 成长学习伙伴 · 复习本功能迁移脚本（Supabase / PostgreSQL）
-- 作用：为 questions、materials 两表各加两列，标记"是否加入复习本"
-- 特性：幂等（add column if not exists），可反复执行不报错
-- 依据：复习本与项目设计.md §3.4
-- 执行：见该文档 §12（Coze 数据库控制台 / Supabase SQL Editor）
-- ============================================================

-- 1) 题目表：标记是否加入复习本
alter table questions
  add column if not exists in_review_book boolean not null default false,
  add column if not exists added_to_review_at timestamp with time zone;

-- 2) 素材表：标记是否加入复习本（图片素材可加入；文档类型不进复习本）
alter table materials
  add column if not exists in_review_book boolean not null default false,
  add column if not exists added_to_review_at timestamp with time zone;

-- 3) 复习本排序索引（按加入时间倒序；部分索引只覆盖已加入的少量行）
create index if not exists questions_review_idx
  on questions (in_review_book, added_to_review_at desc);
create index if not exists materials_review_idx
  on materials (in_review_book, added_to_review_at desc);

-- 4) 校验：查看新列是否创建成功
-- select column_name, data_type, column_default
--   from information_schema.columns
--  where table_name in ('questions','materials')
--    and column_name in ('in_review_book','added_to_review_at')
--  order by table_name, column_name;
