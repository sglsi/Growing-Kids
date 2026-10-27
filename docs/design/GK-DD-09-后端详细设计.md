# GK-DD-09 后端详细设计

> 编号：GK-DD-09 ｜ 版本：v1.0 ｜ 日期：2026-10-27 ｜ 状态：**正文完成**
> 读者：后端 ｜ 上游：ADD-04、ADD-05、ADD-06、ADD-07 ｜ 下游：QA-16
> 定位：NestJS 模块的职责与请求生命周期。**含身份、权限与配额**（原 DD-15 并入第 9 章）。缓存细节引用 DD-13，算法管线引用 DD-10，存储生命周期引用 DD-12。

---

## 1. 技术栈与启动

| 项 | 值 |
|---|---|
| 框架 | NestJS（Express 适配器） |
| 全局前缀 | **`/api`**（`app.setGlobalPrefix('api')` ⇒ 前端路径一律带 `/api/`） |
| 版本化 | URI 版本化，v2 起 `/api/v2`（见 ADD-06 第 8 章） |
| 端口 | `-p` 参数 > `PORT`（平台注入）> `SERVER_PORT` > 3000；小程序联调**固定 3001** |
| 绑定 | 显式 `0.0.0.0`（容器/托管平台要求监听全部网卡） |
| 请求体上限 | `express.json({ limit: '50mb' })`（图片 base64 需要） |
| 定时任务 | `@nestjs/schedule`（`ScheduleModule.forRoot()`） |

### 1.1 启动命令

```bash
cd server
npx nest build
# ⚠️ 必须带 OCR 三件套环境变量，否则 spawn 落到系统 python（缺包直接崩）
node dist/main -p 3001
```

OCR 三件套：`OCR_VENV_DIR`（venv 位置，仓库外 `D:/AI/gk-ocr-env/.venv-py`）、`OCR_ENGINE_DIR`（`ocr-engine/`）、可选 `OCR_PYTHON`。

> 日常开发用 `wake-server.mjs`（`:3002`）自动补这三件套并保活；**直接跑 `node dist/main` 时必须手动带**。

### 1.2 ⚠️ commit ≠ 生效

改了 `server/src` 必须 **重编译 + 重启**才生效——真机连的是本地后端，不是云端。

### 1.3 ⚠️ 重启踩坑：端口被旧进程占用

现象：后台任务停止后 node 子进程仍占端口 ⇒ 新进程 `EADDRINUSE`、health 是**旧进程答的**（曾据此误判"缺 key"）。

正确姿势：

```bash
netstat -ano | grep :3001      # 找 PID
taskkill /PID <pid> /F         # 或用 PowerShell Stop-Process
node dist/main -p 3001
curl --noproxy '*' http://127.0.0.1:3001/api/health   # 验时间戳而非只验 200
```

---

## 2. 模块清单

24 个目录 / 18 个 controller。

| 模块 | 职责 | 对外控制器 | 状态 |
|---|---|---|---|
| **timeline** | **核心**：统一收件箱（图片/题目），含复习本语义、概览统计 | `/api/timeline` | 活跃 |
| subjects | 学科分类维表 | `/api/subjects` | 活跃 |
| upload | 上传与 purpose 分流、配额预检、条目层查重 | `/api/upload` | 活跃 |
| library | 资料库（文档/图片）、网盘归档登记 | `/api/library` | 活跃 |
| documents | **文档记录**（导出物登记：docx/pdf） | `/api/documents` | 活跃 |
| document | **导出流程**（生成 docx / 打印） | `/api/document` | 活跃 |
| pdf | PDF 合成（多图拼页） | `/api/pdf` | 活跃 |
| ocr | OCR 编排：双引擎、侧车管理、结果缓存 | `/api/ocr` | 活跃 |
| image | 图像处理管线（纠偏/黑白/超分/去手写/红笔） | `/api/image` | 活跃 |
| answer-search | 题目答案：三模式（search/ai/kb）+ 持久缓存 | `/api/answer-search` | 活跃 |
| search | 联网检索封装 | `/api/search` | 活跃 |
| ai | LLM 供应商封装与降级链 | — | 活跃 |
| auth | 微信登录、扫码票据、资料更新 | `/api/auth` | 活跃 |
| users | 用户身份（找/建/迁移/清理） | — | 活跃 |
| memory | 成长记忆与媒体 | `/api/memory` | 活跃 |
| chat | 智能客服（对话 + 知识库） | `/api/chat` | 活跃 |
| quota | 存储配额（策略 6） | `/api/quota` | 活跃 |
| storage | 对象存储双驱动、blob 引用计数、文件代理 | `/api/storage` | 活跃 |
| maintenance | 定时任务（匿名清理/软删回收/孤儿 GC） | — | 活跃 |
| app | 根路由服务名片 + `/api/health` | — | 活跃 |
| shared | 用户上下文中间件、mem-cache、auth-token、查询参数清洗 | — | 基础设施 |
| filters / interceptors | 全局异常过滤器 / 状态码拦截器 | — | 基础设施 |
| **questions** | v3 遗留题目主表 | `/api/questions` | **空转** |
| **materials** | v3 遗留素材表 | `/api/materials` | **空转** |

### 2.1 三个必须记住的区分

1. ⚠️ **`document` ≠ `documents`**：`document` 是**导出流程**（生成文件），`documents` 是**文档记录**（导出物的登记与列表）。名字相近，改错地方白忙。
2. **`timeline` 是核心**：统一收件箱，"最近题目" = 全表，"复习本" = `in_review_book` 子集。任何新条目类型优先往这里放，而不是新建表。
3. **`questions` / `materials` 已接线但前端不调用**（空转）。⚠️ 这两个 service **完全没做用户隔离**（`user_id` 列允许 NULL 就是为此预留）。正常业务链路禁止读写。

---

## 3. 请求生命周期

```
请求
  ↓ ① express.json / urlencoded（50mb）
  ↓ ② UserContextMiddleware（全站 forRoutes('*')）
  ↓ ③ 路由匹配 → Controller
  ↓ ④ DTO 校验（管道）
  ↓ ⑤ Service（业务 + 配额 + 缓存）
  ↓ ⑥ 数据访问（supabase client，service_role）
  ↓ ⑦ HttpStatusInterceptor（POST 201 → 200）
  ↓ ⑧ AllExceptionsFilter（异常统一信封 + 5xx 落盘）
响应（含 X-User-Id / X-Auth-Token 回传头）
```

| 环节 | 能做 | 不能做 |
|---|---|---|
| 中间件 | 解析身份、注入 `req.userId` | 抛错中断（失败要降级匿名继续） |
| 守卫 | 全局表写权限（`requireAdmin`） | 业务级校验（放 DTO） |
| 拦截器 | 状态码归一 | 改业务语义 |
| **Controller** | 取值、调用 service、**不做业务逻辑** | 直连数据库 |
| **Service** | 业务、配额、缓存、失效 | 直接读 `req`（应接参数） |
| **数据访问** | `.eq('user_id')`、批量富化 URL | 裸查 |
| 异常过滤器 | 统一信封 + 落盘 | 吞掉 4xx 响应（会挂起请求） |

**配额校验放在 Service 层**（而非中间件）：不同接口消耗的资源不同（存储 / 搜题 / 超分各算各的），中间件无法区分。

---

## 4. 用户上下文中间件

`server/src/shared/user-context.ts`，全站注入（`consumer.apply(UserContextMiddleware).forRoutes('*')`）。

### 4.1 解析流程

```
1) X-Auth-Token  验签通过 → 用令牌里的 userId（防伪造，推荐）
2) X-User-Id     裸 id，过渡兼容（每次 console.warn）
3) X-Open-Id     微信 openid（扫码登录）
4) X-Device-Id   设备锚点，找/建匿名身份
5) 都没有        → 建匿名 user（/api/auth/* 与 /api/health 除外）
```

完整优先级、令牌格式与滑动续签见 **ADD-07 第 2 章**。

### 4.2 用户对象缓存 60s

每个请求都查一次 users 表（新加坡 RTT ~1.5s）曾是隐藏的最大瓶颈：

- TTL 60s，key `user:{userId}`；
- ⚠️ **只缓存非 null**——避免把"刚登录建号前后的瞬间查空"缓存成 60s 幽灵用户；
- 下游只消费 `id` / `is_anonymous` / `expire_at`，一分钟内稳定 ⇒ 无一致性风险。

### 4.3 响应回写与失败行为

- 每个响应回写 `X-User-Id`（匿名建号回传）与 `X-Auth-Token`（滑动续签）；
- ⚠️ **CORS `exposedHeaders` 必须包含这两个头**（`main.ts`）——曾漏配 `X-Auth-Token`，导致 H5 扫码登录页（浏览器环境受 CORS 约束）读不到续签令牌；
- **失败不阻塞**：中间件 catch 后 `req.userId = undefined` 并 `console.error`，交给下游报错——身份失败不应直接 500。

---

## 5. 数据访问层

### 5.1 客户端

`server/src/storage/database/supabase-client.ts`：单例 Supabase client，**service_role**。所有查询绕过 RLS。

### 5.2 四条硬约束

1. ⚠️ **所有查询必须 `.eq('user_id', userId)`**（RLS 未启用，这是唯一隔离手段）。由 `check-isolation.mjs` 静态门禁把关，见 ADD-07 第 3.2 节。
2. ⚠️ **删除必须 `.select('id')` 并校验返回行数**——否则越权删除会"返回 200 但一行没删"，无日志无报错。
3. **`withUrls` 富化**：把 `question_images` / `answer_images` / 附件等 `file_key` 转成可访问 URL。⚠️ **所有返回体含 `*_images` 的读端点都必须过 `withUrls`**（list / overview / create / createBatch / findOne / update）——历史上 findOne 与 update 漏过，导致详情页无图。
4. **未分类哨兵**：`subject_id='none'` 必须转为 `.is('subject_id', null)`，否则查 0 条。

### 5.3 通用出口

`supabase-db.provider.ts` 提供通用查询出口，**where 由调用方传入** ⇒ 它自己无法静态判定隔离，被 `check-isolation.mjs` 列入文件级白名单。⚠️ 用它的地方要格外小心。

---

## 6. DTO 与校验

### 6.1 校验策略

- 查询参数一律过 `cleanStr` / `cleanDate` / `cleanInt`（`shared/query-param.ts`）——**禁止把 `undefined` 传进 query**（会变成字符串 "undefined"）；
- 业务校验用 Nest 内置管道 + DTO 内手写校验。

### 6.2 三条隐式依赖（改前必读）

1. ⚠️ **`PUT /api/timeline/:id` 是局部合并**：未传的字段不清空。这是"只删图片不清题干"的实现基础——**改成整体覆盖会让删图片连带清空题干**。
2. ⚠️ **`JSON.stringify` 会丢 `undefined`**：改 `content` 合并逻辑时，用 `undefined` 表示"不更新"和用 `null` 表示"清空"必须区分清楚，否则字段被静默吃掉。
3. **题目允许"无题干只有图"**：校验已放宽，`title` 兜底「图片题目」。

---

## 7. 错误处理

### 7.1 全局异常过滤器

`filters/all-exceptions.filter.ts`：

- 5xx / 未知异常**落盘** `server/logs/error-YYYY-MM-DD.log`（时间、方法、URL、userId、请求体摘要、消息、完整堆栈）；4xx **不落盘**（避免刷爆磁盘）；
- 单文件超 5MB 自动换号（`.2.log` / `.3.log`…）；请求体落盘上限 2000 字符（防 50mb base64 写进日志）；
- **响应体双写**：`code/msg`（项目统一信封）+ `statusCode/message/error`（Nest 默认形态，向后兼容）。⚠️ 只写 Nest 默认形态的话，前端 `unwrap` 读的 `body.msg` 永远拿不到后端详细文案，只能显示「识别服务异常(500)」；
- ⚠️ **4xx 也必须由本过滤器发响应**（曾提前 `return` 以为"交给 Nest 默认行为"，但 `useGlobalFilters` 注册后 `BaseExceptionFilter` 已被替换 ⇒ 请求挂起直至客户端超时，curl 实测 `HTTP:000`）。

### 7.2 错误码

见 **ADD-06 第 2 章**（统一信封与错误码）。

### 7.3 日志纪律

- 🔴 **best-effort 分支的 catch 必须 `console.error` 打全错**（曾静默吞掉 `mime_type` 超长，导致每次导出丢记录、且查不到原因）；
- 响应头/签名 URL/token **不打进日志**，`file_key` 可打。

---

## 8. 缓存层（接入方式）

机制见 **DD-13 第 4 章**，此处只写接入约定：

| 接入点 | key | 失效 |
|---|---|---|
| `timeline.list()` | `tl:list:{userId}:{stableQuery}` | `invalidateUserTimeline(userId)` |
| `timeline.findOne()` | `tl:item:{userId}:{id}` | 同上 |
| `timeline.overview()` | `tl:ov:{userId}` | 同上 |
| `UserContextMiddleware` | `user:{userId}`（60s） | — |
| `answer-search` | 调用计数 + 结果（**24h 内存层**，DB 持久层见 ADD-05 第 4.10 节） | — |

🔴 **所有写方法成功后必须 `invalidateUserTimeline(userId)`**，最坏读到 30s 旧值。

⚠️ **多副本部署时 mem-cache 必须换成共享缓存**（当前 Map 是进程内），登记 OPS-18。

---

## 9. 身份、权限与配额

### 9.1 三态身份

| 状态 | 产生 | 有效期 | 清理 |
|---|---|---|---|
| 授权（微信登录） | `code2session` → openid | 长期 | 不清理 |
| 匿名 | 无身份头自动创建 / 按 `device_id` 找回 | 1 天，滑动续期 | 每小时清理过期号 |
| 临时 | 同匿名 | — | — |

**匿名 → 授权的数据处置**：登录时把 `anonymous_id` **以及该 `device_id` 名下所有历史匿名号**的数据整体 `update user_id` 到正式账号（保留原 id、外键不破），随后删除匿名空壳。同名学科会撞 `(user_id, name)` 唯一约束 ⇒ `dedupeSubjects` 保留最早创建的、删重复残留。

登录链路、扫码票据、失败降级详见 **ADD-07 第 2 章**。

### 9.2 权限

| 场景 | 机制 |
|---|---|
| 业务数据 | 代码层 `.eq('user_id')` + 静态门禁 |
| 全局表写（知识库） | `requireAdmin()`（`CHAT_ADMIN_IDS` 白名单；未配置放行 + warn） |
| 身份伪造 | `X-Auth-Token` 服务端签发 + 验签 |

### 9.3 配额模型

| 配额项 | 计量点 | 超限表现 | 重置 |
|---|---|---|---|
| **存储**（字节 / 张数双阈值 + 月流量） | `upload.controller` 上传前预检 | 由 `QUOTA_MODE` 决定：`off` / `shadow` / `warn` 都不阻断，只有 `block` 真拦截 | 月流量按月；字节/张数按已用释放 |
| **搜题**（ima / 联网检索） | `answer-search.service.checkQuota` | ⚠️ **HTTP 200** + `source='none'` + note「今日搜题次数已用完（N 次/天），明天再试」——**不是 429**（controller 恒 `@HttpCode(200)`） | 每日（`ANSWER_SEARCH_DAILY_LIMIT`，默认 20） |
| **超分（SR）** | `image.service` 两道防线 | ① 用户级配额 → **429**；② 全局并发闸排队超时/队列满 → **503** + 降级建议（改选 x2 轻任务） | 滑动窗口 |
| **OCR** | 全局 `ocr_results` 缓存 + 逐块并发 `OCR_CONCURRENCY` | 缓存命中即零消耗 | — |

**存储档位**（`quota-policy.ts`）：anonymous 20MB/10 张；free 500MB/300 张；member 10GB/5000；family 50GB/不限。月流量兜底见 ADD-05 第 4.7 节。

⚠️ `QUOTA_MODE` **非法值一律退回 `warn`**（默认不阻断）——避免误伤存量用户。生产建议 `block`。

⚠️ **原图留档不计入配额**（用户消费的是 display/thumb）；**已软删不计入**（删了就释放，用户才有自我管理路径）；**`temp` 不占长期配额**（24h 就回收）。

### 9.4 身份切换后前端必须清缓存

缓存按 `userId` 分桶（`gkc:{userId}:…`），三个切换点（login / applyLoginUser / logout）必须 `clearAllCache()`，否则串号。

---

## 10. 定时任务与维护

| 任务 | 频率 | 作用 | 安全边界 |
|---|---|---|---|
| `cleanupExpiredAnonymous` | 每小时 | 过期匿名用户清理：收集 `file_hash` → 删用户（级联删业务行）→ `release()` 释放引用 | `is_anonymous and expire_at < now()`；`file_hash` 为空的旧数据按 key 直删（无 hash ⇒ 无共享可能） |
| `releaseSoftDeleted` | 每日 3AM | 软删超 7 天宽限期的条目释放 blob 引用 | 扫 timeline_items / library_docs / documents |
| `collectOrphanBlobs` | 每日 4AM | **唯一真删文件的地方**：删所有派生档 → 全部成功后才清登记行 | `ref_count=0 and last_ref_at < now()-24h` |
| OCR 侧车回收 | 巡检 15s | 空闲 900s 回收；资源紧张时按更短窗口回收 | `active>0` 时**任何回收都跳过**（不中断进行中的请求） |

⚠️ **所有删文件动作默认 dry-run**（`STORAGE_GC_DRY_RUN` 默认 `true`），确认日志后再关。详见 ADD-05 第 9 章。

⚠️ 维护任务走全表扫描 ⇒ 被 `check-isolation.mjs` 列入文件级白名单；**新增维护任务若有 user 维度判断，必须显式带条件**。

---

## 11. 子进程与侧车管理

### 11.1 两种 OCR 形态

| 形态 | 用途 | 进程模型 |
|---|---|---|
| **快速识别** | 轻量 OCR | Python **常驻进程**，stdin/stdout 管道通信（不占端口），预热后常驻 |
| **精准识别** | PP-StructureV3 | **侧车 HTTP `:9301`**，按需拉起、**空闲 900s 回收** |

⚠️ **侧车无监听是设计行为，不是故障**——不要因为端口没起就判定服务异常。

### 11.2 Supervisor 策略（`ocr/sidecar.supervisor.ts`）

- 三种模式：`OCR_SUPERVISE=1` 强制托管 / `0` 禁用（外部侧车，直接透传）/ `auto`（默认：仅当 `ocr-engine/main.py` 存在且 python 可用时启用）；
- 启动：spawn → 轮询 `/healthz`，`startTimeoutMs` 默认 30s；
- 回收：空闲 15min 默认；内存 RSS 超 `OCR_SHUTDOWN_RSS_MB` 且无人使用时按 `OCR_TIGHT_IDLE_MS`（默认 2min）尽快回收；
- 🔴 **`active>0`（请求进行中）时任何回收都跳过**——宁可不回收也不能中断请求；
- 任何启动/探活失败都返回 `null`，交由 `OcrService` **降级到 VLM**，绝不抛错阻断主链路。

### 11.3 ⚠️ 三个 OCR 环境变量必须透传

`OCR_VENV_DIR`、`OCR_ENGINE_DIR`、可选 `OCR_PYTHON`。spawn 继承 `process.env` ⇒ **直接跑 `node dist/main` 而不设这三个变量，会落到系统 python**（缺包直接崩，表现为 `main.py` 里 `app=None`）。`wake-server.mjs` 会自动注入。

### 11.4 ⚠️ 编码铁律（#117）

Windows 无 locale 环境下 Python 管道会回落 cp936，Node 按 utf-8 读 ⇒ 全文 `U+FFFD`（汉字零残留）。两条约束：

1. spawn Python 必须走 `pythonEnv()`（`PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8`）；
2. stdout 解码走 `decodeEngineChunk()`（U+FFFD 劣化 ≥10% 时 GBK 兜底）。

**判据：中文 OCR 输出绝不出现 `U+FFFD`，出现即编码损坏。**

### 11.5 闪窗

所有 spawn 已 `windowsHide: true` + 走 `toGuiPython()`（`pythonw.exe`）。2026-10-25 闪窗审计定案：wake 链三连实证零窗口；**再现先看标题栏，勿重复排查**。

---

## 12. 配置管理

| 文件 | 内容 | 入仓库 | 入部署包 |
|---|---|---|---|
| `server/.env` | 非敏感配置（端口、驱动、开关） | ❌ | ✅（非敏） |
| `server/.env.secrets` | **敏感密钥**（service_role、WX_SECRET、LLM Key…） | ❌ | ❌（只传 `.enc`） |
| `server/.env.secrets.enc` | 上者的 AES-256-GCM 密文 | ✅ | ✅ |
| `server/.env.migrate` | 迁移专用低权账号连接串（本地） | ❌ | ❌ |
| `.env.local` | 前端项目域（`PROJECT_DOMAIN`） | ❌ | — |

### 12.1 加载顺序（`main.ts` 顶部，早于任何 `process.env` 读取）

```
.env（按 __dirname 定位三级候选：server/.env → 上级 .env → cwd/.env）
  → .env（默认行为兜底）
  → .env.secrets（同级候选；dotenv 不覆盖已有值 ⇒ 非敏优先、敏感补入，键集不重）
```

⚠️ 不能只用 `import 'dotenv/config'`：那只按 `process.cwd()` 找 `.env`，托管环境 cwd 未必是 server 目录 ⇒ **静默读不到配置** → `STORAGE_DRIVER` 回退 local、图片 URL 变 `127.0.0.1`、处理链路随后 404。

### 12.2 主要配置项

| 名称 | 用途 | 敏感 | 默认 |
|---|---|---|---|
| `SERVER_PORT` / `PORT` | 端口 | 否 | 3000 |
| `STORAGE_DRIVER` | `local` / `supabase` | 否 | `local` |
| `SUPABASE_STORAGE_BUCKET` / `_PUBLIC` | 桶名 / 是否公共桶 | 否 | `media` / `true` |
| `SUPABASE_URL` + `SERVICE_ROLE_KEY` | 数据与对象存储 | 🔴 | — |
| `DATABASE_URL`（`.env.migrate`） | 迁移连接串 | 🔴 | — |
| `WX_APPID` / `WX_SECRET` | 登录与内容安全 | 🔴 | — |
| `AUTH_TOKEN_SECRET` | 身份令牌签名（≥16 字符） | 🔴 | — |
| `CHAT_ADMIN_IDS` | 知识库写白名单 | 否 | 空（放行） |
| `QUOTA_MODE` | `off`/`shadow`/`warn`/`block` | 否 | `warn` |
| `STORAGE_GC_DRY_RUN` | GC 干跑开关 | 否 | `true` |
| `OCR_*` | OCR 三件套 + 侧车参数 | 否 | — |
| `LIBRARY_NETDISK_SYNC` | 资料库网盘归档 | 否 | `false` |
| `ANSWER_SEARCH_DAILY_LIMIT` | 每日搜题次数 | 否 | `20` |

⚠️ **改了 `.env.secrets` 必须重跑 `node server/scripts/encrypt-env.mjs --verify`**（含密钥轮换、refresh_token 变更）。详见 ADD-07 第 5 章。

---

## 13. 本地开发

### 13.1 标准命令

```bash
# 构建
cd server && npx nest build
# 运行（日常用 wake-server 保活，自动补 OCR 环境变量）
node scripts/wake-server.mjs --daemon          # :3002 常驻唤醒服务
curl --noproxy '*' http://127.0.0.1:3002/wake  # 手动唤醒后端 :3001

# 拨测
node server/scripts/health-probe.mjs           # 单次，失败 exit 1
node server/scripts/health-probe.mjs --watch 60

# 门禁
pnpm --filter server check:isolation
```

### 13.2 常用 curl

⚠️ **本机 shell 必须带 `--noproxy '*'`**（系统代理会拦 `127.0.0.1`）：

```bash
curl --noproxy '*' http://127.0.0.1:3001/api/health
curl --noproxy '*' -H "X-Device-Id: dev_test_1" http://127.0.0.1:3001/api/timeline?page=1
```

⚠️ **测试一律用 `X-Device-Id`**（裸 `X-User-Id` 传不存在的 id 会每次新建匿名用户）。

### 13.3 日志位置

| 日志 | 路径 |
|---|---|
| 异常落盘 | `server/logs/error-YYYY-MM-DD.log`（gitignore） |
| 保活服务 | `server/logs/wake-server.log` |
| 启动输出 | 运行终端的 stdout |

### 13.4 排障顺序

1. 后端 3001 是否在监听（`netstat -ano | grep :3001`）；
2. `wake-server.log` 有无唤醒/重启记录；
3. `error-YYYY-MM-DD.log` 有无 5xx；
4. 计划任务是否还在（`GrowingKids-Wake-Launcher`）；
5. 换构建后必须**杀后端再 POST `:3002/wake`**（否则跑的是旧 dist）。

---

## 变更记录

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v0.0 | 2026-10-24 | 建立提纲（待审） |
| v1.0 | 2026-10-27 | **正文完成**：启动与端口占用踩坑、24 模块/18 controller 清单与三个易混区分、请求生命周期八环与每环边界、用户上下文与 60s 缓存、数据访问四条硬约束、DTO 三条隐式依赖、异常过滤器四个要点、配额模型四张表与档位、定时任务与 dry-run 安全阀、子进程与侧车策略（含 #117 编码铁律）、配置加载顺序与主要配置项、本地开发命令与排障顺序。同批修复：`main.ts` CORS `exposedHeaders` 补 `X-Auth-Token`（H5 扫码登录页在浏览器环境读不到续签令牌） |
