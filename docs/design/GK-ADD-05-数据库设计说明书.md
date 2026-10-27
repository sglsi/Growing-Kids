# GK-ADD-05 数据库设计说明书

> 编号：GK-ADD-05 ｜ 版本：v1.0 ｜ 日期：2026-10-27 ｜ 状态：**正文完成**
> 读者：后端 / 运维 ｜ 上游：SRS-01、ADD-04 ｜ 下游：DD-09、DD-10、DD-11、DD-12、DD-14、QA-16
> 定位：**17 张表**（活跃 13 + 备用 1 + 空转 2 + 废弃 1）的权威说明。**含数据字典**（原 SRS-03 的数据字典部分并入第 5 章）。
> ⚠️ 口径校正：v0.0 提纲记 15 张，现按 `migrations/` 实际为 **17 张**——2026-10-24 后新增 `answer_cache`（0014）与 `ocr_results`（0016）。
> 唯一真相源：**`migrations/*.sql`**。代码里 `.from('表名')` 的静态扫描**不完整**（部分访问走 RPC / 常量变量 / raw SQL），不得作为表清单依据。

---

## 1. 概述与环境

### 1.1 数据库与访问方式

| 项 | 取值 / 约定 |
|---|---|
| 引擎 | PostgreSQL（Supabase 托管，新加坡 region） |
| 连接方式 | **Session pooler（IPv4）**，后端统一走 `@supabase/supabase-js` + **service_role key** |
| 用户名形态 | 必须是 `postgres.<project-ref>`；pooler 主机**只能从 Connect 面板复制**，不可手拼 |
| 连接串获取 | 见 `docs/获取DATABASE_URL-操作指引.md`。**本文不记录任何密钥** |
| 迁移执行 | `node server/scripts/migrate.mjs`（见 1.2） |
| 迁移专用账号 | 低权角色 `migrator`（`server/scripts/setup-migrator-role.sql`），凭据放 `server/.env.migrate`（不进仓库） |
| ORM | **无 ORM**。全项目手写 supabase 查询构造器；`schema.ts` 仅作 drizzle 内省留档，不参与运行时 |

### 1.2 迁移器用法

```bash
node server/scripts/migrate.mjs                          # 执行所有未执行过的迁移
node server/scripts/migrate.mjs --ping                   # 只验证连接串（第一次先跑这个）
node server/scripts/migrate.mjs --dry                    # 干跑，只打印将执行哪些文件
node server/scripts/migrate.mjs --force                  # 忽略已执行记录，全部重跑（脚本均幂等）
node server/scripts/migrate.mjs --only 0008_updated_at_trigger.sql
```

机制要点：

- 用 `schema_migrations` 表记录已执行文件（含内容 sha256），重复运行自动跳过；
- **单个文件一个事务**，失败立即回滚并报出文件名 + 错误位置（解决了「SQL Editor 整批回滚却只提示最后一行」的踩坑）；
- 全部成功后发 `NOTIFY pgrst` 刷新 PostgREST schema cache，否则新建表在 REST 上仍报 `PGRST205 Could not find the table`；
- 执行完打印 public schema 实际表清单，可直接核对；
- 连接串按优先级取：`DATABASE_URL` → `SUPABASE_DB_URL` → `SUPABASE_URL + SUPABASE_DB_PASSWORD`。
- ⚠️ **pooler 改密码后首次连接必失败**，20–90s 后重试即通（见 QA-16）。

---

## 2. 实体关系

### 2.1 ER 概览

```
                          users (隔离根)
                            │ 1
        ┌───────────┬───────┼────────┬──────────┬──────────┬───────────┐
        │           │       │        │          │          │           │
    subjects   timeline_items  library_docs  documents  memories  chat_messages  user_quota
        │           │  N     │            │          │         （user_id 可空）
        │           │        │            │          │
        │      (subject_id, on delete set null)   memory_media ── memories
        │                    │
        └── 外键：subjects ← timeline_items / library_docs / memories / questions / materials

   blob_objects（内容寻址，不属于任何用户）
        ▲ 通过 file_hash 被引用（非外键）
        │
   timeline_items.file_hash / library_docs.file_hash / documents.file_hash
        └─ 引用计数模型：acquire(+1) / release(-1) / 归零后 GC 真删

   answer_cache   —— user_id + q_hash + mode 唯一（按用户隔离的持久缓存）
   ocr_results    —— **全局共享**，主键 cache_key = sha256(content_hash|kind|mode|engine_version)
   knowledge_articles —— 活跃（全局表，AI 对话的知识库，内容进 system prompt，写走 requireAdmin）
   login_tickets  —— 备用（多副本扫码登录），当前票据走进程内存
   questions / materials —— 空转（v3 遗留，模块接线但前端不调用）
   health_check   —— 废弃待清理
```

### 2.2 三条结构性约定

1. **`users` 是隔离根**：除全局表（`blob_objects` / `ocr_results` / `knowledge_articles` / `health_check`）外，所有业务表都带 `user_id`，且外键 `references users(id) on delete cascade`。
2. **`timeline_items` 是核心表**（统一收件箱）：`kind` 区分 `image` / `question`；"最近题目" = 全表，`复习本` = `in_review_book = true` 子集；`subjects` 是其分类维表（`on delete set null`，删除学科不删题目）。
3. **`blob_objects` 不与业务表建外键**：靠 `file_hash` 软关联（内容寻址，见第 9 章）。这是刻意的——同一份物理内容可被任意多用户引用，外键无法表达"多对一共享 + 引用计数"。

### 2.3 非活跃表清单（4 张）

| 状态 | 表 | 说明 |
|---|---|---|
| **备用** | `login_tickets` | 已建表、当前无读写。为**多副本部署 H5 扫码登录**准备；当前单机部署票据走 `QrLoginService` 进程内存（`@nestjs/schedule` 无关，重启即失效，用户重扫即可）。多实例下内存票据不共享时才需要落库，接口形态（createTicket/getStatus/authorize）已按表结构设计，届时无需改 controller。 |
| **空转** | `questions` / `materials` | v3 遗留。模块（`questions.service.ts` / `materials.service.ts`）已接线但**前端不调用**。 ⚠️ 这两张表的 service **完全没做用户隔离**（不写也不过滤 `user_id`），`user_id` 列允许 NULL 就是为此预留。**正常业务链路禁止读写这两张表**。 |
| **废弃待清理** | `health_check` | 思傅 2026-10-24 确认登记为技术债（OPS-18 `R-工程-01`）。清理前须确认无外部引用（流程见 10.3）。 |

> ⚠️ **口径订正（2026-10-27）**：v0.0/v1.0 曾把 `knowledge_articles` 一并列为「废弃待清理」，**实测有误**——它是 AI 对话的全局知识库，`chat.service.ts` 的 `getActiveArticles()` 会读取 `is_active = true` 的文章拼进 system prompt（`chat.service.ts:8/81/95/134/159`），CRUD 写操作受 `requireAdmin()` 保护。它属**活跃表**（状态：全局表），不是技术债。详见 OPS-18 第 1.5 节校正说明。

---

## 3. 表清单与职责

| # | 表 | 一句话职责 | 状态 | 主要写入方 |
|---|---|---|---|---|
| 1 | `users` | 用户身份（登录 / 匿名 / 设备），隔离根 | 活跃 | `users.service.ts`（`auth-token.ts` 解析后 upsert） |
| 2 | `subjects` | 学科分类维表（同用户同学科唯一） | 活跃 | `subjects.service.ts` |
| 3 | `timeline_items` | 统一收件箱（图片 / 题目），复习本为其子集 | 活跃 | `timeline.service.ts`、`upload`、`ocr` |
| 4 | `library_docs` | 资料库（上传/外部导入的 PDF、Word、图片） | 活跃 | `library.service.ts`、`upload` |
| 5 | `documents` | 生成的文档（导出的 docx / 合成 pdf）登记 | 活跃 | `document.service.ts`、`pdf` |
| 6 | `blob_objects` | **内容寻址 + 引用计数**（全局物理去重） | 活跃 | `blob.service.ts` |
| 7 | `user_quota` | 存储配额档位与用量缓存 | 活跃 | `quota.service.ts` |
| 8 | `memories` | 成长记忆正文与分类 | 活跃 | `memory.service.ts` |
| 9 | `memory_media` | 成长记忆的媒体（图/音/视频） | 活跃 | `memory.service.ts` |
| 10 | `chat_messages` | 智能客服对话记录（`user_id` 可空，支持匿名提问） | 活跃 | `chat.service.ts` |
| 11 | `answer_cache` | **题目答案持久缓存**（user+q_hash+mode 唯一） | 活跃 | `answer-search.service.ts` 私有方法（0014；**无独立 service 文件**） |
| 12 | `ocr_results` | **OCR 识别结果持久缓存**（全局共享） | 活跃 | `ocr-cache.service.ts`（0016） |
| 13 | `login_tickets` | H5 扫码登录票据 | **备用** | 无（当前走内存） |
| 14 | `questions` | v3 题目主表 | **空转** | 无（前端不调用） |
| 15 | `materials` | v3 素材表 | **空转** | 无（前端不调用） |
| 16 | `knowledge_articles` | AI 对话知识库（**全局表**，内容进 system prompt，后台维护） | **活跃**（全局） | 后台（走 `requireAdmin`），读：`chat.service.ts` `getActiveArticles()` |
| 17 | `health_check` | 运维探针（历史遗留） | **废弃** | 无 |

---

## 4. 表结构详述

> 字段表图例：**PK** 主键 ｜ **FK** 外键 ｜ **UQ** 唯一 ｜ **IX** 有索引（详见第 7 章）
> 通用列 `created_at timestamptz default now()` 在下表省略，仅在有差异时列出。

### 4.1 users（活跃）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | varchar(36) | PK | ⚠️ 全库统一 36 位字符串（非 uuid 类型）。**任何新表外键 user_id 必须用 varchar(36)**，写 `uuid` 会报 `42804`（0012 已踩） |
| `open_id` | varchar(64) | UQ | 微信 openid；仅登录用户有。内容安全 `msgSecCheck v2` 需要它（见 ADD-07） |
| `nickname` | varchar(64) | | 微信昵称 |
| `avatar_url` | text | | 头像 |
| `is_anonymous` | boolean | not null, default false | 免注册匿名用户 |
| `expire_at` | timestamptz | | 匿名用户过期时间（1 天，滑动续期）；登录用户为 NULL |
| `device_id` | text | 部分唯一索引 | 0011 加。匿名身份按设备持久化，解决"每次新匿名身份" |
| `created_at` | timestamptz | not null | |

索引：`users_anon_expire_idx on (expire_at) where is_anonymous`（匿名清理只扫少量行）；`users_device_id_key unique on (device_id) where device_id is not null`。

⚠️ **`users` 无 `updated_at` 列**，因此不在 0008 触发器的覆盖范围内（该触发器只对"已存在 updated_at 列"的表生效）。

### 4.2 subjects（活跃）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | varchar(36) | PK | |
| `user_id` | varchar(36) | FK → users, cascade | |
| `name` | varchar(32) | not null | |
| `color` | varchar(16) | default 'gray-500' | 前端色板 token 名 |
| `sort_order` | int | default 0 | |
| `created_at` | timestamptz | | |

约束：`unique (user_id, name)` —— 同用户同学科唯一（替代旧的全局 unique）。

### 4.3 timeline_items（活跃 · 核心表）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | varchar(36) | PK | |
| `user_id` | varchar(36) | FK → users, cascade | 隔离键 |
| `subject_id` | varchar(36) | FK → subjects, **set null** | NULL = 未分类（前端哨兵 `'none'`，见 5.3） |
| `kind` | varchar(16) | not null | `image` \| `question` |
| `title` | text | | 题目兜底标题「图片题目」（允许"无题干只有图"） |
| `file_key` | text | | 图片主文件对象 key |
| `thumb_key` | text | | 缩略图 key（WebP，宽 ≤400） |
| `mime_type` | varchar(64) | | ⚠️ 0013 只放宽了 documents/library_docs，本表仍为 64（图片 MIME 均 < 20 字符，无风险） |
| `width` / `height` | int | | |
| `size_bytes` | bigint | | |
| `file_hash` | varchar(64) | | 内容 sha256，**去重与 blob 关联的键** |
| `content` | jsonb | not null, default '{}' | 题目结构化内容，见第 6 章 |
| `source` | varchar(24) | | `camera` \| `album` \| `doc` |
| `in_review_book` | boolean | not null, default false | 是否在复习本 |
| `added_to_review_at` | timestamptz | | 加入复习本时间（复习本排序键，未加入为 NULL） |
| `tags` | text[] | default '{}' | |
| `mastered` | boolean | default false | 是否已掌握 |
| `mastered_at` | timestamptz | | |
| `deleted_at` | timestamptz | | **软删**（不物理删，靠 GC 收文件） |
| `created_at` / `updated_at` | timestamptz | not null | `updated_at` 由 0008 触发器自动刷新 |

### 4.4 library_docs（活跃）

`id` / `user_id`(cascade) / `subject_id`(set null) / `name varchar(128)` / `file_key text not null` / `mime_type varchar(128)`（0013 放宽）/ `size_bytes` / `source varchar(24)`（`upload`\|`external`\|`materials`）/ `tags text[]` / `deleted_at` / `created_at`；0004 补 `thumb_key` / `width` / `height` / `file_hash`；0015 补 `netdisk_path text`（百度网盘归档副本绝对路径，NULL = 未同步）。

### 4.5 documents（活跃）

`id` / `user_id` / `title varchar(128)` / `type varchar(8)`（`docx`\|`pdf`）/ `file_key` / `mime_type varchar(128)`（0013 放宽）/ `size_bytes` / `meta jsonb`（生成参数、来源题目 id 列表）/ `deleted_at` / `created_at`；0004 补 `file_hash`。

### 4.6 blob_objects（活跃 · 内容寻址）

| 字段 | 类型 | 说明 |
|---|---|---|
| `content_hash` | varchar(64) PK | sha256 hex，物理内容唯一标识 |
| `storage_key` | text not null | 对象存储 key，形如 `blobs/xx/<64位sha256>/variant` |
| `ref_count` | int not null default 0 | **引用计数；归零后方可回收** |
| `size_bytes` | bigint | display 档字节数 |
| `mime_type` | varchar(64) | |
| `kind` | varchar(16) default 'image' | `image` \| `doc` \| `temp` |
| `width` / `height` | int | |
| `variants` | jsonb default '{}' | `{ original, display, thumb } → storage_key` |
| `original_bytes` / `thumb_bytes` | bigint | 0005 加。分层统计用（转档收益主体是 original） |
| `created_at` / `last_ref_at` | timestamptz not null | `last_ref_at` = 最近一次被引用时间，GC 静止判据 |

### 4.7 user_quota（活跃）

`user_id text PK` / `tier varchar(20) default 'free'`（`free`\|`member`\|`family`\|`anonymous`）/ `quota_bytes bigint default 524288000`（500MB）/ `quota_count int default 300`（张数上限，**双阈值先到先触发**）/ `monthly_bytes bigint default 209715200`（月上传流量上限，原图留档不计配额后的兜底）/ `used_bytes` / `used_count`（缓存用量，统计任务刷新，**非权威值**）/ `updated_at`。

### 4.8 memories / memory_media（活跃）

`memories`：`id` / `user_id` / `title varchar(128)` / `content text` / `category varchar(16) default 'life'` / `mood varchar(16)` / `subject_id`(set null) / `tags text[]` / `cover_key` / `cover_mime` / `media_count int default 0` / `audio_duration` / `occurred_at`（事件发生时间，列表排序键）/ `created_at` / `updated_at` / `deleted_at`。

`memory_media`：`id` / `memory_id`(cascade) / `user_id`(cascade) / `file_key` / `thumb_key` / `mime_type` / `width` / `height` / `size_bytes` / `duration_sec` / `transcript text`（ASR 预留，V1 不写）/ `kind varchar(16)`（`image`\|`audio`\|`video`）/ `sort_order` / `created_at`。

### 4.9 chat_messages（活跃）

`id` / `session_id varchar(36)` / `user_id varchar(36)`（**可空**，支持匿名提问）/ `role varchar(20)`（`user`\|`assistant`）/ `content text` / `created_at`。索引 `(session_id, created_at)`。

### 4.10 answer_cache（活跃 · 0014）

`id` / `user_id`(cascade) / `q_hash varchar(64)`（题面 sha256 前 32 位）/ `mode varchar(16)`（`search`\|`ai`\|`kb`）/ `result jsonb`（完整 `AnswerSearchResult`）/ `hit_count` / `created_at` / `last_hit_at`。
约束：`unique (user_id, q_hash, mode)`。语义见 DD-11 第 9.1 节：**成功结果默认永久**（`ANSWER_CACHE_TTL_DAYS=0`），失败/零命中按 `ANSWER_CACHE_NEG_TTL_HOURS`（默认 12h）短期记忆——避免 ima 配额被反复白扣。
⚠️ 读写逻辑**内联在 `answer-search.service.ts` 的私有方法里**，不存在独立的 `answer-cache.service.ts`；内存层 TTL 为 24h（`CACHE_TTL_MS`）。

### 4.11 ocr_results（活跃 · 0016）

| 字段 | 类型 | 说明 |
|---|---|---|
| `cache_key` | varchar(64) PK | `sha256(content_hash|kind|mode|engine_version)` |
| `content_hash` | varchar(64) not null | 源文件内容 sha256 |
| `kind` | varchar(16) | `image` \| `pair` \| `doc` |
| `mode` | varchar(16) default '' | `fast` \| `precise` \| `rapid` \| 空 |
| `engine_version` | varchar(32) not null | 引擎/模型版本；**变更即老条目自然失效**，无需手工清理 |
| `result` | jsonb not null | 识别产物，原样回放 |
| `result_bytes` | int | 容量治理用 |
| `hit_count` / `created_at` / `last_hit_at` | | 冷热与收益分析 |

⚠️ 本表**启用了 RLS 但故意不建任何 policy** ⇒ 客户端（anon/authenticated）完全不可访问，只有 service_role 能读写。**切勿为它建宽松 policy**。

### 4.12 login_tickets（备用 · 0012）

`token text PK` / `status text check in (pending, authorized, expired)` / `user_id varchar(36) → users, set null` / `created_at` / `expires_at default now() + 5 minutes`。索引：`(expires_at) where status='pending'`。

### 4.13 questions（空转 · 0009 + 0010）

`id` / `subject_id`(cascade, not null) / `question_content text` / `question_image_keys jsonb` / `answer_content` / `answer_image_keys jsonb` / `solution` / `wrong_answer` / `source` / `status varchar(20) default 'answered'`（`answered`\|`pending`）/ `recognized_at` / `created_at` / `updated_at` / `mastered` / `mastered_at` / `in_review_book` / `added_to_review_at`（0010 加）/ `user_id`（**可空**，隔离预留）。

### 4.14 materials（空转 · 0009 + 0010）

`id` / `name varchar(255)` / `type varchar(20) default 'image'` / `file_key varchar(500)` / `url text` / `mime_type` / `size_bytes` / `subject_id`(set null) / `used` / `created_at` / `user_id`（可空）/ `in_review_book` + `added_to_review_at`（0010 加）。

> ⚠️ `size_bytes` 是 `integer`（非 bigint）——大文件会溢出，是这张空转表的已知问题，清理时一并处理。

### 4.15 knowledge_articles / health_check（废弃）

- `knowledge_articles`：`id` / `title` / `content` / `category` / `tags text[]` / `is_active` / `sort_order` / `created_at` / `updated_at`。全局表，写操作走 `requireAdmin()`。
- `health_check`：`id serial PK` / `updated_at`。

---

## 5. 数据字典（跨表统一口径）

### 5.1 通用字段

| 字段 | 类型 | 口径 |
|---|---|---|
| `id` | varchar(36) | **字符串 36 位**，非 PostgreSQL uuid。全库统一 |
| `user_id` | varchar(36) | 隔离键；由**后端强制写入**，任何 `Create*Dto` 都不得包含它 |
| `created_at` | timestamptz | `default now()` |
| `updated_at` | timestamptz | `default now()` + **0008 触发器 BEFORE UPDATE 自动刷新**（有此列的表自动覆盖） |
| `deleted_at` | timestamptz | 软删；NULL = 未删 |
| `file_hash` | varchar(64) | 文件内容 sha256 hex，小写 |
| `tags` | text[] | 默认 `'{}'`，GIN 索引 |

### 5.2 枚举值域

| 字段 | 值域 | 出现位置 | 语义 |
|---|---|---|---|
| `kind` | `image` \| `question` | timeline_items | 收件箱条目类型 |
| `kind` | `image` \| `doc` \| `temp` | blob_objects | 物理对象类型；`temp` = 中间上传，ref_count=0，24h 可回收 |
| `kind` | `image` \| `pair` \| `doc` | ocr_results | 识别任务类型（`pair` = 题面+答题卡双图） |
| `kind` | `image` \| `audio` \| `video` | memory_media | 媒体类型 |
| `status` | `answered` \| `pending` | timeline_items.content.status | 题目是否已有答案 |
| `status` | `pending` \| `authorized` \| `expired` | login_tickets | 扫码票据状态 |
| `source` | `camera` \| `album` \| `doc` | timeline_items | 图片来源 |
| `source` | `upload` \| `external` \| `materials` | library_docs | 资料来源 |
| `source` | `manual` \| `search` \| `ocr` \| `library` \| `mixed` | content.answer_source | 答案来源（可溯源） |
| `purpose` | `save` \| `1` \| `true` \| `memory` \| `attach` \| `temp` | **上传接口参数，非列** | 见 5.4 |
| `category` | `study` \| `life` \| `hobby` \| `feel` \| `other` | memories | 成长记忆分类 |
| `mood` | `happy` \| `calm` \| `excited` \| `thoughtful` \| `sad` \| `proud` | memories | 心情 |
| `tier` | `free` \| `member` \| `family` \| `anonymous` | user_quota | 配额档位 |
| `mode` | `search` \| `ai` \| `kb` | answer_cache | 搜题模式（三模式边界见 DD-11） |
| `mode` | `fast` \| `precise` \| `rapid` \| 空 | ocr_results | OCR 精度模式 |
| `scope` | `recent` \| `review` | 列表查询参数 | 最近题目 / 复习本 |
| `role` | `user` \| `assistant` | chat_messages | 对话角色 |

### 5.3 布尔与哨兵语义（易错）

| 项 | 语义 |
|---|---|
| `in_review_book` | 加入复习本；配套 `added_to_review_at`（未加入为 NULL，是复习本排序键） |
| `is_anonymous` | 匿名用户。配套 `expire_at`（1 天，滑动续期）与 `device_id`（设备持久化） |
| `mastered` | 已掌握；配套 `mastered_at` |
| **`subject_id = NULL`** | **未分类**。⚠️ 前端用哨兵字符串 `'none'` 表示，真实库值是 `NULL` ⇒ **列表查询必须把 `'none'` 转成 `.is('subject_id', null)`**，否则必然查 0 条（历史踩坑，见 `timeline.service.ts` 第 176 行注释） |
| `deleted_at` | 软删。所有列表查询默认带 `.is('deleted_at', null)` |

### 5.4 `purpose` 语义表（上传接口参数，非数据库列）

| purpose | 持久化 | 建业务条目 | 典型场景 |
|---|---|---|---|
| `save` / `1` / `true` | ✅ | ✅ | 拍照入收件箱、资料库上传 |
| `temp` | ✅ | ❌ | AI 识别前的中间上传（ref_count=0，24h 回收） |
| `memory` / `attach` | ✅ | ❌ | 附件类（key 会被写进别处）。⚠️ 误用 `save` 会**重复建条目** |

### 5.5 易错字段与历史事故

| 字段 | 坑 | 现状 |
|---|---|---|
| `mime_type` | docx 的 MIME 长 71 字符 > varchar(64) ⇒ 导出记录**静默入库失败**（文件生成了、能打开，但文档库看不到） | 0013 已放宽 documents / library_docs 至 128；PDF（15 字符）不受影响故此前未暴露 |
| 外键类型 | `users.id` 是 `varchar(36)`，外键写 `uuid` 报 `42804 foreign key constraint cannot be implemented` | 0012 已修；**新表 user_id 一律 varchar(36)** |
| `updated_at` | `default now()` 只在 insert 生效，update 不写就永不变 ⇒ 前端"最后编辑时间"、缓存判断全失真 | 0008 库级触发器治本 |
| `size_bytes` | `materials.size_bytes` 是 integer，大文件溢出 | 空转表，待清理 |

---

## 6. 核心 JSON 结构（timeline_items.content）

权威定义：`server/src/timeline/timeline.types.ts` → `QuestionContent`。

### 6.1 Schema

| 字段 | 类型 | 语义 |
|---|---|---|
| `question` | string | 题干（可含 LaTeX） |
| `answer` | string | 正确答案 |
| `solution` | string | 解题过程 / 解析 |
| `wrong_answer` | string | 孩子的错误答案（错因分析输入） |
| `status` | `'answered'` \| `'pending'` | 是否已有答案 |
| `question_label` | string | 规范题号标签（如 `预习案·Ⅱ.汉译英 18`）。两节各自重起题号时数字有歧义，**标签才能唯一指认题目** |
| `level` | number | 1=大题/父题，2=小题/子题 |
| `parent_index` | number \| null | 所属父题在识别结果数组中的下标；顶层题为 null |
| `stem` | string | 子题携带的所属大题完整题干（可脱离父题独立读懂） |
| `error_analysis` | `ErrorAnalysis` | P2-16 错因分析结论（本地规则引擎产出，见 DD-11） |
| `review_count` | number | P2-18 艾宾浩斯复习阶段计数（计划由 `created_at` + 该值现算） |
| `images` | string[] | **旧版**（题面+答案混在一起），仅兜底渲染与删除，无新消费者 |
| `question_images` | string[] | 题面图 file_key |
| `answer_images` | string[] | 答题卡 / 答案图 file_key |
| `answer_attachments` | `AnswerAttachment[]` | 答案附件（图/文档/文本）。**内嵌在题目记录里**，物理上不存在"答案挂到别的题上" |
| `answer_source` | `AnswerSource \| 'mixed'` | 答案来源，可溯源 |
| `answer_refs` | `{title, url?}[]` | 联网搜索命中的参考来源（与附件解耦） |
| `answer_searched_at` | string | 最近一次联网搜答案的时间 |

`AnswerAttachment`：`{ id, type: 'image'|'doc'|'text', file_key?, thumb_key?, name?, mime?, size?, text?, source?, ref_id?, refs?, created_at }`。

### 6.2 演进说明

1. **老 `images` → `question_images` / `answer_images`**：早期题面图与答题卡图混在一个数组，无法区分。拆分后老字段**已无消费者，仅保留兜底渲染与删除清理**，不要再往里写。
2. **合并语义（重要隐式依赖）**：`PUT /api/timeline/:id` 是**局部合并**——未传的字段不清空。这正是"只删图片不清题干"功能的实现基础。**若改成整体覆盖，删除图片会连带清空题干**。
3. **允许"无题干只有图"**：校验已放宽，`title` 兜底为「图片题目」。
4. **答案与题目同记录**：不独立建表、不靠外键 ⇒ 从物理上杜绝答案错挂（见 `题目答案功能-设计方案.md` §1.2）。

---

## 7. 索引与查询模式

### 7.1 主要查询路径

| 场景 | 查询 | 命中索引 |
|---|---|---|
| 最近题目列表 | `user_id` + `deleted_at is null` + `created_at desc` + `range` 分页 | `timeline_user_created_idx` |
| 复习本列表 | `user_id` + `in_review_book` + `added_to_review_at desc` | `timeline_review_idx`（部分索引） |
| 学科筛选 | `user_id` + `subject_id` | `timeline_subject_idx` |
| 标签筛选 | `tags @> '{x}'` | `timeline_tags_gin`（GIN） |
| 关键词搜索 | `title/content->>question/content->>answer/content->>question_label` 的 `ilike` 组合 | ❌ **无索引，见 7.3** |
| 时间范围 | `since` 过滤 `created_at`（review 模式过滤 `added_to_review_at`） | 同上，靠排序索引前缀 |
| 去重查找 | `user_id` + `file_hash` | `timeline_hash_idx` |
| 资料库 / 文档列表 | `user_id` + `deleted_at is null` + `created_at desc` | `library_user_created_idx` / `documents_user_created_idx` |
| 成长记忆列表 | `user_id` + `occurred_at desc` / `user_id` + `category` | `memories_user_occurred_idx` / `memories_user_category_idx` |
| 答案缓存命中 | `(user_id, q_hash, mode)` | `answer_cache_uq_idx`（唯一索引） |
| OCR 缓存命中 | `(content_hash, kind, mode, engine_version)` | `ocr_results_lookup_idx` |
| 孤儿 GC | `ref_count = 0` + `last_ref_at < X` | `blob_gc_idx`（部分索引） |
| 统计（总览） | 见 `timeline.service.ts` 第 652–669 行：4 个并行 count | 各自走前缀索引 |

### 7.2 索引清单（来自 migrations）

| 索引 | 表 | 定义 |
|---|---|---|
| `users_anon_expire_idx` | users | `(expire_at) where is_anonymous` |
| `users_device_id_key` | users | `unique (device_id) where device_id is not null` |
| `timeline_user_created_idx` | timeline_items | `(user_id, created_at desc) where deleted_at is null` |
| `timeline_review_idx` | timeline_items | `(user_id, added_to_review_at desc) where in_review_book and deleted_at is null` |
| `timeline_tags_gin` | timeline_items | `gin (tags)` |
| `timeline_subject_idx` | timeline_items | `(user_id, subject_id)` |
| `timeline_hash_idx` | timeline_items | `(user_id, file_hash)` |
| `library_user_created_idx` / `library_hash_idx` / `library_docs_netdisk_idx` | library_docs | 部分索引 + 去重 + 网盘路径 |
| `documents_user_created_idx` / `documents_hash_idx` | documents | |
| `blob_gc_idx` / `blob_created_idx` | blob_objects | `(ref_count, last_ref_at) where ref_count=0` / `(created_at)` |
| `user_quota_tier_idx` | user_quota | `(tier)` |
| `memories_*`（4 个） | memories / memory_media | 见 0006 |
| `chat_session_created_idx` | chat_messages | `(session_id, created_at)` |
| `answer_cache_uq_idx` / `answer_cache_user_time_idx` | answer_cache | |
| `ocr_results_lookup_idx` / `ocr_results_lru_idx` | ocr_results | |
| `login_tickets_expires_idx` | login_tickets | `(expires_at) where status='pending'` |
| `questions_*` / `materials_*` | 空转表 | 0009/0010 |

### 7.3 慢查询风险点

| 风险 | 说明 | 处置 |
|---|---|---|
| **关键词 `ilike` 全表扫** | `content->>question` 等的模糊匹配无索引；`%kw%` 前缀通配即便加 B-tree 也不生效 | 当前数据量（单用户千级）可接受；若需优化 → PostgreSQL `pg_trgm` GIN 索引或全文检索（登记 OPS-18） |
| **跨表统计** | 总览页 4 个并行 count，每个都带 user_id（走索引前缀），暂无风险 | 保持并行；禁止改成串行 |
| **jsonb 过滤** | `content->>status = 'pending'` 无索引 | 同上，数据量小；必要时加表达式索引 |

### 7.4 查询优化约定

1. **每个查询必须 `.eq('user_id', userId)`**（无 RLS，见第 8 章），由 `check-isolation.mjs` 静态门禁把关。
2. **只取需要的列**：列表不 select `content`（jsonb 可能很大），详情页才取。
3. **避免 N+1**：学科名用 `subjects(id,name)` 内嵌 select 一次带出，不逐条查。
4. **分页用 `range(from, to)`**，且必须与 `order` 同时给（否则分页不稳定）。
5. **删除必须 `.select('id')` 校验行数**——否则越权删除会"返回 200 但一行没删"，无法察觉。

---

## 8. 数据隔离

### 8.1 现状：RLS 未启用，隔离靠代码

- `0002_fresh_schema.sql` 里 RLS 的 `alter table ... enable row level security` 与 policy **全部处于注释状态**；
- 后端以 **service_role** 连接，**service_role 天然绕过 RLS**；
- 且本项目登录体系不发 Supabase JWT ⇒ 即使启用 RLS，`auth.uid()` 取不到值，policy 也写不出来。
- 唯一例外：`ocr_results`（0016）**启用了 RLS 但故意不建 policy** ⇒ 客户端完全不可访问，只有 service_role 能读写。这是"最严格的隔离"，不要给它补 policy。

⇒ **代码层 `.eq('user_id', userId)` 是唯一隔离手段。**

### 8.2 风险与缓解

| 风险 | 缓解措施 |
|---|---|
| 新增查询漏写 `user_id` ⇒ 越权读 | **静态门禁**：`node server/scripts/check-isolation.mjs`（扫描 `server/src` 下所有 `.from()` 调用点，向后看 12 行内必须出现 `.eq('user_id'`，否则 exit 1）。CI / 提交前必跑 |
| 删除未校验行数 ⇒ 越权删"返回 200 但一行没删" | 所有 `delete()` 必须 `.select('id')` 并校验返回行数（DD-09 有统一封装约定） |
| 前端传 `user_id` 被信任 | `user_id` **一律由后端从身份令牌解析后强制写入**；所有 `Create*Dto` 不含 `user_id` 字段 |
| 全局表被误当业务表读写 | `requireAdmin()` 保护全局表写操作；`check-isolation.mjs` 的表级白名单逐条有据 |

**门禁豁免规则**（有意设计，不可为过检而删检查）：

- 表级白名单：`knowledge_articles`（全局）、`blob_objects`（内容寻址，按 content_hash 查）、`health_check`（运维探针）、`users`（身份表，按 id/open_id/device_id 限定）；
- 文件级白名单：`maintenance.service.ts`（cron 全表扫描）、`tier-stats.service.ts`（容量统计）、`supabase-db.provider.ts`（通用出口，where 由调用方给）；
- `insert` 链：隔离靠 payload 里的 `user_id`，由 code review + DTO 不含该字段共同保证。

### 8.3 未来启用 RLS 的前提

1. 接入 Supabase Auth（或自建 JWT 并用 `anon key + 自定义 claim`）⇒ `auth.uid()` 可用；
2. 后端从 service_role 切到"按用户 JWT 访问"，或保留 service_role 但把 RLS 当作第二道防线；
3. 逐表补 policy，并跑一轮回归（特别是全局表与 content 寻址表）。
改造量评估与决策记录见 **OPS-18**。当前以静态门禁 + 代码评审作为等效防线。

---

## 9. 生命周期与清理

### 9.1 `blob_objects` 引用计数模型

**核心契约（顺序不可颠倒，否则误删共享文件）**：

1. **上传**：先 `acquire(hash)`。命中已有 `content_hash` ⇒ `ref_count++` 且**复用 `storage_key`，调用方不要再上传对象存储**；未命中 ⇒ 返回 `existed=false`，调用方才去上传，再 `register()`（ref_count 初始化为 1）。
2. **删除**：只 `release(hash)`（`ref_count--`）。归零时返回 `shouldDelete=true`，**由调用方决定删文件**；仍 >0 则**绝不能删**（别的用户还在用）。
3. **GC**：`collectOrphanBlobs` 真删对象存储 + 清登记行。

⚠️ **PostgREST 没有原子自增**：用「读-改-写 + CAS 乐观校验」——更新时带 `ref_count=旧值` 作为条件，未命中则重读重试。极端并发下少计只会让 blob 提前进入待回收队列（GC 前还会做孤儿二次核对），**安全方向正确**。

⚠️ **两条最危险的误用**（代码注释里已反复标注）：

- `register()` **不覆盖已有的正式记录**（尤其 `kind='image'`）——一次 temp 上传把正式资产"降格"成 temp，24h 后 GC 删掉 ⇒ **已保存的图片裂掉**；
- `registerTemp()` 若该内容已登记过（无论 image 还是 temp）**直接复用、不改任何字段**。

⚠️ **条目层查重必须在 ingest 之前**：按 `(user_id, file_hash)` 查到已有条目则复用/从回收站 restore。**若在 ingest（acquire）之后才发现重复且不建条目，ref_count 会虚高，导致 blob 永不回收**（2026-10-25 修，见 DD-12）。

### 9.2 定时任务（`maintenance.service.ts`）

| 任务 | 频率 | 作用 | 判据 |
|---|---|---|---|
| `cleanupExpiredAnonymous` | 每小时 | 过期匿名用户清理：收集其 `file_hash` → 删用户（级联删业务行）→ `release()` 释放引用。另有兼容分支：`file_hash` 为空的旧数据按 key 直接删（无 hash ⇒ 无共享可能，安全） | `is_anonymous and expire_at < now()` |
| `releaseSoftDeleted` | 每日 3AM | 软删超过宽限期的条目释放 blob 引用（扫 timeline_items / library_docs / documents） | `deleted_at < now() - 7d` |
| `collectOrphanBlobs` | 每日 4AM | **唯一真正删文件的地方**：删对象存储的所有派生档（original/display/thumb）→ 全部成功后才清登记行 | `ref_count=0 and last_ref_at < now() - 24h` |

关键常量：`SOFT_DELETE_GRACE_MS = 7d`（误删恢复窗口）、`BLOB_GRACE_MS = 24h`（防上传中途的短暂 0）。

### 9.3 安全阀

**所有"删文件"动作默认 dry-run**（`STORAGE_GC_DRY_RUN` 默认 `true`，只记日志不动手）。确认日志无误后设 `STORAGE_GC_DRY_RUN=false` 才真正执行。默认开启的理由：误删不可逆，宁可多看一轮日志。

⚠️ `collectOrphanBlobs` 只有**文件全部删成功**才清登记行，避免"行没了文件还在"。

### 9.4 软删 vs 硬删现状

- **业务表一律软删**（`deleted_at`），不物理删行；
- **对象存储靠 GC**：release 归零 + 静止 24h 后由 GC 真删；
- **用户级联删除**（`on delete cascade`）是唯一的物理删行路径：删 users ⇒ subjects / timeline_items / library_docs / documents / memories / memory_media / user_quota / answer_cache 全部级联删除。**先 release 再删用户**，否则 blob 变孤儿。

---

## 10. 迁移演进史

### 10.1 迁移清单（15 个文件，0002 → 0016）

| 文件 | 作用 | 备注 |
|---|---|---|
| `0002_fresh_schema.sql` | 全量重建 v4：users / subjects / timeline_items / library_docs / documents / health_check + 索引 + RLS（注释态） | 前提：当时库里全是测试数据，不迁移直接重建 |
| `0003_blob_dedup.sql` | 建 `blob_objects`（内容寻址 + 引用计数） | 全局物理去重地基 |
| `0004_thumb_columns.sql` | library_docs 补 thumb_key/width/height/file_hash；documents 补 file_hash | 对齐 timeline_items，消除资料库存储盲区 |
| `0005_quota_and_tiering.sql` | 建 `user_quota`；blob_objects 补 original_bytes/thumb_bytes | 配额（策略 6）+ 分层统计（策略 3） |
| `0006_memory.sql` | 建 `memories` + `memory_media` | 成长记忆 |
| `0007_chat_schema.sql` | 建 `knowledge_articles` + `chat_messages` | ⚠️ 原名 `0003_chat_and_storage_schema.sql`，与 0003_blob_dedup 撞号 |
| `0008_updated_at_trigger.sql` | 库级 BEFORE UPDATE 触发器自动刷新 `updated_at` | ⚠️ 见 10.2 铁律 |
| `0009_questions_and_materials.sql` | 补建 `questions` / `materials` | 这两张表是扣子时代手工建的，从未写进迁移脚本，0002 重建后丢失 |
| `0010_review_book.sql` | questions / materials 加 `in_review_book` / `added_to_review_at` | ⚠️ 原为 0001，因依赖 0009 建表而改号 |
| `0011_user_device_id.sql` | users 加 `device_id` + 部分唯一索引 | 匿名身份按设备持久化 |
| `0012_login_tickets.sql` | 建 `login_tickets` | ⚠️ user_id 必须是 varchar(36)（原写 uuid 报 42804） |
| `0013_mime_type_widen.sql` | documents / library_docs 的 mime_type 64 → 128 | docx MIME 71 字符导致静默入库失败 |
| `0014_answer_cache.sql` | 建 `answer_cache` | 应对 ima 每日调用配额 |
| `0015_library_netdisk_path.sql` | library_docs 加 `netdisk_path` | 百度网盘归档副本登记（主存储仍为主，网盘只是副本） |
| `0016_ocr_result_cache.sql` | 建 `ocr_results`（全局 OCR 结果缓存，启用 RLS 无 policy） | 同文件只识别一次 |

### 10.2 迁移纪律（写死）

1. **编号必须唯一**。曾有两个 `0003_*.sql`，手工执行时只跑了其中一个 ⇒ 表没建起来且当时误判为"执行成功"。
2. **`0008_updated_at_trigger.sql` 只覆盖执行时已存在的表** ⇒ **新建任何带 `updated_at` 的表后，必须 `node server/scripts/migrate.mjs --force --only 0008_updated_at_trigger.sql` 重跑一次**。
3. **迁移文件只增不改**。已执行的记录带内容 sha256，改内容会被识别为"已执行但内容已变更"并跳过（需 `--force`）。
4. **全部幂等**：一律 `create table if not exists` / `add column if not exists` / `create index if not exists`，可反复执行。
5. **外键类型对齐**：`users.id` 是 `varchar(36)`，新表 `user_id` 必须同型。
6. **全局表写操作**必须走 `requireAdmin()`；新表若属全局（非按用户隔离），同步在 `check-isolation.mjs` 的表级白名单里加注理由。

### 10.3 废弃表清理流程（`knowledge_articles` / `health_check`）

1. 全仓搜索确认无读写引用（`grep -rn "knowledge_articles\|health_check" server/src src`）；
2. 备份：`pg_dump` 单表或 Supabase 面板导出；
3. 写新迁移 `0017_drop_deprecated.sql`，内容为 `drop table if exists ...`（**只增不改，不回头改 0002/0007**）；
4. 同步更新本文第 2/3 章表清单、ADD-06（若有接口影响）、`check-isolation.mjs` 白名单；
5. 在 OPS-18 关闭对应技术债条目。

---

## 11. 变更流程：新增表 / 字段的标准动作

```
1. 写迁移文件 migrations/001N_xxx.sql（编号唯一、全幂等、user_id 用 varchar(36)）
2. node server/scripts/migrate.mjs --ping          # 先验证连接
3. node server/scripts/migrate.mjs --dry           # 预演：确认只执行预期文件
4. node server/scripts/migrate.mjs                 # 执行
5. 若新表带 updated_at：
   node server/scripts/migrate.mjs --force --only 0008_updated_at_trigger.sql
6. node server/scripts/check-isolation.mjs         # 隔离门禁（新表若属全局，加白名单并写理由）
7. 更新本文：第 2 章 ER、第 3 章表清单、第 4 章表结构、第 5 章数据字典（如有新枚举）、第 7 章索引
8. 若影响接口：更新 ADD-06；若影响缓存失效：更新 DD-13
9. 提交时按「迁移 SQL」与「代码」拆成独立 commit
```

---

## 12. 备份与恢复

### 12.1 现状

| 项 | 状态 |
|---|---|
| Supabase 侧自动备份 | **【待确认】** 当前是否开启定期备份未在项目中验证。免费档 Supabase 不提供 PITR，仅付费档有每日备份 |
| 本地导出 | `pg_dump "$DATABASE_URL" > backup_$(date +%Y%m%d).sql`（需本机安装 pg 客户端） |
| 迁移脚本幂等性 | ✅ 全部幂等，可在空库上一键重建全部表结构（**只含结构，不含数据**） |
| 恢复演练记录 | ⬜ 尚无 |

### 12.2 风险登记

若确认无定期备份 ⇒ 登记为 **OPS-18 风险项**（数据不可恢复）。建议最低动作：

- 每次发布前手动 `pg_dump` 一次，落 `key/`（已被 gitignore）或外部盘；
- 对象存储侧：blob 有引用计数保护，误删风险低于数据库行。

---

## 变更记录

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v0.0 | 2026-10-23 | 建立提纲（待审） |
| v1.0 | 2026-10-27 | **正文完成**。按 `migrations/` 复核校正表清单为 **17 张**（新增 answer_cache / ocr_results）；补齐 12 章正文：ER 与三条结构约定、逐表字段表、`timeline_items.content` 完整 schema 与演进、索引清单与查询热路径、隔离门禁（check-isolation.mjs）豁免规则、blob 引用计数三条契约与三类定时任务、迁移演进史 15 个文件与 6 条纪律、变更流程 9 步、备份现状与待确认项 |
| v1.1 | 2026-10-27 | **表分类订正**：`knowledge_articles` 由「废弃」改判为**活跃全局表**（实证 `chat.service.ts` 的 `getActiveArticles()` 读取 `is_active=true` 文章拼进 system prompt，写操作走 `requireAdmin`）⇒ 分类改为 **活跃 13 + 备用 1 + 空转 2 + 废弃 1**，2.3 节由「非活跃 5 张」改为「4 张」并附订正说明。与 OPS-18 `R-工程-01` 对齐 |
