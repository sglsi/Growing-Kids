# P-029 · 资料库多图导入：自动排序 + 手动调序 + 合成一图一页 PDF（工程类）

> 提案号：P-029 ｜ 状态：已批准 ｜ 日期：2026-11-15 ｜ 关联决策：D-063、D-064 ｜ 关联缺口：无（纯「资料入库」工程改造，不新增学习行为、不触碰排程/激励/判定层；按 D-015 判例走工程类降维，不写效果评估方案）
> 🔴 拍板原文：2026-11-14 思傅「资料导入页面中，当前只能导入文件，现增加以下功能：支持多份图片导入，导入的图片能够进行自动排序，支持手动修改排序顺序，最后将导入的图片合成一份文件进行存储」；四问答复「PDF 智能拼页 / 选择顺序＋数字序兜底（推荐）/ 缩略图＋上移·下移＋序号（推荐）/ 只存合成文件到资料库（推荐）」；2026-11-15 改判「按一图一页，开始我的理解有误，继续当前任务」⇒ **Q1 最终 = PDF 一图一页**。
> 🔴 2026-11-15 二次改判（`D-064`）：排序页改为「三列缩略图网格 + 右上角 ✕ 移入下部暂存框（可加回）+ 缩略图下方 `-N-` 页码 + 点图全屏左右滑动预览 + 长按调序 + 『确定／开始合成』两段确认」⇒ **Q3 以 D-064 为准**，原「缩略图列表 + ↑↓/删除」不再成立。
> 🔴 生效边界：本地代码已实现并验证，**未换生产 dist、未重启、未上传小程序、未提审、未发版、未写生产库**；状态「已批准」而非「已实施」。

---

## 1. 触发与现状（实测代码，不是推测）

- `src/pages/library/index.tsx` 的「导入」是 ActionSheet 两项：文档 `chooseMessageFile({count:1})`、图片 `chooseImage({count:1})`，逐条直接入库 `library_docs`，**一次一份、没有批次与顺序概念**。
- 后端 `POST /api/pdf/combine` 已有多图→PDF/DOCX 能力，但 `fetchImages()` 只认 **timeline 条目 id**，资料库上传的临时图喂不进去；且其 `combineIntoPdf()` 用 Guillotine-BSSF 智能拼页，多图共用一页会把顺序淹没。
- 微信 `chooseMedia` 不返回原始文件名、EXIF 常被剥离 ⇒「按文件名/拍摄时间排」不可靠；能用的是**选择顺序**，附带数字序兜底。

## 2. 四项拍板（逐题确认，不代做取舍）

| # | 问题 | 结论 |
|---|---|---|
| Q1 | 成品格式与版式 | **PDF 一图一页**（11-15 改判；每图独占 A4、等比居中） |
| Q2 | 自动排序依据 | 选择顺序为主，仅当每张图都带可区分真实文件名时用自然数字序兜底 |
| Q3 | 手动改序交互 | **D-064 改判**：三列缩略图网格 + 右上角 ✕ 移入下部暂存框（可加回原位）+ 缩略图下方 `-N-` 页码 + 长按调序（点选落点/±1 兜底）+ 点图 Swiper 全屏预览 + 「确定／开始合成」两段确认 |
| Q4 | 存储与留档 | 只把**一份成品**建进 `library_docs`；原图不建条目 |

### ① 判据（L1 / L2 / L3）

- **L1（事实）**：现状四条均为代码实测；`blob_objects` 无 `user_id`/owner 列，对象 key 为内容寻址；`purpose=temp` 的临时对象 `ref_count=0`，由既有孤儿 GC 24h 回收；微信 request/uploadFile 超时硬顶 60s；Taro 的 `ScrollView.onTouchMove` 事件类型是 `BaseEventOrig`，`touches` 需自行窄化（D-064 实测）。
- **L2（工程判断）**：复习本智能拼页与资料库按页序还原是**两种版式**，不复用装箱算法，但共用图片归一与 A4 常量；同步合成必须封顶张数，否则会撞 60s 天花板产生「前端超时、服务端其实已入库」的幽灵数据。D-064 不用 `movable-view` 自由拖拽，改用「长按激活 → `createSelectorQuery` 抓格子视口矩形 → touchmove 命中落点 → 松手插入」，规避与 ScrollView 的滚动冲突。
- **L3（不宣称）**：不宣称自动排序在任何机型都等于真实页序（微信不给文件名时只能按选择顺序）；不宣称 PDF 无损还原原图（沿用既有上传压缩链路）；不宣称逐对象强隔离；不宣称长按手势已在真机验证；不宣称该功能已面客。

### ② 归因（不变量 / 约束 / 准则）

- **不变量**：`shared/question-match.ts` 六条 P0 硬闸与判定层一行未动；`CACHE_VERSION` 保持 v17；`POST /api/pdf/combine` 对复习本行为零改动；`library_docs` 表结构零改动；既有单图/文档导入两条路径零改动；D-064 后端合成协议零改动。
- **约束**：新端点 `POST /api/library/combine-images` 走 `requireUserId()`，不在 `PUBLIC_ROUTES`；只接受 `tmp|blobs|raw` 前缀且无 `..` 的对象 key；`keys` 数组顺序即页序，服务端不排序、不并行；一次 ≤20 张；只有 `confirmed` 复核态才允许触发合成。
- **准则**：同一能力只留一份实现（格式归一抽 `image-normalize.ts`）；best-effort 分支必须打全错；改动可回滚、可由静态守卫与离线实证复验；删除必须可撤销（暂存框）。

### ③ 证据（20b 条目 + 级别）

- 代码级：`src/pages/library/index.tsx`、`server/src/pdf/pdf.service.ts`、`server/src/storage/ingest.service.ts`、`server/src/upload/upload.controller.ts` 的 purpose 语义表（temp / attach / save 三态）。
- 工程级：`dynamic-tests/run-library-combine-d063.cjs` 用编译产物实证「页数 == 图片数」「页序 == 入参序」「倒序入参后页序随之倒转」「WebP 可归一嵌入」「空输入 fail-closed」，另以 mock 注入验证服务层「只建 1 条 `library_docs`／keys 顺序即页序／上限与 key 白名单拒绝且不入库」，**14/14 PASS**。
- 交互级：`dynamic-tests/run-library-compose-d064.cjs` 用 TypeScript 编译器执行源码真实 `moveItem()` 函数体验证调序与边界，并检查删除暂存/恢复原位/两段确认契约、编译产物特征串与 `base.wxml` swiper 模板注册，**27/27 PASS**。
- 守卫级：`server/scripts/verify/modules/51-library-image-combine.mjs` **9/9 PASS**（A9 为 D-064 新增）；`verify:gate` 38/38、`method:check` H1/H2/H3 全绿；后端/前端 tsc、lint、双端构建 RC=0。

### ④ 算子（T / D / X）

- **T（转换）**：`chooseMedia` 多选 → `autoSortPicked()` → 网格长按 `moveCompose` / ✕ `removeCompose` / ＋ `restoreCompose` → `确定` → 复核态 → `开始合成` → 串行 `uploadFile(purpose='temp')` → `combineLibraryImages(keys, name)` → 服务端逐 key `readObject` + `normalizeImageSource` → `buildOneImagePerPagePdf` → `uploadBuffer` → `LibraryService.create()` 一条。
- **D（判定）**：服务端只按 `keys` 下标顺序逐张读取，任何解码失败跳过并记日志；全部失败 400；张数或 key 格式不合规 400。前端 `doCombine()` 在 `!confirmed` 时直接 return。
- **X（排除）**：不接 OCR 认页码（慢、有误排风险）；**不做自由拖拽浮起视图**（Taro 真机手势坑）⇒ 改长按选中 + 落点命中，并保留点选落点/±1 兜底；不做智能拼页；不把原图建成条目；不引入 jobs（本链路单请求远低于 60s，20 张封顶）；暂存框里的图不进合成、不进预览。

### ⑤ falsifier

- 若生成的 PDF 页数少于图片数 ⇒ 一图一页被改回智能拼页，判失败。
- 若交换两张图后 PDF 页序不变 ⇒ 排序未生效，判失败。
- 若合成后资料库出现 N+1 条记录或收件箱多出 N 条 ⇒ 原图误入库，判失败。
- 若 `purpose` 不是 `temp` 而临时图长期不回收 ⇒ 存储泄漏，判失败。
- 若前端改成 `Promise.all` 上传后按返回顺序组装 keys ⇒ 慢图会把页序打乱，判失败。
- 若 ✕ 直接把图真删、暂存框无法加回 ⇒ 防误删失效，判失败（D-064）。
- 若未点「确定」就能触发上传合成 ⇒ 两段确认失效，判失败（D-064）。

### ⑥ 验收断言

- `node dynamic-tests/run-library-combine-d063.cjs` → 14 PASS / 0 FAIL（顺序、页数、A4、WebP、空输入、服务层归档与闸门）。
- `node dynamic-tests/run-library-compose-d064.cjs` → 27 PASS / 0 FAIL（调序算法、暂存/恢复、两段确认、产物特征串）。
- `cd server && node scripts/verify/run.mjs M51` → 9 用例全绿。
- `pnpm verify:gate` 38/38、`pnpm method:check` 三条硬门全绿、`pnpm build:server` / `pnpm build:weapp` RC=0。
- 编译产物含 `combine-images` 与新入口文案「多张图片合成一份 PDF」。
- 真机回归（**未做，需授权发货后**）：多选 3 张 → 长按交换 → 点图左右滑预览 → ✕ 移入暂存框再 ＋ 加回 → 确定 → 开始合成 → 资料库只多 1 条 PDF → 打开核对 3 页顺序。
