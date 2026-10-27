-- 0018_user_ai_toggle.sql
-- 用户级「是否允许把内容发往第三方 AI」开关（OPS-18 R-合规-02 处置）
--
-- 背景：题干文本/图片会发给 ima（知识库检索）与 LLM 供应商（解题/对话）。
-- 对未成年人学习数据来说，"默认全部外发"不是合理缺省；改为：
--   默认 false = 仅本地（本机 OCR 侧车 + 本地题库，任何内容不出机器）
--   用户显式开启 = 才允许调用 ima / 联网检索 / 大模型
--
-- 设计要点：
--   1. `not null default false` —— 默认不开，新增账号天然是"仅本地"（fail-closed）；
--   2. 不加 check 约束以外的业务规则：开关是用户意愿，不是权限；
--   3. 幂等（add column if not exists），可重复执行。
--
-- ⚠️ 生效点：后端在 `requireAiEnabled()` 处拦截 AI 外发接口（403 / AI_DISABLED），
--    不是只靠前端藏按钮——前端藏按钮只是体验，不是控制。

alter table public.users
  add column if not exists ai_enabled boolean not null default false;

comment on column public.users.ai_enabled is
  '是否允许把题目内容发往第三方 AI（ima / 联网检索 / LLM）。默认 false=仅本地处理。';
