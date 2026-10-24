-- 0014_answer_cache.sql
-- 题目答案持久化缓存（思傅 2026-10-24 定）
--
-- 背景：ima 知识库有**每日调用配额**（code=220021，按调用计数、零命中也扣、不可退避），
--       500 次/天 的档位下，一道题 2~10 次调用意味着一天只能搜几十道题。
--       原缓存是进程内存（mem-cache），后端一重启就全丢，重启当天等于重新烧配额。
--
-- 方案：把「题面 hash + mode」的结果落库，同一道题（同一 mode）永不重复消耗外部配额。
--   - key 含题面内容 hash ⇒ 题面改了自然换 key，不存在「结果陈旧」问题；
--   - 成功结果默认永久（ANSWER_CACHE_TTL_DAYS=0 表示不过期）；
--   - 失败/零命中结果按 ANSWER_CACHE_NEG_TTL_HOURS（默认 12h）短期记忆，
--     既避免同一道搜不到的题反复白扣配额，又不会把配额耗尽状态永久固化。
--
-- ⚠️ 与既有约定一致：RLS 全注释 + service_role ⇒ 所有查询必须显式带 .eq('user_id', userId)。

create table if not exists answer_cache (
  id            varchar(36) primary key default gen_random_uuid(),
  user_id       varchar(36) not null references users(id) on delete cascade,

  -- 题面 sha256 前 32 位；mode 必须入 key（检索结果与推理结果不可串味）
  q_hash        varchar(64) not null,
  mode          varchar(16) not null,          -- search | ai | kb

  -- 完整 AnswerSearchResult（含 source / verified / refs / note 等）
  result        jsonb not null,

  hit_count     int not null default 0,
  created_at    timestamp with time zone not null default now(),
  last_hit_at   timestamp with time zone not null default now()
);

create unique index if not exists answer_cache_uq_idx
  on answer_cache (user_id, q_hash, mode);

create index if not exists answer_cache_user_time_idx
  on answer_cache (user_id, created_at desc);
