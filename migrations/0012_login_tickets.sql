-- 0012: login_tickets 表 —— H5 扫码登录票据（多副本部署升级用）
--
-- 背景（思傅 2026-10-20 拍板「H5 扫码登录」）：电脑浏览器没有 wx.login，
-- H5 出二维码 → 手机微信扫码授权。当前云端为单机部署，票据用 NestJS
-- 进程内存（qr-login.service.ts，重启即失效、用户重扫即可），**不需要本表**。
--
-- 本文件为「未来上多副本部署」准备：多实例下内存票据不共享，需落库。
-- 届时把 QrLoginService 的 tickets Map 替换为对本表的 CRUD 即可，
-- 接口形态（createTicket/getStatus/authorize）已按表结构设计，无需改动 controller。
--
-- 执行方式（与 0011 相同）：Supabase Dashboard → SQL Editor → 粘贴运行。幂等可重跑。

CREATE TABLE IF NOT EXISTS public.login_tickets (
  token       text PRIMARY KEY,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'authorized', 'expired')),
  user_id     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '5 minutes'
);

-- 轮询查询按 token 主键即可；定时清理按过期时间扫
CREATE INDEX IF NOT EXISTS login_tickets_expires_idx
  ON public.login_tickets (expires_at)
  WHERE status = 'pending';
