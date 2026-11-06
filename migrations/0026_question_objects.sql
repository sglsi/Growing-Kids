-- 0026_question_objects.sql
-- P-010 / D-013：题目级结构化对象（P1 · 入库时预切分）
--
-- 背景（报告《资料库正文召回-检索侧四步方案评审》§7 / §8）：
--   P0 把判定单元从「整份文件」收敛到「题目对象」，但对象仍是**检索时从全文临时切**
--   出来的。TextIn 把「解析张冠李戴」列为行业卡点，根因不在 OCR，而在
--   「题目 / 答案 / 解析的对应关系缺乏工程管控」。运行时临时切分没有稳定身份、没有
--   来源坐标、错误无法定点修复，只能靠调阈值假装证明归属（§8.4 的 40/40 ROC 已证伪）。
--
-- 本迁移做三件事，全部是**工程管控**，不是「算法证明了解析归属」：
--   ① 入库时把正文切成一题一对象，题干与解析在切分阶段就绑定成同一行；
--   ② 为每行落稳定内容指纹 + 正文版本 + 切分规则版本，任何改动都可复算、可审计；
--   ③ 落 link_status，允许把「已证实的张冠李戴对象」按指纹定点标 rejected，
--      永不参与 exact —— 这是 P0 做不到的事（那时只能改算法，一改就误杀一片）。
--
-- ⚠️ 诚实边界（不得在文档/文案里越线）：
--   纯文本没有版面坐标，若**原始文本流本身**把别人的解析排在这道题后面，
--   结构化切分照样会把它们绑在一起。P1 消除的是「运行时猜关系」的不确定性与
--   「错了改不动」，不是把 §8.4 的残余风险洗掉。彻底消除需要版面坐标（后续阶段）。
--
-- 🔴 只写本表，绝不改 netdisk_files / library_docs 的任何列。
-- 🔴 无 RLS：所有查询必须带 .eq('user_id', userId)，见 QA-16。
-- 🔴 user_id 必须 varchar(36)（与 users.id 一致），否则外键类型不匹配。

create table if not exists question_objects (
  id                  varchar(36) primary key default gen_random_uuid(),
  user_id             varchar(36) not null references users(id) on delete cascade,
  -- 'netdisk' = netdisk_files.text_content；'library' = library_docs.text_content
  source_type         varchar(12) not null check (source_type in ('netdisk', 'library')),
  -- 多态来源，不做外键（两张源表），但必须由构建脚本保证指向真实存在的行
  source_id           varchar(64) not null,
  source_name         text,
  object_index        integer not null,
  label               varchar(32) not null default '',
  char_start          integer not null,
  char_end            integer not null,
  stem_start          integer not null,
  stem_end            integer not null,
  stem_text           text not null,
  solution_text       text,
  has_solution        boolean not null default false,
  -- sha256(objectFingerprintInput(...))：内容 + 位置 + 规则版本，重跑必须得同一值
  object_fingerprint  char(64) not null,
  -- sha256(来源正文原文)：正文一变，旧对象立即失效，绝不拿旧解析当新题答案
  source_revision     char(64) not null,
  -- ok=结构校验通过 / rejected=结构可疑或人工定点排除（永不 exact）
  link_status         varchar(16) not null default 'ok' check (link_status in ('ok', 'rejected')),
  link_reason         text,
  -- 改 splitQuestionObjects() 或字段口径必须 bump OBJECT_ENGINE_VERSION
  engine_version      varchar(16) not null,
  built_at            timestamp with time zone not null default now()
);

-- 幂等 upsert 的唯一键：同一来源的同一题号只能有一行
create unique index if not exists question_objects_src_obj_idx
  on question_objects (user_id, source_type, source_id, object_index);

-- 按来源批量取对象（判定层主路径）
create index if not exists question_objects_src_idx
  on question_objects (user_id, source_type, source_id);

-- 按指纹定点排查 / 修复误判对象
create index if not exists question_objects_fp_idx
  on question_objects (object_fingerprint);

-- 构建脚本按来源 + 规则版本筛待重建行
create index if not exists question_objects_engine_idx
  on question_objects (source_type, engine_version, built_at);

comment on table question_objects is
  'P1 题目级结构化对象：入库预切分、题干与解析绑定、稳定内容指纹与来源坐标';
comment on column question_objects.object_fingerprint is
  'sha256(内容+位置+规则版本)。判定前复算，不一致即拒绝，防库内对象被篡改或串档';
comment on column question_objects.source_revision is
  'sha256(来源正文)。与检索时读到的正文 hash 不一致即视为过期，绝不复用旧解析';
comment on column question_objects.link_status is
  'ok=结构校验通过；rejected=解析段串题/人工定点排除，永不参与 exact';
