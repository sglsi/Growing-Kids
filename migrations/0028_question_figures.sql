-- 0028_question_figures.sql
-- P-017 / D-020：参考例题的「原题快照」（图形 + 公式）
--
-- 背景（思傅 2026-11-08）：
--   「对不同类型的科目，特别对于数学，有很多图形的题目，当前题库中查寻到的相同类型题目
--     只有文字的描述，没有图形，这对于数学或其他科目题目的理解就会有比较大的障碍」
--
-- 取证结论（本轮，L3 现网）：
--   ① `question_objects` 只有字符偏移，**没有任何图片字段**；
--   ② `pdf_tool.py` 的 `text_only=True` 只取文字层，明确不保留图；
--   ③ 更严重：docx 里公式是 OLE 对象（以 WMF 位图呈现）。成都二诊那份 3,205 个 wmf 中
--      2,761 个是 `o:OLEObject` ⇒ 纯文本抽取把**公式**也一起吞掉了。库内数学解析实际是
--      「抛物线中，当时，；当时，或3」这种残缺串，不只是缺图。
--
-- 本表只存「图片与题目对象的对应关系」，不存图片本体：
--   图片本体走既有内容寻址存储（`figures/<2位>/<sha256>.webp`），
--   读取复用**已公开**的 `GET /api/storage/files/*`（小程序 <Image src> 不发头部，
--   必须可匿名 GET，见 `user-context.ts` PUBLIC_ROUTES 的说明）。
--
-- ⚠️ 诚实边界（不得在文档/文案里越线）：
--   图片是**转换后的近似呈现**（LibreOffice → PDF → 渲染），不是出版社原始矢量；
--   转换失败或题干定位不到时**不产出图**，绝不拿相邻题目顶替；
--   有图不等于「看懂了图」，也不改变判定层任何口径。
--
-- 🔴 无 RLS：所有查询必须带 .eq('user_id', userId)，见 QA-16。
-- 🔴 只写本表，绝不改 question_objects / netdisk_files / library_docs。

create table if not exists question_figures (
  id              varchar(36) primary key default gen_random_uuid(),
  user_id         varchar(36) not null references users(id) on delete cascade,
  -- 与 question_objects 对齐：'netdisk' = netdisk_files；'library' = library_docs
  source_type     varchar(12) not null check (source_type in ('netdisk', 'library')),
  source_id       varchar(64) not null,
  object_index    integer not null,
  -- 该题在原文档里的页码（1 起），供「查看原页」与人工核对
  page_index      integer not null,
  -- 内容寻址 key：figures/<前两位>/<sha256>.webp（复用 /api/storage/files/ 公开读）
  storage_key     text not null,
  width           integer not null,
  height          integer not null,
  size_bytes      bigint,
  -- sha256(来源正文)：与 question_objects.source_revision 对齐；正文一变，旧图立即失效
  source_revision char(64) not null,
  -- 生成管线版本（改定位/裁切策略必须 bump，便于定点重跑）
  engine_version  varchar(16) not null,
  built_at        timestamp with time zone not null default now()
);

-- 一道题最多一张快照（重跑幂等）
create unique index if not exists question_figures_obj_idx
  on question_figures (user_id, source_type, source_id, object_index);

-- 按来源批量取（参考例题命中后回填图）
create index if not exists question_figures_src_idx
  on question_figures (user_id, source_type, source_id);

-- 构建脚本按版本筛待重建
create index if not exists question_figures_engine_idx
  on question_figures (engine_version, built_at);

comment on table question_figures is
  'P-017 参考例题的原题快照（含图形与公式）：题目对象 → 内容寻址图片，供检索结果内嵌展示';
comment on column question_figures.source_revision is
  'sha256(来源正文)。与 question_objects.source_revision 不一致即视为过期，前端不得展示旧图';
comment on column question_figures.page_index is
  '原文档页码（1 起）。仅用于人工核对与「查看原页」，不参与判定';
