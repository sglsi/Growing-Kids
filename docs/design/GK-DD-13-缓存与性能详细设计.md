# GK-DD-13 缓存与性能详细设计

> 编号：GK-DD-13 ｜ 版本：v1.0 ｜ 日期：2026-10-27 ｜ 状态：**正文完成**
> 读者：全体 ｜ 上游：ADD-04、ADD-05 ｜ 下游：DD-08、DD-09、QA-15
> 定位：双层缓存（前端 SWR + 后端 mem-cache）与性能基线的**唯一权威说明**。跨层机制集中在此，DD-08 / DD-09 只引用不重复。

---

## 1. 性能目标与基线

### 1.1 为什么必须缓存

数据库在 **Supabase 新加坡**，单次 RTT 高（实测 ~1.5s）。更关键的是 **`UserContextMiddleware` 对每个请求都要查一次 `users` 表**——这是一个隐藏的、每个请求都付的固定成本。前端缓存省掉的是"第二次查询"，这第一次一直没省，直到用户对象缓存落地。

### 1.2 基线与实测

| 场景 | 目标 | 实测 | 测量方式 |
|---|---|---|---|
| 首页首帧（缓存命中） | 0 网络等待 | ✅ 同步读缓存直接渲染 | 冷/热启动对比（SWR） |
| timeline 列表接口 | 消除重复 RTT | 热路径 **3.06s → 0.0025s** | 服务端计时（缓存前后） |
| 用户校验查询（每请求） | 60s 内不查库 | ~1.5s（未缓存）→ 缓存 60s 后 ~0 | 服务端计时 |
| Supabase 单次 RTT | — | ~1.5s（新加坡） | 服务端计时 |
| OCR fast / precise | 1~3s / 更长 | 见 DD-10 | 客户端计时 |
| 跨用户重复文件识别 | 命中缓存秒回 | **62.5s → 1.3s**（47.5×） | `ocr_results` 缓存前后 |
| 小程序主包 | < 2MB | 918 KB（2026-10-26） | 开发者工具「代码依赖分析」 |

> 3.06s 是「用户校验 1.5s + 列表查询 1.5s」的叠加——这也解释了为什么单做前端缓存不够，两层必须都做。

---

## 2. 前端缓存（SWR）

实现：`src/services/cache.ts`。

### 2.1 存储与 key 结构

```
gkc:{userId}:{域}:{子键}
```

- **key 带 `userId` ⇒ 账号隔离**；未登录（匿名 id 未回传）归到 `anon` 桶；
- 登出 / 切身份必须 `clearAllCache()`（保守清所有 `gkc:` 前缀，含 LRU 索引）；
- 小程序 Storage 上限 10MB：列表域只缓存各页面当前查询，详情域 LRU 上限 30 条。

### 2.2 三个分支行为

| 情况 | 行为 |
|---|---|
| 缓存存在且未过期 | **同步**返回数据渲染首帧（0 网络等待），同时后台发请求刷新 |
| 缓存过期 / 不存在 | 返回 `null`，页面走骨架屏路径，请求完成后 `cacheSet` 回写 |
| 读/写缓存抛异常 | **静默降级**（缓存是优化不是依赖），任何异常都不影响主流程 |

### 2.3 域与 TTL

| 域前缀 | 内容 | TTL |
|---|---|---|
| `tl:list:` / `tl:ov:` | 题目列表 / 概览 | 5 分钟 |
| `tl:item:` / `mem:item:` | 题目详情 / 记忆详情 | 10 分钟（**LRU 30 条**） |
| `subj:` | 学科（极少变） | 30 分钟 |
| 其余（默认） | 列表类 | 5 分钟 |

TTL 按 key 前缀判定（`ttlOf()`），详情域写缓存时 `touchLru()` 置顶，超出 30 条弹最旧并删其 storage。

### 2.4 缓存安全前提（改动前必读）

图片 URL 来自后端 `withUrls` → `getPublicUrl`，**公开桶、永久有效、非签名 URL** ⇒ 缓存存久了**不会图裂**。

⚠️ **若将来改为私有桶 + 签名 URL，本前提即失效**：签名过期后缓存里的旧 URL 会全部图裂。届时要么缩短 TTL 短于签名有效期，要么缓存只存 `file_key`、渲染时再换 URL。

---

## 3. 写后失效收口（本设计的核心纪律）

实现：`src/services/api.ts` 的 `invalidateAfter(p, ...domains)`。

### 3.1 规则

```ts
// 用法：请求成功后才失效，失败不清
return invalidateAfter(unwrap<T>(Network.request({ ... })), 'tl')
return invalidateAfter(p, 'subj', 'tl')   // 多域
```

- **成功后才失效**：请求 reject 时缓存原样保留——它仍反映服务端现状，页面回退显示缓存比白屏好；
- 失效实现为**按域前缀扫描删除**（`invalidateDomain` 遍历 `getStorageInfoSync().keys`）；
- 🔴 **新增写接口必须包 `invalidateAfter`**，否则缓存 5~10 分钟不刷新。这是**最容易漏**的地方，列为提交自查项。

### 3.2 域表与判定

| 域 | 覆盖 | 触发写操作 |
|---|---|---|
| `tl` | 题目列表 / 详情 / 概览 | 题目增删改、复习本加减、上传（save）、OCR 保存 |
| `subj` | 学科 | 学科增删改 |
| `lib` | 资料库 | 资料库条目增删改 |
| `doc` | 文档导出 | 导出 / 合成 / 删除文档 |
| `mem` | 成长记忆 | 记忆与媒体增删改 |

### 3.3 `uploadFile` 按 purpose 判域

| purpose | 失效域 | 说明 |
|---|---|---|
| `save` / `1` / `true` | `tl` + `lib`（按 `archiveTo` 判定） | 建了业务条目 ⇒ 必须失效 |
| `memory` | `mem` | 持久化但不建条目 |
| `temp` / `attach` | **不清** | 不建条目，清了是白清（且会造成无谓的骨架屏） |

### 3.4 auth 三个身份切换点必须 `clearAllCache()`

`login` / `applyLoginUser` / `logout`（`src/services/auth.ts`）。身份变了而缓存按 `userId` 分桶，不清理会串号。

---

## 4. 后端缓存（mem-cache）

实现：`server/src/shared/mem-cache.ts`。

### 4.1 机制

- `Map<string, Entry>` + TTL（默认 **30s**）+ 前缀失效；
- 定时每分钟清理过期项防内存膨胀，定时器 `unref()` 不阻止进程退出；
- **所有 key 必须带 `userId`**（本项目 RLS 全靠代码层隔离，缓存同理）；
- 单进程部署（本地 3001 / 云托管单容器）⇒ Map 足够，**不引 Redis**。⚠️ 一旦多副本部署，本模块必须换成共享缓存（登记 OPS-18）。

### 4.2 timeline 域接入点

| 方法 | 缓存 key | 失效 |
|---|---|---|
| `list()` | `tl:list:{userId}:{stableQuery(q)}` | `invalidateUserTimeline(userId)` |
| `findOne()` | `tl:item:{userId}:{id}` | 同上 |
| `overview()` | `tl:ov:{userId}` | 同上 |

`stableQuery()` 排序 + 过滤空值 ⇒ 同查询同 key（与前端 `cacheListKey` 同思路）。

**所有写方法**（create / createBatch / update / remove / removeMany / review / markReviewed）成功后**必须**调 `invalidateUserTimeline(userId)`。最坏情况下读到 30s 内的旧值。

### 4.3 用户对象缓存（60s）

`UserContextMiddleware` 每个请求查一次 users 表，是隐藏的最大瓶颈：

- TTL **60s**（`USER_CACHE_TTL`），key `user:{userId}`；
- **只缓存非 null**——避免把"刚登录建号前后的瞬间查空"缓存成 60s 幽灵用户；
- 下游只消费 `id` / `is_anonymous` / `expire_at`，一分钟内稳定；登录是新 user id（新 key），改资料不动这三个字段 ⇒ 无一致性风险。

### 4.4 其它接入点

| 位置 | 用途 | TTL |
|---|---|---|
| `answer-search.service.ts` | ① 用户级调用计数（配额保护）② 答案结果缓存（DB 持久化前的内存层） | `CACHE_TTL_MS` |
| 新增读接口 | 照此模式：`memGet` → 未命中查库 → `memSet`；**key 必须带 userId** | 30s 起 |

---

## 5. 静默刷新（silent）

### 5.1 现象（本项目最痛的一个问题）

列表内任何写操作（加入/移出复习本、删除、改分类、上传、导出）后，**页面跳回第 1 题**。

### 5.2 根因链

```
写操作 → invalidateAfter 清缓存 → load() 走 setLoading(true)
       → 整页骨架屏替换列表 → ScrollView 内容高度塌缩
       → 原生滚动位置被钳到 0
```

注意：缓存失效是**对的**，错的是"失效后用骨架屏整页重绘"。

### 5.3 修法

五个列表页（首页 `index` / 复习本 `subject` / 资料库 `library` / 成长记忆 `memory` / 文档导出 `document`）的 `load()` 增加 `silent` 选项：

```ts
const load = async (sid = subjectFilter, opts: { silent?: boolean } = {}) => {
  // 缓存命中：不置 loading
  if (!opts.silent) setLoading(true)
  ...
  if (!opts.silent) setLoading(false)   // 失败分支同理
}
```

`silent` = **不置 loading、不显骨架，旧列表留在屏上，后台拉新数据静默替换**。

### 5.4 适用范围

| 场景 | 走哪条路 |
|---|---|
| **所有列表内写操作**（加/移复习本、删除、改分类、上传、导出） | `silent` |
| 筛选切换 / 分页追加 / 首屏加载 | 骨架路径（非 silent） |

### 5.5 与「详情返回按 id 锚回」的分工

两套机制**缺一不可**，各治一种跳转：

| 机制 | 治理场景 | 实现 |
|---|---|---|
| **silent 刷新** | 列表内操作（不跨页） | `load({ silent: true })` |
| **按 id 锚回** | 从详情页返回（跨页） | `restoreItemIdRef` + `useDidShow` 单次恢复 |

---

## 6. 数据库访问优化

减少 RTT 的手段清单（按收益排序）：

1. **缓存优先**（第 2、4 章）——收益最大的一层；
2. **查询合并**：概览页的 4 个 count 用 `Promise.all` 并行，不要串行；
3. **避免 N+1**：学科名用 `subjects(id,name)` 内嵌 select 一次带出，不逐条查；
4. **`withUrls` 批量富化**：签名/公开 URL 在 service 层一次性批量生成，不在页面层逐条调；
5. **只取需要的列**：列表不 select `content`（jsonb 可能很大），详情页才取；
6. **分页大小**：列表 `page_size` 与首屏视口匹配，避免一次拉全量；
7. **新表索引**：新建带 `updated_at` 的表后记得补索引（指向 ADD-05 第 7 章）；
8. ⚠️ **禁止在每个请求里新增"顺便查一下"**：每多一次 Supabase 往返 ≈ 多 1.5s。

---

## 7. 图片与文件加载优化

| 项 | 约定 |
|---|---|
| **缩略图** | 列表一律用 `thumb_key`（WebP，宽 ≤400）；原图只在详情页/预览用 |
| **public 桶直连** | 小程序 `<Image>` 直连公开桶 URL，省一次后端往返 |
| **手机必须走代理** | 打开文档（`openDocument`）走 `/api/storage/files/{file_key}` 后端代理——真机实测手机直连 Supabase 新加坡 `downloadFile` **60s 超时**（`reportTask costTime too long: 60022ms`） |
| **超时兜底** | `downloadFile` 显式 `timeout: 30000`（默认 60s 太久）；失败 `setClipboardData` 复制链接 + 提示 |
| **上传前客户端粗压** | 长边 ≤1600 / q80（`UPLOAD_MAX_SIDE` / `UPLOAD_COMPRESS_QUALITY`）。⚠️ 服务端仍会 sharp 精压一遍（权威压缩点），客户端压缩失败或被跳过**不影响最终体积**——是优化不是依赖 |
| **占位与懒加载** | 列表图片给固定尺寸占位，避免布局抖动；长列表分页而非一次渲染 |

---

## 8. 已做优化记录

| 日期 | 问题 | 手段 | 前后数据 |
|---|---|---|---|
| 2026-10-21 | 每次点开题目都要等 | ① timeline list/findOne/overview 后端缓存 ② 用户对象缓存 60s | 热路径 **3.06s → 0.0025s** |
| 2026-10-21 | 首页首屏白屏等待 | 前端 SWR：进入先同步读缓存渲染 | 首帧 0 网络等待 |
| 2026-10-23 | 列表内写操作后跳回第 1 题 | 五页 `load({ silent: true })` | 滚动位置不再丢失 |
| 2026-10-25 | 同文件重复上传/重复识别 | ① blob 内容寻址 ② `ocr_results` 全局缓存 | 跨用户重复识别 **62.5s → 1.3s**（47.5×） |
| 2026-10-24 | ima 日配额被反复消耗 | `answer_cache` 落库持久化 | 同一题同一 mode 永不重复消耗外部配额 |

---

## 9. 性能回归检查项

每次改动后自查（建议作为提交前 checklist 的一部分）：

- [ ] **新增读接口**是否接了缓存（前端 SWR 或后端 mem-cache）？key 是否带 `userId`？
- [ ] **新增写接口**是否包了 `invalidateAfter`（前端）/ `invalidateUserTimeline`（后端）？
- [ ] **新增列表页**的 `load()` 是否支持 `silent` 选项？列表内写操作是否都传了 `silent: true`？
- [ ] 是否引入了**新的每请求查询**（尤其注意中间件、拦截器、守卫里）？
- [ ] 列表图片是否用了 `thumb_key`（而非原图）？
- [ ] 是否有 N+1 查询？多个独立查询是否 `Promise.all` 并行？
- [ ] 打开文档是否走 `/api/storage/files/{file_key}` 代理？`downloadFile` 是否显式 30s 超时？
- [ ] 主包体积是否仍 < 2MB？新增依赖是否必要？

---

## 变更记录

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v0.0 | 2026-10-24 | 建立提纲（待审） |
| v1.0 | 2026-10-27 | **正文完成**：补齐性能基线实测表（含跨用户识别 47.5×、包体 918KB）、前端 SWR key 结构与三个分支行为、写后失效收口规则与 purpose 判域表、后端 mem-cache 接入点与 60s 用户缓存、静默刷新根因链与适用范围、DB/图片优化清单、已做优化记录 5 条、回归检查项 8 条 |
