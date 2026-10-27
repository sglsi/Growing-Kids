# GK-DD-12 存储与文件生命周期详细设计

> 编号：GK-DD-12 ｜ 版本：v1.0 ｜ 日期：2026-10-27 ｜ 状态：**正文完成**
> 读者：后端 / 运维 ｜ 上游：ADD-04、ADD-05、ADD-07 ｜ 下游：DD-08、DD-14、QA-16
> 定位：文件从上传到回收的全生命周期。🔴 **`purpose` 分流语义是本项目最容易出错的地方之一**。
> 边界：数据库表结构见 ADD-05，上传端点字段见 ADD-06 第 6 章，本文讲生命周期与分流规则。

---

## 1. 文档目的与读者

覆盖"**文件怎么进来 → 存在哪 → 被谁引用 → 怎么访问 → 什么时候回收**"。

---

## 2. 双驱动架构

`StorageService`（`server/src/storage/storage.service.ts`）抽象两个实现：

| 驱动 | 存储位置 | URL 形态 | 持久性 | 跨设备可见 |
|---|---|---|---|---|
| **`local`**（默认） | 本地盘 `STORAGE_LOCAL_DIR`（默认 `<cwd>/.local-storage`） | `http://127.0.0.1:{port}/api/storage/files/{key}` | 依本地盘 | ❌ 仅本机 |
| **`supabase`** | Supabase Storage，bucket `media` | 公共桶公网直链 / 私有桶签名 URL | 高 | ✅ |

- 切换：`STORAGE_DRIVER=local|supabase`；桶名 `SUPABASE_STORAGE_BUCKET`（默认 `media`）；公共桶开关 `SUPABASE_STORAGE_PUBLIC`（默认 `true`）。
- ⚠️ `local` 驱动的 `resolveLocal()` 做**路径逃逸防护**（`../` 拒绝）。
- 相关：`blob_objects` 表（内容寻址）、`ref_count` 引用计数、`ingest.service.ts`。

**当前生产配置**：`STORAGE_DRIVER=local`（本机 3001 联调）+ `SUPABASE_STORAGE_PUBLIC=true`。

---

## 3. 上传协议与 `purpose` 分流（⚠️ 改上传逻辑前必读）

| purpose | 存储 | 是否建业务记录 | 说明 |
|---|---|---|---|
| `save` / `1` / `true` | 正式（ingest），`ref_count +1` | ✅ **建**：图片 → `timeline(kind=image)`；文档 → `library` 条目 | 用于"这张图本身就是一条内容" |
| `temp` | ingestTemp，`ref_count = 0` | ❌ | **24h 后 GC 回收** |
| `memory` | 正式 | ❌ | key 由 `memory_media` 关联 |
| `attach` 及其他值 | 正式 | ❌ | **附件**，key 由别处引用（写进题目的 `content.question_images` 等） |

### 3.1 🔴 「要持久化」≠「用 save」

**附件类上传必须用 `attach`**。误用 `save` 会在**上传瞬间**多建一条"最近题目"，与随后保存的题目重复 ⇒ **首页同一道题显示两行**（历史上三轮复测才坐实，是"图文分家"的真因）。

**保留 `save` 的三处（不要改）**：

1. 依赖返回的 `timeline_id` 的上传；
2. `image-editor` 存图；
3. `library` 传文档。

### 3.2 中文文件名

微信 `uploadFile` 的 multipart filename 取的是**临时文件路径名**（`tmp_xxx.pdf`），后端拿不到真实名 ⇒ 资料库显示一串随机名。

**解法**：`formData.original_name = encodeURIComponent(name)`（表单字段值 UTF-8 安全，不像 `Content-Disposition` 头会被 Node 按 latin1 读成乱码），后端优先读它并做 latin1→utf8 回转。

---

## 4. 命名与 key 规则

- **生成**：`ingest` 按内容 sha256 分目录，形如 `blobs/<2位hex>/<64位sha256>/<variant>`；variant = `original` / `display` / `thumb`。
- **唯一性**：内容寻址（sha256）保证；同内容多用户共用**一个**物理对象。
- 🔴 **只存 key，不存 URL**（ADR-001）：URL 会变（驱动切换、端口变化、签名过期），key 不变。
- ⚠️ **key 一律 ASCII**：Supabase 会拒 `Invalid key`，中文文件名（如 `复习资料-xxx.pdf`）上传必然失败；`local` 驱动不报错 ⇒ **本地联调正常、切 supabase 才炸**。中文只出现在 `documents.title`（展示名）与 `original_name`（上传原名）。
- **指纹可反解**：从 key 或 URL 可直接解析出 64 位 sha256。

---

## 5. 引用计数与孤儿 GC

### 5.1 `ref_count` 维护点

| 动作 | 计数 |
|---|---|
| 上传命中已有内容（`acquire`） | **+1**，且复用 `storage_key`（**调用方不要再上传**） |
| 首次登记（`register`） | 初始化为 **1** |
| 登记临时对象（`registerTemp`） | **0**（24h 可回收） |
| 删除 / 软删（`release`） | **−1**；归零返回 `shouldDelete=true` |

**删除业务条目时只解引用、不物理删文件**（与"编辑替换"同一语义），物理删除交给 GC。

### 5.2 ⚠️ 两条最危险的误用

1. `register()` **不覆盖已有的正式记录**（尤其 `kind='image'`）——一次 temp 上传把正式资产"降格"成 temp ⇒ 24h 后 GC 删掉 ⇒ **已保存的图片裂掉**；
2. `registerTemp()` 若该内容已登记过（无论 image 还是 temp）**直接复用、不改任何字段**。

### 5.3 ⚠️ 条目层查重必须在 ingest 之前

按 `(user_id, file_hash)` 查到已有条目 ⇒ 复用 / 从回收站 restore。

**若在 `acquire` 之后才发现重复且不建条目，`ref_count` 会虚高 ⇒ blob 永不回收**（2026-10-25 修）。

### 5.4 GC 执行

| 任务 | 频率 | 判据 |
|---|---|---|
| `collectOrphanBlobs` | 每日 4AM | `ref_count = 0` 且 `last_ref_at < now() - 24h` |

- **唯一真删文件的地方**：删所有派生档（original / display / thumb）→ **全部成功后**才清登记行（避免"行没了文件还在"）；
- 🔴 `ref_count > 0` **永不删**；
- 🔴 默认 **dry-run**（`STORAGE_GC_DRY_RUN` 默认 `true`），确认日志后再关。

完整契约与 CAS 实现见 ADD-05 第 9 章。

---

## 6. 访问与下载

### 6.1 public 桶永久有效

`getPublicUrl()` 返回**公开桶直链**，`永久有效、非签名` ⇒ 缓存存久了**不会图裂**（这是前端敢做 SWR 缓存的前提，见 DD-13 第 2.4 节）。

⚠️ 若改为私有桶 + 签名 URL（86400s），该前提失效 ⇒ 要么 TTL 短于签名有效期，要么缓存只存 `file_key`、渲染时再换 URL。

### 6.2 🔴 手机必须走后端代理

**真机实测**：手机直连 Supabase（新加坡）`downloadFile` **60s 超时**（`reportTask costTime too long: 60022ms`）。

**解法**：`GET /api/storage/files/{file_key}` 后端代理（`serveFile`，本地盘没有时从 Supabase 服务端下载回传）。

前端统一入口 `openStorageFile(url, isPdf, fileKey?)`：

```ts
openStorageFile(res.url, false, res.file_key)   // ✅ 第三参必须传，否则不走代理
```

⚠️ **9 个调用点已补齐，新增调用点必须遵守**。

⚠️ 所有 `downloadFile` 必须**显式 `timeout: 30000`**（默认 60s 太久），失败兜底 = 复制公网 URL 到剪贴板。

⚠️ **代理下载同样要校验归属**（ADD-07 第 3.3 节）——不能因为"key 不可猜"就跳过。

---

## 7. 缩略图

| 项 | 约定 |
|---|---|
| 生成时机 | `ingest` 时由 sharp 生成 `thumb` 档（WebP，宽 ≤400） |
| 存储 | `blob_objects.variants.thumb` + 业务表 `thumb_key` |
| 使用规则 | **列表用 `thumb_key`，详情/预览用原图** |
| 容量 | `blob_objects.thumb_bytes` 单独记账（<64KB，刻意不参与转档） |

⚠️ 所有返回体含 `*_images` 的读端点必须过 `withUrls`（含缩略图 URL 富化）。

---

## 8. PDF 合成与文档导出

### 8.1 双格式（2026-10-24 定稿）

复习本批量选择后，同一入口「合成 PDF/WORD」，由用户选格式：

| 格式 | 实现 | 适用 |
|---|---|---|
| **PDF** | `pdf-lib` + **Guillotine-BSSF 智能拼页**；多图共用一页、省纸少留白 | 直接打印 |
| **DOCX** | `docx` 库图片顺排（A4 + 34pt 页边距） | 家长可编辑、加批注后再打印 |

两路共用素材下载与格式归一，产物统一归档 `documents`（`type` = `pdf` / `docx`）。

### 8.2 两个已确认的坑（2026-10-24 实跑坐实，勿回退）

1. 🔴 **对象存储 key 只接受 ASCII**（见 §4）——本地联调正常、切 supabase 才炸；
2. 🔴 **素材格式必须归一**：`pdf-lib` 与 `docx` **只吃 PNG/JPEG**，而素材里存在 WebP ⇒ 症状是「PDF 报『所选素材中没有可合成的图片』」「Word 里图片损坏打不开」，**二者根因同一个**。
   **规则**：合成前用 `sharp` 读 metadata，非 png/jpeg 时按 `hasAlpha` 转 PNG 或 JPEG(quality 92)；sharp 失败才回退头部解析。

### 8.3 导出记录入库

⚠️ `mime_type` 长度：docx 的 MIME 长 **71 字符**，曾超过 `varchar(64)` ⇒ **每次导出静默丢记录**（文件生成了、能打开，但文档库看不到）。**0013 已放宽至 128**（PDF 的 `application/pdf` 仅 15 字符，故此前未暴露）。

### 8.4 打开 / 分享

走代理 + `file_key`（§6.2）；大文件与超时兜底 = 复制链接。

---

## 9. 配额与容量

| 项 | 口径 |
|---|---|
| 计量 | 按 `blob_objects` 的**物理字节**（display 档计入配额；**原图留档不计入**——用户消费的是 display/thumb） |
| 释放 | **已软删不计入**（删了就释放，用户才有自我管理路径）；`temp` 不占长期配额 |
| 双阈值 | `quota_bytes`（字节）与 `quota_count`（张数）**先到先触发** |
| 月流量兜底 | `monthly_bytes`——原图留档不计入配额后的安全兜底 |
| 超限表现 | 由 `QUOTA_MODE` 决定：`off` / `shadow` / `warn` 都不阻断，只有 `block` 真拦截 |

档位与判定逻辑见 DD-09 第 9.3 节；分层统计配置见 `docs/策略3-生命周期分层-配置清单.md`。

---

## 10. 故障与运维

| 场景 | 处置 |
|---|---|
| **驱动切换回退** | 改 `STORAGE_DRIVER` 重启即可；⚠️ 两个驱动的对象不互通，切回后旧 key 在新驱动下取不到 ⇒ 迁移需脚本搬运 |
| **孤儿清理手动触发** | 日志观察 `collectOrphanBlobs` 的 dry-run 输出；确认后设 `STORAGE_GC_DRY_RUN=false` 重启 |
| **Storage 不可用** | 上传/下载失败；已入库条目的图片会裂。⚠️ 当前无自动降级到另一驱动的机制（登记 OPS-18） |
| **本地 ↔ Supabase 迁移** | `server/scripts/backfill-storage.ts`、`fix-tmp-file-keys.ts` |
| **误删防护** | ① 软删 7 天窗口；② GC dry-run 默认开；③ `ref_count > 0` 永不删 |

---

## 变更记录

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v0.0 | 2026-10-24 | 建立提纲（待审） |
| v1.0 | 2026-10-27 | **正文完成**：双驱动对照与当前配置、purpose 四档分流与「要持久化≠用 save」红线、key 命名与 ASCII 铁律、ref_count 四个维护点与两条危险误用、条目层查重必须先于 ingest、GC 判据与 dry-run 安全阀、public 桶永久有效与手机代理的实测依据、缩略图规则、PDF/DOCX 双格式与两个实跑坑、配额计量口径、运维场景与误删三道防护 |
