-- ============================================================
-- 0009 补建 questions / materials 两张业务主表
-- ------------------------------------------------------------
-- 为什么需要这个文件（2026-10-19 实测发现，非猜测）：
--   migrate.mjs 首次执行时在 0001 就报 42P01 relation "questions" does not exist。
--   排查结论：**整个 migrations/ 目录从来没有任何一个文件定义过 questions / materials**。
--   这两张表是扣子时代在 Coze 数据库控制台手工建的，从未写进迁移脚本；
--   后来执行 0002_fresh_schema.sql（在新 Supabase 项目上重建库）时只建了 6 张表，
--   questions / materials 就此丢失 —— 库里 12 张表里根本没有它们。
--   而 server/src/questions/questions.service.ts、materials.service.ts 全程在读写这两张表。
--
-- 表结构来源（权威，不是我拍脑袋写的）：
--   server/src/storage/database/shared/schema.ts 里 drizzle 内省出来的
--   questionsLegacy / materialsLegacy 定义（即扣子库的原始表结构，
--   内省时被加了 _legacy 后缀）。本文件按该结构还原为 questions / materials。
--
-- 特性：全幂等（create table if not exists + create index if not exists），可反复执行。
-- ============================================================

-- ------------------------------------------------------------
-- 1) questions —— 错题 / 题目表
-- ------------------------------------------------------------
create table if not exists questions (
  id                  varchar(36) primary key default gen_random_uuid(),
  subject_id          varchar(36) not null references subjects(id) on delete cascade,
  question_content    text not null,
  question_image_keys jsonb not null default '[]'::jsonb,
  answer_content      text not null default '',
  answer_image_keys   jsonb not null default '[]'::jsonb,
  solution            text not null default '',
  wrong_answer        text not null default '',
  source              varchar(100) not null default '',
  status              varchar(20) not null default 'answered',   -- 'answered' | 'pending'
  recognized_at       timestamp with time zone not null default now(),
  created_at          timestamp with time zone not null default now(),
  updated_at          timestamp with time zone not null default now(),
  mastered            boolean not null default false,
  mastered_at         timestamp with time zone,
  -- ⚠️ 新增列（扣子原始表没有）：为多用户隔离预留。
  --    当前 questions.service.ts 完全没做用户隔离（不写也不过滤 user_id），
  --    故此处允许 NULL，保证现有代码零改动即可跑通；
  --    等 service 补上 user_id 写入与过滤后，再改为 not null。
  user_id             varchar(36) references users(id) on delete cascade
);

create index if not exists questions_created_at_idx
  on questions (created_at desc);
create index if not exists questions_status_idx
  on questions (status);
create index if not exists questions_subject_id_idx
  on questions (subject_id);
create index if not exists questions_subject_created_idx
  on questions (subject_id, created_at desc);
create index if not exists questions_user_id_idx
  on questions (user_id);

-- ------------------------------------------------------------
-- 2) materials —— 素材表（图片 / 文档）
-- ------------------------------------------------------------
create table if not exists materials (
  id          varchar(36) primary key default gen_random_uuid(),
  name        varchar(255) not null,
  type        varchar(20) not null default 'image',   -- 'image' | 'document'
  file_key    varchar(500) not null,
  url         text not null,
  mime_type   varchar(100) not null default '',
  size_bytes  integer not null default 0,
  subject_id  varchar(36) references subjects(id) on delete set null,
  used        boolean not null default false,
  created_at  timestamp with time zone not null default now(),
  user_id     varchar(36) references users(id) on delete cascade   -- 同上：预留多用户
);

create index if not exists materials_created_at_idx
  on materials (created_at desc);
create index if not exists materials_type_idx
  on materials (type);
create index if not exists materials_user_id_idx
  on materials (user_id);

-- ------------------------------------------------------------
-- 3) 说明：复习本相关列（in_review_book / added_to_review_at）
--    由 0010_review_book.sql（原 0001）负责追加，本文件不重复定义。
-- ============================================================
