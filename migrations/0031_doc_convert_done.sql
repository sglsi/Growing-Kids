-- P-019 / D-024 阶段 1：老式 .doc 转换与正文补抽的扫描记账。
-- 目的：.doc 是转换产物，抽正文与后续抠图必须复用「同一次转换」的文字流；
--       记账表钉住该次转换的文字流哈希、docx 哈希与对象计数，供阶段 2 硬门与阶段 3 二次评审校对。
-- 只记事实与统计，不存二进制、不改其它表；转换产物不入库、不进 blob_objects。
create table if not exists doc_convert_done (
  user_id varchar(36) not null references users(id) on delete cascade,
  source_id varchar(64) not null,
  status varchar(12) not null check (status in ('ok', 'none', 'review', 'failed', 'too_big')),
  meaningful_chars integer not null default 0,
  text_sha256 varchar(64),
  docx_sha256 varchar(64),
  drawing_count integer not null default 0,
  object_count integer not null default 0,
  omath_count integer not null default 0,
  convert_ms integer not null default 0,
  bytes bigint not null default 0,
  engine_version varchar(24) not null,
  notes text,
  scanned_at timestamptz not null default now(),
  primary key (user_id, source_id)
);

create index if not exists doc_convert_done_status_idx on doc_convert_done (status);

comment on table doc_convert_done is
  'P-019：.doc 单次转换产物的扫描记账与文字流哈希钉子（阶段 2 双次转换对比 / 阶段 3 同源校对的事实来源）';
comment on column doc_convert_done.text_sha256 is
  '写入 netdisk_files.text_content 的那份文本的 sha256；阶段 3 抠图必须先校对，防 char_offset 静默错位。唯一合法的同源校对判据';
comment on column doc_convert_done.docx_sha256 is
  '仅供诊断追溯：D-024 双次转换预实验 12/12 显示 LibreOffice 每次转换的 docx 二进制都不同，文字流却 100% 一致 ⇒ 本列不得用作同源校对判据，也不可拿它判断重转是否等价';
comment on column doc_convert_done.status is
  'ok=有正文可索引；none=确认无文字层；review=50~199 字薄文本待人工复核（不进 question_objects）；failed=内容类失败；too_big=超上限未下载';
