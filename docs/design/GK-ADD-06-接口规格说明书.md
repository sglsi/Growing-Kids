# GK-ADD-06 接口规格说明书（REST API）

> 编号：GK-ADD-06 ｜ 版本：v0.0（提纲） ｜ 日期：2026-10-23 ｜ 状态：提纲待审
> 读者：前后端 / 测试 ｜ 上游：SRS-01、ADD-05 ｜ 下游：DD-08、DD-09、QA-15
> 定位：前后端**唯一契约来源**。改接口不改本文视为缺陷；e2e 用例以本文为准。

---

## 1. 通用约定

**要写**：
- 基址与全局前缀：后端 `app.setGlobalPrefix('api')` ⇒ **所有路径必须 `/api/xxx`**（历史上 `src/services/memory.ts` 整份漏写前缀导致 404）；
- Content-Type：JSON（上传除外，见第 6 章）；
- 请求头：`X-User-Id`（用户身份；e2e 必须传真实 user UUID）；
- 响应头：`x-user-id`（服务端回写，前端用于校正匿名建号后的身份）；
- 时间格式、空值处理、分页默认值。
**素材**：`server/src/main.ts`、`src/services/net.ts`

## 2. 统一响应与错误码

**要写**：
- 成功包装结构（含 `data` 与列表分页结构 `{ list, total, page, pageSize }`）；
- 错误结构（HTTP 状态 + 业务消息）与**错误码表**（逐码：含义 / 触发条件 / 前端该做什么 / 用户可见文案）；
- 常见故障码归类：鉴权缺失、参数非法、资源不存在、配额超限、外部依赖失败；
- 全局异常过滤器行为。
**素材**：`server/src/filters/`、`server/src/interceptors/`

## 3. 鉴权与用户上下文

**要写**：
- `UserContextMiddleware`：每个请求解析 `X-User-Id` → 查 users 表 → 缺失时创建匿名；
- 用户对象缓存 60s（只缓存非 null，防"登录建号前瞬间查空"被缓存成幽灵）；
- 失败行为（不阻塞、降级为匿名）；
- 前端三个身份切换点（登录 / 应用登录用户 / 登出）的配套动作（清缓存）。
**素材**：`server/src/shared/` 中间件、`src/services/auth.ts`

## 4. 参数清洗约定

**要写**：
- ⚠️ 前端禁止把 `undefined` 拼进 query（会变字符串 `'undefined'`）：等值过滤导致静默查不到；**日期比较会导致 Postgres 解析 timestamptz 失败 → 接口 500**；
- 后端一律用 `server/src/shared/query-param.ts` 的 `cleanStr / cleanDate / cleanInt` 兜底；
- 新增接口必须接入清洗，并在本文登记。
**素材**：`server/src/shared/query-param.ts`

## 5. 端点清单

**要写**：按 18 个 controller 分组，每条端点给「方法 / 路径 / 鉴权 / 入参表 / 出参表 / 错误 / 前端调用位置」。已核实前缀：
`timeline`、`subjects`、`library`、`documents`、`document`、`memories`、`upload`、`image`、`ocr`、`answer-search`、`search`、`chat`、`auth`、`quota`、`pdf`、`storage`、`questions`、`materials`（+ 应用级 controller）。
其中需特别标注：
- `timeline`：list / findOne / create / createBatch / update（局部合并）/ delete（批量）/ overview / 复习本增删；
- `upload`：purpose 分流（见第 6 章）；
- `storage`：`GET /api/storage/files/{file_key}` 文件代理（手机必经）；
- `answer-search`：`mode=search|kb|ai`；
- `questions` / `materials`：**已接线但前端不调用**，明确标注"可用但无人用"。
**素材**：`server/src/*/*.controller.ts`、`src/services/api.ts`

## 6. 文件上传协议

**要写**：
- multipart 字段：`file`、`purpose`、`original_name`；
- ⚠️ **purpose 语义表**（改上传前必看）：`save|1|true`=持久化+建条目（图片→timeline、文档→library）；`temp`=24h GC 回收；`memory`=持久化不建条目；`attach` 及未知值=持久化不建条目。**附件类上传必须 attach，误用 save 会重复建条目**；
- 中文文件名：`fileName` → `formData.original_name = encodeURIComponent(name)`（表单值 UTF-8 安全）；后端 `decodeUploadFileName()` 优先读它并做 latin1→utf8 回转；
- 大小限制、超时、失败重试。
**素材**：`server/src/upload/upload.controller.ts`、`src/services/api.ts` 的 uploadFile

## 7. 分页、筛选与排序规范

**要写**：`page` / `pageSize` / `scope`（recent|review）/ `subjectId` / `keyword` / `tag` / `since` 的语义、默认值、边界；学科筛选与未分类哨兵的转换（`'none'` → NULL）；排序字段与稳定性。

## 8. 版本与兼容

**已决策（思傅 2026-10-24）：引入 URI 版本前缀 `/api/v2`**，与现有 v1 共存，渐进切换。

**要写清的实现方案**：
1. **后端启用 URI 版本化**：`main.ts` 在 `setGlobalPrefix('api')` 之后调用
   `app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })`。
   现有 18 个 controller **一行不改**，由 `defaultVersion:'1'` 隐式映射到 `/api/<路径>`；
2. **v2 端点写法**：需要破坏性变更时新增控制器 `@Controller({ path: 'timeline', version: '2' })`
   ⇒ 对外路径 `/api/v2/timeline`，与 v1 并存，互不影响；
3. **前端切换开关**：`src/services/net.ts` 增加常量 `API_VERSION`（默认空串 = v1，切 v2 时置 `'/v2'`），
   所有请求经统一封装拼接，**禁止在各 service 里手写 `/v2`**；
4. **迁移纪律**：v2 端点上线必须同步更新本文第 5 章与第 9 章对照表；v1 端点弃用后至少保留一个完整发布周期，
   并在本文标注"已弃用 / 计划移除版本"；
5. **非版本化接口**：`/api/health` 等基础设施端点保持不版本化；
6. **兼容性底线**：字段只增不改、弃用字段保留读取一个周期、错误码只增不复用。
**待确认**：首个迁移到 v2 的端点范围（候选：`timeline`、`answer-search`）。

## 9. 前端调用对照表

**要写**：`src/services/api.ts` 每个函数 ↔ 端点 ↔ 缓存失效域（`tl` / `subj` / `lib` / `doc` / `mem`）三列对照；标出「已定义但前端未调用」的端点。作用：改后端时能一眼看出影响面。
**素材**：`src/services/api.ts`（含 `invalidateAfter` 调用点）

## 10. 接口变更流程

**要写**：改接口的检查清单（DTO → controller → service → 前端类型 → 本文 → 缓存失效 → e2e 用例 → dist 重建）。

## 附录 A · e2e 用例索引

**要写**：指向 QA-15 的接口用例编号（本文不重复写用例细节）。

## 变更记录

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v0.0 | 2026-10-23 | 建立提纲（待审） |
