# 后端改造交付说明（v4 · 统一 timeline_items + 多租户 + 匿名清理）

> 依据：`数据库重新设计-v4.md`（定稿）、`migrations/0002_fresh_schema.sql`。
> 本目录 `server-v4/` 是按仓库 `server/` 结构产出的**完整后端代码**，可直接覆盖/新增到 `sglsi/Growing-Kids` 的 `server/` 下。

---

## 1. 改动总览

| 模块 | 动作 | 说明 |
|---|---|---|
| `src/users/*` | 🆕 | 用户服务：`findById` / `findOrCreateByOpenId` / `createAnonymous` / `listExpiredAnonymous` / `updateProfile` / `removeByIds` |
| `src/auth/*` | 🆕 | **微信登录**：`code2session` 换 openid → 找/建正式用户 → 迁移匿名数据 → 返回身份 |
| `src/shared/user-context.ts` | 🆕 | 全局中间件：解析 `X-User-Id`/`X-Open-Id`，缺省创建**匿名用户**并回传 `X-User-Id`；`/api/auth/*`、`/api/health` 跳过自动建号 |
| `src/timeline/*` | 🆕 | **统一收件箱**：recent/review（页 20）、搜索、标签、增删改、加入/移出复习本、overview、按 id 取（PDF 用） |
| `src/library/*` | 🆕 | 资料库：外部文档 CRUD（软删） |
| `src/maintenance/*` | 🆕 | 定时（每小时）清理 **1 天前的匿名用户**及其对象存储文件 |
| `src/storage/storage.module.ts` | 🆕 | Storage 可注入模块；`storage.service.ts` 增 `deleteObject` |
| `src/subjects/*` | ♻️ | 按 `user_id` 过滤；**空则自动铺设默认学科**（含"生活"） |
| `src/upload/*` | ♻️ | 图片→`timeline_items(kind=image)`；文档→`library_docs`（按 mime 分流） |
| `src/image/*` | ♻️ | 处理图归档改走 timeline；service 增 `userId` 入参 |
| `src/document/*` | ♻️ | 汇总导出数据源 `questions` → `timeline_items(kind=question)` 的 `content` jsonb |
| `src/documents/*` | ♻️ | 生成文档加 `user_id`；软删；返回签名 URL |
| `src/pdf/*` | ♻️ | 合成 PDF 素材源 `materials` → `timeline_items`；结果归档进 `documents` |
| `src/storage/database/shared/schema.ts` | ♻️ | v4 重写（6 表，含 users 匿名字段） |
| `src/app.module.ts` | ♻️ | 注册新模块；挂 `UserContextMiddleware`；引入 `ScheduleModule` |
| `src/main.ts` | ♻️ | CORS `exposedHeaders: ['X-User-Id']` |
| `src/ocr/*` `src/search/*` `src/interceptors/*` | ⚪ | 基本原样保留（OCR 模块改为 import StorageModule） |
| **删除** | ❌ | `src/questions/*`、`src/materials/*`（被 timeline 取代） |

---

## 2. 接口映射表（前端需同步改造）

| 旧接口 | 新接口 | 变化 |
|---|---|---|
| `GET /api/questions` | `GET /api/timeline?scope=recent` | 统一收件箱，页 20，支持 `subject_id/tag/keyword` |
| `GET /api/questions/overview` | `GET /api/timeline/overview` | 增 `review_total` |
| `GET /api/questions/:id` | `GET /api/timeline/:id` | 数据结构变 `TimelineItem` |
| `POST /api/questions` | `POST /api/timeline` | body `{kind:'question', subject_id, content:{question,answer,...}}` |
| `PUT /api/questions/:id` | `PUT /api/timeline/:id` | — |
| `DELETE /api/questions/:id` | `DELETE /api/timeline/:id` | 软删 |
| `GET /api/materials?type=image` | `GET /api/timeline?scope=recent` | 图片已并入 timeline |
| `GET /api/materials?type=document` | `GET /api/library` | **新**：资料库 |
| `DELETE /api/materials/:id` | `DELETE /api/timeline/:id`（图片）/ `DELETE /api/library/:id`（文档） | — |
| `POST /api/materials/batch-delete` | `POST /api/timeline/batch-delete` / `POST /api/library/batch-delete` | — |
| `POST /api/document/export` | 同（内部走 user_id） | — |
| `GET /api/documents` | 同（加 user_id） | — |
| `POST /api/pdf/combine` | 同（素材 id 改指 timeline item） | — |
| — | **`GET /api/timeline?scope=review`** | **新**：复习本（含搜索/标签） |
| — | **`POST /api/timeline/review-book {ids}`** | **新**：加入复习本 |
| — | **`DELETE /api/timeline/review-book {ids}`** | **新**：移出复习本 |
| — | `POST/PUT/DELETE /api/subjects` | **新**：学科增删改 |
| — | **`POST /api/auth/login`** | **新**：微信登录（后端 code2session 换 openid） |
| — | **`GET /api/auth/me`** | **新**：当前用户（校验身份有效性） |
| — | **`PATCH /api/auth/profile`** | **新**：更新昵称 / 头像 |
| — | **`POST /api/auth/logout`** | **新**：退出（服务端无状态） |

> 身份：前端首次请求无需任何 header，后端会建匿名用户并在**响应头 `X-User-Id`** 返回；前端存下来，后续请求带上 `X-User-Id` 即可续用同一身份。

---

## 2.1 微信登录（v4 新增）

### 数据流

```
小程序 wx.login() ──code──▶ POST /api/auth/login {code, anonymous_id?, nickname?, avatar_url?}
                                        │
                          服务端 code2Session(appid, secret, code)
                                        │
                                     openid
                                        │
                      找/建 users(open_id=openid, is_anonymous=false)
                                        │
                    迁移匿名数据（subjects/timeline_items/library_docs/documents
                              UPDATE user_id: anonymous_id → 正式 userId）
                                        │
                返回 { user, migrated }  ──▶ 前端存 user.id 为 X-User-Id
```

### 关键点

- **AppSecret 只在服务端**：微信官方**禁止**小程序直连 `api.weixin.qq.com`（该域名不可加入 `request 合法域名`，且 AppSecret 泄露风险极高）。前端只负责 `wx.login()` 拿 `code`。
- **`code` 一次性、5 分钟有效**：拿到后立即 `POST /api/auth/login`，不要缓存。
- **匿名数据自动迁移**：登录时前端带上当前匿名 `user_id`（`anonymous_id`）。后端把该匿名用户名下 4 张表的数据整体 `UPDATE user_id`，再删掉空壳匿名账号；同名学科（`(user_id,name)` 唯一）会自动去重。
- **`/api/auth/*` 不自动建匿名号**：`UserContextMiddleware` 对 `/api/auth/`、`/api/health` 前缀跳过匿名创建，避免每次登录产生垃圾账号。
- **退出即丢身份**：服务端无状态，前端清掉本地 `X-User-Id` 即可；下次请求会拿到新的匿名身份（1 天后被清理）。

### 环境变量（必须配置）

| 变量 | 说明 |
|---|---|
| `WX_APPID` | 微信小程序 AppID |
| `WX_SECRET` | 微信小程序 AppSecret（**仅服务端**） |

> 未配置时 `POST /api/auth/login` 返回 `400 服务端未配置 WX_APPID / WX_SECRET`。

> 校验状态：本目录代码已通过 `tsc` 独立类型检查（**0 error**）。
> `types/` 目录仅含"本地检查用的 SDK 声明桩"，**不要复制进仓库**（仓库已装真实 `coze-coding-dev-sdk`）。

---

## 3. 应用步骤

1. **建表**：在 Supabase SQL Editor 执行 `migrations/0002_fresh_schema.sql`（含 users 匿名字段）。旧 `questions`/`materials` 可 drop 或改名为 `_legacy`。
2. **覆盖后端**：把本 `server-v4/src/**` 覆盖到仓库 `server/src/**`；**删除** `server/src/questions/`、`server/src/materials/`。
3. **依赖**：`server/package.json` 增 `@nestjs/schedule`（本目录 `package.json` 已含）。
4. **同步 schema**：用 `src/storage/database/shared/schema.ts` 覆盖原文件。
5. **构建运行**：`pnpm install && pnpm build && pnpm start`（在 `server/` 下）。
6. **前端**：按 §2 映射表改造 `src/services/api.ts` 与页面。

---

## 4. 校验清单

- [ ] `GET /api/health` 正常
- [ ] 首次 `GET /api/subjects`（不带 header）→ 返回默认学科，且**响应头含 `X-User-Id`**
- [ ] 带同一 `X-User-Id` 再次请求 → 学科一致（同一用户）
- [ ] `POST /api/upload`（图片）→ 返回 `timeline_id`；`GET /api/timeline?scope=recent` 能查到
- [ ] `POST /api/upload`（PDF）→ 返回 `library_id`；`GET /api/library` 能查到
- [ ] `POST /api/timeline/review-book {ids}` → `GET /api/timeline?scope=review` 能查到
- [ ] 不同 `X-User-Id` 的数据互不可见（隔离）
- [ ] 隔天（或手动把 expire_at 调到过去）→ 定时任务删除匿名用户及其文件
- [ ] **先匿名建几条数据 → `POST /api/auth/login` → `GET /api/timeline` 用返回的 `user.id` 能查到（迁移成功）**
- [ ] **`GET /api/auth/me`（带登录后的 `X-User-Id`）→ 返回正式用户，`is_anonymous=false`**
- [ ] **登录前后不同设备（不同 openid）数据隔离**

---

## 5. 回滚

本次为「不迁移、重建」策略：
- 数据库：保留旧表改名 `_legacy` 即可随时切回旧代码。
- 代码：`git revert` 到改造前 commit。
- 二者独立，互不阻塞。

---

## 6. 重要约定（务必遵守）

> ⚠️ **Coze 注入 service_role ⇒ Supabase RLS 被绕过。**
> 所有业务查询**必须**显式 `.eq('user_id', userId)`；新增**必须**由后端强制写入 `user_id`，**禁止信任前端传入**。
> 禁止"裸查"（不带 user_id 的 `from(...).select()`）。新增查询请参照 `timeline.service.ts` 的写法。
