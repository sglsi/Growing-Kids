-- 0015_library_netdisk_path.sql
-- 资料库 → 百度网盘副本的路径登记（思傅 2026-10-24 定：资料库归到网盘 /学生/GrowingKids资料库）
--
-- 设计取舍（重要，改前先读）：
--   主存储**仍是本地/Supabase**（file_key 不变），网盘只是**归档副本**。
--   理由：网盘读取要「取 dlink → 带 UA 下载」，dlink 只有 8 小时有效期且限速，
--         若把 file_key 直接换成网盘路径，小程序里每次预览/打开文档都要走一次网盘 API，
--         首屏与「打开文档」体验会明显退化。
--   因此：小程序内秒开走主存储；家长在电脑网盘里看归档副本；两者用 netdisk_path 关联。
--
-- ⚠️ 同步是 best-effort：网盘不可用时只记日志，绝不让「保存资料」失败。

alter table library_docs add column if not exists netdisk_path text;

comment on column library_docs.netdisk_path is
  '百度网盘归档副本的绝对路径（null=未同步；形如 /学生/GrowingKids资料库/xxx.pdf）';

create index if not exists library_docs_netdisk_idx
  on library_docs (user_id, netdisk_path)
  where netdisk_path is not null;
