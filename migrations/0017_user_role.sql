-- ============================================================
-- 0017: users.role —— 正式管理员体系（OPS-18 R-技术-08 彻底方案）
--
-- 背景：全局表 knowledge_articles（AI 对话知识库，内容直接进 system prompt）
-- 的写操作此前用 env 白名单 CHAT_ADMIN_IDS 兜底，两个硬伤：
--   1) 未配置白名单时门禁**直接放行**（只打 warn）⇒ 部署漏配 = 门禁失效；
--   2) 白名单是外部配置，改一次要动 .env.secrets + 重跑 encrypt-env + 重启，
--      且无法表达「谁是管理员」这个业务事实。
--
-- 本迁移把管理员身份落进数据：users.role ∈ ('user','admin')。
-- 之后 requireAdmin() 只认 role，CHAT_ADMIN_IDS 降级为迁移期兼容（打 warn）。
--
-- ⚠️ 约定：
--   - 默认 'user'，历史行全部自动填 'user'（含匿名用户，匿名永不可能是管理员）；
--   - 角色变更最多 60s 生效（user-context 有 60s 用户缓存，见 DD-13）；
--   - 提权只能走脚本/后台，不开放任何 API（不接受「自己给自己升管理员」的路径）。
-- ============================================================

alter table public.users
  add column if not exists role varchar(16) not null default 'user';

-- 值域约束：用 DO 块保证可重复执行（add constraint 不支持 if not exists）
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_role_check'
  ) then
    alter table public.users
      add constraint users_role_check check (role in ('user', 'admin'));
  end if;
end $$;

-- 管理员是最稀有的行，部分索引足够，几乎零成本
create index if not exists users_role_admin_idx
  on public.users (role) where role = 'admin';

comment on column public.users.role is
  '角色：user | admin。admin 可写全局表（knowledge_articles），见 GK-OPS-18 R-技术-08';

-- ------------------------------------------------------------
-- 首次提权（手动执行一次，把思傅的账号设为 admin）
-- 已知 id：cc6d7b10…（思傅账号）。这里不写死整串，按需在控制台执行下面任一句：
--
--   update public.users set role = 'admin' where id = '<你的 user id>';
--   update public.users set role = 'admin' where open_id = '<你的 openid>';
--   update public.users set role = 'admin' where device_id = '<你的 device id>';
--
-- 也可用脚本：node server/scripts/promote-admin.mjs --device-id dev_xxx
-- ------------------------------------------------------------
