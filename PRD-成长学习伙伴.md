# 成长学习伙伴 · 产品需求与设计文档

> 文档类型：PRD + 数据模型 + API 契约（"需求/设计"层）
> 配套视觉规范：仓库内 `DESIGN.md`（气质/配色）、`design_guidelines.md`（组件/导航规范）——**本文档不重复视觉，直接复用**
> 技术底座：Taro 4 + React + TypeScript 前端 / NestJS + Drizzle ORM + Zod 后端（pnpm monorepo）
> 状态：草案 v0.5（在 v0.4 之上新增「两级内容结构」：最近题目=采集收件箱/全量原始资料，复习本=经"加入复习本"筛选的子集；两列表交互统一；范围仍收敛于学科支柱，生活支柱与周报列入后续规划；数据库 SQLite 优先、OCR 微信官方优先 / Doubao 兜底、海外用户与数据驻留分析、用户分层与数据隔离）

---

## 0. 背景与文档边界

本项目仓库名为 `Growing-Kids`，代码内产品名为「成长学童」，此前已按 **错题巩固系统 / 复习本** 搭建了前端骨架与后端模块结构。

项目简介：

> 伴随孩子一起成长的学习伙伴，孩子可以在这里添加自己的在学科上或生活上的相关内容，一起成长、共同进步。

**本期范围决策（已与需求方确认）**：

1. **学科支柱（本期设计）**：以现有错题巩固能力为核心，做完整的"错题采集 → 结构化 → 复习 → 管理"闭环。
2. **生活支柱（列入后续规划，本期不设计）**：简介中的"生活上的内容"暂不作为本期设计范围，仅在第 8 节列出方向。
3. **周报功能（本期去除）**：不再设计周报聚合与 DOCX 周报导出，相关表/接口/页面从本文档移除。
4. 文档边界：只覆盖**产品需求、信息架构、数据模型、API 契约**，以及本期新增的**数据库选型、OCR 方案、隐私功能、微信海外用户与数据驻留**分析。视觉、组件、配色见仓库既有设计文档，直接复用。

---

## 1. 产品定位

| 项 | 内容 |
|---|---|
| 一句话定位 | 为孩子打造的"错题本"：拍照/相册把做错的题沉淀下来，结构化整理、按学科复习，把"错过的题"真正弄懂。 |
| 核心价值 | 学科上"把错过的弄懂"——采集、整理、复习、回溯。 |
| 本期支柱 | **学科（Study）**：错题采集 → 结构化 → 复习 → 管理。 |
| 后续支柱 | **生活（Life）**：成长记录（文字/图片/语音）→ 时间线（见第 8 节，本期不设计）。 |
| 目标用户 | 小学生/初中生（主使用者）+ 家长（共成长、查看）。 |
| 形态 | 微信小程序为主（现有 Taro 已支持 H5 / 抖音小程序多端编译）。 |

**与简介的对齐**：本期落地简介中"学科上的内容"部分（错题/知识点）；"生活上的内容"延后至后续规划，避免 scope 过大。

**设计语言复用原则**：复用 `DESIGN.md` 的"纸感错题本"美学（米白纸底 `#FAF8F3`、墨字 `#2A2825`、朱砂红 `#BE3E2D` 点睛、细边框、极淡阴影）。学科色标签仅用于**学科相关**元素。

---

## 2. 目标用户与角色

| 角色 | 说明 | 典型动作 |
|---|---|---|
| **孩子（主用户）** | 记录错题、按学科复习、看图回顾 | 拍照录题、校正、翻看、标记已复习 |
| **家长（共成长者）** | 查看孩子错题本、轻度引导 | 浏览学科分布、了解薄弱点 |

权限模型保持轻量：v1 以**单账户（微信 openid）**为主，家长通过同一微信账号查看。家庭/多角色关系、独立家长账号列入后续规划（第 8 节）。

**用户身份分层与数据归属（v0.4 新增）**：
- **授权用户**：完成微信登录（取得 openid）并同意隐私说明的用户，拥有**长期持久化**的个人数据空间（"自己的数据表"），可长期保存错题与学科。
- **临时用户（未授权 / 游客）**：未登录或未授权即使用功能的用户，系统为其建立**临时数据空间**存放本次临时内容；该空间在用户**断开小程序 24 小时后自动删除**，且使用前 / 使用中需向用户明确提示"内容为临时保存、将于断开 24 小时后清除，登录后可长期保留"。
- **隔离强制**：无论授权或临时，每位用户**只能查看 / 编辑 / 删除自己的数据，彼此完全隔离**，无法查阅或改动他人资料。后端所有数据查询必须按用户身份作用域执行（见第 5.4 节）。

**关于孩子档案（本期弱化）**：昵称、年级、头像、学校等**均不要求填写**；新用户可零资料直接开始拍照录题。档案字段保留为可选能力，填了更好（如按年级推荐），不填不影响任何功能。

---

## 3. 功能需求

### 3.1 学科 · 错题巩固（本期核心）

> **两级内容结构（v0.5 新增，规范数据模型）**：所有采集到的内容（原始图片、OCR 草稿、手动录入、结构化错题）统一进入 **「最近题目」**（采集收件箱 / 全量原始资料）；用户从最近题目中点 **「加入复习本」** 后，该条目才进入 **「复习本」** 供主动复习。**复习本是最近题目的子集**——二者共享同一底层条目，仅成员资格不同。最近题目中的内容是"初始的原始资料或过程资料"，复习本是经挑选的复习清单。

- **F-S1 错题采集**：拍照/相册上传试卷或手写题 → OCR 识别 → 返回结构化候选（题干/学生作答/正确答案/解析/学科建议）。采集结果先落入「最近题目」。
- **F-S2 结构化录入**：手动校正识别结果，填写 学科、标签、错因、掌握度；支持多图。
- **F-S3 加入复习本**：在「最近题目」列表中，对任一条目提供 **「加入复习本」** 操作（支持单选，或长按多选后批量加入）；加入后该条目同时出现在「复习本」；支持从「复习本」移出（退回为仅最近题目）。**只有加入复习本的条目才在复习本页面显示**（见 F-S4）。
- **F-S4 复习本管理**：复习本 = `inReviewBook=true` 的条目集合，可按学科 Tabs 浏览，支持关键词搜索、标签筛选、收藏、删除；列表卡片复用现有 `question-card`。
- **F-S5 复习与掌握度**：记录复习次数，依据掌握度（0–100）与下次复习时间做轻量间隔复习提醒（Leitner 思路，v1 可先做"待复习"标记）。
- **F-S6 列表交互统一（v0.5 新增）**：「最近题目」与「复习本」两个列表**复用同一套交互能力**——长按进入选择态、多选、批量删除、点击图片放大预览。即复习本既有列表功能全部下放至最近题目，保证两个列表的体验一致。

### 3.2 账户与设置

- **F-A1 微信登录**：`code2Session` 换取 openid + JWT（现有 `auth` 模块模式）；未登录时进入**临时模式**。
- **F-A2 孩子档案（可选，不强制）**：昵称、年级、头像、学科管理（增删学科、绑定学科色）。**不填写也可正常使用**。
- **F-A3 设置**：清空缓存、关于、隐私说明（儿童数据最小化，见第 11 节）。
- **F-A4 临时用户提示与转化**：临时用户进入时提示"当前为临时模式，数据将在断开 24 小时后清除"；提供"登录保留"入口（授权后临时数据可迁移至个人长期空间，v1 可仅提示不迁移，见第 5.4 节）。

### 用户故事（节选）

- 作为**孩子**，我想拍照把做错的题存进本子，这样不用手抄、也不会丢。
- 作为**孩子**，我不想一上来就填一堆资料，能直接拍照录题最好。
- 作为**孩子**，我想把刚拍的题先都收在「最近题目」里，挑出真正要练的再「加入复习本」，不用一上来就整理。
- 作为**孩子**，我希望在「最近题目」里也能长按多选、删掉不要的、点开大图看清楚，和复习本里一样好用。
- 作为**孩子**，我想按学科翻看错题，并知道哪些还没复习熟。
- 作为**家长**，我想看看孩子这阵子哪科错得多，和他聊聊。

---

## 4. 信息架构与导航

### 4.1 TabBar（本期 2 Tab）

| Tab | 页面 | 图标（lucide-react-taro） | 说明 |
|---|---|---|---|
| 首页 | `pages/index/index` | `House` | 概览、学科入口、**最近题目（采集收件箱 / 全量原始资料）**、识别主操作；列表支持「加入复习本」与统一交互 |
| 复习本 | `pages/subject/index` | `NotebookPen` | 经「加入复习本」筛选的子集：学科 Tabs + 复习条目列表（仅 `inReviewBook`） + 搜索 |

> 普通页（识别 `pages/recognize`、详情 `pages/detail`）沿用 `navigateTo`；Tab 间用 `switchTab`。图标生成方式见仓库 README "TabBar 图标生成"。"文档/成长"类 Tab 本期不纳入，见第 8 节后续规划。

### 4.2 页面树（本期）

```
pages/
├─ index/        首页（概览 + 学科入口 + 最近题目[全量收件箱] + 识别 CTA + 加入复习本）
├─ subject/      复习本（学科 Tabs + 复习条目列表[仅 inReviewBook] + 搜索）
├─ recognize/    识别录入（拍照/相册 → OCR → 校正）
└─ detail/       错题详情
```

### 4.3 关键流程

- **识别录入**：首页 CTA → `recognize` 拍照 → 上传 `/api/upload` → `/api/ocr/recognize-*` → 校正表单 → `POST /api/questions`（落入「最近题目」）。
- **加入复习本**：`index` 最近题目列表 → 长按/多选 → 「加入复习本」 → `POST /api/questions/:id/review-book`（或批量 `POST /api/questions/review-book`）→ 该条目 `inReviewBook=true`，同步出现在 `subject` 复习本。
- **复习标记**：`detail` 页"标记已复习" → `PATCH /api/questions/:id`（掌握度/复习次数/下次复习时间更新）。

---

## 5. 数据模型

### 5.1 实体关系（概览）

```
User(1) ──< UserProfile(0..1, 可选)   # 微信用户 + 可选孩子档案（不强制）
User(1) ──< Subject(*)               # 学科，绑定学科色
User(1) ──< Question(*)              # 条目（题目/原始资料），subject_id → Subject；inReviewBook 标记是否进入复习本（复习本=该字段为 true 的子集）
User(1) ──< OcrTask(*)               # 识别任务（记录调用与结果）
User(1) ──< Material(*)              # 素材（已有 materials 模块）
```

> 已移除：生活记录（life_records）、周报（weekly_reports）——均列入后续规划，本期不建表。

### 5.2 Drizzle Schema 草案（SQLite 方言 · v1 落地版；升级 PG 见第 9 节）

```typescript
// server/src/db/schema.ts  （Drizzle SQLite 方言；切换 PG 见第 9 节 9.3）
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

// 主键：应用层用 crypto.randomUUID() 生成后写入（SQLite 无原生 uuid 类型）
const pkId = () => text('id').primaryKey()

// ---------- 用户与档案（档案可选） ----------
export const users = sqliteTable('users', {
  id: pkId(),
  openid: text('openid').unique(),          // 授权用户有值；临时用户为 NULL
  guestToken: text('guest_token').unique(), // 临时用户会话标识；授权用户为 NULL
  tier: text('tier').notNull().default('authorized'), // authorized | temporary
  nickname: text('nickname'),          // 可选
  avatar: text('avatar'),              // 可选
  lastActiveAt: integer('last_active_at', { mode: 'timestamp' }), // 最近活动（临时用户清理依据）
  expiresAt: integer('expires_at', { mode: 'timestamp' }),        // 临时用户数据过期时间；授权用户为 NULL
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
})

// 可选档案：不强制填写，所有字段可空
export const userProfiles = sqliteTable('user_profiles', {
  id: pkId(),
  userId: text('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  displayName: text('display_name'),   // 孩子昵称（可选）
  grade: text('grade'),                // 年级（可选）
  school: text('school'),              // 学校（可选）
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
})

// ---------- 学科 ----------
// colorKey 对应 design_guidelines.md 的学科索引色（SQLite 无原生 enum，用 text + 应用层约束取值）
export const subjects = sqliteTable('subjects', {
  id: pkId(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),          // 语文 / 数学 …
  colorKey: text('color_key').notNull().default('gray'), // rose|blue|emerald|cyan|violet|green|red|amber|orange|gray
  sort: integer('sort').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
})

// ---------- 错题（本期核心） ----------
export const questions = sqliteTable('questions', {
  id: pkId(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  subjectId: text('subject_id').references(() => subjects.id, { onDelete: 'set null' }),
  content: text('content').notNull(),            // 题干
  answer: text('answer'),                        // 正确答案
  analysis: text('analysis'),                    // 解析
  sourceType: text('source_type').notNull().default('photo'), // photo | text
  imageUrls: text('image_urls'),                 // JSON 字符串数组（SQLite 无数组类型）
  wrongReason: text('wrong_reason'),              // 错因
  tags: text('tags'),                             // JSON 字符串数组
  mastery: integer('mastery').notNull().default(0), // 0–100 掌握度
  reviewCount: integer('review_count').notNull().default(0),
  nextReviewAt: integer('next_review_at', { mode: 'timestamp' }),
  favorite: integer('favorite', { mode: 'boolean' }).notNull().default(false),
  inReviewBook: integer('in_review_book', { mode: 'boolean' }).notNull().default(false), // 是否加入复习本；复习本=该字段为 true 的子集
  addedToReviewAt: integer('added_to_review_at', { mode: 'timestamp' }), // 加入复习本时间（复习本排序依据；未加入为 NULL）
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
})

// ---------- 识别任务 / 素材（已有模块对齐） ----------
export const ocrTasks = sqliteTable('ocr_tasks', {
  id: pkId(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  imageUrl: text('image_url').notNull(),
  provider: text('provider'),                    // wechat | doubao（记录实际调用的识别方，支撑兜底统计）
  status: text('status').notNull().default('pending'), // pending|done|failed
  resultJson: text('result_json'),               // JSON 字符串
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
})

export const materials = sqliteTable('materials', {
  id: pkId(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type'),
  url: text('url').notNull(),
  relatedQuestionId: text('related_question_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
})
```

> SQLite 差异注意：`image_urls`/`tags` 用 JSON 字符串存储并在应用层序列化；时间戳用 `integer(timestamp)`（unix 秒）；布尔用 `integer`；需在连接层开启 `PRAGMA foreign_keys=ON` 才能让 `onDelete` 生效；搜索由 FTS5 虚拟表支撑（见第 9 节）。

### 5.3 字段说明（节选）

| 表 | 关键字段 | 说明 |
|---|---|---|
| `userProfiles` | 全部可空 | **可选档案**，不填也能用；`userId` 唯一，存在即代表填过 |
| `subjects.colorKey` | 学科色 | 映射到 `design_guidelines.md` 学科索引色，前端用 `rose-600` 等类名渲染 |
| `questions.mastery` | 掌握度 0–100 | 驱动复习提醒与"薄弱点"统计 |
| `questions.inReviewBook` | 是否加入复习本（bool） | 两级结构核心字段：**最近题目=全部条目，复习本=该字段为 true 的子集**；「加入复习本」置 true，「移出复习本」置 false |
| `questions.addedToReviewAt` | 加入复习本时间 | 复习本列表排序依据；未加入为 NULL |
| `questions.tags` | 文本数组 | v1 用数组简化；如需统计可规范化到 `tags` 表 |
| `ocrTasks.resultJson` | 识别结果 | 留痕便于排查与后续复核 |

---

### 5.4 用户数据隔离与生命周期（授权长期 / 临时 24 小时清理）

#### 5.4.1 身份分层

| 类型 | 标识 | 数据空间 | 生命周期 |
|---|---|---|---|
| **授权用户** | `openid`（登录后取得） | 个人长期空间（"自己的数据表"） | 持久保存，直至用户主动删除 |
| **临时用户（未授权 / 游客）** | `guestToken`（本地生成，未登录） | 临时空间 | 断开小程序 **24 小时后**自动清除 |

- 临时用户无 `openid`（`users.openid` 为 NULL），以 `guestToken` 唯一标识本次会话；`users.expiresAt` 记录清理时刻。
- 授权用户 `tier='authorized'`、`expiresAt` 为 NULL；临时用户 `tier='temporary'`、`expiresAt = 最近活动 + 24 小时`。

#### 5.4.2 隔离强制（安全基线）
- **行级作用域**：所有数据访问必须带用户身份过滤（授权用户按 `openid`→`user.id`，临时用户按 `guestToken`→`user.id`），任何列表 / 详情 / 更新 / 删除接口**不得跨用户返回或操作数据**。
- **越权拦截**：在 NestJS 守卫（Guard）或拦截器中统一注入当前 `userId`，service 层查询强制 `where userId = :current`，从架构上杜绝越权（呼应第 11 节隐私设计）。
- **物理隔离备选**：若需更强隔离，可为**每位授权用户使用独立 SQLite 库文件**（`data/{openid-hash}.db`，复用第 5.2 节同一套表结构），天然实现"自己的数据表"，且单用户导出 / 删除（被遗忘权）即删文件；PG 阶段再合并为分区表。v1 推荐先用逻辑分区（`user_id` 列）以简化运维，物理隔离作为加固选项。

#### 5.4.3 临时数据清理
- **触发**：以"最近一次请求时间 `lastActiveAt` + 24 小时"近似判定用户断开小程序，到点清除（小程序无可靠的服务器端"断开"事件，故以活跃超时近似）。
- **实现**：后端定时任务（NestJS `@nestjs/schedule` 或云函数定时触发器）扫描 `users` 中 `tier='temporary' AND expiresAt <= now()`，级联删除该用户及其 `subjects / questions / ocr_tasks / materials`（依赖 `onDelete: 'cascade'`）。
- **用户提示**：临时用户进入功能前与使用中，明确告知"当前为临时模式，内容将于断开 24 小时后清除；登录后可长期保留"，并提供登录入口（F-A4）。

#### 5.4.4 临时 → 授权 的数据处置
- v1 最简策略：**临时数据不自动迁移**，仅提示用户登录以长期保存（避免授权前后数据归属复杂化）。
- 若后续要支持"先试用后登录保留"，可在授权时按 `guestToken` 找到临时用户行，写入 `openid`、置 `tier='authorized'`、`expiresAt = NULL`，实现无缝迁移（列入后续规划）。

---

## 6. API 契约

### 6.1 通用约定

- **前缀**：所有接口以 `/api` 开头（已在 `main.ts` 设置 `setGlobalPrefix('api')`）。
- **统一响应**（复用 README 的 `TransformInterceptor` 思路）：
  ```json
  { "code": 200, "data": <T>, "message": "success" }
  ```
- **鉴权**：`Authorization: Bearer <JWT>`。授权用户令牌由微信 `code2Session` 签发（含 `userId`）；**临时用户**未登录时由后端签发 `guest` 令牌（含 `guestToken`），其数据写入临时空间、受同一套隔离约束，24 小时后随临时用户清理（见第 5.4 节）。
- **校验**：请求体用 **Zod** 校验（见 README 示例），失败返回 400 + 字段错误。
- **分页**：列表接口支持 `?page=&pageSize=`，响应 `data` 含 `{ items, total }`。

### 6.2 端点清单（本期）

| 模块 | 方法 | 路径 | 说明 |
|---|---|---|---|
| 鉴权 | POST | `/api/auth/login` | `code` → `{ token, user }`（授权登录）；未传 `code` 时返回 `guest` 临时令牌进入临时模式 |
| 学科 | GET | `/api/subjects` | 列表（按 sort） |
| 学科 | POST | `/api/subjects` | 新增学科（name, colorKey） |
| 学科 | PATCH | `/api/subjects/:id` | 改名/改色/排序 |
| 学科 | DELETE | `/api/subjects/:id` | 删除 |
| 错题 | GET | `/api/questions` | 列表，支持 `?scope=recent\|review&subjectId&keyword&tag&favorite`（`recent`=最近题目全量，`review`=仅复习本；默认 `recent`） |
| 错题 | POST | `/api/questions` | 新增错题（见 6.3），默认 `inReviewBook=false`（落入最近题目） |
| 错题 | GET | `/api/questions/:id` | 详情 |
| 错题 | PATCH | `/api/questions/:id` | 更新（含掌握度/复习） |
| 错题 | DELETE | `/api/questions/:id` | 删除 |
| 复习本 | POST | `/api/questions/:id/review-book` | 加入复习本（置 `inReviewBook=true`、`addedToReviewAt=now`） |
| 复习本 | DELETE | `/api/questions/:id/review-book` | 移出复习本（置 `inReviewBook=false`、`addedToReviewAt=NULL`） |
| 复习本 | POST | `/api/questions/review-book` | 批量加入复习本（body `{ ids: string[] }`） |
| 上传 | POST | `/api/upload` | 图片 → 对象存储 URL |
| 识别 | POST | `/api/ocr/recognize-exam` | 试卷图片 → 结构化候选（现有 `ocr` 模块） |
| 识别 | POST | `/api/ocr/recognize-exam-url` | 图片 URL → 结构化候选 |
| 识别 | POST | `/api/ocr/recognize-pair` | 题目图 + 答案图分别上传 → 关联成题 |
| 识别 | POST | `/api/ocr/recognize-doc` | 文档（txt/doc/pdf 文本）→ 结构化 |
| 搜索 | GET | `/api/search?q=` | 跨错题检索（本期仅错题；生活记录后续纳入） |
| 系统 | GET | `/api/health` | 健康检查（已有） |

> 已移除：周报相关（`/api/weekly-reports/*`、`/api/documents/export`）、生活记录（`/api/life/*`）。

### 6.3 关键请求体（Zod 思路）

```typescript
// 错题（与现有 ocr 返回结构对齐）
createQuestionSchema = z.object({
  subjectId: z.string().uuid().nullable().optional(),
  content: z.string().min(1),
  answer: z.string().optional(),
  analysis: z.string().optional(),
  sourceType: z.enum(['photo', 'text']).default('photo'),
  imageUrls: z.array(z.string().url()).optional(),
  wrongReason: z.string().optional(),
  tags: z.array(z.string()).max(10).optional(),
  mastery: z.number().int().min(0).max(100).default(0),
})

// 学科
createSubjectSchema = z.object({
  name: z.string().min(1).max(20),
  colorKey: z.enum(['rose','blue','emerald','cyan','violet','green','red','amber','orange','gray']).default('gray'),
})

// 列表查询（两级结构）
listQuestionsSchema = z.object({
  scope: z.enum(['recent', 'review']).default('recent'), // recent=最近题目全量，review=仅复习本
  subjectId: z.string().uuid().optional(),
  keyword: z.string().optional(),
  tag: z.string().optional(),
  favorite: z.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

// 批量加入复习本
addToReviewBookSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
})
```

---

## 7. 与现有代码的衔接

### 7.1 可直接复用

| 现有资产 | 复用方式 |
|---|---|
| `DESIGN.md` / `design_guidelines.md` | 视觉与组件规范**全量复用** |
| `src/components/ui/*` | 所有 UI 走 `@/components/ui`（Button/Card/Input/Tabs/Dialog/Toast…） |
| `src/network.ts` + `src/services/api.ts` | 网络层与 API 客户端扩展即可，无需重写 |
| `src/components/question-card.tsx` | 错题卡片直接用 |
| `src/components/image-editor.tsx` / `material-picker.tsx` | 图片编辑/素材选择复用于识别录入 |
| `src/pages/{index,subject,recognize,detail}` | 学科侧页面骨架已存在，扩展内容 |
| 后端 `app.module.ts` 模块 | `subjects/questions/ocr/search/materials/image` 已规划，补实现 |

### 7.2 需要调整

- **聚焦学科闭环**：优先补全 `subjects` / `questions` / `ocr` / `search` 的业务实现。
- **移除/搁置**：`document` / `documents` / `pdf` 模块（原服务于周报/导出）本期不实现，保留空壳待后续规划。
- **数据层**：按第 5 节建立 Drizzle schema 与迁移（注意 `userProfiles` 设为可选）。
- **TabBar**：本期 2 Tab（首页/复习本），更新 `src/app.config.ts` 与对应 PNG 图标。

---

## 8. 后续规划（本期不设计，仅列方向）

| 方向 | 说明 | 影响 |
|---|---|---|
| **生活支柱** | 成长记录（文字/图片/语音）、时间线、可选关联学科；新增 `life` 模块、页面与 `life_records` 表 | 范围较大，独立一期 |
| **周报 / 导出** | 学科统计周报、DOCX 导出与打印（复用 `document`/`pdf` 模块） | 依赖生活支柱与统计能力 |
| **多角色 / 家长账号** | 独立家长视角、家庭关系、亲子共看 | 需账号体系扩展 |
| **复习计划智能化** | 基于掌握度的自动排程与提醒 | 依赖 `questions` 掌握度数据积累 |

---

## 9. 数据库选型与落地策略：SQLite 优先，按阈值升级 PostgreSQL

> 决策结论（v0.3 已定）：**v1 使用 SQLite**（或与其等价的边缘/云托管版，如 Cloudflare D1、微信云开发云数据库），不引入独立数据库服务；当用户规模 / 并发 / 能力需求超过下方阈值时，再评估迁移 PostgreSQL。第 5.2 节 Schema 已按 SQLite 方言编写。

### 9.1 为什么不一开始就上 PostgreSQL
- 儿童错题本的使用模式是**低频写、低频读、按用户维度隔离**，SQLite 完全够用，且**零运维、零成本、上线最快**。
- 后端 NestJS 可部署为常驻服务 + 挂载本地/挂载盘上的 SQLite 文件，或部署到 D1 / 微信云开发，即可满足 v1。
- Drizzle 抽象层使后续迁移成本可控（见 9.3）。

### 9.2 升级到 PostgreSQL 的触发阈值（建议）
出现以下**任意一项**即启动迁移评估：

| 触发信号 | 建议阈值（初值，可在 M3 复盘调整） | 说明 |
|---|---|---|
| 日活跃用户 DAU | **> 1 万** | 并发与连接数上升，SQLite 单写锁开始吃力 |
| 总错题量 | **> 50 万–100 万行** | 复杂查询/统计变慢，需索引与分区 |
| 写并发瓶颈 | 出现明显写锁等待、接口 P99 上升 | SQLite 库级写锁，多用户同时写受限 |
| 复杂查询需求 | 需要 JSONB、窗口函数、全文检索(FTS5 不足)、联表统计 | PG 类型/能力更完整 |
| 运维/高可用需求 | 需要自动备份、读写分离、多副本、故障转移 | PG 托管（RDS / Cloud SQL）更成熟 |

> 经验值：SQLite 可轻松支撑"单库几万用户、日均数千错题写入"级别；一旦逼近上述阈值，迁移到托管 PostgreSQL（腾讯云 / 阿里云 RDS，配合 ICP 备案）是自然路径。

### 9.3 迁移成本（Drizzle 视角）
- 切换方言导入：`sqlite-core` → `pg-core`，业务代码（Zod、service）基本不动。
- 主要改动：
  - 主键 `text`(uuid) → 原生 `uuid`；
  - JSON 文本字段 → `jsonb`；
  - 数组 `text`(JSON) → 原生数组或独立关联表；
  - 时间戳 `integer(timestamp)` → `timestamp`；
  - 枚举 `text` → `pgEnum`。
- 迁移量可控，建议在阈值触发前预演一次。

### 9.4 v1 部署形态建议
- **最小验证**：NestJS 常驻 + 服务器本地 SQLite 文件（适合早期）；
- **省运维**：Cloudflare D1（边缘 SQLite，适合云函数）或微信云开发云数据库；
- **搜索**：SQLite 用 **FTS5** 虚拟表支撑 `/api/search`；PG 阶段可换 `tsvector` 或专用搜索引擎。

---

## 10. OCR 方案分析（v0.3 策略：微信官方优先，Doubao 兜底）

### 10.1 当前实现到底是什么？

**不是自研模型。** 读取 `server/src/ocr/ocr.service.ts` 确认：它依赖 `coze-coding-dev-sdk` 的 `LLMClient`，调用多模态大模型 **`doubao-seed-2-0-pro-260215`**（字节跳动 Doubao 视觉大模型）。流程是——把试卷/题目图片或文档文本发给该大模型，用 system prompt（"你是一名严谨的中小学阅卷与错题整理助手"）约束其输出结构化 JSON（题干/学生错答/正确答案/解析/状态）。

也就是说，当前"OCR"本质是**调用第三方云视觉大模型做"理解式识别"**（介于传统 OCR 与 VLM 之间），并非自训练/自托管模型，也非传统 OCR 引擎（Tesseract/PaddleOCR）。

### 10.2 既定策略：微信官方识别优先，Doubao 作为兜底

按需求方最新决策，识别链路调整为**两级**：

1. **主识别：微信官方 / 腾讯云 OCR（数据不出境、微信原生）**
   - 路径：通过**微信云开发 CloudBase 内置能力**或**腾讯云 OCR API**（通用印刷体 / 手写体 / 数学公式 / 试卷切题）完成识别与结构化。
   - 优点：**用户图片留在腾讯云境内链路，不向第三方大模型外发**，合规与隐私压力最小；与微信小程序天然集成、延迟低、无需额外密钥体系。
   - 局限：对红笔批改、混排版面、复杂"学生错答 vs 正确答案"语义理解弱于视觉大模型，需后端补一层规则/模板后处理拼装错题结构。

2. **兜底：Doubao 视觉大模型（沿用现有实现）**
   - 触发条件：微信 / 腾讯 OCR **识别失败、置信度过低、或版面 / 手写过于复杂**时，回退调用 Doubao（`ocrTasks.provider` 记为 `doubao`，见第 5.2 节）。
   - 兜底时图片会外发给字节云，**需在隐私告知中明示**（见第 11 节），且应只在必要时触发。

### 10.3 自研/自托管 vs 调用第三方（对照）

| 维度 | 自研 / 自托管（PaddleOCR、开源 OCR） | 调用第三方（微信/Tencent OCR、视觉大模型） |
|---|---|---|
| 数据结构化 | 需自写后处理 | 微信 OCR 出文本块，大模型可直接出 JSON |
| 数据隐私 | 数据不出域，合规友好 | 微信 OCR 不出境；视觉大模型会外发图片 |
| 成本 | 前期投入大、边际成本低 | 按量计费、无运维 |
| 手写 / 批改理解 | 需专门训练 | 视觉大模型（Doubao）理解较好 |
| 运维 | 需 GPU / 服务 | 免运维 |
| 供应商锁定 | 无 | 有 |

**结论**：v1 走"微信官方优先 + Doubao 兜底"，对儿童试卷**优先留在境内链路**；待规模与合规要求提升，可将自托管 OCR 作为进一步降本/合规的备选。第 12 节关于海外用户的分析也表明：**保持识别链路在境内（微信 / Tencent OCR），是避免跨境数据传输的最直接手段**。

---

## 11. 隐私功能设计（示例）

儿童产品对隐私敏感，应在产品与工程两侧落实"数据最小化 + 监护人可控"。**本期即应落地**以下示例功能：

1. **资料最小化（呼应档案弱化）**：注册即可用，昵称/年级/学校/头像**全部可选**；不收集真实姓名与学校亦可正常使用。
2. **首次告知与同意**：首启弹《儿童隐私说明》，用孩子能懂的语言说明"我们会收集什么、用来做什么、会不会发给别人"，监护人点同意才启用识别等能力。
3. **识别数据外发明示**：因 OCR 调用第三方大模型，拍摄/上传前明确提示"图片将发送至云服务用于识别"；提供**"仅手动录入、不拍照识别"**的纯本地路径。
4. **去标识与匿名**：后端仅以 `openid` 关联用户，不存真实姓名/班级；错题图片中的姓名、班级建议**打码后再上传**。
5. **不出敏感人脸**：引导用户**不要拍摄含人脸的照片**上传至第三方；必要时前端检测提醒。
6. **传输与存储安全**：全链路 HTTPS；对象存储用**私有桶 + 限时签名 URL**，不公开直链。
7. **权限最小化**：小程序仅申请必要 `scope`（如相册/拍照），不强制申请定位等无关权限。
8. **监护人删除权（被遗忘权）**：设置页提供"**删除我的全部数据**"一键清除（用户 + 档案 + 错题 + 素材 + 对象存储文件）。
9. **服务端日志脱敏**：日志不记录 openid 全文、不记录图片内容、不包含答案明文（可按需哈希）。
10. **合规基线**：参照《儿童个人信息网络保护规定》及适用地区的儿童数据法规；跨境数据传输（如使用境外大模型）需额外评估与告知。

---

## 12. 微信海外用户与数据驻留分析（本次研究结论）

> 问题：微信海外用户能否使用本小程序？他们在小程序中产生的数据存储在国内还是国外？
> 前提：当前后端部署在**境内**、不涉及跨境数据传输（与需求方确认）。

### 12.1 海外用户能否使用？——结论：技术上可能，但需实测验证，v1 不承诺
- 微信存在两个体系：**微信（Weixin，+86 注册，国内版）** 与 **WeChat（国际版，非 +86 注册）**。小程序生态主要依托国内版微信[1]。
- 公开资料对"国际版用户能否用小程序"说法不一：有资料称国际版与国内版"可使用相同小程序"[2]；也有资料指出国际版用户**大多数小程序无法使用或功能受限**，因其依赖国内手机号、实名、支付、LBS 等能力[3]。
- 对**本小程序**的关键判断：它是**免费、纯内容创作（错题记录）、不依赖支付 / 实名 / LBS** 的工具，绕开了上述典型限制，因此即便国际版用户能打开，也应能正常使用核心功能。
- 但存在真实不确定性：微信可能按账号地区对小程序做分发 / 可达性限制，**国际版客户端未必能完整触达国内发布的小程序**。
- **建议**：v1 将"海外用户支持"列为**未验证 / 不在承诺范围**；若未来要服务海外华人家庭，应在上线前用真实国际版微信账号实测可达性与功能完整性，而非仅依据文档推断。

### 12.2 数据存在境内还是境外？——结论：取决于你的部署，与用户所在地无关
这是本问题的核心澄清：
- **小程序用户数据的存储位置，由开发者把后端部署在哪里决定，不由用户身处何地决定。**
- 微信自身的聊天服务器虽分境内外（国际版走境外节点），但那是微信的基础设施，**与你的小程序数据库无关**；你 App 的数据落在**你自建的数据库（SQLite 文件 / D1 / 云开发）**，而该库由你部署在境内。
- 因此，既然当前计划是**境内后端、无跨境传输**，那么**包括海外用户在内的所有用户数据，都存储在中国大陆服务器**——这正好契合"当前不涉及跨境数据传输"的前提，且**不构成 PIPL 下的数据出境**。

### 12.3 需注意的合规边界
- **第三方识别引入的出境**：一旦启用 Doubao 兜底（第 10 节），被兜底的那部分试卷图片**会外发至字节云（第三方）**，构成事实上的数据出境，需隐私明示与同意（第 11 节）。这也是"微信官方识别优先"策略的合规动机。
- **海外用户本地法**：若未来确有欧盟 / 其他地区居民使用，其所在地法律（如 GDPR）可能在数据主体权利方面提出额外要求，但**数据驻留在中国大陆本身并不违反 PIPL**；是否引入境外处理方才是跨境传输的判断点。
- **实操建议**：在隐私说明中写明"数据存储于中国大陆服务器"；若后续要服务海外用户且启用任何境外服务，单独做数据出境评估。

### 参考
- [1] 微信官方 / WeChat 介绍：https://www.wechat.com/
- [2] 微信国际版与国内版互通说明（含"小程序可用"表述）：http://www.kswsj.cn/article/cdschsg.html
- [3] WeChat 国际版差异分析（多数小程序国际用户受限）：https://www.whbydcc.com/wechat%E5%9B%BD%E9%99%85%E7%89%88/
- [4] 小程序服务器部署与数据合规（建议数据存境内）：https://www.phpwp.cn/article/99450.html

## 13. 里程碑（建议）

| 阶段 | 范围 | 产出 |
|---|---|---|
| **M0 对齐** | 本文档评审通过 | PRD 定稿 |
| **M1 数据层** | Drizzle schema + 迁移（含可选档案）+ 学科/错题/识别模块骨架 | 可跑后端（✅ 已完成：后端可启动并通过端到端冒烟测试） |
| **M2 学科闭环** | 补全 subjects/questions/ocr/search 实现 + 前端 4 页；含**首页「最近题目」全量收件箱 +「加入复习本」+ 两列表交互统一** | 错题本可用 |
| **M3 打磨** | 空状态/动效/隐私提示/小程序提审准备 | 可上线 |

> **M1 实施注记（v0.5.1）**：后端位于 `server/`（NestJS 11 + Drizzle ORM + Zod）。SQLite 驱动选用 **sql.js（纯 WASM、零原生依赖）**——沙箱中 `better-sqlite3` 预编译二进制与 glibc 不兼容（段错误）且 `node-gyp` 无法下载头文件（网络受限），故改用 sql.js；sql.js 为内存库，已通过 `export()` 主动落盘到 `./data/growing-kids.db`。已验证：临时/授权登录、24 小时临时用户清理、学科 CRUD、错题创建（图片/标签 JSON 序列化）、`scope=recent|review` 双列表、单条/批量「加入复习本」、行级用户隔离、无 token 返回 401。

> 生活支柱、周报导出、多角色家长账号列入后续一期（见第 8 节），不在 M0–M3。

---

## 14. 待确认事项（评审要点）

1. **数据库（已定）**：v1 用 SQLite（或 D1 / 微信云开发）。升级 PostgreSQL 的触发阈值见第 9 节（DAU > 1 万 / 错题 > 50–100 万 / 写锁瓶颈 / 需 JSONB·FTS·高可用）。
2. **OCR 供应方（已定）**：微信官方 / 腾讯云 OCR 优先（数据不出境），Doubao 视觉大模型仅作兜底（识别失败 / 版面复杂时），见第 10 节。
3. **隐私合规级别**：当前境内后端、无跨境传输；若启用 Doubao 兜底或扩展海外用户，需做数据出境评估与隐私明示（第 11、12 节）。
4. **识别兜底与本地录入（已定）**：默认走微信 OCR；Doubao 仅兜底；"纯手动录入"保留为隐私可选路径（第 11 节）。
5. **海外用户可达性（新增）**：v1 不承诺海外用户可用，需用国际版微信账号实测验证（第 12 节）。
6. **两级内容结构（已定）**：最近题目（全量收件箱/原始资料）与复习本（经「加入复习本」筛选的子集）共享同一 `questions` 条目，由 `inReviewBook` 字段区分；两列表交互统一（长按/多选/删除/图片放大）。见第 3.1、5.2、6.2 节。
