-- 0011: users.device_id 列 —— 匿名身份按设备持久化（修复「每次新匿名身份」）
--
-- 背景：匿名 user 此前仅靠请求头 X-User-Id 识别，TTL 1 天。过期被 maintenance
-- 清理后，前端带着失效 id 请求 → 后端静默建新匿名用户 → 旧数据「看不见」，
-- 存储/查询全乱（思傅 2026-10-20 实测反馈）。
-- 方案 A（思傅拍板）：前端生成一次 deviceId 永存 storage，请求带 X-Device-Id；
-- 后端按 device_id 找/建匿名 user 并滑动续期，实现「同一设备 = 同一身份」。
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS device_id text;
CREATE UNIQUE INDEX IF NOT EXISTS users_device_id_key
  ON public.users (device_id) WHERE device_id IS NOT NULL;
