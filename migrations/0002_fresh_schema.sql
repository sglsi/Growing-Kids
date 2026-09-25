-- ============================================================
-- 成长学习伙伴 · 数据库全量重建脚本（v4 定稿）
-- 依据：数据库重新设计-v4.md（决策速览）/ 复习本与项目设计.md §13
-- 前提：当前库均为测试数据，不迁移，直接重建为最终形态
-- 特性：幂等（create ... if not exists），可反复执行
-- 执行：Supabase SQL Editor（Coze 项目绑定的库）
-- ⚠️ 密钥：Coze 注入 service_role → RLS 被绕过 → 隔离靠后端 where user_id（见文末说明）
-- ============================================================

-- ------------------------------------------------------------
-- 0) （可选）旧测试表清理 —— 确认无真实数据后解除注释
-- ------------------------------------------------------------
-- drop table if exists health_check;
-- drop table if exists questions;
-- drop table if exists materials;
-- drop table if exists documents;
-- drop table if exists subjects;

-- 若想留痕而非直删，可改名保留：
-- alter table questions rename to questions_legacy;
-- alter table materials rename to materials_legacy;

-- ------------------------------------------------------------
-- 1) 用户与学科
-- ------------------------------------------------------------
create table if not exists users (
  id            varchar(36) primary key default gen_random_uuid(),
  open_id       varchar(64) unique,             -- 微信 openid（登录用户才有）
  nickname      varchar(64),
  avatar_url    text,
  is_anonymous  boolean not null default false, -- 免注册匿名用户
  expire_at     timestamp with time zone,       -- 匿名用户过期时间（1 天）；登录用户为 NULL
  created_at    timestamp with time zone not null default now()
);
-- 匿名清理任务用：只扫"匿名 + 已过期"的少量行
create index if not exists users_anon_expire_idx
  on users (expire_at) where is_anonymous;

create table if not exists subjects (
  id          varchar(36) primary key default gen_random_uuid(),
  user_id     varchar(36) not null references users(id) on delete cascade,
  name        varchar(32) not null,
  color       varchar(16) not null default 'gray-500',
  sort_order  int not null default 0,
  created_at  timestamp with time zone not null default now(),
  unique (user_id, name)                        -- 同用户同学科唯一（替代旧的全局 unique）
);

-- ------------------------------------------------------------
-- 2) 统一收件箱：所有"可复习条目"一张表（kind 区分图片/题目）
--    最近题目 = 全量；复习本 = in_review_book 子集
-- ------------------------------------------------------------
create table if not exists timeline_items (
  id                  varchar(36) primary key default gen_random_uuid(),
  user_id             varchar(36) not null references users(id) on delete cascade,
  subject_id          varchar(36) references subjects(id) on delete set null,
  kind                varchar(16) not null,          -- 'image' | 'question'
  title               text,
  -- 文件（kind=image）
  file_key            text,
  thumb_key           text,
  mime_type           varchar(64),
  width               int,
  height              int,
  size_bytes          bigint,
  file_hash           varchar(64),                   -- sha256，用于内容去重
  -- 题目内容（kind=question）
  content             jsonb not null default '{}',   -- {question,answer,solution,wrong_answer,images[],status}
  source              varchar(24),                   -- 'camera'|'album'|'doc'
  -- 复习本标记
  in_review_book      boolean not null default false,
  added_to_review_at  timestamp with time zone,
  -- 标签与状态
  tags                text[] not null default '{}',
  mastered            boolean not null default false,
  mastered_at         timestamp with time zone,
  deleted_at          timestamp with time zone,      -- 软删
  created_at          timestamp with time zone not null default now(),
  updated_at          timestamp with time zone not null default now()
);

-- 最近题目（全量收件箱）：按创建时间倒序
create index if not exists timeline_user_created_idx
  on timeline_items (user_id, created_at desc) where deleted_at is null;
-- 复习本：部分索引，只覆盖已加入的少量行
create index if not exists timeline_review_idx
  on timeline_items (user_id, added_to_review_at desc)
  where in_review_book and deleted_at is null;
-- 标签（GIN）+ 学科
create index if not exists timeline_tags_gin on timeline_items using gin (tags);
create index if not exists timeline_subject_idx on timeline_items (user_id, subject_id);
-- 去重查找
create index if not exists timeline_hash_idx on timeline_items (user_id, file_hash);

-- ------------------------------------------------------------
-- 3) 资料库（外部文档）与 文档页（生成文档）
-- ------------------------------------------------------------
create table if not exists library_docs (
  id          varchar(36) primary key default gen_random_uuid(),
  user_id     varchar(36) not null references users(id) on delete cascade,
  subject_id  varchar(36) references subjects(id) on delete set null,
  name        varchar(128) not null,
  file_key    text not null,
  mime_type   varchar(64),
  size_bytes  bigint,
  source      varchar(24),                           -- 'upload'|'external'|'materials'
  tags        text[] not null default '{}',
  deleted_at  timestamp with time zone,
  created_at  timestamp with time zone not null default now()
);
create index if not exists library_user_created_idx
  on library_docs (user_id, created_at desc) where deleted_at is null;

create table if not exists documents (
  id          varchar(36) primary key default gen_random_uuid(),
  user_id     varchar(36) not null references users(id) on delete cascade,
  title       varchar(128) not null,
  type        varchar(8) not null,                   -- 'docx'|'pdf'
  file_key    text not null,
  mime_type   varchar(64),
  size_bytes  bigint,
  meta        jsonb not null default '{}',           -- 生成参数 / 来源题目 id 列表
  deleted_at  timestamp with time zone,
  created_at  timestamp with time zone not null default now()
);
create index if not exists documents_user_created_idx
  on documents (user_id, created_at desc) where deleted_at is null;

-- ------------------------------------------------------------
-- 4) health_check 保留
-- ------------------------------------------------------------
create table if not exists health_check (
  id          serial primary key,
  updated_at  timestamp with time zone default now()
);

-- ------------------------------------------------------------
-- 5) 双保险：RLS（service_role 会绕过，保留作将来切换 anon+JWT 用）
--    若要启用，取消下面注释并配好 JWT 体系即可，无需改表
-- ------------------------------------------------------------
-- alter table subjects       enable row level security;
-- alter table timeline_items enable row level security;
-- alter table library_docs   enable row level security;
-- alter table documents      enable row level security;
--
-- create policy "own_rows_timeline" on timeline_items
--   for all using (user_id = auth.uid()::text) with check (user_id = auth.uid()::text);
-- create policy "own_rows_subjects" on subjects
--   for all using (user_id = auth.uid()::text) with check (user_id = auth.uid()::text);
-- create policy "own_rows_library" on library_docs
--   for all using (user_id = auth.uid()::text) with check (user_id = auth.uid()::text);
-- create policy "own_rows_documents" on documents
--   for all using (user_id = auth.uid()::text) with check (user_id = auth.uid()::text);

-- ------------------------------------------------------------
-- 6) 校验
-- ------------------------------------------------------------
-- select table_name from information_schema.tables
--  where table_schema = 'public'
--    and table_name in ('users','subjects','timeline_items','library_docs','documents','health_check')
--  order by table_name;

-- ============================================================
-- ⚠️ 重要：本项目 Coze 注入 service_role key → RLS 被绕过
--    ⇒ 数据隔离【完全依赖后端 service 层强制 where user_id = :currentUserId】
--    ⇒ 禁止裸查；新增时 user_id 由后端强制写入，禁止信任前端传入
-- ============================================================
