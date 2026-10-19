# Issue：#150 错题提取 OCR 双模式改造 + 侧车不可用根因修复

> 2026-10-17 · 用户实测反馈：「输入的图片不能正确 OCR 识别（显示未能识别出文字），
> 其中一次还将正排的图片旋转了 90 度」；同时提出两项改造：
> ① OCR 默认不自动识别，底部增「快速」「精准」两个手动按键；
> ② 粘贴栏内容默认保存到错题库，支持打印与导出 Word。

## 1. 根因（两个现象同一来源：3.x OCR 侧车在生产部署不可用）

错题提取（split 模式）链路：选图上传 → `buildLayoutContext`（摆正）→ `recognizePageForPanel`（全页 OCR）→ OCR 文本栏 → 粘贴栏。

| 现象 | 代码路径 | 侧车缺席时的行为 |
|---|---|---|
| 「未能识别出文字」 | `ocr.service.ts` `recognizePageForPanel` → `withSidecar(() => ppsv3.parse(...))` | 启动失败/端口无监听 → 返回 null → **静默返回空 regions**，前端只显示"本页暂未识别到文字"，与服务不可用完全同形 |
| 正排图被转 90° | `image-dewarp.ts` `straightenImage` → `estimateOrientation` | 朝向细化走工具式子进程 `main3.py --once --op orient`（需 `/opt/pocr3-venv/bin/python`），spawn 失败 → 回落纯几何 → `scoreOrientation` 把横排版面误判为竖排 → **angle=90 被直接施加**（纯几何对 0/180、90/270 正立与否本质无能） |

侧车不可用的触发面（按概率）：

1. **`/opt/pocr3-venv/bin/python` 不存在**（venv 未随部署落地）——工具式调用 `spawn-error`；`PPSV3_SUPERVISE=1` 时托管 spawn ENOENT，且 `start()` 的 error 事件不 reject 启动 promise，**每次 OCR 先卡 30s 启动超时再静默失败**；
2. **`ocr-engine/main3.py` 未找到**（四候选解析路径都没有）；
3. `PPSV3_SUPERVISE=0` 且 :9301 无外部侧车。

## 2. 代码修复（本次改动）

**后端（server/src）**

| 文件 | 修复 |
|---|---|
| `ocr/sidecar.supervisor.ts` | ① `pythonUsable()`：绝对路径 venv 显式查文件+可执行位（原 `command -v` 对路径行为依 shell 而定）；② 托管未启用时日志给出**具体原因**（supervise=0 / 脚本缺失 / python 不可用）；③ `start()` spawn 失败**立即抛错**（对象承载 err，避免 TS 闭包窄化），不再卡满 30s |
| `ocr/ppsv3.client.ts` | `parse()` 失败（侧车不可达/超时）除静默返回 null 外，补 `telemetry.markDegrade` + 60s 节流告警 `sidecar-unreachable`——「侧车挂了」不再与「正常无文字」同形 |
| `image/image-orient.ts` | `estimateOrientation` 侧车缺席时**保守不猜转**：横排→0°（同旧行为），竖排也→0° 不施加旋转，并标记 `suspect=true`。误转正排图（用户实测事故）比漏摆正更糟，漏摆正由 OCR/人工兜底 |
| `image/image-dewarp.ts` | suspect 判定兼容新回落：`o.suspect === true \|\| (projection 且 angle≠0)`，告警文案更新 |
| `ocr/ocr.service.ts` | 新增 `recognizePageFast()`（2.x 侧车 `main.py --once --op recognize --mode rapid`，RapidOCR 轻量通道）；`recognizePageForPanel` 区分「服务不可用→抛错」与「本次无文字→空」：托管模式 `ensureReady` 失败、或 `parse` 失败且 `health()` 不通 → 抛错 |
| `image/image.types.ts` / `image.service.ts` | `OcrPageDto.mode: 'precise' \| 'fast'`；`ocrPage` 按 mode 分支；服务不可用转模式化 `BadRequestException`（前端明确提示）；返回 `orient_suspect`（本页可能侧躺） |

**前端（src）**

| 文件 | 改动 |
|---|---|
| `pages/recognize/index.tsx` | ① 选图后**不再自动 OCR**（`ocr:'idle'`，等手动触发）；② 图片栏下方「快速识别 / 精准识别」双按钮（标注耗时预期）；③ split 模式常驻学科选择（入库需要）；④ 底部操作条三能力：**存入错题库**（`createTimelineBatch`，条目→kind=question，文字进 `content.question`、裁剪图进 `content.question_images`）、**导出 Word**（既有链路）、**打印**（H5 `window.print` 打印视图；小程序/tt 引导导出 Word 后打印）；⑤ 失败态记录原因（面板内红字提示「修复后重试或换模式」） |
| `components/wrongq-ocr-panel.tsx` | 新增 `error` prop；空态引导「尚未识别 · 点下方快速/精准开始」 |
| `services/api.ts` | `ocrPage(url, mode)` 传 mode，返回 `orient_suspect` |

**为什么「快速」走后端 RapidOCR 而非前端 onnxruntime-web**：项目主端是微信小程序，onnxruntime-web 依赖 DOM/WebWorker/WASM glue，小程序三者均不可用，且主包 2MB 限制塞不进 ~12MB 模型；微信官方 OCR 插件不支持通用作业页。且业务图在上传时已在服务端，前端推理并不省网络往返。后端 RapidOCR 的提速来自跳过 UVDoc/版面/全链路（1~3s vs 15~20s）。若未来 H5 用户占比上来，可加前端分支（API 不变）。

## 3. 部署侧自检（代码修复不替代环境修复——必须执行）

见同目录 `ocr-sidecar-selfcheck.sh`，在**部署 server 的机器**上以部署用户执行：

```bash
bash ocr-sidecar-selfcheck.sh
```

检查项：3.x venv（paddle 可 import）、`main3.py`/`main.py` 位置、:9301/:9300 监听、`/healthz` 响应、`PPSV3_*` 环境变量、工具式子进程冒烟（orient）。

**三种修复路径**（按自检结果选一）：

1. **补 venv（推荐，精准模式必需）**：按 `ocr-engine/README.md` 建 `/opt/pocr3-venv`（paddlepaddle ≤3.2.2 + paddleocr 3.7.0），确保 `PPSV3_ENGINE_DIR` 或相对路径能解析到 `main3.py`；
2. **外部侧车**：`PPSV3_SUPERVISE=0` + 手动/系统服务常驻 `python main3.py --host 0.0.0.0 --port 9301`；
3. **仅快速模式**（无 venv 时的降级）：2.x 引擎 `python3 main.py` 常驻 :9300，或保持工具式子进程（需 `rapidocr` 包 + 模型）。

**修复后验证**：小程序进「错题提取」→ 选图 → 点「精准识别」→ 后端日志应出现
`[image-dewarp] 朝向摆正：旋转 0°（方法 ocr，主轴 horizontal）`（侧车在场）与
`识别到 N 段文字` toast；若日志出现 `[sidecar] 守护未启用（python 不可用…）` 或
`[ocr-alert] sidecar-unreachable`，即环境仍未就绪。

## 4. 实测验证（2026-10-17，沙箱复现：/opt/pocr3-venv + 系统 python3 均具备）

验证矩阵（Node 直调 server build 产物的 `OcrService` / `estimateOrientation`，中文测试页 12 行文字）：

| # | 场景 | 结果 |
|---|---|---|
| 1 | 精准模式（:9301 侧车在场）`recognizePageForPanel` | ✅ 22.3s，11 regions，「一、选择题 / 1.春眠不觉晓…」全对，score 0.99+，坐标在原图系 |
| 2 | 快速模式 `recognizePageFast`（系统 python3 + rapidocr_onnxruntime） | ✅ 9.5s，11 regions，文本与精准一致——**快速通道真实可用，非摆设** |
| 3 | 朝向·正排横排图（用户报障"被转 90°"） | ✅ `angle=0, method=ocr, axis=horizontal`——侧车消歧生效，不再误转 |
| 4 | 朝向·真侧躺 90° 图 | ✅ `angle=90, method=ocr, axis=vertical`——正确转正 |
| 5 | 侧车不可达（9301 停 + SUPERVISE=0 透传） | ✅ **511ms 内显式抛错**「OCR 侧车不可达」→ 前端提示"精准识别服务暂不可用"，不再静默空栏 |
| 6 | 托管模式 venv 缺失（SUPERVISE=1 + PPSV3_PYTHON 不存在） | ✅ **511ms 快速失败**（修复前卡满 30s），日志 `[sidecar] 子进程错误: spawn … ENOENT` + 告警 `sidecar-startup-failed` |

构建验证：前端 `tsc --noEmit` ✓ / `eslint --max-warnings=0` ✓ / `build:web` ✓ / `build:weapp` ✓；server `tsc --noEmit` ✓ / `nest build` ✓。

**注意**：快速模式的 2.x 引擎用**系统 python3**（`OCR_PYTHON`，默认 `python3`）+ `rapidocr_onnxruntime` 包，与 3.x venv 相互独立——部署时需确认系统 python3 也装了该包，否则快速模式降级为"本次失败返回空"（前端提示重试/换精准）。

## 4.1 续修：静默空结果 → 显式报错 + OCR 诊断端点（2026-10-17 第二批）

**用户二次反馈**：端口已迁到 9300/9301（避开小程序端被占用的 9000/9001），但小程序端仍显示「本页未识别到文字」。**根因仍是"失败被静默吞成空结果"**——侧车挂掉 / 端口冲突 / 引擎缺包 时，前端收到的 `page_text` 永远是 `[]`，与"图上真没字"完全同形，无从定位。

### 4.1.1 端口迁移收尾（本批）

上一批端口迁移有遗漏：`image-orient.ts`（朝向细化默认 9001）、`ocr-prior.ts`（2.x 引擎默认 9000）、`sidecar.supervisor.ts` 的 `parseBaseUrl` 回落值（9000）未跟上。本批全部补为 9301（3.x）/ 9300（2.x），全仓再无 9000/9001 的生效引用（仅剩注释里的"旧端口说明"）。

### 4.1.2 静默空 → 显式报错（核心修复）

| 文件 | 改动 |
|---|---|
| `ocr/ocr-tool.ts` | `ToolOcrResult` 新增 `stderr?` 字段；超时/失败（nonzero-exit/bad-json）携带 stderr 尾部 3 行（Traceback 根因）；spawn 失败/超时也带 stderr |
| `ocr/ppsv3.client.ts` | `parse()` 记录 `lastParseError`（HTTP 非 200 / 响应缺 blocks / 请求异常三类）；新增 `getLastParseError()` 供上层区分"侧车故障"与"图中无文字" |
| `ocr/ocr.service.ts` | `recognizePageFast`：`no-script`/`spawn-error`/超时/非零退出 **一律抛错**（附 stderr 摘录）——不再静默返回空；`recognizePageForPanel`：`parse` 返回 null **一律抛错**（带 `lastParseError` 与 `/healthz` 状态区分），仅 `200 + blocks:[]` 才是真正的"图中无文字" |
| `pages/recognize/index.tsx` | `runPageOcr` 的 catch 已记录 `err` 并显示在面板；`page_text` 为空但**无报错**时才提示「本页未识别到文字，可手动输入」（合法空图）；真正失败走 `error` 态 + 真实原因 |

> 效果：过去"侧车挂了→前端只看到未识别到文字"，现在变为"精准识别服务暂不可用：侧车 /healthz 无响应"等明确报错。

### 4.1.3 OCR 诊断端点（自助排查）

新增 `GET /api/image/ocr-diagnose`（无需登录），逐项实测两条识别路径与侧车状态，返回结构化报告：

- **环境与端口**：快速/精准引擎 python 解析路径与版本、`PPSV3_URL`/`OCR_ENGINE_URL`/`supervise`；
- **侧车状态**：`disabled` 与未启用原因；
- **快速引擎实测**：用内置已知文字探针图（`diagnose-probe.ts`，"OCR诊断测试12345"）跑 RapidOCR，报告状态 / 段数 / 样例 / stderr；
- **精准侧车实测**：`/healthz` 健康检查 + 同一探针图 `/ppsv3`，报告 status（OK / UNREACHABLE / FAIL / EMPTY）、blocks 数、最近 parse 错误。

前端 `recognize` 页在「快速/精准」双按钮下方新增「识别不出字？点此「识别诊断」自查」入口，点击调用 `diagnoseOcr()`，弹层展示可读报告 + 一句话结论（哪条路径挂了、优先查端口/侧车/引擎）。

### 4.1.4 实测（本批，沙箱 /opt/pocr3-venv + 系统 python3 均具备）

| # | 场景 | 结果 |
|---|---|---|
| A | `diagnose()` 正常环境 | fastEngine=OK（7 段，样例"诊断测试"）、preciseEngine=OK（blockCount 1，样例"OCR诊断测试12345"）、侧车 disabled=false |
| B | 精准侧车不可达（PPSV3_URL 指向死端口 9999） | preciseEngine=**UNREACHABLE**，lastParseError="侧车 /healthz 无响应"，fastEngine 仍 OK——可定位"只精准挂了" |
| C | 全链路 harness（前处理→快速/精准双模式） | 快速 13 段 / 精准 13 段，侧车自动起在 9301，与 #150 验收一致 |


## 5. 环境变量速查（ocr-page 链路相关）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PPSV3_URL` | `http://127.0.0.1:9301` | 3.x 侧车地址 |
| `PPSV3_PYTHON` | `/opt/pocr3-venv/bin/python` | 3.x venv python（**部署缺失即精准模式全挂**） |
| `PPSV3_SUPERVISE` | `auto` | auto=脚本+python 可用才托管；1=强制；0=外部侧车 |
| `PPSV3_IDLE_TIMEOUT_MS` | 900000 | 空闲回收（3.x 驻留 2~3GB） |
| `OCR_TOOL_TIMEOUT_MS` | 180000（ppsv3）/120000（legacy） | 工具式子进程硬超时 |
| `OCR_ORIENT_REFINE` | 开 | 朝向 OCR 细化开关（关后纯几何保守不转） |
