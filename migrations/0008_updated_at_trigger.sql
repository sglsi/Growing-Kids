-- ============================================================
-- 0008_updated_at_trigger.sql · updated_at 自动刷新（库级治本）
-- ------------------------------------------------------------
-- 问题（2026-10-19 实测发现）：
--   所有表的 updated_at 只有 `default now()`，而 default **仅在 insert 时生效**。
--   update 时若不显式写 updated_at，字段永远停在创建时间。
--   → PATCH /api/chat/knowledge/:id 返回的 updated_at 与 created_at 完全相同，
--     前端「最后编辑时间」、缓存判断、增量同步都会失真。
--
-- 方案：库级 BEFORE UPDATE 触发器，统一刷新 updated_at。
--   好处一：代码层不必逐个记得写（chat.service 已漏，memory/timeline/questions 靠手写）；
--   好处二：任何客户端直连改库也保证正确；
--   好处三：动态扫描 public 下所有含 updated_at 列的表，将来新增表自动覆盖
--           （重跑本脚本即可）。
--
-- 幂等：create or replace function + drop trigger if exists，可反复执行。
-- ============================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- 为 public schema 下所有「已存在 updated_at 列」的普通表挂上触发器
do $$
declare
  t record;
begin
  for t in
    select c.relname as tab_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and exists (
         select 1 from pg_attribute a
          where a.attrelid = c.oid
            and a.attname = 'updated_at'
            and not a.attisdropped
       )
  loop
    execute format(
      'drop trigger if exists trg_set_updated_at on public.%I', t.tab_name
    );
    execute format(
      'create trigger trg_set_updated_at before update on public.%I
         for each row execute function public.set_updated_at()', t.tab_name
    );
    raise notice 'updated_at 触发器已挂载：public.%', t.tab_name;
  end loop;
end $$;

-- ---------- 校验：应列出所有被挂载触发器的表 ----------
-- select c.relname as table_name
--   from pg_trigger tg
--   join pg_class c on c.oid = tg.tgrelid
--  where tg.tgname = 'trg_set_updated_at'
--  order by 1;
