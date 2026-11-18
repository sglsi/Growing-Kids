# P-032 · 裁剪改后端高分直裁，绕开微信 Canvas 1365 墙（工程类）

> 提案号：P-032 ｜ 状态：已批准（档位与存量口径经思傅 2026-11-18 逐题确认）｜ 日期：2026-11-18 ｜ 关联决策：D-092（待建 D-093）｜ 关联缺口：C-资源（打印清晰度）—— 本提案纯工程改动，**不新增学习行为、不改判据、不碰排程／激励／判定层**；按 D-015 判例走工程类降维，不写效果评估方案。
> 🔴 需求原文：思傅 2026-11-18「前端只传裁剪框坐标、后端从高分原图直接裁；项目 MEMORY.md 经常超限，有没有其他的办法」（后半句为 MEMORY 分层，另记；本提案只管裁图）。
> 🔴 两问答复（逐题确认，不代做取舍）：**Q1 档位** → 思傅选「页图提 3 倍 + 后端裁」⇒ 页图渲染维持 D-092 的 `GK_PDF_RENDER_SCALE` 默认 3（A4≈1786px），**不提到 4**；核心是把裁剪从前端 Canvas 挪到后端 sharp，绕开 1365px 墙。**Q2 存量** → 思傅选「不动存量」⇒ 11 道存量题不重裁（它们没存框坐标/源 PDF 引用，无法自动重裁），新链路只惠及今后新裁的题。

---

## 1. 触发与现状（实测代码，不是推测）

- D-091/092 复查已实锤：11 道题图打印糊的根因是裁剪底图的分辨率被两道墙锁死——① 旧 `docPages()` 写死 `scale:2`（A4≈1190px），D-092 已提到 `GK_PDF_RENDER_SCALE` 默认 3（A4≈1786px，未部署）；② 前端 `image-editor.tsx:124` `MAX_CANVAS_SIDE=1365` 是微信 Canvas 2D 官方硬上限（超过安卓 crash），`drawAndExport()`（`:858-989`）把 >1365px 的裁剪块压回 1365px。两者叠加：scale 再高也被墙吃，实得 152→186dpi。
- 裁剪框是**归一化坐标**：`crop.x/y/w/h`（相对 `naturalW/H`，`:889-897`），语义与 scale 无关——这是本提案可行的关键：同一归一化框，前端按 1365 缓冲裁，后端可按原始 1786px 裁。
- 后端已有现成能力：`image.service.ts:1252 recropWrongBlock()` 就是「收像素框 → `sharp.extract()` → `ingest()` 入库 → 回传 key/url」；`fetchImage()`（`:423`）已支持从自家 storage 取原图并读 `original`（D-091）。**无需造新轮子，复用这两段即可。**
- 调用方三处都把 `onConfirm` 返回的本地路径再 `uploadImage(..., purpose:'attach')` 上传：`recognize` 的 `handleCropConfirm`（`:1357`）、`handleSeqCropConfirm`（`:1927`）、`answer-editor` 的 `handleCropConfirm`（`:363`）。

## 2. 落地口径

| 环节 | 改动 |
|---|---|
| 后端端点 | `image.controller.ts` 新增 `POST /api/image/crop-box`，DTO `{image_url, box:{x,y,w,h}, rotation?, purpose?}` |
| 后端服务 | `image.service.ts` 新增 `cropByBox()`：`fetchImage(image_url)` 取原图（scale=3 页图/original）→ 按归一化框换算像素框 → `sharp.extract()` → `ingest()` → 回 `{key,url,width,height}`；旋转在后端用 sharp 烘焙 |
| 前端编辑器 | `ImageEditor` 加 `highResCrop?: boolean`；`cropOnly + rect` 且为 true 时 `handleConfirm` 改走新端点，回传**云端 URL**（`purpose:'attach'` 已入库，调用方 `uploadImage` 识别远程 URL 直接复用、不再二次上传） |
| 前端接入 | 只对**来自 docPages 页图**的裁剪开启 `highResCrop`：recognize 的 seq 裁剪（`curPage.url`）、manual 裁剪中 `cropEditor.src` 为页图的场景、answer-editor 的 PDF 页裁剪；本地拍照图暂不开（其 original 已是高分，1635 墙影响小） |
| 断言 | 新增 M72，锁「crop-box 用 sharp 不用 canvas / 归一化框换算 / ingest 回传 / highResCrop prop 接入」 |
| 边界 | 不改 `docPages` 倍率（D-092 已改）、不重裁存量、不改判定层、不动 `question-match.ts` |

## 3. 六栏（归因门硬结构）

### ① 判据（L1 / L2 / L3）

- **L1（事实）**：裁剪框 `crop.x/y/w/h` 是归一化坐标（相对 `naturalW/H`，`image-editor.tsx:889-897`），与渲染 scale 无关；前端 Canvas 2D `MAX_CANVAS_SIDE=1365` 是微信官方硬上限（超了安卓 crash），把 >1365px 裁块压回；D-092 已把 `docPages` 倍率提到 `GK_PDF_RENDER_SCALE` 默认 3（A4≈1786px）——底图已高清，只是被前端这最后一刀压糊。
- **L2（工程判断）**：同一归一化框，前端按 1365 缓冲裁 ≈186dpi，后端按页图原生 1786px 裁理论 ≈228dpi（按 527pt 宽、1660px 算）；后端 `image.service.ts` 已有 `fetchImage`+`sharp`+`ingest` 三件套，新端点只需组装，不造轮子；ingest 的 display 是 1600px q80，但合成端 `downloadOriginalPreferred` 读 original 原图，故裁块清晰度不被入库降质吃掉。
- **L3（不宣称）**：不宣称达 300dpi（实际以新样张实测为准）；不宣称存量题变清晰（存量不动）；不宣称印刷级/全覆盖；不宣称真机已验证或已面客。

### ② 归因（不变量 / 约束 / 准则）

- **不变量**：`server/src/shared/question-match.ts` 一行未动（P0 六条硬闸全保留）；`CACHE_VERSION` 不变；判定层、排程、激励、r11 政策与两道发布门均不动；`docPages` 倍率维持 D-092 实现（默认 3，不提到 4）。
- **约束**：新端点 `requireUserId()`、不进 `PUBLIC_ROUTES`；归一化框夹紧到 `[0, W-1]/[0, H-1]` 且最小 2px；来源图仅取可云端取回的 URL（本地临时路径由前端回退 Canvas）；裁块走 `purpose='attach'` 语义（ingest 正式存储、不建条目）；后端失败前端必须回退老路径，不留死出口。
- **准则**：同一能力只留一份实现（裁剪精度逻辑只在后端 sharp 一处）；纯函数式的框换算可离线断言；改动可回滚、可静态守卫复验；用户可撤销（裁图按附件挂载、可删）。

### ③ 证据（20b 条目 + 级别）

- 代码级：`server/src/image/{image.types,image.service,image.controller}.ts`、`src/services/api.ts`、`src/components/image-editor.tsx`、`src/pages/recognize/index.tsx`、`src/components/answer-editor.tsx`。
- 守卫级：新增 `server/scripts/verify/modules/72-crop-box-highres.mjs`（6 条：端点三件齐全 / sharp 裁非 canvas / original 不降质 / 前端 prop+回退 / 三处接入 / 边界不动）；既有 M71 与 M12/13/16/18 门禁不得回退。
- 实证级：`docs/design/method/decision-log.md` D-091/092 的 DPI 实测（题图 117~155dpi、被 1365 墙压回）是触发证据；本提案放行前须补「新裁块像素宽 >1365」的实测（见 §4）。

### ④ 算子（T / D / X）

- **T（移植）**：把「裁剪」这一既有能力从前端 Canvas 移到后端 sharp，坐标系（归一化框）原样移植，不新增学习机制。
- **D（降维）**：只解「前端墙压糊」这一处瓶颈，不做端到端画质增强、不做超分、不改扫描/渲染链路；存量题显式不动。
- **X（排除/不做）**：不提到 scale=4（思傅选页图 3 倍）；不做向量/LLM/OCR 兜底；不改判定层；不新增数据库表；不自动重裁存量。
- **宣称同步降级**：对外只能说「新裁的题按更高分辨率裁剪」，不得写成「300dpi/印刷级/所有题变清晰」。

### ⑤ falsifier

- 若新裁块实测像素宽仍 ≤1365：说明后端没真正绕开墙（可能 ingest 只存了降质 display 而合成读了它），须查 `downloadOriginalPreferred` 是否命中 original——否则本提案收益为零，应撤回。
- 若前端出现「裁完图但题目里没图」：说明 `onConfirmUploaded` 的 key/url 没被调用方正确写入 `question_images`/答案附件，须退回老路径（本地 Canvas + uploadImage）。
- 若后端端点超时/500 频繁：说明 sharp 裁高分图拖垮侧车，须降 `GK_PDF_RENDER_SCALE` 或限制裁块尺寸；此时前端回退路径必须兜住。

### ⑥ 验收断言

- 静态：`M72` 6/6 + `M71` 4/4 + 门禁 `M12/13/16/18` 全绿；`nest build` RC=0；前端 `tsc --noEmit` RC=0。
- 分步：新增提案须过 `method-gates` H1 六栏门（即本节结构）。
- 显式**不宣称**：300dpi、存量题清晰、真机已验证、已面客；放行前实证项见 §4，本提案不代为宣称完成。

## 4. 待验证（放行前必做，本提案不代做）

1. 本地造一张 scale=3 页图，调 `crop-box` 裁一块，量输出像素宽是否 >1365（证明绕过墙）。
2. 前端开发版真机裁一题，确认 `uploadImage` 未二次上传（key 唯一）、图入库正确。
3. 用新裁的题生成复习资料 PDF，实测 DPI 较 186 有提升；样本仅方向性证据，不算统计口径。
4. 上生产 dist／上传小程序／提审／发版均待思傅另行指示。
