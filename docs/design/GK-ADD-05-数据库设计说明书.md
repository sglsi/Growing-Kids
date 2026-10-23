# GK-ADD-05 数据库设计说明书

> 编号：GK-ADD-05 ｜ 版本：v0.0（提纲） ｜ 日期：2026-10-23 ｜ 状态：提纲待审
> 读者：后端 / 运维 ｜ 上游：SRS-01 ｜ 下游：DD-09、DD-12、QA-16
> 定位：**15 张表**（活跃 10 + 备用 1 + 空转 2 + 废弃 2）的权威说明。**含数据字典**（原 SRS-03 的数据字典部分并入第 5 章）。
> ⚠️ 2026-10-24 校正：此前口径为 14 张，漏计了 `login_tickets`（`migrations/0012` 已建表但未启用）。以 `migrations/` 为准，共 15 张。

---

## 1. 概述与环境

**要写**：
- 数据库：PostgreSQL，托管在 Supabase（新加坡，Session pooler，IPv4）；
- 连接串获取方式（指向 `docs/获取DATABASE_URL-操作指引.md`，**本文不复制密钥**）；用户名必须是 `postgres.<ref>`；pooler 主机只能从 Connect 面板复制；
- 迁移器：`node server/scripts/migrate.mjs`（参数 `--ping / --dry / --force / --only <file>`）；
- 访问方式：后端统一走 Supabase client（service_role）。
**素材**：`server/scripts/migrate.mjs`、`docs/获取DATABASE_URL-操作指引.md`

## 2. 实体关系

**要写**：ER 图（表 + 主外键 + 一对多关系），并标注：
- `users` 为隔离根，其余业务表均带 `user_id`；
- `blob_objects` 被 `timeline_items` / `library_docs` / `memory_media` 等通过 `file_key` 引用（引用计数模型）；
- `timeline_items` 是核心表（统一收件箱），`subjects` 为其分类维表；
- 标出**非活跃表**（处置见第 10 章与 OPS-18），共 5 张：
  - *备用*（已建表、当前无读写）：`login_tickets` —— 为多副本部署 H5 扫码登录准备，当前单机部署票据走 `QrLoginService` 进程内存（重启即失效，用户重扫即可）；
  - *空转*（模块已接线但前端不调用）：`questions` / `materials`（v3 遗留）；
  - *已废弃待清理*（思傅 2026-10-24 确认登记为技术债）：`knowledge_articles`、`health_check`。
**素材**：`migrations/*.sql`
**已确认（思傅 2026-10-24）**：`knowledge_articles` / `health_check` **已废弃**，按技术债登记在 OPS-18 第 4 章；正常业务链路不得读写这两张表，清理前先确认无外部引用（清理流程见第 10 章）。

## 3. 表清单与职责

**要写**：逐表一行：表名 / 一句话职责 / 状态 / 主要写入方。已核实清单（15 张，2026-10-24 校正）：

| 状态 | 张数 | 表 |
|---|---|---|
| **活跃** | 10 | `users`、`timeline_items`、`subjects`、`library_docs`、`memories`、`memory_media`、`documents`、`blob_objects`、`user_quota`、`chat_messages` |
| **备用**（已建表、当前无读写） | 1 | `login_tickets`（`0012`，多副本部署升级用，见第 2 章） |
| **空转**（模块已接线、前端不调用） | 2 | `questions`、`materials` |
| **废弃待清理** | 2 | `knowledge_articles`、`health_check` |

**素材**：`migrations/` 全部 CREATE TABLE（12 个迁移文件：`0002`~`0013`，编号唯一；`0001` 已重排为 `0010_review_book.sql`）
**边界**：表清单以 `migrations/` 为唯一真相源——代码里 `.from('表名')` 的静态扫描**不完整**（部分访问走 RPC / 常量 / raw SQL），不得作为清单依据。

## 4. 表结构详述

**要写**：逐表给字段表（字段 / 类型 / 约束 / 默认 / 说明 / 是否索引）。重点表展开更细：
- `timeline_items`：kind、subject_id、content(JSON)、in_review_book、added_to_review_at、status、来源与创建时间、软删除策略
- `subjects`：名称、排序、是否系统预置
- `blob_objects`：file_key、size、mime_type、ref_count、created_at（孤儿 GC 依据）、thumb 列
- `user_quota`：配额项与计数、重置周期
- `login_tickets`：一次性票据、过期
- `memories` / `memory_media`：正文 + 媒体关联
**素材**：`migrations/0002_fresh_schema.sql`、`0003_blob_dedup.sql`、`0004_thumb_columns.sql`、`0005_quota_and_tiering.sql`、`0006_memory.sql`、`0007_chat_schema.sql`、`0010_review_book.sql`、`0011_user_device_id.sql`、`0012_login_tickets.sql`、`0013_mime_type_widen.sql`

## 5. 数据字典

**要写**：跨表统一口径的字段与枚举（值域必须写全，避免"0/1"无人懂）：
- 通用：`id`（uuid）、`user_id`、`created_at`、`updated_at`
- 枚举：`kind`（image / question）、`status`、`source`（search / ai / kb）、`purpose`（save / temp / memory / attach）、`category`（成长记忆分类）、`scope`（recent / review）、`range`（时间范围）
- 布尔语义：`in_review_book`、`is_anonymous`
- 易错字段：`subject_id` 为 NULL 表示未分类（前端哨兵 `'none'`，**列表查询必须转 NULL**）；`mime_type` 长度（曾因 docx 的 71 字符超长导致入库静默失败，0013 放宽至 128）
**素材**：`server/src/timeline/timeline.types.ts`、`src/types/index.ts`

## 6. 核心 JSON 结构（timeline_items.content）

**要写**：完整 schema + 演进说明 + 字段语义：
- `question`（题干）、`question_label`、`solution`（解题过程）、`question_images[]`、`answer_images[]`、`images[]`（旧版，仅兜底）、`answer_attachments[]`、答案与解析字段、`verified` 等；
- **演进**：老 `images` → 拆分为 `question_images` / `answer_images`；老字段已无消费者，仅兜底渲染与删除；
- **合并语义**：`PUT /api/timeline/:id` 为局部合并（未传字段不清空）——这是"只删图片不清题干"的隐式依赖；
- 允许"无题干只有图"（校验已放宽，title 兜底「图片题目」）。
**素材**：`server/src/timeline/timeline.types.ts`、`timeline.service.ts` 的 update

## 7. 索引与查询模式

**要写**：
- 主要查询路径（列表按 `user_id + created_at/added_to_review_at` 倒序分页、按学科筛选、关键词、时间范围）；
- 现有索引清单与是否命中；
- 慢查询风险点（关键词 LIKE、跨表统计）；
- 优化约定（查询合并、避免 N+1、只取需要的列）。
**素材**：migrations 中的 CREATE INDEX、各 service 查询

## 8. 数据隔离

**要写**：
- ⚠️ **RLS 全部处于注释状态**（0002 未启用），后端以 service_role 访问 ⇒ **代码层 `.eq('user_id', userId)` 是唯一隔离手段**；
- 风险与缓解（代码评审自查项、删除必须 `.select('id')` 校验行数，否则越权删除会"返回 200 但一行没删"）；
- 未来启用 RLS 的前提与改造量（登记到 OPS-18）。
**素材**：`migrations/0002_fresh_schema.sql`、项目记忆

## 9. 生命周期与清理

**要写**：
- 匿名/临时用户 24 小时清理（范围、例外、执行入口）；
- `temp` purpose 文件的 24 小时孤儿 GC；
- `blob_objects.ref_count` 的维护点（上传 +1、引用移除 -1、删除只解引用）；
- 物理删除策略（当前不物理删，靠 GC）；
- 软删除 vs 硬删除现状。
**素材**：`server/src/maintenance/`、`server/src/storage/`、DD-12

## 10. 迁移演进史

**要写**：0002 → 0013 逐个：文件名 / 作用 / 上线时间 / 备注。并写死纪律：
- **编号必须唯一**（曾有两个 0003 导致拿错文件、表没建起来）；
- `0008_updated_at_trigger.sql` 只覆盖执行时已存在的表 ⇒ **新建表后必须 `--force --only 0008_...` 重跑**；
- 迁移文件只增不改。
**素材**：`migrations/`、项目记忆迁移章节

## 11. 变更流程

**要写**：新增表/字段的标准动作清单：写迁移 → `migrate.mjs --dry` 预演 → 执行 → 若新增带 `updated_at` 的表则重跑 0008 → 更新本文第 3/4/5 章 → 更新 ADD-06（若有接口影响）。

## 12. 备份与恢复

**要写**：Supabase 侧备份策略、本地导出方式、迁移脚本幂等性、恢复演练记录。
**待确认**：当前是否已有定期备份（若无，登记到 OPS-18 风险）。

## 变更记录

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v0.0 | 2026-10-23 | 建立提纲（待审） |
