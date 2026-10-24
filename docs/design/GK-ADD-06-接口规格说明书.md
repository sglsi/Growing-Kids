# GK-ADD-06 接口规格说明书（REST API）

> 编号：GK-ADD-06 ｜ 版本：v1.0 ｜ 日期：2026-10-25 ｜ 状态：正文完成（待统一校正）
> 读者：前后端 / 测试 ｜ 上游：SRS-01、ADD-05 ｜ 下游：DD-08、DD-09、QA-15
> 定位：前后端**唯一契约来源**。改接口不改本文视为缺陷；e2e 用例以本文为准。
> 数据来源：2026-10-25 从 `server/src/*/*.controller.ts` 全量提取（**20 个 controller / 70 个处理器**），与代码冲突时以代码为准并回写本文。

---

## 1. 通用约定

| 项 | 约定 |
|---|---|
| 基址 | 编译期常量 `PROJECT_DOMAIN`（小程序端，缺省 `http://127.0.0.1:3001`）；H5 端为空串走 devServer 代理 |
| 全局前缀 | 后端 `app.setGlobalPrefix('api')` ⇒ **所有路径必须 `/api/xxx`**。⚠️ 历史上 `src/services/memory.ts` 整份漏写前缀导致 404，新增 service 必须自查 |
| 端口 | `-p` > `PORT` > `SERVER_PORT` > 3000；当前本机 3001，唤醒服务 3002 |
| Content-Type | JSON（上传除外，见第 6 章）；请求体上限 50MB（大图 base64 需要） |
| CORS | `origin: true`，`credentials: true`，暴露 `X-User-Id` |
| 请求头 | `X-Auth-Token`（优先，HMAC 验签）、`X-User-Id`（兼容期）、`X-Device-Id`、`X-Open-Id` |
| 响应头 | `X-User-Id`（服务端回写）、`X-Auth-Token`（每次响应滑动续签） |
| 时间格式 | ISO 8601（UTC，如 `2026-10-24T15:27:15.032Z`） |
| 空值 | 未设置的文本字段返回 `null`；数组默认 `[]`；布尔不省略 |
| 分页默认 | `page` 从 1 起，默认 1；`page_size` 默认 20（后端上限 100） |
| POST 状态码 | 全局拦截器把 201 统一改为 200（前端只认 200） |

---

## 2. 统一响应与错误码

### 2.1 成功结构

```json
{ "code": 200, "msg": "success", "data": { } }
```

列表类 `data`：`{ list: [...], total: 12, page: 1, page_size: 20 }`。

### 2.2 错误结构（`src/filters/all-exceptions.filter.ts`，全局 `@Catch()`）

```json
{
  "code": 400,
  "msg": "名称不能为空",
  "statusCode": 400,
  "message": "名称不能为空",
  "error": "Bad Request"
}
```

- `msg` 与 `message` 双写（历史兼容）：`HttpException.getResponse()` 为字符串直接用；为对象取 `message`（数组取首项或 `；` 拼接）；否则取 `Error.message`。
- **4xx 不落盘**（视为业务正常）；**5xx / 未知异常**写 `server/logs/error-YYYY-MM-DD.log`（单文件 5MB 换号，请求体截断 2000 字符）。
- ⚠️ 所有异常必须由该过滤器发响应；提前 return 会导致请求挂起（HTTP 000）。

### 2.3 错误码表

| HTTP | `code`/业务码 | 触发条件 | 前端该做什么 | 用户可见文案 |
|---|---|---|---|---|
| 400 | — | 参数非法（DTO 校验失败、`ids 必须是数组`、`image_url 不能为空`、`框选范围过小`、`名称不能为空/过长`、`没有可导出的识别内容`） | 提示并停止操作 | 后端 `msg` 原文 |
| 400 | — | 非法对象 key（路径逃逸） | 不重试 | 「对象不存在」 |
| 403 | — | `requireAdmin` 未命中白名单 | 隐藏管理入口 | 「无权限：仅管理员可维护全局知识库」 |
| 404 | — | `NotFoundException`（文档/知识条目不存在） | 刷新列表 | 后端原文 |
| 413 | `QUOTA_BYTES` | 存储容量超限 | 引导清理 | 「存储空间已满」 |
| 413 | `QUOTA_COUNT` | 图片张数超限 | 同上 | 「图片数量已达上限」 |
| 429 | `SR_RATE_LIMIT` | 超分全局并发闸 | 稍后重试 | 「处理繁忙，请稍后」 |
| 429 | `SR_USER_BUSY` | 同一用户已有超分在跑 | 等待当前任务 | 「已有任务在处理」 |
| 500 | — | ⚠️ `requireUserId` 抛普通 Error（非 HttpException）⇒ **身份缺失表现为 500 而非 401**；其它未捕获异常 | 提示重试并上报 | 「服务异常，请稍后重试」 |
| 503 | `SR_QUEUE_TIMEOUT` | 超分排队超时 | 降级重试（x2） | 「排队超时，可稍后重试」 |
| — | `220021` / 「已达上限」 | ima 日配额耗尽（**不可重试**） | 禁用 kb 模式至次日 | 「知识库今日调用次数已达上限，请明天再试」 |
| — | `200001` / 「频率超限」 | ima QPS 限流 | 自动退避重试（后端已处理） | 用户无感 |
| — | errno≠0 | 百度网盘业务失败 | 归档跳过（fail-open） | 用户无感 |

**故障归类**：鉴权缺失 → 500（见上，登记技术债）；参数非法 → 400；资源不存在 → 404；配额超限 → 413/429；外部依赖失败 → 该能力明确降级，业务码随依赖而定（第 2.3 表末四行）。

---

## 3. 鉴权与用户上下文

**解析顺序**（`shared/user-context.ts`）：`X-Auth-Token`（验签通过才认）→ `X-User-Id`（兼容期，每次 warn）→ `X-Open-Id` → `X-Device-Id`（命中则滑动续期）→ 匿名建号（`is_anonymous=true`，TTL 30 天）。

- 令牌格式 `v1.<userId>.<expSec>.<sig>`，HMAC-SHA256，TTL 30 天，`timingSafeEqual` 验签；**未配 `AUTH_TOKEN_SECRET` 时不签不验**（退回旧行为）。
- **免建号前缀**：`/api/auth/*`、`/api/health`（避免每次登录产生垃圾账号）。
- 用户对象内存缓存 60s，**只缓存非 null**（防"登录建号前瞬间查空"被缓存成幽灵）。
- 管理员：`requireAdmin()` 读 `CHAT_ADMIN_IDS` 白名单；**未配置时放行并 warn**（登记风险）。
- 前端三个身份切换点（登录成功 / 应用已登录用户 / 登出）必须：清全部本地缓存（`clearAllCache`）、重置唤醒状态；登出连 `gk_auth_token` 一起清。

---

## 4. 参数清洗约定

- ⚠️ **前端禁止把 `undefined` 拼进 query**：会变成字符串 `'undefined'`；等值过滤静默查不到，**日期比较会让 Postgres 解析 timestamptz 失败 → 接口 500**。
- 后端一律用 `server/src/shared/query-param.ts` 的 `cleanStr / cleanDate / cleanInt` 兜底。
- 新增接口必须接入清洗，并在本文第 5 章登记。

---

## 5. 端点清单

> 身份列：`需` = `requireUserId`；`管理` = `requireAdmin`；`否` = 未强制（中间件仍会为 `/api/*` 建/绑定匿名用户，`/api/auth/*` 与 `/api/health` 除外）。

### 5.1 应用级 AppController

| 方法 | 路径 | 用途 | 身份 |
|---|---|---|---|
| GET | `/api/health` | 健康检查（返回 ISO 时间） | 否（免建号） |
| GET | `/api` | 服务名片（版本/运行时/端点索引） | 否 |
| GET | `/api/hello` | 问候 | 否 |
| GET | `/` | 同名片（原生路由，绕过 Nest 前缀） | 否 |

### 5.2 auth

| 方法 | 路径 | 用途 | 入参 | 身份 |
|---|---|---|---|---|
| POST | `/api/auth/login` | 微信登录 | `code`(必)、`anonymous_id?`、`nickname?`、`avatar_url?`；另取 `X-Device-Id` → `{user, migrated, auth_token}` | 否 |
| GET | `/api/auth/me` | 当前用户资料 | — | 需 |
| PATCH | `/api/auth/profile` | 改昵称/头像 | `nickname?`、`avatar_url?` | 需 |
| POST | `/api/auth/logout` | 登出（服务端无状态） | — | 否 |
| POST | `/api/auth/qr-login/ticket` | 创建扫码票据 → `{token, expires_in:300}` | — | 否 |
| GET | `/api/auth/qr-login/status` | 轮询票据 | `?token`（pending/authorized/expired） | 否 |
| POST | `/api/auth/qr-login/authorize` | 手机端授权 | `token`、`code`、`anonymous_id?` | 否 |

### 5.3 subjects

| 方法 | 路径 | 用途 | 入参 | 身份 |
|---|---|---|---|---|
| GET | `/api/subjects` | 学科列表 | — | 需 |
| POST | `/api/subjects` | 新建 | `name`、`color?`、`sort_order?` | 需 |
| PUT | `/api/subjects/:id` | 修改 | `name?`、`color?`、`sort_order?` | 需 |
| DELETE | `/api/subjects/:id` | 删除 | — | 需 |

### 5.4 timeline

| 方法 | 路径 | 用途 | 入参 | 身份 |
|---|---|---|---|---|
| GET | `/api/timeline` | 列表 | `scope`(recent\|review)、`subject_id`、`tag`、`keyword`、`since`、`page`(1)、`page_size`(20) | 需 |
| GET | `/api/timeline/overview` | 概览 + recent | — | 需 |
| POST | `/api/timeline` | 新建条目 | `CreateTimelineDto`（kind/title/file_key/thumb_key/content/tags/subject_id…） | 需 |
| POST | `/api/timeline/batch` | 批量新建 | `{items: CreateTimelineDto[]}`（空 → 400） | 需 |
| POST | `/api/timeline/review-book` | 加入复习本 | `{ids}` | 需 |
| DELETE | `/api/timeline/review-book` | 移出复习本 | `{ids}` | 需 |
| POST | `/api/timeline/:id/similar` | 相似/变式题推荐 | `{limit?}`（钳制 1~20，默认 5） | 需 |
| POST | `/api/timeline/:id/review` | 标记本次复习完成 | — | 需 |
| POST | `/api/timeline/batch-delete` | 批量删除 | `{ids}` | 需 |
| GET | `/api/timeline/:id` | 详情（**补签名 URL**） | — | 需 |
| PUT | `/api/timeline/:id` | 更新（补签名 URL） | `UpdateTimelineDto` | 需 |
| DELETE | `/api/timeline/:id` | 删除 | — | 需 |

### 5.5 library（资料库）

| 方法 | 路径 | 用途 | 入参 | 身份 |
|---|---|---|---|---|
| GET | `/api/library` | 列表（补 URL，带 `subjects` 关联） | `subject_id`、`keyword`、`page`(1)、`page_size`(20) | 需 |
| POST | `/api/library` | 新建条目 | `name`、`file_key`、`thumb_key?`、`subject_id?`、`mime_type?`、`width/height?`、`size_bytes?`、`file_hash?`、`source?`、`tags?` | 需 |
| PATCH | `/api/library/:id` | 改名 / 归属学科 | `{name?, subject_id?}`（`subject_id=null` = 未分类；传 id 时校验属于本人，否则 400） | 需 |
| POST | `/api/library/batch-delete` | 批量删除 | `{ids}` | 需 |
| DELETE | `/api/library/:id` | 删除（软删） | — | 需 |

### 5.6 upload

| 方法 | 路径 | 用途 | 入参 | 身份 |
|---|---|---|---|---|
| POST | `/api/upload` | 文件上传（multipart，字段 `file`，内存存储，限 20MB） | `purpose`、`archive_to`、`original_name`（query 与 formData 双读） | 需 |

返回 `{key, url, thumb_key, thumb_url, type, timeline_id, library_id, size_bytes, width, height, deduped}`；配额拦截抛 **413**。

### 5.7 image

| 方法 | 路径 | 用途 | 入参 | 身份 |
|---|---|---|---|---|
| GET | `/api/image/capabilities` | 能力自检（version=3、pipeline_mode、straighten/enhance/erase_v2） | — | 否 |
| GET | `/api/image/ocr-diagnose` | OCR 诊断（快速/精准路径 + 侧车状态） | — | 否 |
| POST | `/api/image/process` | 图像处理 | `action`(auto\|enhance\|erase\|erase_v2)、`image_url`、`save?`、`use_vlm?`、`manual_regions?`、`strategy?`、`erase_mode?`、`manual_corners?`、`sr_scale?`(2/3/4)、`sr_mode?`、`enhance_preset?`、`multi_modes?` 等 | 需 |
| POST | `/api/image/wrongq` | 错题区域粗框（VLM + 红笔证据） | `ProcessImageDto` | 需 |
| POST | `/api/image/extract-wrong` | 错题切块 + 逐块 OCR | `image_url`、`answer_image_keys?` | 需 |
| POST | `/api/image/extract-wrong-recrop` | 改框重切重识 | `image_url`、`box`、`system_box?`、`question_label?`、`answer_content?`、`answer_image_keys?` | 需 |
| POST | `/api/image/ocr-page` | 全页 OCR（摆正 + 阅读序，不切块） | `image_url`、`mode?`(precise\|fast)、`rectify?` | 需 |

### 5.8 documents / document / pdf

| 方法 | 路径 | 用途 | 入参 | 身份 |
|---|---|---|---|---|
| GET | `/api/documents` | 导出产物列表 | `type?`、`keyword?`、`page?`、`page_size?` | 需 |
| PATCH | `/api/documents/:id` | 改名 | `{title}`（空/超 100 字 → 400） | 需 |
| POST | `/api/documents/batch-delete` | 批量删除 | `{ids}` | 需 |
| DELETE | `/api/documents/:id` | 删除 | — | 需 |
| POST | `/api/document/export` | 题目汇总导出 docx → 写 documents | `subject_id?`、`start_date?`、`end_date?`、`title?`、`include_mastered?` | 需 |
| POST | `/api/pdf/combine` | 图片合成 PDF/DOCX 归档 | `{ids[], format?: 'pdf'\|'docx'}` | 需 |

### 5.9 ocr

| 方法 | 路径 | 用途 | 入参 | 身份 |
|---|---|---|---|---|
| POST | `/api/ocr/recognize-exam` | 整卷识别 | `subject_id`、`image_keys[]` | 否 |
| POST | `/api/ocr/recognize-exam-url` | 整卷识别（URL 版） | `subject_id`、`urls[]` | 否 |
| POST | `/api/ocr/recognize-pair` | 题答分传识别 | `question_image_keys[]`、`answer_image_keys[]`（答案 keys 原样回传） | 否 |
| POST | `/api/ocr/recognize-doc` | 文档识别 | `file_url` | 否 |
| POST | `/api/ocr/export-docx` | 识别结果导出 Word | `items[]`、`title?`（空 → 400） | 需 |

### 5.10 search / answer-search

| 方法 | 路径 | 用途 | 入参 | 身份 |
|---|---|---|---|---|
| POST | `/api/search/solve` | 题目求解（联网 + 大模型） | `{question_content}`（空 → 400） | 否 |
| POST | `/api/answer-search/:id` | 为题目搜答案，**不写库**（前端「采纳」才落库） | path `id`；**body** `{force?: boolean, mode?: 'search'\|'ai'\|'kb'}`（默认 search） | 需 |

> ⚠️ `mode` 是 **body 参数**，写在 query 上会静默走默认 `search`（联网搜题约 70s）。出参含 `cached` 标记（命中持久化缓存）。

### 5.11 quota / storage

| 方法 | 路径 | 用途 | 入参 | 身份 |
|---|---|---|---|---|
| GET | `/api/quota/usage` | 当前用量与档位 | — | 需 |
| GET | `/api/storage/tier-stats` | 分层统计 / 容量告警数据源 | — | 需 |
| GET | `/api/storage/files/*` | 对象读取（local 直读 / supabase 代理） | 通配 `file_key` | 需 |

### 5.12 memories

| 方法 | 路径 | 用途 | 入参 | 身份 |
|---|---|---|---|---|
| GET | `/api/memories` | 列表 | `category`、`subject_id`、`tag`、`keyword`、`since`、`page`、`page_size` | 需 |
| GET | `/api/memories/:id` | 详情（含媒体 + URL） | — | 需 |
| POST | `/api/memories` | 新建 | `title?`、`content?`、`category?`、`mood?`、`subject_id?`、`tags?`、`occurred_at?` | 需 |
| PATCH | `/api/memories/:id` | 更新（`mood`/`subject_id` 可置 null） | `UpdateMemoryDto` | 需 |
| DELETE | `/api/memories/:id` | 删除 | — | 需 |
| POST | `/api/memories/batch-delete` | 批量删除 | `{ids}` | 需 |
| POST | `/api/memories/:id/media` | 添加媒体 | `file_key`、`mime_type`、`kind`(image\|audio\|video)、`thumb_key?`、`width/height?`、`size_bytes?`、`duration_sec?`、`sort_order?` | 需 |
| DELETE | `/api/memories/:id/media/:mediaId` | 删除媒体 | — | 需 |

### 5.13 chat（含全局知识库）

| 方法 | 路径 | 用途 | 入参 | 身份 |
|---|---|---|---|---|
| GET | `/api/chat/knowledge` | 知识条目列表（**全局表，无 user_id**） | — | 管理 |
| POST | `/api/chat/knowledge` | 新建知识条目 | `title`、`content`、`category?`、`tags?`、`is_active?`、`sort_order?` | 管理 |
| PATCH | `/api/chat/knowledge/:id` | 更新 | 同上（可为 null） | 管理 |
| DELETE | `/api/chat/knowledge/:id` | 删除 | — | 管理 |
| POST | `/api/chat/message` | 智能客服发消息 | `session_id?`（缺省自动建会话）、`content` | 需 |
| GET | `/api/chat/messages` | 会话消息列表 | `?session_id`（必填） | 需 |
| POST | `/api/chat` | 中性通用对话（不含小程序人设/知识库，走 LLM 降级链） | `{message, history?[{role,content}]}` → `{answer}` | 需 |

### 5.14 questions / materials（**v3 遗留：已接线但前端不调用**）

| 方法 | 路径 | 用途 | 入参 | 身份 |
|---|---|---|---|---|
| GET | `/api/questions` | 列表 | `subject_id`、`keyword`、`start_date`、`end_date`、`mastered`、`page`、`page_size` | 需 |
| GET | `/api/questions/overview` | 概览 | — | 需 |
| GET | `/api/questions/:id` | 详情 | — | 需 |
| POST | `/api/questions` | 新建 | `subject_id`、`question_content`、`question_image_keys?`、`answer_content?`、`answer_image_keys?`、`solution?`、`wrong_answer?`、`source?`、`status?`、`mastered?` | 需 |
| PUT | `/api/questions/:id` | 更新 | `Partial<CreateQuestionDto>` | 需 |
| DELETE | `/api/questions/:id` | 删除 | — | 需 |
| GET | `/api/materials` | 列表 | `type`(image\|document)、`subject_id`、`keyword`、`page`、`page_size` | 需 |
| POST | `/api/materials/:id/used` | 标记已用 | — | 需 |
| DELETE | `/api/materials/:id` | 删除 | — | 需 |
| POST | `/api/materials/batch-delete` | 批量删除 | `{ids}` | 需 |

> 概览里的未分类哨兵：`subject_id='none'` 代表 NULL，查询需转 `.is('subject_id', null)`。

---

## 6. 文件上传协议

**multipart 字段**：`file`（文件）、`purpose`、`archive_to`、`original_name`。

**purpose 语义表（改上传前必看）**：

| 值 | 行为 | 建条目 |
|---|---|---|
| `save` / `1` / `true` | 持久化 | ✅ 图片 → timeline（收件箱）；文档 → library；配 `archive_to=library` 时图片也进资料库 |
| `temp` | 持久化，24h 由孤儿 GC 回收 | ❌ |
| `memory` | 持久化（成长记忆媒体，key 由 `memory_media` 引用） | ❌ |
| `attach` 及其他未知值 | 持久化（**附件**：key 写进别处，如 `content.question_images`） | ❌ |

> ⚠️ 附件类上传绝不能写 `save`：会多出一条「最近题目」，随后保存题目再建一条 ⇒ 首页同一题两行。

**中文文件名**：HTTP 头非 ASCII 会被 Node 按 latin1 读乱 ⇒ 前端显式传 `formData.original_name = encodeURIComponent(name)`，后端 `decodeUploadFileName()` 优先读它并回转。

**限制与失败**：单文件 20MB（内存存储）；配额拦截 413；开发者工具返回的 `http://tmp/...` 是伪 URL，前端必须用 `isRemoteImageUrl()` 判定（裸写 `/^https?:\/\//` 会让后端 `ENOTFOUND tmp`）。

---

## 7. 分页、筛选与排序规范

| 参数 | 语义 | 默认 / 边界 |
|---|---|---|
| `page` | 页码，从 1 起 | 1 |
| `page_size` | 每页条数 | 20（后端上限 100；前端 `PAGE_SIZE=20`） |
| `scope` | timeline 作用域：`recent`（最近）/ `review`（复习本） | recent |
| `subject_id` | 学科过滤；`'none'` 表示未分类（转 NULL） | 空 = 全部 |
| `keyword` | 名称/题干模糊匹配（`ilike`） | 空 |
| `tag` / `category` | 标签 / 记忆分类精确匹配 | 空 |
| `since` | 起始时间（ISO 或日期） | 空；⚠️ 传 `undefined` 会变成字符串导致 500 |
| `type` | materials/documents 的类型过滤 | 空 |

**排序**：统一按 `created_at desc`（timeline/library/documents/memories）；`subjects` 按 `sort_order`。列表稳定性依赖 `created_at` 唯一性，批量导入时由后端保证递增。

---

## 8. 版本与兼容

**已决策（思傅 2026-10-24）：引入 URI 版本前缀 `/api/v2`，与 v1 共存、渐进切换。当前状态：尚未实施（代码中未启用版本化）。**

实施步骤（实施时按此执行并回写本节）：

1. `main.ts` 在 `setGlobalPrefix('api')` 后调用 `enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })`；现有 controller 一行不改，`defaultVersion:'1'` 隐式映射到 `/api/<路径>`；
2. 需要破坏性变更时新增 `@Controller({ path: 'timeline', version: '2' })` ⇒ `/api/v2/timeline`，与 v1 并存；
3. 前端开关：`src/services/net.ts` 增加常量 `API_VERSION`（默认空串 = v1），所有请求经统一封装拼接，**禁止各 service 手写 `/v2`**；
4. 迁移纪律：v2 上线必须同步更新本文第 5 章与第 9 章；v1 弃用后至少保留一个完整发布周期并标注「已弃用」；
5. 非版本化端点：`/api/health` 等基础设施保持不版本化；
6. 兼容底线：字段只增不改、弃用字段保留读取一个周期、错误码只增不复用。

**首个迁移候选**：`timeline`、`answer-search`（待确认）。

---

## 9. 前端调用对照表

> `src/services/api.ts`（主）、`auth.ts`、`memory.ts`、`chat.ts`；缓存域：`tl`（时间线）/ `subj`（学科）/ `lib`（资料库）/ `doc`（文档）/ `mem`（记忆）。

| 前端函数（业务域） | 端点 | 写后失效域 |
|---|---|---|
| `uploadFile` | `POST /api/upload` | 调用方按需 |
| `getSubjects` / `createSubject` / `updateSubject` / `deleteSubject` | `/api/subjects*` | `subj` |
| `getTimeline` / `getTimelineOverview` | `GET /api/timeline`、`/overview` | 读 |
| `createTimeline` / `createTimelineBatch` / `updateTimeline` / `deleteTimelines` | `/api/timeline*` | `tl` |
| `addToReviewBook` / `removeFromReviewBook` | `/api/timeline/review-book` | `tl` |
| `getSimilarQuestions` / `markReviewed` | `/api/timeline/:id/similar`、`/review` | `tl`（review 影响掌握状态） |
| `getLibrary` / `createLibraryDoc` / `updateLibraryDoc` / `deleteLibraryDocs` | `/api/library*` | `lib` |
| `exportDocument` / `combinePdf` | `/api/document/export`、`/api/pdf/combine` | `doc` |
| `getDocuments` / `renameDocument` / `deleteDocuments` | `/api/documents*` | `doc` |
| `recognizeExam` / `recognizeDoc` / `recognizeExamUrl` / `exportDocx` | `/api/ocr/*` | — |
| `extractWrong` / `recropWrong` / `ocrPage` / `processImage` / `getImageCapabilities` | `/api/image/*` | — |
| `solveQuestion` | `/api/search/solve` | — |
| `searchAnswer(itemId, {mode, force})` | `/api/answer-search/:id` | —（不写库） |
| `getQuotaUsage` | `/api/quota/usage` | 读 |
| `login` / `getMe` / `updateProfile` / `logout` | `/api/auth/*` | 身份切换点清全缓存 |
| `getMemories` / `createMemory` / `updateMemory` / `deleteMemories` / `addMemoryMedia` | `/api/memories*` | `mem` |
| `getKnowledge` / `createKnowledge` 等 | `/api/chat/knowledge*` | —（管理端） |
| `sendChatMessage` / `getChatMessages` | `/api/chat/message`、`/api/chat/messages` | — |
| 通用对话（`services/chat.ts`） | `POST /api/chat` | — |
| `openStorageFile`（`services/net.ts`） | `/api/storage/files/{fileKey}` | 读 |

**已定义但前端未调用**：`/api/questions*`、`/api/materials*`（v3 遗留，见 5.14）；`/api/auth/qr-login/*`（仅 H5 扫码落地页调用）。

---

## 10. 接口变更流程

改动一个接口的检查清单（按顺序）：

1. DTO（字段、校验、清洗 `cleanStr/cleanDate/cleanInt`）；
2. Controller（路由、方法、身份 `requireUserId`/`requireAdmin`）；
3. Service（隔离 `.eq('user_id')`、删除行数校验、写后缓存失效）；
4. 前端 `api.ts` 函数 + 类型（`src/types`）+ 调用页面；
5. **本文第 5 章与第 9 章**（契约与对照表）；
6. e2e 用例（`server/dynamic-tests/` 或 QA-15 登记）；
7. 重建后端 dist（`npx nest build`）与小程序 dist（`pnpm build:weapp`）+ 特性串校验；
8. 真机回归（前端改动需重新生成二维码扫码）。

---

## 附录 A · e2e 用例索引

本文不重复写用例细节，指向 **QA-15**（接口用例编号按本文第 5 章的 controller 分组编排）。

---

## 变更记录

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v0.0 | 2026-10-23 | 建立提纲（待审） |
| v1.0 | 2026-10-25 | 全章正文落地：按 2026-10-25 代码全量提取 **20 controller / 70 处理器**端点表、统一信封与错误码表、鉴权链路、上传 purpose 语义表、分页筛选规范、前端调用对照表、变更流程；标注 `mode` 必须走 body、身份缺失表现为 500 等实测坑；第 8 章 `/api/v2` 标注为「已决策未实施」 |
