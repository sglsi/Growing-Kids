# GK-DD-12 存储与文件生命周期详细设计

> 编号：GK-DD-12 ｜ 版本：v0.0（提纲） ｜ 日期：2026-10-24 ｜ 状态：提纲待审
> 读者：后端 / 运维 ｜ 上游：ADD-04、ADD-05 ｜ 下游：DD-08、QA-16
> 定位：文件从上传到回收的全生命周期。**purpose 分流语义是本项目最容易出错的地方之一**。

---

## 1. 文档目的与读者

**要写**：覆盖"文件怎么进来、存在哪、被谁引用、怎么访问、什么时候回收"；数据库表见 ADD-05，上传端点字段见 ADD-06 第 6 章，本文讲生命周期与分流规则。

## 2. 双驱动架构

**要写**：
- 抽象接口与两个实现：`local`（本地盘）与 `supabase`（Supabase Storage，bucket `media`，**public 桶**）；
- 当前生产配置与回退方式（`.env` 的 `STORAGE_DRIVER`）；
- 两驱动的行为差异（URL 形态、持久性、跨设备可见性）与选择依据；
- 相关服务：`storage`、`blob_objects` 表、`ref_count` 引用计数。

## 3. 上传协议与 purpose 分流

**要写**（⚠️ 改上传逻辑前必读）：
| purpose | 存储位置 | 是否建业务记录 | 说明 |
|---|---|---|---|
| `save` / `1` / `true` | 正式（ingest），ref_count +1 | **建**：图片 → timeline(kind=image)；文档 → library 条目 | 用于"这张图本身就是一条内容" |
| `temp` | ingestTemp，ref_count=0 | 不建 | **24h 后 GC 回收** |
| `memory` | 正式 | 不建 | key 由 `memory_media` 关联 |
| `attach` 及其他值 | 正式 | **不建** | 附件，key 由别处引用（写进题目的 `question_images` 等） |
- ⚠️ **「要持久化」≠「用 save」**：附件类上传必须用 `attach`；误用 `save` 会在上传瞬间多建一条"最近题目"，与随后保存的题目重复 ⇒ **首页同一道题显示两行**（历史上三轮复测才坐实）；
- 保留 `save` 的三处（依赖返回的 `timeline_id`、image-editor 存图、library 传文档）不要改；
- 中文文件名：`formData.original_name = encodeURIComponent(name)`，后端优先读它并做 latin1→utf8 回转（multipart filename 走临时名且非 ASCII 会被 Node 按 latin1 读成乱码）。
**素材**：`server/src/upload/upload.controller.ts`、`src/services/api.ts`

## 4. 命名与 key 规则

**要写**：`file_key` 的生成规则（目录分层、随机段、扩展名保留）、唯一性保证、为什么只存 key 不存 URL（ADR-001）、重命名与迁移的影响。

## 5. 引用计数与孤儿 GC

**要写**：
- `ref_count` 的维护点（上传 +1、被引用 +1、引用移除 -1）；
- 删除业务条目时**只解引用、不物理删文件**（与"编辑替换"同一语义），物理删除交给 GC；
- `temp` 用途的 24h 孤儿回收任务；
- GC 的执行入口、频率、安全边界（ref_count>0 永不删）与误删防护。

## 6. 访问与下载

**要写**：
- public 桶 `getPublicUrl` **永久有效**（非签名 URL）⇒ 缓存久了不会图裂（这是前端敢缓存的前提）；
- ⚠️ **手机访问对象存储必须走后端代理** `GET /api/storage/files/{file_key}`：手机直连跨境段会 60s 超时；代理在后端 `serveFile` 内本地盘没有时从 Supabase 服务端下载回传；
- 前端统一入口 `openStorageFile(url, isPdf, fileKey?)` —— **第三参必须传 file_key，否则不走代理**（9 个调用点已补齐，新增调用点必须遵守）；
- ⚠️ 所有 `downloadFile` 必须显式 timeout（统一 30s），失败兜底复制公网 URL；
- 权限：代理下载同样要校验归属（ADD-07 第 3 章）。

## 7. 缩略图

**要写**：`thumb` 列的生成时机与尺寸、列表用缩略图 / 详情用原图的规则、历史补生成方式。

## 8. PDF 合成与文档导出

**要写**：
- **合成导出双格式**（2026-10-24 定稿）：复习本批量选择后同一入口「合成PDF/WORD」，由用户选格式——
  - `PDF`：`pdf-lib` + Guillotine-BSSF 智能拼页，多图共用一页、省纸少留白，适合直接打印；
  - `DOCX`：`docx` 库图片顺排（A4 + 34pt 页边距），家长可编辑、加批注后再打印；
  - 两路共用素材下载与格式归一（见下条），产物统一归档 `documents`（`type` 分别为 `pdf`/`docx`）；
- 导出记录入库 ⚠️ `mime_type` 长度（docx 的 71 字符曾超过 varchar(64) 导致**每次导出静默丢记录**，0013 已放宽至 128）；
- 打开/分享导出的文件（走代理 + file_key）；
- 大文件与超时的兜底（复制链接）。

**已确认的两个坑（2026-10-24 实跑坐实，勿回退）**：

1. ⚠️ **对象存储 key 只接受 ASCII**。Supabase 会拒 `Invalid key`，中文文件名（如 `复习资料-xxx.pdf`）上传必然失败；`local` 驱动不报错 ⇒ 本地联调正常、切 supabase 才炸。**规则：key 一律 ASCII（如 `review-pack-${Date.now()}.pdf`），中文只出现在 `documents.title`（展示名）与 `original_name`（上传原名）**。
2. ⚠️ **素材格式必须归一**。pdf-lib 与 docx 都只吃 PNG/JPEG，而素材里存在 WebP 等格式 ⇒ 症状是「PDF 报『所选素材中没有可合成的图片』」「Word 里图片损坏打不开」，二者根因同一个。**规则：合成前用 `sharp` 读 metadata，非 png/jpeg 时按 `hasAlpha` 转 PNG 或 JPEG(quality 92)**；sharp 失败才回退头部解析（保持旧行为）。

## 9. 配额与容量

**要写**：用户存储配额的计量口径（按 `blob_objects.size` 还是按条目）、超限表现、容量分层策略（指向 `docs/策略3-生命周期分层-配置清单.md`）。

## 10. 故障与运维

**要写**：驱动切换回退、孤儿清理手动触发、Storage 不可用时的影响面与降级、本地 ↔ Supabase 迁移脚本。

## 变更记录

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v0.0 | 2026-10-24 | 建立提纲（待审） |
