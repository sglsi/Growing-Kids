-- P-018 / D-021 补充：记录「已扫描过」的 docx 来源。
-- 目的：有些文档本身没有可内联的图/公式（纯文字说课稿等），如果不记账，
-- `not exists (question_inline_figures)` 永远为真，每轮都会把它重新下载、重转一遍。
-- 只记扫描事实与统计，不存二进制、不动其它表。
create table if not exists question_inline_done (
  user_id varchar(36) not null references users(id) on delete cascade,
  source_id varchar(64) not null,
  objects integer not null default 0,
  figures integer not null default 0,
  bytes bigint not null default 0,
  status varchar(12) not null check (status in ('ok', 'empty')),
  engine_version varchar(16) not null,
  scanned_at timestamptz not null default now(),
  primary key (user_id, source_id)
);

comment on table question_inline_done is
  'P-018：已扫描过的 docx 来源（含 0 图文档），避免重复下载与重复转换';
