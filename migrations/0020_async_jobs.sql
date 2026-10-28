-- ============================================================
-- 0020 异步任务表（async_jobs）
-- ------------------------------------------------------------
-- 背景（OPS-18 `R-上线-01`）：
--   微信小程序的 `wx.request` / `wx.uploadFile` 超时**默认与最大都是 60s**
--   （官方服务市场文档），前端写 `timeout: 180000` 之类的值**完全不生效**。
--   而本项目有三个链路实测必然超过 60s：
--     · 精准 OCR（摆正 ~17s + PP-StructureV3 ~50s）≈ 67s
--     · 联网搜答案（扣子 bot 跑检索插件 ~100~115s + 提炼）≈ 110~135s
--     · AI 解题（联网检索 + 大模型）≈ 60~90s
--   ⇒ 小程序端**与网络好坏无关**地被掐断，表现为「点了没反应 / 失败」。
--
--   真解不是调大超时（上限就在那），而是**把长任务改成异步**：
--   提交立即回 ticket，前端用短请求轮询结果。轮询请求本身是毫秒级，
--   永远不会撞 60s 天花板。
--
-- 设计取舍：
--   ① 任务**只在提交它的那个进程的内存里执行**，不引入队列中间件
--      （单机部署，加 Redis/RabbitMQ 是把一个小问题换成一套运维问题）。
--      代价：进程重启 ⇒ 未完成的任务全部失效。这是**显式接受**的，
--      服务启动时把它们标记 failed 并给出可读原因，不做假装还在跑。
--   ② 表只做**记录与结果传递**，不做调度。调度在内存（并发闸门）。
--   ③ `dedupe_key` 用于幂等：同一用户对「同一参数的同一类任务」重复提交，
--      若已有在跑的则复用 —— 精准 OCR 是 CPU 密集、搜答案要花钱，
--      重复提交既浪费算力又会让用户看到两个都超时。
--
-- 特性：全幂等（create table/index if not exists）。
-- ============================================================

create table if not exists async_jobs (
  id            varchar(36) primary key,
  -- ⚠️ RLS 未启用且 service_role 绕过 RLS ⇒ 每个查询都必须 .eq('user_id', userId)
  user_id       varchar(36) not null references users(id) on delete cascade,
  type          varchar(32) not null,
  status        varchar(16) not null default 'pending',   -- pending|running|done|failed
  -- 幂等键：hash(user_id + type + 规范化参数)；只对 pending/running 生效
  dedupe_key    varchar(64),
  params        jsonb     not null default '{}'::jsonb,
  result        jsonb,
  error         text,
  -- 阶段文案（面向用户，不追求百分比精度 —— 假进度比没进度更糟）
  stage         varchar(64),
  attempts      int       not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  -- 过期时间：过期行由清理任务删除，避免任务表无限增长
  expires_at    timestamptz not null default (now() + interval '24 hours')
);

-- 单用户查自己的任务（列表 / 轮询）
create index if not exists idx_async_jobs_user_created
  on async_jobs (user_id, created_at desc);

-- 幂等：查「同一 key 是否已有在跑的」
create index if not exists idx_async_jobs_dedupe
  on async_jobs (user_id, dedupe_key);

-- 清理：扫过期行
create index if not exists idx_async_jobs_expires
  on async_jobs (expires_at);

-- 状态约束：写错状态会让前端永远轮询下去
alter table async_jobs
  drop constraint if exists async_jobs_status_check;
alter table async_jobs
  add constraint async_jobs_status_check
  check (status in ('pending', 'running', 'done', 'failed'));
