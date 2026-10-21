-- 0013: mime_type 列宽 64 → 128
--
-- 根因（2026-10-21 真机排查发现）：docx 的 MIME
--   application/vnd.openxmlformats-officedocument.wordprocessingml.document
-- 长达 71 字符，超过 documents / library_docs 两表的 varchar(64) ⇒
-- 每次「导出打印 / 导出 Word」的记录入库都静默失败
-- （Error: value too long for type character varying(64)），
-- 表现为：文件生成了、能打开，但文档库/资料库里永远看不到这条记录。
-- PDF 的 MIME（application/pdf，15 字符）不受影响，故此前未暴露。
alter table documents    alter column mime_type type varchar(128);
alter table library_docs alter column mime_type type varchar(128);
