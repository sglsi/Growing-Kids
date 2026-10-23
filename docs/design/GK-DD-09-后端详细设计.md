# GK-DD-09 后端详细设计

> 编号：GK-DD-09 ｜ 版本：v0.0（提纲） ｜ 日期：2026-10-24 ｜ 状态：提纲待审
> 读者：后端 ｜ 上游：ADD-04、ADD-05、ADD-06、ADD-07 ｜ 下游：QA-16
> 定位：NestJS 模块的职责与请求生命周期。**含身份、权限与配额**（原 DD-15 并入第 9 章）。缓存细节引用 DD-13。

---

## 1. 技术栈与启动

**要写**：
- NestJS；全局 `/api` 前缀；URI 版本化（v2 起 `/api/v2`，见 ADD-06 第 8 章）；
- 启动：`cd server && npx nest build` → 带三个 OCR 环境变量 `node dist/main -p 3001`（小程序联调固定 3001）；
- ⚠️ **改了 `server/src` 必须重编译 + 重启才生效**（真机连的是本地后端，不是云端）；
- ⚠️ 重启踩坑：后台任务停止后 node 子进程仍占端口 ⇒ 新进程 EADDRINUSE、health 是旧进程答的（曾误判"缺 key"）；必须先 `netstat -ano | grep :3001` 找 PID 再 `taskkill`，启动后验 health 时间戳。
**素材**：项目记忆工程结构章节

## 2. 模块清单

**要写**：逐模块表（目录 / 职责 / 对外控制器 / 依赖 / 状态）。已核实 24 个目录：
`ai`、`answer-search`、`auth`、`chat`、`document`、`documents`、`filters`、`image`、`interceptors`、`library`、`maintenance`、`materials`、`memory`、`ocr`、`pdf`、`questions`、`quota`、`search`、`shared`、`storage`、`subjects`、`timeline`、`upload`、`users`。
需标注：
- `timeline` 是核心（统一收件箱，含复习本语义）；
- `questions` / `materials` **已接线但前端不调用**（空转）；
- `document`（导出流程）与 `documents`（文档记录）是**两个不同模块**，名字相近，务必写清区别。
**素材**：`server/src/`

## 3. 请求生命周期

**要写**：中间件（用户上下文）→ 守卫 → 拦截器 → 控制器 → 服务 → 数据访问 → 异常过滤器的完整链路，以及每一环能做什么、不能做什么（如配额校验放在哪一层）。

## 4. 用户上下文中间件

**要写**：
- 解析 `X-User-Id` → 查 users → 缺失则创建匿名；
- 用户对象缓存 60s（**只缓存非 null**，防"登录建号前瞬间查空"被缓存成幽灵）；只消费 id / is_anonymous / expire_at；
- 响应回写 `x-user-id`；
- 失败行为：不阻塞、降级匿名。
**素材**：`server/src/shared/`

## 5. 数据访问层

**要写**：
- Supabase client 封装（service_role）；
- ⚠️ **所有查询必须 `.eq('user_id', userId)`**（RLS 未启用，这是唯一隔离手段，见 ADD-07 第 3 章）；
- `withUrls` 富化：把 `question_images` / `answer_images` / 附件等 file_key 转成可访问 URL；**所有返回体含 `*_images` 的读端点都必须过 withUrls**（list/overview/create/createBatch/findOne/update，历史上 findOne 与 update 漏过导致详情页无图）；
- ⚠️ 删除必须 `.select('id')` 并校验非空（否则越权删除会"返回 200 但一行没删"）；
- 未分类哨兵：`subject_id='none'` 必须转为 `.is('subject_id', null)`。
**素材**：`timeline.service.ts`

## 6. DTO 与校验

**要写**：校验策略；⚠️ **`PUT /api/timeline/:id` 是局部合并**（未传字段不清空）——这是"只传 question_images 不会清空题干"的隐式依赖；⚠️ `JSON.stringify` 会丢 undefined，改 content 合并逻辑时要小心；题目允许"无题干只有图"（title 兜底「图片题目」）；查询参数一律 `cleanStr/cleanDate/cleanInt`。

## 7. 错误处理

**要写**：全局异常过滤器结构、错误码（指向 ADD-06 第 2 章）、日志格式；⚠️ **best-effort 分支的 catch 必须 `console.error` 打全错**（曾静默吞掉 mime_type 超长导致每次导出丢记录）。

## 8. 缓存层

**要写**：只写接入方式（list/findOne/overview 已接，写方法成功后 `invalidateUserTimeline`），机制引用 DD-13 第 4 章。

## 9. 身份、权限与配额

**要写**（原 DD-15）：
- 三态身份：授权 / 匿名 / 临时（24h 清理）；匿名创建与合并规则；临时 → 授权的数据处置；
- 登录链路：`code2session`、扫码票据（一次性、短时效、绑定设备）、失败降级；
- 配额模型：配额项清单（存储 / 识别 / 搜题 / AI / 超分）、计量点、超限表现、重置周期（`user_quota` 表）；
- 限流：SR 泳道并发闸 + 用户级限流 + 排队降级提示；
- 身份切换后前端必须清缓存（缓存按 userId 隔离）。
**素材**：`server/src/auth`、`quota`、`users`、`策略6-配额方案.md`

## 10. 定时任务与维护

**要写**：孤儿 blob GC（temp 24h）、临时用户清理、配额重置、dns-pin 自愈重探（5min）；任务的执行入口、频率、失败重试与安全边界（维护任务也必须带 user 维度判断）。

## 11. 子进程与侧车管理

**要写**：
- 快速识别：Python 常驻进程（stdin/stdout 管道，不占端口，预热后常驻）；
- 精准识别：PP-StructureV3 侧车 HTTP 9301，**空闲 900s 回收、按需重启**（无监听是设计行为，不是故障）；
- supervisor 的启动/健康检查/超时/重启策略；
- ⚠️ 三个 OCR 环境变量必须透传（spawn 继承 process.env）。

## 12. 配置管理

**要写**：`.env`（非敏） / `.env.secrets`（敏感，加密后随部署包） / `.env.migrate`（仅本地迁移用） / `.env.local`（前端项目域）；配置项清单表（名称 / 用途 / 是否敏感 / 默认值）；⚠️ 改了 `.env.secrets` 必须重跑 `encrypt-env.mjs`（细节见 ADD-07 第 5 章）。

## 13. 本地开发

**要写**：启动/停止/重启的标准命令、端口冲突排查、health 自检、常用 curl（⚠️ 本机 shell 需 `--noproxy '*'`）、日志位置。

## 变更记录

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v0.0 | 2026-10-24 | 建立提纲（待审） |
