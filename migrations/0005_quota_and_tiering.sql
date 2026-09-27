-- ============================================================
-- 0005_quota_and_tiering.sql
-- 作用：① 配额（策略 6）的档位表  ② 分层统计（策略 3）所需的派生图字节列
-- 依据：复习本与项目设计.md §11.3 策略 3（生命周期分层）+ 策略 6（配额）
--       配套文档：策略3-生命周期分层-配置清单.md / 策略6-配额方案.md
-- 特性：幂等（add column if not exists / create table if not exists），可反复执行
-- ============================================================

-- ---------- ① 配额（策略 6）----------

create table if not exists user_quota (
  user_id       text primary key,
  tier          varchar(20) not null default 'free',   -- free | member | family | anonymous
  quota_bytes   bigint      not null default 524288000, -- 免费档默认 500MB（设计文档 §11.3 口径）
  quota_count   integer     not null default 300,        -- 张数上限（双阈值，先到先触发）
  monthly_bytes bigint      not null default 209715200,  -- 月上传流量上限 200MB（原图不计配额后的兜底）
  used_bytes    bigint      not null default 0,          -- 缓存用量（统计任务刷新，非权威值）
  used_count    integer     not null default 0,
  updated_at    timestamptz not null default now()
);

comment on table  user_quota is '用户存储配额档位（策略 6）；缺省即免费档';
comment on column user_quota.quota_bytes is '存储配额（字节）；与 quota_count 双阈值，先到先触发';
comment on column user_quota.monthly_bytes is '月上传流量上限：原图留档不计入配额，用它兜底防无限传';

create index if not exists user_quota_tier_idx on user_quota (tier);

-- ---------- ② 分层统计所需的派生图字节（策略 3）----------
-- 背景：blob_objects.size_bytes 记的是 display 一档的字节；
--       original（留档）与 thumb（缩略图）的字节此前没记，导致冷热成本算不清：
--       —— 转档收益的主体正是 original，缺了它就无法验收生命周期规则的效果。

alter table blob_objects
  add column if not exists original_bytes bigint,
  add column if not exists thumb_bytes    bigint;

comment on column blob_objects.original_bytes is 'original 留档档字节数（转档收益主体，策略 3 验收需要）';
comment on column blob_objects.thumb_bytes    is 'thumb 缩略图档字节数（<64KB，刻意不参与转档）';
