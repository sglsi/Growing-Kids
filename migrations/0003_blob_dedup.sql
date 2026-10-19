-- ============================================================
-- 0003_blob_dedup.sql
-- 作用：新增 blob_objects 表 —— 内容寻址 + 引用计数（全局去重）
-- 依据：复习本与项目设计.md §11.3 策略 4（内容去重 + 引用计数）
-- 特性：幂等（if not exists），可反复执行
--
-- 设计要点：
--   * content_hash 作为主键 —— 物理内容唯一标识（sha256）
--   * storage_key 复用 —— 同一份内容再多用户也只有一个对象存储对象
--   * ref_count  引用计数 —— 归零才真删文件，避免 A 用户删图误伤 B 用户
--   * last_ref_at —— 便于识别冷数据（后续可接生命周期归档）
-- ============================================================

-- 存储介质分工：图片一律走对象存储；本表只存「物理对象」元数据，
-- 业务侧仍由 timeline_items.file_hash / library_docs.file_hash 指向它。

create table if not exists blob_objects (
  content_hash  varchar(64) primary key,          -- sha256 hex，物理内容唯一标识
  storage_key   text not null,                    -- 对象存储 key（如 blobs/a1/a1b2.../display.webp）
  ref_count     integer not null default 0,       -- 引用计数；归零后可回收
  size_bytes    bigint,                           -- 主对象字节数
  mime_type     varchar(64),
  kind          varchar(16) not null default 'image', -- 'image' | 'doc'
  width         integer,
  height        integer,
  variants      jsonb not null default '{}'::jsonb,   -- { original, display, thumb } -> storage_key
  created_at    timestamptz not null default now(),
  last_ref_at   timestamptz not null default now()    -- 最近一次被引用时间（冷热判断）
);

-- 引用计数为 0 的候选回收对象（部分索引，只覆盖待清理的少量行）
create index if not exists blob_gc_idx
  on blob_objects (ref_count, last_ref_at)
  where ref_count = 0;

-- 按创建时间审计
create index if not exists blob_created_idx on blob_objects (created_at);

-- 注释：orphan 扫描依赖「业务表 file_hash 是否引用本表」
comment on table blob_objects is '内容寻址去重表：sha256 -> 物理对象，ref_count 归零后方可删文件';
