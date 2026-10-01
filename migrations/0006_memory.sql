-- 0006_memory.sql
-- 成长记忆功能：memories + memory_media

create table if not exists memories (
  id              varchar(36) primary key default gen_random_uuid(),
  user_id         varchar(36) not null references users(id) on delete cascade,

  -- 内容
  title           varchar(128),
  content         text,

  -- 分类与情境
  category        varchar(16) not null default 'life',  -- study | life | hobby | feel | other
  mood            varchar(16),                          -- happy | calm | excited | thoughtful | sad | proud
  subject_id      varchar(36) references subjects(id) on delete set null,
  tags            text[] not null default '{}',

  -- 媒体摘要（列表展示用，无需 join）
  cover_key       text,
  cover_mime      varchar(64),
  media_count     int not null default 0,
  audio_duration  int,

  -- 时间
  occurred_at     timestamp with time zone not null default now(),
  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now(),
  deleted_at      timestamp with time zone
);

create index if not exists memories_user_occurred_idx
  on memories (user_id, occurred_at desc)
  where deleted_at is null;

create index if not exists memories_user_category_idx
  on memories (user_id, category)
  where deleted_at is null;

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
  duration_sec    int,                                 -- 音/视频时长
  transcript      text,                                -- ASR 转写预留，V1 暂不写

  kind            varchar(16) not null,                -- image | audio | video
  sort_order      int not null default 0,
  created_at      timestamp with time zone not null default now()
);

create index if not exists memory_media_memory_idx
  on memory_media (memory_id, sort_order);