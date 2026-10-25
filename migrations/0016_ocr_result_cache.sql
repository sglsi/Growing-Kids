-- ============================================================
-- 0016_ocr_result_cache.sql
-- 作用：OCR 识别结果持久缓存（全局共享）——同一份文件的内容只识别一次
-- 依据：思傅 2026-10-25 定「ACS-07 同文件去重 + 识别结果复用」
-- 特性：幂等（if not exists / if not exists index），可反复执行
--
-- 背景与收益
--   物理文件早已去重（见 0003_blob_dedup：blob_objects 内容寻址 + 引用计数），
--   但「识别」本身没有记忆：同一份文件上传/上传后再点识别，都要重跑整条 OCR 管线
--   （图片要多算子 pipeline、文档要逐页 OCR + 可能的版面/VLM），既慢又重复消耗算力。
--   本表把「识别产物」按文件内容指纹缓存下来：命中则秒回、零额外算力。
--
-- 设计要点
--   * 缓存作用域取「全局」而非单用户：识别结果只由文件内容决定，
--     与「谁上传的」无关 ⇒ 多用户传同一份卷子只需算一次（也是本次需求的核心场景）。
--   * 隐私边界：只有**文件字节完全相同**（sha256 一致）才会命中。
--     命中方本就持有该文件，拿到的也是自己这份内容的识别结果 ⇒ 无信息增量泄漏。
--   * 键包含 mode（fast/precise）与 engine_version：两条链路的产物不可串味；
--     引擎升级后 engine_version 变化 ⇒ 老条目自然失效、不再被命中，无需手工清理。
--   * 保留了 kind / content_hash / mode / engine_version 明细列：便于按维度排查
--     与按来源清理，不至于只能对着一串 cache_key 发呆。
--   * result_bytes：便于后续做容量治理（默认永久保留，与 answer_cache 策略一致）。
--
-- 权限（与既有全部表一致）
--   * RLS 启用 + **不建任何 policy** ⇒ 客户端（anon/authenticated）完全不可访问；
--   * 服务端用 service_role 连接，绕过 RLS 正常读写。
--     ⚠️ 切勿为本表建宽松 policy：缓存里存的是全站题目文本汇总结构。
-- ============================================================

create table if not exists ocr_results (
  cache_key       varchar(64) primary key,      -- sha256(content_hash|kind|mode|engine_version)
  content_hash    varchar(64) not null,         -- 源文件/图内容 sha256（来自 blob key）
  kind            varchar(16) not null,         -- 'image' | 'pair' | 'doc'
  mode            varchar(16) not null default '', -- fast | precise | rapid | ''（依请求）
  engine_version  varchar(32) not null,         -- 引擎/模型版本；变更即自然失效
  result          jsonb not null,               -- 识别产物（原样回放给调用方）
  result_bytes    integer not null default 0,   -- jsonb 体积，供容量治理
  hit_count       integer not null default 0,   -- 命中次数（判冷热/收益）
  created_at      timestamp with time zone not null default now(),
  last_hit_at     timestamp with time zone not null default now()
);

-- 查询热路径：从内容指纹反查（不必先算 cache_key）
create index if not exists ocr_results_lookup_idx
  on ocr_results (content_hash, kind, mode, engine_version);

-- 容量治理 / 冷热分析：按最近命中排序取冷数据
create index if not exists ocr_results_lru_idx
  on ocr_results (last_hit_at desc);

alter table public.ocr_results enable row level security;

comment on table ocr_results is
  'OCR 识别结果持久缓存：内容指纹 -> 产物，全局共享；命中条件为文件字节完全相同';
comment on column ocr_results.engine_version is
  '引擎/模型版本，进缓存键；升级后旧自动不会被命中（等效失效），无需手工清理';
