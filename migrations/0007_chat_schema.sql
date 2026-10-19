-- ============================================================
-- 0007_chat_schema.sql · 智能客服模块表（知识库 + 对话记录）
--
-- 背景：0002~0006 建库时智能客服模块尚未合入，本脚本补齐其 schema.ts 新增的 2 张表。
-- 依据：server/src/storage/database/shared/schema.ts
--   - knowledge_articles（知识库，后台维护，非按用户隔离）
--   - chat_messages    （对话记录，session_id 分组，user_id 可空以支持匿名提问）
--
-- ⚠️ 命名说明（曾造成事故）：本文件原名 0003_chat_and_storage_schema.sql，
--    与既有的 0003_blob_dedup.sql 同为 "0003" 前缀，极易拿错。
--    user_quota / blob_objects 由 0005_quota_and_tiering.sql 负责，本文件不再重复建。
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
-- 2) 智能客服 · 对话记录（user_id 可空——匿名用户也能问）
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
-- 3) 校验（执行后应返回 2 行）
-- ------------------------------------------------------------
-- select table_name from information_schema.tables
--  where table_schema = 'public'
--    and table_name in ('knowledge_articles','chat_messages')
--  order by table_name;
