-- =============================================================================
-- D-045 / 样张闸 S1：3–5 份只读整题快照的候选池（纯 SELECT，零写入）
-- 依据：docs/reports/3-5份样张与图文同源复核闸-作业指导书-D044.md §2 / §4 S1
-- 执行：L3 `sudo -n -u gk -H` + psql "$DATABASE_URL" -t -A -q -f
--
-- 🔴 join 键以 doc-inline-shadow.mjs（D-042 已实跑 200 份）为准：
--    question_objects.source_id = netdisk_files.id（同 user_id），不是 fs_id。
-- 🔴 样本纪律：排除 D-034 的 20 个 source_id；不复用 t0-blind-v1（验收样本）。
-- 🔴 不输出题干原文、不输出 user_id、不输出完整归一文本，只落 id / 长度 / 层标。
-- 🔴 分层（D-045 定稿取 3 层，每层备选 5 条供去重选文档）：
--    S-a 含 OLE/VML 公式（doc_convert_done.object_count > 0）
--    S-c 纯文字长题（stem >= 200 且无 drawing / object 标记）
--    S-d 必含反例（归一后短题干 10–20 字，或含 U+FFFD 缺字形态）
-- =============================================================================

with excluded(source_id) as (
  values
    ('01257d4b-2673-4b1d-aaac-e906d5cb80a0'),
    ('1903e20c-6f40-40e2-89ea-77b44e2c4445'),
    ('1b26c142-6aa3-4e10-947e-3c5266136e74'),
    ('2cfc181b-91fd-4a64-ba4f-bce080ff4afa'),
    ('2fe35a1a-9b65-4d6b-8b62-0be4c78c7d3f'),
    ('3aaa2f28-1905-4ed6-9285-dcd5d9380b9b'),
    ('3fa09b56-0721-44da-aa3f-155e59099751'),
    ('41674ee5-24c0-43fe-8e83-2f38a83b08f9'),
    ('4321722e-9f92-4dd4-a529-de37508edc1b'),
    ('4a26c1e9-6a4a-483c-a5c9-76b1de058a54'),
    ('4e7f10ea-489d-4e6d-9da8-3016ec9decb8'),
    ('51a8aa7d-ee62-4f31-ab9d-92c851547dbb'),
    ('56774719-3676-4666-ab15-146afece1b97'),
    ('5bb8bde7-4c0c-4436-b328-6633a5ddc606'),
    ('5d0f2322-feb9-4931-ad14-1ed9ea67a83b'),
    ('6b3944e8-3620-4cdd-9f74-41a911aea53a'),
    ('896882ee-04e7-4b5f-bdde-df824feffea2'),
    ('8fe5c5ad-d78a-4a5a-ae78-8e6196b029cf'),
    ('e106cb26-e944-4d98-aa57-8a506b3db385'),
    ('eae70026-03fb-4bbe-91de-e0d2fc9091c3')
),
base as (
  select q.source_id::text                       as source_id,
         q.object_index                          as object_index,
         q.char_start                            as char_start,
         length(q.stem_text)                     as stem_len,
         q.has_solution                          as has_solution,
         (position(chr(65533) in q.stem_text) > 0) as has_replacement,
         n.id::text                              as doc_id,
         n.fs_id::text                           as fs_id,
         n.name                                  as doc_name,
         n.size_bytes::bigint                    as size_bytes,
         coalesce(d.drawing_count, 0)            as drawings,
         coalesce(d.object_count, 0)             as objects,
         length(coalesce(n.text_content, ''))    as total_len,
         md5(q.source_id::text || ':' || q.object_index::text || ':gk-sample-v1') as ord
    from question_objects q
    join netdisk_files n
      on n.id = q.source_id and n.user_id = q.user_id
    join doc_convert_done d
      on d.source_id = n.id and d.user_id = n.user_id
   where n.ext = 'doc'
     and n.text_status = 'ok'
     and d.status = 'ok'
     and q.link_status = 'ok'
     and q.has_solution
     and length(q.stem_text) >= 10
     and q.source_id not in (select source_id from excluded)
     -- 资源纪律：跳超大文件，避免单份拖垮 L3（D-021 长尾教训）
     and n.size_bytes between 10000 and 8000000
),
layered as (
  select *, case
      when objects > 0 then 'S-a'
      when stem_len >= 200 and objects = 0 and drawings = 0 then 'S-c'
      when (stem_len between 10 and 20) or has_replacement then 'S-d'
      else null
    end as layer
  from base
),
ranked as (
  select *, row_number() over (partition by layer order by ord) as rn
  from layered
  where layer is not null
)
select json_build_object(
  'layer', layer, 'rn', rn, 'source_id', source_id, 'object_index', object_index,
  'char_start', char_start, 'stem_len', stem_len, 'has_solution', has_solution,
  'has_replacement', has_replacement, 'doc_id', doc_id, 'fs_id', fs_id,
  'doc_name', left(doc_name, 40), 'size_bytes', size_bytes,
  'drawings', drawings, 'objects', objects, 'total_len', total_len, 'ord', ord
)::text
from ranked
where rn <= 5
order by layer, rn;
