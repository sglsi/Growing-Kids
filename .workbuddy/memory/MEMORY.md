# Growing-Kids 长期约定（r79 · 分层索引）

> **结构**：本文件＝索引＋最高优先级红线（系统自动注入）。**详细规则在 `.workbuddy/memory/rules/NN-主题.md`（不会自动注入，动相关领域前必读对应文件）**。完整证据＝`MEMORY-full-archive.md`、`docs/reports/`、`proposals/P-NNN`、`docs/design/method/decision-log.md` D-NNN。
> **维护**：新增规则先写对应 `rules/` 文件；本文件只补「闯祸级红线＋指针」，目标 <10KB（此前反复触 16KB 上限）。任何 🔴/⛔ 不得从两层中丢失。

## 导航：动什么 → 先读哪个 rules 文件
| 领域 | 文件 |
|---|---|
| 改学习行为/流程/评审 | `rules/00-流程红线.md` |
| 生产/SSH/部署/侧车/转换/微信CLI | `rules/01-环境与发货.md` |
| 数据库/备份/去重/RLS | `rules/02-数据红线.md` |
| 检索判定/P0硬闸/图形/课标/签核 | `rules/03-检索与判定.md` |
| 前端裁剪/光标/LaTeX/页码/隐私拦截 | `rules/04-接口与前端.md` |
| AI开关/品牌/存储/Caddy/健康探针 | `rules/05-AI与品牌.md` |
| 发布/备案/PIPL/真机验证 | `rules/06-发布与验证.md` |
| 排程/年级/CI/本机删除守卫 | `rules/07-其它.md` |

## 🔴 最高优先级红线（不知道就会闯祸，明细见对应 rules）
**环境与发货**
- 生产＝L3 `42.192.36.120`；SSH 用 **`ubuntu@42.192.36.120`**（非 root/ubu），默认 `~/.ssh/id_ed25519` 可用；查删必 ssh、删前备份。本地 `.env` 是 Supabase 云开发库**非现网**。微信 IDE 唯一目录 `D:\AI\Growing-Kids`。
- **commit≠发货≠生产有代码**：前端 `build:weapp`→上传→提审→发版；后端换 `server/dist` 重启 `gk-api`。精准换 dist＝build→sha256 比对→备份旧→只覆盖点名文件＋`chown gk:gk`＋`chmod 644`→复比零差异→才重启。漏 `ocr-engine/*.py`⇒静默降级（在 `/opt/gk/ocr-engine/`）。
- 实跑签 token 须 `sudo -u gk bash -c 'set -a; . .env.secrets; node gen-token.cjs <uid>'` 否则 401。生产 `STORAGE_PUBLIC_BASE_URL` 必须 `https://deep-root.cn`（旧 http IP⇒裂图）。`:8080` 是 Caddy 非 PostgREST 直连；真健康打 `:3000/api/health`（`:8080/api/health` 是空 200 假探针）。
- 侧车 `gk-ppsv3.service`（:9301/1.6G）空闲 15min stop、被调用预热 ~17s；`/healthz` 200≠能用。gk-api 带 NoNewPrivileges⇒授权只走 polkit `/etc/polkit-1/rules.d/49-gk-ppsv3.rules`＋`PPSV3_UNIT_SUDO=0`。

**数据**
- 无 RLS⇒查询必 `.eq('user_id', …)`；删除加 `.select('id')` 校行数；真相源只有 `migrations/`；空串≠NULL 回写前 `trim()`；PG text 不收 U+0000⇒`stripNul()`；媒体读端点必须 `res.sendFile` 禁 `.pipe()`。
- 备份 `gk_backup` 必须 `bypassrls`；🔴 派生表（`question_objects`/`question_figures`/`question_inline_figures`）不进备份、恢复后重建；备份未成功前不 `--apply`。改引擎/切分必 bump 版本。

**检索与判定（判定层一行未动是放行前提）**
- 真相源 `shared/question-match.ts`（零依赖单文件，不加 import）。🔴 P0 六条硬闸串联否决、禁改加权求和：≥3 长锚点／题干 ≤6000 字／设问一致／锚点共现限对象内／相邻解析段 ≥8 字不串题号／来源唯一；举证责任倒置。
- ⛔ 不上向量库/Reranker/LLM 兜底（仅判定层）；⛔ 拍照搜题，exact 才放解析。⛔ 已证伪别重走（P-013 改召回选词／单独切题 OCR／P-014 换词，见 rules/03）。
- 🔴 不宣称命中提升/误判归零/全覆盖；样本仅方向性证据、不得算召回率；唯一够格指标＝`0021 review_events`（0 行）。开发版、未提审未发正式版，两门仍关。
- 🔴 图形：定位不到不入库不下发、绝不拿相邻题顶替，错图比没图更糟；公式必须 PDF 渲染；⛔ WMF／`≤→£` 假证伪。

**接口与前端**
- 🔴 光标：两个 pnpm 补丁＋`flushSync()`＋丢非字符串 `detail.value`；全仓用 `ui/Textarea`。下载打自家 `/api` 必须 `header: buildHeaders()`，service 自己 unwrap。
- 🔴 LaTeX：库存源码是真相源；**编辑态留源码、展示态过 `latexToReadable()`**（`review-item-card`/`detail` 等），PDF 渲染前同源转可读。
- 🔴 页码后端 0 基⇒唯一 `+1`（禁 `index||i+1`）。头像 `avatarUrl` 存对象 key 不能直接当 src⇒先 `downloadFile` 落本地。>60s 请求走 `POST /api/jobs`＋轮询。
- 🔴 隐私同意真拦写：`guardPolicy(action)` 与 `guardPrivacy` 串行两道；`<PolicyConsent/>` 首帧；隐私接口失败禁 `catch {}`；政策 r11（升版＝全员重同意）。面客说「资料库」；tab 页只能 `switchTab`。

**打印清晰度（D-091/092/093/094）**
- 🔴 裁剪底图＝`ocr.service.ts docPages()` 旧写死 `scale:2`（A4≈144dpi），`pdf-tool.ts` 显式传 `--scale`⇒`pdf_tool.py DEFAULT_SCALE` 是死代码。D-092：`docPages` 读 `GK_PDF_RENDER_SCALE`（默认 3/回退 2/下限 0.5）。
- 🔴 前端 Canvas2D `MAX_CANVAS_SIDE=1365` 硬墙（超安卓 crash）⇒实得 152→186dpi、scale 再高被墙吃。**存量 11 题不重裁、不变清晰**。
- 🔴 D-093/P-032（思傅选「页图3倍+后端裁」/「不动存量」）：治本＝前端只传归一化框、后端 `POST /api/image/crop-box`（`cropByBox`: fetchImage→sharp.extract→ingest）绕 1365 墙；`ImageEditor` `highResCrop`+`onConfirmUploaded`，失败回退 Canvas，三处调用方接 `string|CropUploaded`。M72 6/6。
- 🟢 D-094 已上生产+开发版：`docPages` 实渲页图 1785×2526（scale3/216dpi）、crop-box 裁块 **1661px/227dpi 越过1365墙**（前端同框只能1365）、存量样张 PDF 仍 117~155dpi（11/13<150）。后端 5 文件换 dist 备份`/opt/gk/backups/D-093-20261118_205109`、sha256 5/5零差异才重启；前端开发版 **2026.11.18.7**。真机UI操作由思傅复现，**未提审/未发版/未push**。明细 rules/04 + 台账 D-093/094 + P-032。

**发布与验证**
- ⛔ 个人主体不得做共享题库/UGC 分享；AI 助手对用户不可用（`AI_PUBLIC_ENTRY=false`＋fail-closed）；禁教育培训文案。发布门两阻断＝`urlCheck`／`__usePrivacyCheck__`（旧 IDE 误报「无效」，不要删字段）。mp 前置只认 `docs/reports/mp后台-隐私指引7项与UGC声明-操作指引.md`。
- 🔴 验证 `ide-verify.mjs --launch --marker "<特征串>"`；冷启动唯一解＝纯 Node 写 UTF-8 `.cmd` 交桌面 `explorer.exe`，只认 9222＋哨兵文件；⛔ Start-Process／WMI／schtasks 被挡。测试期禁真登录。

**本机操作**
- 🔴 删除守卫：`Remove-Item -Recurse`／`rm -rf`／`fs.rmSync` 被拦，`Add-Type`/COM 被禁⇒回收站 API 不可用。合规＝逐文件 `[System.IO.File]::Delete` 每批 10 个校验＋自底向上 `[System.IO.Directory]::Delete(p,$false)`；删前备份＋警告＋列清单。

## 全局 ⛔ 禁止清单（汇总，细节见各 rules）
励志推送／智能排程／ZPD／打卡时长激励；向量库/Reranker/LLM 兜底（判定层）；拍照搜题；WMF 与 `≤→£` 假证伪；`Start-Process`/WMI/schtasks 起微信；改加权求和判定；宣称命中提升/误判归零。

## 流程
- 家长主用；改「学习行为」先过 20a §5.1 三问＋§6.2 M1–M11；GK-OPS-22：L0/L1/L2＋提案 P-NNN＋台账 D 号，先查台账再评审；动 `question-match.ts` 前建档；设计决策逐题确认。
- 缺口序 C3 错因 > C2 信心 > C1 掌握梯度 > C5 交错。push 等思傅指示、本地 commit 照常。要实际进展、别堆方案。
