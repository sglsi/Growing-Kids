# GK-ADD-07 安全与隐私设计说明书

> 编号：GK-ADD-07 ｜ 版本：v1.0 ｜ 日期：2026-10-27 ｜ 状态：**正文完成**
> 读者：全体 / 合规 ｜ 上游：SRS-01、ADD-04、ADD-05 ｜ 下游：QA-16（发布清单）、DD-09、OPS-18
> 定位：安全基线与合规口径。**发布前必读**。本文不复制密钥值，只登记密钥的存放位置与轮换方式。

---

## 1. 安全目标与威胁模型

### 1.1 受保护资产

| 资产 | 内容 | 泄露后果 | 等级 |
|---|---|---|---|
| **儿童学习数据** | 作业照片、错题题干/答案、成长记录（含儿童影像） | 儿童隐私泄露，不可逆 | 🔴 最高 |
| **对象存储文件** | 原件与派生档（original / display / thumb） | 同上（图里可能含姓名、学校、班级） | 🔴 最高 |
| **第三方凭据** | service_role key、`DATABASE_URL`、`WX_SECRET`、LLM / ima Key | 整库被读被删、登录态被伪造、成本被盗刷 | 🔴 最高 |
| 用户身份 | `openid`、`device_id`、昵称头像 | 账号被冒用 | 🟠 中高 |
| 全局配置 | `knowledge_articles`（影响所有用户的 AI 人设） | prompt 注入，污染全体回答 | 🟠 中高 |

### 1.2 威胁清单与评级

| # | 威胁 | 现状处置 | 残余风险 |
|---|---|---|---|
| T1 | **越权读取他人数据**（IDOR） | ① 所有查询强制 `.eq('user_id', userId)`；② 静态门禁 `check-isolation.mjs`；③ 身份令牌防伪造头 | 已缓解。漏写仍可能发生 ⇒ 门禁是启发式，需人工确认告警 |
| T2 | **伪造身份头**（直接带他人 `X-User-Id`） | 服务端签发 `X-Auth-Token`（HMAC-SHA256，TTL 30 天，定长比较） | 过渡期仍兼容裸 `X-User-Id`（每次 warn），待前端全量升级后禁用 |
| T3 | **密钥随部署包泄露** | 敏感项拆 `.env.secrets` → AES-256-GCM 加密 → 只传密文，容器启动还原 | 派生因子是公开的 AppID ⇒ **防扫描不防定向攻击**；且 `WX_SECRET` 已明文上传过，**必须轮换** |
| T4 | 小程序包反编译 | 包内**无任何密钥**：不直连 Supabase、不直连 LLM，一律走后端 `/api` | 接口可被直接调用 ⇒ 靠身份令牌 + 配额约束 |
| T5 | 第三方数据传输 | 送 ima / LLM 的仅题干文本与图片；内容安全检测送微信 | 需在使用手册中明示（第 7 章） |
| T6 | **配额滥用 / 成本攻击** | 用户级配额（双阈值 + 月流量）、SR 泳道并发闸、排队降级 | `QUOTA_MODE` 默认 `warn`（不阻断），见第 8 章 |
| T7 | 临时用户数据滞留 | 每小时清理过期匿名用户；`temp` 文件 24h 孤儿 GC | 已覆盖 |
| T8 | 全局表被任意篡改 | `requireAdmin()` 读 `users.role`（0017）保护知识库四个写端点 | **已闭环**：非 `admin` 一律 403（fail-closed）；漏配=没人能用，不是放行 |

### 1.3 安全目标在本项目的具体含义

| 目标 | 具体含义 |
|---|---|
| **机密性** | 一个账号 = 一个孩子的数据空间，跨 `user_id` 的读取在任何接口都不该发生；密钥不出服务端 |
| **完整性** | 答案附件内嵌在题目记录里（`content` jsonb），物理上杜绝"答案挂到别的题上"；全局知识库写操作受控 |
| **可用性** | 外部依赖（ima / LLM / 微信接口）不可用时不阻断主链路——best-effort 放行，但**必须 console.error 打全错** |
| **可审计** | 关键动作（登录、迁移、删除、导出）留日志；安全事件登记 OPS-18 并复盘 |

---

## 2. 身份分层与认证

### 2.1 三态身份

| 状态 | 产生方式 | 有效期 | 清理 |
|---|---|---|---|
| **授权用户**（微信登录） | `code2session` → openid → 找/建正式 user | 长期 | 不清理 |
| **匿名**（免注册） | 无身份头时自动创建；或按 `X-Device-Id` 找/建 | 1 天，**每次请求滑动续期** | `cleanupExpiredAnonymous` 每小时清过期号 |
| **临时** | 同上（临时即匿名，24h 口径） | — | — |

匿名用户登录后会**整体迁移**到正式账号（见 2.3），不会丢数据。

### 2.2 身份解析优先级（`UserContextMiddleware`）

```
1) X-Auth-Token   —— 服务端签发令牌，验签通过才认（推荐，防伪造）
2) X-User-Id      —— 旧版裸 id，过渡期兼容（每次 console.warn）
3) X-Open-Id      —— 微信 openid（扫码登录路径）
4) X-Device-Id    —— 设备锚点，找/建匿名身份（「同一设备 = 同一身份」）
5) 都没有         —— 建匿名 user（/api/auth/* 与 /api/health 除外，避免登录产生垃圾账号）
```

- **滑动续期**：每个响应都回传 `X-User-Id` 与续签后的 `X-Auth-Token`，前端覆盖本地 ⇒ 30 天不过期。
- **过期匿名视为失效**：匿名 id 已过 `expire_at` 则继续按设备/匿名重建，避免"前端带失效 id 被静默当合法身份，数据全进新号、旧号成孤儿"。
- **用户对象内存缓存 60s**（`USER_CACHE_TTL`）：中间件对每个请求都查一次 users 表（新加坡 RTT ~1.5s）曾是"点开题目要等"的后端主因；只缓存非 null 且下游只消费 `id / is_anonymous / expire_at`，一致性无风险。

### 2.3 微信登录链路

```
wx.login() → code（5 分钟、一次性）
   ↓ POST /api/auth/login { code, anonymous_id, profile, device_id }
code2Session(appid, secret) → openid
   ↓
findOrCreateByOpenId(openid, deviceId)   ← 正式账号绑定设备（本地 user_id 丢失可凭设备找回）
   ↓
updateProfile（昵称/头像，首次有值才写）
   ↓
migrateAnonymousData：把 anonymous_id **以及该 device_id 名下所有历史匿名号**的数据
                      整体 update user_id 到正式账号（保留原 id、外键不破），
                      随后删除匿名空壳账号
   ↓
返回 { user, migrated } ；登录/扫码授权接口的**响应体**带 auth_token
```

⚠️ **失败时降级为匿名而非阻塞**：`code2Session` 失败（40029 无效 code、45011 频率限制、-1 系统繁忙）抛 `BadRequestException`，前端提示后仍可继续用匿名身份，不阻断收集动作。

⚠️ **迁移后同名学科会撞唯一约束** `(user_id, name)`：迁移逻辑会 `dedupeSubjects` 保留最早创建的、删除重复残留。

### 2.4 扫码登录（H5）

- ⚠️ **2026-10-27 订正：票据已落库**（`QR_TICKET_STORE=auto` 默认 db 优先，`db` 强制不降级，`memory` 仅本地开发）。原口径「走进程内存、单机够用」已作废——理由是多副本时 `/authorize` 打 A、`/status` 轮询打 B 就查不到票，表现为"扫了没反应"而两端日志都正常，极难排查（OPS-18 `R-技术-10` 第 2 项）。
- 流程不变：`POST /api/auth/qr-login/ticket` 出票 → H5 轮询 `GET /api/auth/qr-login/status?token=` → 手机端 `POST /api/auth/qr-login/authorize` 授权。
- 票据一次性、5 分钟过期（`status pending/authorized/expired`）。**安全语义靠 token 本身**：24 字节随机（`randomBytes(24).toString('base64url')`），不可猜、不可枚举，所以查询按 `token` 主键寻址而非 `user_id`。
- 运维判读：`GET /api/health/runtime` 的 `ticketStore` 显示是否已落库；显示降级到 memory 说明表不可用（未跑 0012 / 网络异常）。

### 2.5 前端身份切换纪律

**身份切换点必须 `clearAllCache()`**。缓存按 `userId` 隔离，切换后不清理会串号（看到上一个账号的数据）。登出时 **`gk_auth_token` 与 `gk_user_id` 一起清**——只清 uid 不清令牌会"登出不成功"。

---

## 3. 授权与数据隔离

### 3.1 RLS 未启用 ⇒ 代码层是唯一隔离手段

⚠️ **`migrations/0002_fresh_schema.sql` 里的 RLS 全部为注释状态**（138~153 行预留了 4 条策略，`0002` 之后新建的表一条都没有）；后端以 **service_role** 访问，**service_role 一律绕过 RLS**。

⇒ **代码层 `.eq('user_id', userId)` 是唯一隔离手段。**

强制规范（代码评审自查项，逐条）：

1. 所有 `select` 必须带 `.eq('user_id', userId)`——由 `check-isolation.mjs` 静态门禁把关（见 3.2）；
2. 所有 `update` / `delete` 必须带 `.eq('user_id', userId)`；
3. 所有 `delete` 必须 `.select('id')` **校验返回行数**——否则越权删除会"返回 200 但一行没删"，无日志无报错，完全不可察觉；
4. 所有 `insert` 的 `user_id` **由后端从身份令牌解析后强制写入**；`Create*Dto` 一律不含 `user_id` 字段（前端传了也不认）；
5. 全局表（无 `user_id` 列）的**写操作**必须走 `requireAdmin()`；
6. 恢复类接口（`restore`）同样要带 `user_id` 条件——曾漏过（`timeline.service.ts` 第 292 行注释）。

### 3.2 静态门禁 `check-isolation.mjs`

扫描 `server/src` 下所有 `.from()` 调用点，向后看 12 行内必须出现 `.eq('user_id'`，否则 exit 1。当前 **113 处调用点全通过**（2026-10-27 实测；`answer_cache` / `ocr_results` 接入后由 93 增至 108，扫码票据落库后 `login_tickets` 入白名单再增至 113）。

**四类豁免（有意设计，逐条有据，不得为过检而删检查）**：

| 类型 | 内容 | 理由 |
|---|---|---|
| 表级白名单 | `knowledge_articles` / `blob_objects` / `ocr_results` / `health_check` / `users` | 全局表按内容寻址/按 id 限定，不属任何用户；`ocr_results` 表内**无 `user_id` 列**，键含内容指纹 + 引擎版本，跨用户共享（ADD-05 第 4 章） |
| 文件级白名单 | `maintenance.service.ts` / `tier-stats.service.ts` / `supabase-db.provider.ts` | cron 全表扫描、容量统计、通用出口（where 由调用方给） |
| insert / upsert 链 | 隔离靠 payload 里的 `user_id` | 由 code review + DTO 不含该字段共同保证；**upsert 额外要求**窗口内可见 `user_id`（payload 或 `onConflict`），否则按缺口报出——upsert 语义上可覆盖他人行，比 insert 危险 |
| 源码级 | `// check-isolation-ignore: 理由` | **理由必须写清**（例：`auth.service.ts` 的 `dedupeSubjects` 按同用户查询结果删除残留） |

跑法：`pnpm --filter server check:isolation`（提交前 + CI 各跑一次）。

⚠️ 它是**启发式告警门禁**（向后看 12 行 + 常量表名还原），报出的点需人工确认；发现漏报先改脚本。

### 3.3 文件访问

| 驱动 | URL 形态 | 安全性 |
|---|---|---|
| `local`（默认） | `http://127.0.0.1:<port>/api/storage/files/<key>` | 走后端静态路由；`resolveLocal()` 做路径逃逸防护（`../` 拒绝） |
| `supabase` + 公共桶 | 公网直链，**URL 永久有效、无签名过期** | 依赖 **key 不可猜**（形如 `blobs/xx/<64位 sha256>/variant`）+ 不在前端暴露列表 |
| `supabase` + 私有桶 | 签名 URL（86400s） | `SUPABASE_STORAGE_PUBLIC=false` 开启 |

⚠️ **当前默认 `STORAGE_DRIVER=local` + `SUPABASE_STORAGE_PUBLIC=true`**。公共桶的"URL 永久有效"是已知取舍：好处是省一次签名 RTT（列表页几十张图差别明显），代价是拿到 URL 的人可永久访问。改造为私有桶 + 签名 URL 的评估已登记 **OPS-18**。

⚠️ **后端代理下载** `/api/storage/files/{file_key}` 同样必须校验归属（文档预览走此路径），不能因为"key 不可猜"就跳过校验。

### 3.4 数据共享授权模型（**预留，本期不实现**）

需求口径（SRS-01 第 2.4 节，思傅定稿）：**家长 / 孩子 / 朋友在授权范围内共享本人名下数据**。本期**一律一人一库、全量按 `user_id` 隔离，共享不实现**。

预留设计要点（实现时照此展开）：

- 共享 = 引入「数据空间 + 成员 + 角色」**授权行，不复制数据**（复制 ⇒ 两份数据必然漂移）；
- 角色最小集：**只读**（查看/导出）/ **可编辑**（增删改）/ **可管理**（改成员与权限）；对外共享默认只读；
- 随时可撤回，关键操作留痕可审计；
- ⚠️ **导出物出系统后不再受授权约束** ⇒ 导出需显式确认，姓名/学校/班级等身份信息**默认不写入导出物**；
- ⚠️ **一旦实现共享，本章首条前提即被打破**：可见性 = 「本人数据空间 ∪ 被授权空间」，`.eq('user_id')` 不再成立 ⇒ 必须同步改造为「数据空间可见性」判定（收口到**一个函数**），并重新评估 RLS。改动面大，登记 **OPS-18**。

---

### 3.1′ RLS 重新评估（2026-10-24，结论：**不启用**，改用静态门禁兜底）

> 本节是 3.1 的决策依据留档。

**现状**：`migrations/0002_fresh_schema.sql` 138~153 行预留了 4 条策略（timeline_items / subjects / library_docs / documents），**全部处于注释状态**；其余表没有策略。

**为什么不启用（四条理由，逐条可验证）**：

| # | 理由 |
|---|---|
| 1 | **生效前提不成立**：RLS 只对「anon key + 用户 JWT 走 PostgREST」的路径生效。本项目所有查询走后端 NestJS + service_role，而 **service_role 一律绕过 RLS** ⇒ 启用后不拦截任何现有查询，纯装饰 |
| 2 | **策略写不出来**：策略谓词依赖 `auth.uid()`，但本项目登录体系是自定义的（微信 code2session + 内存票据），**没有 Supabase Auth JWT** ⇒ `auth.uid()` 恒为空，只能写出 `using (false)`（全拒）或全放 |
| 3 | **覆盖面不增反减**：预留策略只覆盖少数几张表。补全需逐表写、新表必须同步补，漏一张就是一个洞——维护负担与代码层 `.eq('user_id')` 完全相同，却多一层"看起来安全"的错觉 |
| 4 | **与共享模型冲突**：一旦实施共享，可见性 = 「本人空间 ∪ 被授权空间」，策略要 join 授权表判断，可读性与查询性能都差；把该判定放在应用层**一个收口函数**里更可控、可测试、可灰度 |

**替代方案（已落地）**：即 3.2 的静态门禁。

**本次同步修掉的两个授权缺口**：

1. **越权读（已修）**：`chat.service.ts` `sendMessage` 取会话历史只按**客户端可控的 `session_id`** 过滤 ⇒ 传入他人 session_id 即可读走该会话全部历史，并作为多轮上下文注入 LLM（数据外泄面）。已补 `.eq('user_id', userId)`。
2. **全局表零鉴权（已关闭）**：`knowledge_articles` 无 `user_id` 列，内容直接拼进 system prompt，而 `/chat/knowledge` 四个 CRUD 端点此前无任何身份校验 ⇒ 任意请求可操纵所有用户的助手人设。**2026-10-27 已彻底解决**：`users` 加 `role` 列（迁移 `0017`，`check in ('user','admin')`，默认 `user`），`requireAdmin()` 改为 **fail-closed**——非 `admin` 一律 403，**漏配不再是放行**。提权唯一入口 `server/scripts/promote-admin.mjs`（不开放 HTTP 接口，避免自提权）。`CHAT_ADMIN_IDS` 降级为迁移期兼容。详见 OPS-18 `R-技术-08`（已关闭）。

**身份头伪造的处置（2026-10-24 落地，服务端签发票据方案）**

`X-User-Id` 无签名 ⇒ `.eq('user_id')` 可被伪造 header 绕过，此前「数据隔离」只防误操作/IDOR、不防伪装身份。小程序前端不能持有签名密钥（JS 可被提取），所以采用**服务端签发票据**而非前端 HMAC：

- `server/src/shared/auth-token.ts`：格式 `v1.<userId>.<expSec>.<sig>`，`sig = HMAC-SHA256(payload, AUTH_TOKEN_SECRET)` 取 hex 前 40 位，TTL 30 天，`timingSafeEqual` 定长比较防时序侧信道；
- 登录/扫码授权接口在**返回体**带 `auth_token`；前端 `buildHeaders` 带 `X-Auth-Token`，登出时**令牌与 uid 一起清**；
- **过渡策略**：`AUTH_TOKEN_SECRET` 未配置（或长度 < 16）⇒ 不签不验，行为与改造前一致；配置后 `X-User-Id` 仍兼容但每次 warn，待前端全量带上令牌后再禁用（登记 **OPS-18 R-技术-09**）；
- ⚠️ 边界：令牌防"伪造他人身份"，不防"自己的令牌被拿走"（设备丢失场景）；更彻底的方案是 Supabase Auth JWT，与 RLS 议题合并评估。

---

## 4. 密钥清单与存放

⚠️ **本文只登记位置与轮换方式，不写密钥值。**

| 名称 | 用途 | 存放位置 | 入部署包 | 轮换周期 / 触发条件 | 已暴露 |
|---|---|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | **绕过 RLS 整库读写** | `server/.env.secrets` | 密文（`.env.secrets.enc`） | 怀疑泄露即 Rotate；生产与开发分 key | 否 |
| `DATABASE_URL` | 整库 DDL+DML（仅迁移用） | `server/.env.migrate`（本地专用） + `.env.secrets` | **否**（迁移账号不随包） | 同上；pooler 改密码后首次连接必失败，20–90s 重试 | 否 |
| `WX_SECRET` | `code2session`、内容安全 access_token | `server/.env.secrets` | 密文 | 🔴 **正式版发布前必须轮换**（曾随包明文上传） | **是** |
| `WX_APPID` | 公开标识；兼作加密派生因子 | `.env`（可公开） | 是 | 无需轮换 | 公开值 |
| LLM API Key（扣子 / 混元 / DeepSeek） | AI 答案与对话 | `server/.env.secrets` | 密文 | 按供应商策略；泄露即换 | 否 |
| `IMA_CLIENT_ID` / `IMA_API_KEY` | ima 知识库检索（有日配额） | `server/.env.secrets` | 密文 | 同上 | 否 |
| `AUTH_TOKEN_SECRET` | 身份令牌 HMAC 签名（≥16 字符） | `server/.env.secrets` | 密文 | 轮换 ⇒ 全体用户重新登录（等效登出） | 否 |
| `CHAT_ADMIN_IDS` | 全局知识库写白名单（**已降级为迁移期兼容**，主门禁改为 `users.role`） | `server/.env.secrets` | 密文 | 可下线 | 否 |
| `BAIDU_*`（网盘 OAuth / refresh_token） | 资料库归档同步 | `.env.secrets` | 密文 | refresh_token 变更即重跑加密 | 否 |
| 私钥 `key/private.appid.key`（如有） | 微信支付等 | 仓库外（gitignore） | **否** | — | — |

### 4.1 `WX_SECRET` 轮换步骤（正式版发布前必做）

1. mp 后台 → 开发管理 → 开发设置 → **重置 AppSecret**；
2. 把新值写进 `server/.env.secrets` 的 `WX_SECRET`；
3. **重跑加密**：`node server/scripts/encrypt-env.mjs --verify`（不重跑 ⇒ 线上还是旧密钥，且旧密钥视为已泄露）；
4. 重启后端（或走 wake-server 保活链路重新拉起）；
5. 验证：`POST /api/auth/login` 能拿到 openid；内容安全日志无 `40001`。

### 4.2 通用红线

1. `.env` / `.env.secrets` / `.env.migrate` **永不进版本库**（`.gitignore` 已覆盖 `.env`、`.env.*`，仅 `!.env.example` 例外）；提交前 `git status --short` 扫一眼；不放心就 `git log --all --oneline -- server/.env`，有输出说明已泄，立即吊销 + 清历史；
2. 新增环境变量**同步改 `.env.example`**，只写占位符；
3. 需要帮忙排查时把值打码（`sed -E 's/(=.{6}).*/\1.../'`），**不贴聊天/工单/截图**；
4. 生产环境走平台密钥管理（环境变量面板 / SSM），文件不落盘、不进镜像。

---

## 5. 部署包加密方案

### 5.1 背景

平台 sites 部署**打包 `server/` 全目录**，且排除名单不含 `.env*`；平台无 env 注入能力 ⇒ 敏感项必须脱离明文。

### 5.2 方案

```
敏感项集中到 server/.env.secrets
   ↓ node server/scripts/encrypt-env.mjs [--verify]
AES-256-GCM 加密（密钥 = scrypt(AppID | 'growing-kids/.env.secrets/v1', 随机盐)，N=2^15 约 100ms）
   ↓ 产出 server/.env.secrets.enc（只传密文）
部署：startCmd 覆盖为 `node scripts/decrypt-env.mjs && npm run start`（容器内还原）
打包前后：node server/scripts/deploy-pack.mjs pack | restore | status
         把本地专属文件挪到 <项目根>/.deploy-staging/，并把 OCR 引擎等依赖复制进 server/ 一起上传
```

### 5.3 纪律

- ⚠️ **改了 `.env.secrets` 必须重跑 `encrypt-env.mjs`**（含 `refresh_token` 变更、密钥轮换）；
- `pack` 后必须 `restore`，否则本地 OCR 引擎等被清理；`pack` 前会检查暂存区是否残留，残留则报错终止；
- `--verify` 会加密后立即解密自检（不写回明文），推荐每次都带。

### 5.4 边界声明（不要高估它的防护力）

派生因子 **AppID 是公开的**（小程序包体内本就含它）。该方案防的是**包被随手翻看 / 被自动扫描器捞 key**，**防不住平台运维与定向攻击**。真正的防护是**轮换密钥本身**——这就是 `WX_SECRET` 必须轮换的原因。

---

## 6. 前端与客户端安全

| 项 | 约定 | 状态 |
|---|---|---|
| 包内无密钥 | 不直连 Supabase（无 anon key）、不直连第三方 LLM，一律走 `/api` | ✅ 已核实 |
| 上传/下载超时与兜底 | 超时有兜底提示，**不向用户暴露内部地址**（如 `127.0.0.1:3001`、对象存储直链） | ✅ |
| 域名白名单 | 生产环境必须在 mp 后台配置 `request` 合法域名（`urlCheck` 仅开发环境关闭） | ⚠️ 发布前人工确认 |
| 日志脱敏 | `file_key` 可打；**签名 URL、token、openid 不打** | ✅ |
| 隐私授权 | `app.config.ts` 开 `__usePrivacyCheck__`；全局 `onNeedPrivacyAuthorization` 弹窗，同意键必须是**原生 button + `openType=agreePrivacyAuthorization`**（View 伪造无效） | ✅ 已落地，仍需 mp 后台勾选（见第 7 章） |
| 内容安全 | UGC 入口（提问、知识库文章）过 `security.msgSecCheck` v2 | ✅ 已落地（见 7.4） |

---

## 7. 儿童隐私与内容合规

### 7.1 数据最小化

只收集实现功能必需的数据：作业照片与识别文本、学科与掌握状态、成长记录正文与媒体。**不收集**精确位置、通讯录、设备标识符以外的信息（`device_id` 由前端生成并仅用于身份锚定）。

### 7.2 留存周期（与用户手册口径一致）

| 数据 | 留存 |
|---|---|
| 授权用户数据 | 长期保存，直到用户删除 |
| 匿名用户数据 | 1 天（滑动续期），过期后由每小时任务清理 |
| 软删条目 | 7 天宽限期后可恢复，之后文件被 GC 回收，**不可恢复** |
| `temp` 中间文件 | 24 小时孤儿 GC |

### 7.3 用户权利

| 权利 | 实现 |
|---|---|
| 查看 | 收件箱 / 复习本 / 资料库 / 成长记忆列表 |
| 导出 | 导出 Word（含 ids 白名单 + 是否含答案）、合成 PDF/Word（默认不带答案） |
| 删除 | 条目软删（7 天窗口）；**账号级删除需人工流程**（联系开发者，走 `users` 级联删除）⇒ 登记 OPS-18 待办 |

### 7.4 第三方数据传输

| 接收方 | 传输内容 | 目的 | 最小化措施 |
|---|---|---|---|
| ima 知识库 | 题干文本 | 检索答案 | 只送题面，不送学生姓名/学校 |
| LLM 供应商（扣子 / 混元 / DeepSeek） | 题干、错答、多轮对话上下文 | 生成解析与讲解 | 同上；上下文窗口截断 |
| 微信 `security.msgSecCheck` | UGC 文本（提问、知识库文章） | 内容安全合规 | 仅 UGC 入口；AI 回复默认不检（`CONTENT_CHECK_AI_REPLY=true` 才开） |
| 百度网盘 | 资料库文件副本 | 家长侧归档 | `LIBRARY_NETDISK_SYNC=true` 才开；**只写不读** |

⚠️ **msgSecCheck v2 强制要求 openid**：不带会返回 `40003 invalid openid` ⇒ 检测形同虚设。实现按 `userId` 换 `users.open_id`（缓存 5 分钟）；**匿名（open_id 为 NULL）跳过并只 warn 一次**。

### 7.5 内容合规

- AI 输出标注"AI 生成，仅供参考 / 未经核实"，**不冒充官方答案**；
- 检索结果带来源（`answer_refs`），可溯源；
- 检测为 `reject` 的内容不放行；`risky` 按业务策略处理。

### 7.6 合规待办

| 待办 | 状态 |
|---|---|
| 正式《隐私政策》文本并在小程序中展示（微信平台通常要求） | ⬜ **待确认 / 待办** |
| mp 后台「用户隐私保护指引」**勾选相册 / 摄像头** | ⬜ **必须人工做**：不勾选则 `getPrivacySetting` 恒返回 `needAuthorization=false`，**用户点了同意也无效** |
| 账号级删除的自助入口 | ⬜ 待办（登记 OPS-18） |

---

## 8. 配额滥用与成本防护

详版见 **DD-09 第 9 章**。本节只列安全视角的要点。

| 资源 | 风险 | 防护 |
|---|---|---|
| **ima 日配额** | 500 次/天档位下，一道题 2~10 次调用 ⇒ 一天只能搜几十道；**零命中也扣、不可退避** | `answer_cache` 落库持久化（成功结果默认永久；失败/零命中 12h 短期记忆），**同一题同一 mode 永不重复消耗** |
| **LLM 调用** | 长上下文/多轮放大成本 | 上下文窗口截断；多轮历史条数上限 |
| **超分（SR）并发** | 算力密集，并发打满 ⇒ 全体排队 | SR 泳道并发闸 + 排队降级提示（见 `docs/reports/sr-rate-limit.md`） |
| **OCR 重复识别** | 同一份文件反复识别烧算力 | `ocr_results` 全局缓存（键含 `mode` + `engine_version`） |
| **存储** | 无限上传 | `user_quota` **双阈值**（字节 / 张数先到先触发）+ 月流量兜底 |

**配额档位**（`quota-policy.ts`）：

| 档位 | 字节 | 张数 | 月流量 |
|---|---|---|---|
| `anonymous` | 20 MB | 10 | 50 MB |
| `free`（默认） | 500 MB | 300 | 200 MB |
| `member` | 10 GB | 5000 | 2 GB |
| `family` | 50 GB | 不限 | 10 GB |

⚠️ `QUOTA_MODE` 取值 `off` / `shadow` / `warn` / `block`，**非法值一律退回 `warn`（默认不阻断）**——避免误伤存量用户。生产环境建议 `block`。

---

## 9. 发布前安全清单

> 逐条可勾选，QA-16 引用。每条都要有证据（命令输出或截图）。

- [ ] 🔴 **轮换 `WX_SECRET`** 并重跑 `encrypt-env.mjs --verify`（第 4.1 节 5 步）
- [ ] 小程序包内无明文密钥：`grep -r "service_role\|sk-\|SECRET" dist/` 无输出
- [ ] 部署包内无明文：确认 `server/.env.secrets` 已被 `deploy-pack pack` 挪走，只传 `.enc`
- [ ] `.gitignore` 覆盖 `key/`、`/assets/`、`*.env*`；`git status --short` 干净
- [ ] mp 后台：request 合法域名已配置；**生产 `urlCheck` 打开**；`packOptions.ignore` 不含 `./assets`（TabBar 图标）
- [ ] mp 后台「用户隐私保护指引」**已勾选相册 / 摄像头**
- [ ] `AUTH_TOKEN_SECRET` 已配置（≥16 字符），且前端全量带 `X-Auth-Token`（日志里 `X-User-Id` warn 应趋近于 0）
- [ ] **至少一个账号已 `role='admin'`**（`node scripts/promote-admin.mjs --list` 确认非空；空表 = 知识库不可写，属 fail-closed 的预期表现）
- [ ] 后端不输出堆栈到客户端（全局异常过滤器已兜底，返回统一信封）
- [ ] 存储桶权限复核（`SUPABASE_STORAGE_PUBLIC` 取值符合预期；`STORAGE_DRIVER` 与部署形态匹配）
- [ ] 临时用户清理任务在运行（日志出现 `[maintenance]`；`STORAGE_GC_DRY_RUN` 取值符合预期）
- [ ] 依赖凭据均已配置且未过期（`node server/scripts/health-probe.mjs` 全绿）
- [ ] `pnpm --filter server check:isolation` 通过
- [ ] 内容安全链路已验证（匿名跳过只 warn 一次；带 openid 时无 `40003`）

---

## 10. 安全事件处置

三类事件的统一流程：**发现 → 止损 → 轮换 → 追溯 → 复盘 → 登记 OPS-18**。

| 事件 | 止损动作 | 轮换/修复 | 追溯 |
|---|---|---|---|
| **密钥泄露** | 立即吊销（Supabase Rotate / 微信重置 AppSecret / 供应商后台禁用） | 更新 `.env.secrets` → 重跑 `encrypt-env.mjs` → 重启；`AUTH_TOKEN_SECRET` 轮换等效全体登出 | 查访问日志：异常 IP、异常用量峰值；确认数据是否被读/删 |
| **越权访问** | 先定位受影响接口并临时下线或加严校验 | 修查询条件（补 `.eq('user_id')`）+ 补静态门禁豁免理由；跑 `check-isolation` | 查日志确认被访问的 `user_id` 范围与时间窗口；必要时通知受影响用户 |
| **数据误删** | 立即把 `STORAGE_GC_DRY_RUN` 设为 `true` 并重启（暂停 GC 真删） | 7 天软删窗口内可恢复；超窗口只能从备份恢复（见 ADD-05 第 12 章） | 查 `[maintenance]` 日志与删除接口调用记录 |

复盘要求：写清**根因 / 修复 / 怎么用 / 验证**四段（项目惯例），同步更新本文与 OPS-18，并把可复用的教训写进 QA-17 工程规范。

---

## 变更记录

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v0.0 | 2026-10-23 | 建立提纲（待审） |
| v0.1 | 2026-10-24 | 落地 RLS 重新评估结论（不启用 + 静态门禁）、身份令牌方案、两个授权缺口修复 |
| v1.0 | 2026-10-27 | **正文完成**：补齐威胁模型与资产分级、身份三态与解析优先级、微信登录与匿名数据迁移链路、扫码登录、隔离六条强制规范与文件访问三种形态、密钥全量表与 `WX_SECRET` 轮换 5 步、部署包加密与边界声明、儿童隐私与第三方数据传输、配额档位与滥用防护、发布前 14 项安全清单、三类事件处置流程 |
| v1.1 | 2026-10-27 | **门禁口径同步**：调用点由 93 → **108**（`answer_cache` / `ocr_results` 接入后）；表级白名单增列 `ocr_results`（表内无 `user_id` 列，内容寻址跨用户共享）；豁免类型由「insert 链」扩为「insert / upsert 链」，并明确 **upsert 额外要求窗口内可见 `user_id`**（可覆盖他人行，比 insert 危险） |
