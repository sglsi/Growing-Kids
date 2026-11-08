-- P-018 / D-021：题干原位重建的「图 ↔ 题目对象 ↔ 插入点」映射。
-- 只存映射与内容寻址 key，不存二进制；不动 question_objects / netdisk_files / question_figures。
-- 与 0028（P-017 整块快照）并存：0028 是兜底，本表是原位内联。
create table if not exists question_inline_figures (
  id varchar(36) primary key default gen_random_uuid(),
  user_id varchar(36) not null references users(id) on delete cascade,
  source_type varchar(12) not null check (source_type in ('netdisk', 'library')),
  source_id varchar(64) not null,
  object_index integer not null,
  seq integer not null,
  char_offset integer not null,
  kind varchar(8) not null check (kind in ('formula', 'figure')),
  storage_key text not null,
  width integer not null,
  height integer not null,
  size_bytes bigint,
  page_index integer,
  source_revision char(64) not null,
  engine_version varchar(16) not null,
  built_at timestamptz not null default now()
);

create unique index if not exists question_inline_figures_obj_idx
  on question_inline_figures (user_id, source_type, source_id, object_index, seq);

create index if not exists question_inline_figures_src_idx
  on question_inline_figures (source_id, object_index);

comment on table question_inline_figures is
  'P-018：题干内联图/公式。一张图一行，按 (source, object_index, seq) 有序拼回题干。';
comment on column question_inline_figures.char_offset is
  '相对该题 stem_text 起点的字符偏移；前端在此处切开、插入图片。定位失败不入库。';
comment on column question_inline_figures.kind is
  'formula=行内公式（PDF IMAGE bbox 裁切）；figure=几何图（docx 原图，独占一行）';
