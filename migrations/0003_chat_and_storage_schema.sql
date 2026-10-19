-- ============================================================
-- 成长学习伙伴 · 补充迁移 0003（智能客服 + 存储模块新表）
-- 背景：0002_fresh_schema.sql 建于智能客服模块合入之前，
--       本脚本补齐其后端 schema.ts 新增的 4 张表。
-- 依据：server/src/storage/database/shared/schema.ts
--   - knowledge_articles / chat_messages（智能客服：知识库 + 对话记录）
--   - blob_objects / user_quota（图片存储去重与配额）
-- 特性：幂等（create ... if not exists），可反复执行
-- 执行：Supabase Dashboard → SQL Editor → 粘贴运行
-- 注意：service_role 会绕过 RLS，数据隔离靠后端 where user_id（与 0002 一致）
-- ============================================================

-- ------------------------------------------------------------
-- 1) 智能客服 · 知识库（后台维护，非按用户隔离）
-- ------------------------------------------------------------
create table if not exists knowledge_articles (
  id          varchar(36) primary key default gen_random_uuid(),
  title       varchar(255) not null,
  content     text not null,
  category    varchar(64),
  tags        text[] not null default '{}',
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamp with time zone not null default now(),
  updated_at  timestamp with time zone not null default now()
);
create index if not exists knowledge_tags_gin
  on knowledge_articles using gin (tags);

-- ------------------------------------------------------------
-- 2) 智能客服 · 对话记录（session_id 分组，user_id 可空——匿名用户也能问）
-- ------------------------------------------------------------
create table if not exists chat_messages (
  id          varchar(36) primary key default gen_random_uuid(),
  session_id  varchar(36) not null,
  user_id     varchar(36),
  role        varchar(20) not null,                -- 'user' | 'assistant'
  content     text not null,
  created_at  timestamp with time zone not null default now()
);
create index if not exists chat_session_created_idx
  on chat_messages (session_id, created_at);

-- ------------------------------------------------------------
-- 3) 图片存储 · 内容寻址去重表（blob_objects）
-- ------------------------------------------------------------
create table if not exists blob_objects (
  content_hash  varchar(64) primary key not null,  -- sha256
  storage_key   text not null,
  ref_count     int not null default 0,
  size_bytes    bigint,
  mime_type     varchar(64),
  kind          varchar(16) not null default 'image',
  width         int,
  height        int,
  variants      jsonb not null default '{}',
  created_at    timestamp with time zone not null default now(),
  last_ref_at   timestamp with time zone not null default now(),
  original_bytes bigint,
  thumb_bytes    bigint
);
create index if not exists blob_created_idx
  on blob_objects (created_at);
-- GC 扫描：只找 ref_count = 0 的少量行
create index if not exists blob_gc_idx
  on blob_objects (ref_count, last_ref_at) where ref_count = 0;

-- ------------------------------------------------------------
-- 4) 用户存储配额（user_quota）
-- ------------------------------------------------------------
create table if not exists user_quota (
  user_id       text primary key not null,
  tier          varchar(20) not null default 'free',
  quota_bytes   bigint not null default 524288000,   -- 500MB
  quota_count   int not null default 300,
  monthly_bytes bigint not null default 209715200,   -- 200MB/月
  used_bytes    bigint not null default 0,
  used_count    int not null default 0,
  updated_at    timestamp with time zone not null default now()
);
create index if not exists user_quota_tier_idx
  on user_quota (tier);

-- ------------------------------------------------------------
-- 5) 校验
-- ------------------------------------------------------------
-- select table_name from information_schema.tables
--  where table_schema = 'public'
--    and table_name in ('knowledge_articles','chat_messages','blob_objects','user_quota')
--  order by table_name;
