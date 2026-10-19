-- ============================================================
-- 补齐缺失表 · 一键 SQL（保底方案）
-- ------------------------------------------------------------
-- 适用：暂时拿不到 Postgres 连接串（DATABASE_URL）时，手工粘贴到
--       Supabase Dashboard → SQL Editor → 运行。
-- 首选方案仍是：node server/scripts/migrate.mjs（自动记录执行状态、失败精确报错）
--
-- 现状（2026-10-19 实测，service_role 逐表探测）：
--   已存在：users / subjects / timeline_items / library_docs / documents
--           / health_check / blob_objects
--   缺  失：knowledge_articles / chat_messages / user_quota
--           / memories / memory_media，以及 library_docs 的 thumb_key 等列
--
-- 内容 = migrations/0004 + 0005 + 0006 + 0007 的合成（全部幂等，可反复执行）
-- ⚠️ 粘贴时务必整段复制，不要只复制一半：SQL Editor 一次执行是一个事务，
--    中途截断会导致「部分语句未执行但界面显示成功」的错觉。
-- ============================================================

-- ---------- 0004：library_docs 补缩略图与去重字段 ----------
alter table library_docs
  add column if not exists thumb_key  text,
  add column if not exists width      integer,
  add column if not exists height     integer,
  add column if not exists file_hash  varchar(64);

create index if not exists library_hash_idx
  on library_docs (user_id, file_hash);

-- ---------- 0005：用户配额表 + blob 字节列 ----------
create table if not exists user_quota (
  user_id       text primary key,
  tier          varchar(20) not null default 'free',
  quota_bytes   bigint      not null default 524288000,
  quota_count   integer     not null default 300,
  monthly_bytes bigint      not null default 209715200,
  used_bytes    bigint      not null default 0,
  used_count    integer     not null default 0,
  updated_at    timestamptz not null default now()
);
create index if not exists user_quota_tier_idx on user_quota (tier);

alter table blob_objects
  add column if not exists original_bytes bigint,
  add column if not exists thumb_bytes    bigint;

-- ---------- 0006：成长记忆 ----------
create table if not exists memories (
  id              varchar(36) primary key default gen_random_uuid(),
  user_id         varchar(36) not null references users(id) on delete cascade,
  title           varchar(128),
  content         text,
  category        varchar(16) not null default 'life',
  mood            varchar(16),
  subject_id      varchar(36) references subjects(id) on delete set null,
  tags            text[] not null default '{}',
  cover_key       text,
  cover_mime      varchar(64),
  media_count     int not null default 0,
  audio_duration  int,
  occurred_at     timestamp with time zone not null default now(),
  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now(),
  deleted_at      timestamp with time zone
);
create index if not exists memories_user_occurred_idx
  on memories (user_id, occurred_at desc) where deleted_at is null;
create index if not exists memories_user_category_idx
  on memories (user_id, category) where deleted_at is null;
create index if not exists memories_subject_idx
  on memories (user_id, subject_id);
create index if not exists memories_tags_gin
  on memories using gin (tags);

create table if not exists memory_media (
  id              varchar(36) primary key default gen_random_uuid(),
  memory_id       varchar(36) not null references memories(id) on delete cascade,
  user_id         varchar(36) not null references users(id) on delete cascade,
  file_key        text not null,
  thumb_key       text,
  mime_type       varchar(64) not null,
  width           int,
  height          int,
  size_bytes      bigint,
  duration_sec    int,
  transcript      text,
  kind            varchar(16) not null,
  sort_order      int not null default 0,
  created_at      timestamp with time zone not null default now()
);
create index if not exists memory_media_memory_idx
  on memory_media (memory_id, sort_order);

-- ---------- 0007：智能客服（知识库 + 对话记录）----------
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

create table if not exists chat_messages (
  id          varchar(36) primary key default gen_random_uuid(),
  session_id  varchar(36) not null,
  user_id     varchar(36),
  role        varchar(20) not null,
  content     text not null,
  created_at  timestamp with time zone not null default now()
);
create index if not exists chat_session_created_idx
  on chat_messages (session_id, created_at);

-- ---------- 收尾：强制刷新 PostgREST schema cache ----------
-- 不刷新的话，新表在 REST 接口上仍会报 PGRST205 "Could not find the table"
notify pgrst, 'reload schema';

-- ---------- 校验：应返回 5 行 ----------
-- select table_name from information_schema.tables
--  where table_schema = 'public'
--    and table_name in ('user_quota','memories','memory_media','knowledge_articles','chat_messages')
--  order by table_name;
