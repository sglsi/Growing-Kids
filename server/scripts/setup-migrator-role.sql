-- ============================================================================
-- 迁移专用低权限角色（#120）
-- ============================================================================
-- 背景：迁移连接串（.env.migrate 的 DATABASE_URL）此前直接用 postgres 角色——
-- 该角色在本项目近乎全权（建角色、改任何 schema），连接串一旦泄露代价极大。
-- 本脚本把「跑 migrations/*.sql」收敛到专用角色 migrator：
--   ① 只能操作 public schema（应用数据全在此）；
--   ② 对既有/未来对象自动授权给 anon / authenticated / service_role
--      （对齐 Supabase 对 postgres 建表的默认特权，REST 访问不受属主变更影响）；
--   ③ 既有 public 对象的属主移交给 migrator，使未来迁移里的 ALTER TABLE
--      （如 0011 的 ADD COLUMN）能以低权角色执行——DDL 需 owner，GRANT 不够。
--
-- 执行分两段（由 server 侧一次性 runner 自动完成，也可手工复现）：
--   [A] 以 postgres 执行：建角色 + schema/对象授权 + 属主移交；
--   [B] 以 migrator 本尊连接执行：设置自己的默认特权。
--   为什么拆两段：ALTER DEFAULT PRIVILEGES FOR ROLE X 与 SET ROLE X 都要求
--   执行者是 X 的成员；Supabase 的 postgres 不是 migrator 的成员，合并执行会
--   "permission denied to change default privileges / to set role"。
--
-- ⚠️ 2026-10-30 实施踩坑（复现前必读）：
--   ① [B] 段三条 ALTER DEFAULT PRIVILEGES（TABLES/SEQUENCES/ROUTINES）一条都不能少；
--      runner 切片务必用 indexOf('ALTER DEFAULT PRIVILEGES')——用 lastIndexOf 会只留
--      ROUTINES 一条，migrator 建的表/序列不会自动授权给 API 三角色。
--      验证法：pg_default_acl 中 migrator 应有 r/S/f 三条；建探针表查
--      has_table_privilege('service_role', 'public._probe', 'SELECT') 为 true。
--   ② 改 migrator 密码后，pooler（Supavisor）SCRAM 校验有子缓存：首次连接必报
--      "password authentication failed"，约 20–90s 后重试即通（失败不会无限延长缓存）。
--      runner 已带每 25s、最多 6 次的重试；手工执行时失败一次别急着重试密集轰炸。
--
-- 回滚（属主还 postgres + 删角色）：
--   DO $$ DECLARE r record; BEGIN
--     FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
--       EXECUTE format('ALTER TABLE public.%I OWNER TO postgres', r.tablename); END LOOP;
--     FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname='public' LOOP
--       EXECUTE format('ALTER SEQUENCE public.%I OWNER TO postgres', r.sequencename); END LOOP;
--   END $$;
--   REASSIGN OWNED BY migrator TO postgres;  -- 兜底
--   DROP OWNED BY migrator;                  -- 清授权（不动对象）
--   DROP ROLE migrator;
-- ============================================================================

-- ============================ [A] postgres 段 ============================

-- ① 角色本身（幂等）。密码由 runner 注入（__MIGRATOR_PASSWORD__ 占位符）。
--    紧跟 GRANT migrator TO postgres：属主移交（OWNER TO）与 SET ROLE 都要求
--    执行者是目标角色成员，Supabase 的 postgres 默认不是；事务结尾再 REVOKE 掉。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migrator') THEN
    CREATE ROLE migrator LOGIN PASSWORD '__MIGRATOR_PASSWORD__';
  ELSE
    ALTER ROLE migrator LOGIN PASSWORD '__MIGRATOR_PASSWORD__';
  END IF;
END
$$;
GRANT migrator TO postgres;

-- ② schema 级：能用、能建对象（不给数据库级 CREATE——不动其他 schema）
GRANT USAGE, CREATE ON SCHEMA public TO migrator;

-- ③ 既有对象全授权（迁移要 ALTER/INSERT 种子/删表重建）
GRANT ALL ON ALL TABLES IN SCHEMA public TO migrator;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO migrator;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO migrator;

-- ⑤ 属主移交：DDL（ALTER TABLE/REPLACE FUNCTION）需要 owner，仅 public schema
--    应用对象；可回滚（见文件头）。
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO migrator', r.tablename);
  END LOOP;
  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO migrator', r.sequencename);
  END LOOP;
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO migrator', r.sig);
  END LOOP;
END
$$;

-- 收尾：收回临时成员身份（属主已落位，后续 SET ROLE 不再需要）
REVOKE migrator FROM postgres;

-- ============================ [B] migrator 段 ============================
-- 以下须以 migrator 身份连接执行（见文件头说明）。默认特权按角色记忆，
-- 设一次永久生效，之后 migrator 建的任何表/序列/函数都自动带授权。

-- ④ 未来对象：migrator 建的表/序列/函数自动授权给 API 三角色
--    （Supabase 的默认特权挂在 postgres 上，migrator 建表不继承，必须显式设）
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT EXECUTE ON ROUTINES TO anon, authenticated, service_role;
