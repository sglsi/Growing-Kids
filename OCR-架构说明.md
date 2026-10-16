# OCR 架构说明（本地主识别 + VLM 语义切分/兜底）

> 适用版本：去手写项目当前 OCR 改造后
> 关联：`ocr-engine/`（侧车）、`server/src/ocr/`（Node 端）、`去手写-升级方向-低质量照片自适应.md`

> **当前状态更新（2026-10-15，3.x 上生产）**：本文为 2.x 融合侧车时期的设计稿，**生产主引擎已切换为 PaddleOCR 3.7.0 / PP-StructureV3 3.x 侧车**（`main3.py` :9001，Node 侧 `Ppsv3Client` + `ppsv3ToLocal()` 契约适配层，下游零改动）；2.x 融合侧车（`main.py` :9000）降为**回滚备份**。本文中 `LocalOcrClient`/`OCR_ENGINE_URL` 相关描述对应回滚形态。部署、坐标保真默认值（`PPSV3_UNWARP=0`/`PPSV3_ORIENT_CLS=0`）、回滚步骤见根目录 `DEPLOY.md` 第 6 章与 `ocr-engine/README.md`；切换 e2e 验证数据见 `/workspace/homework-eval/prod-switch-result.json`。

## 1. 设计目标

文字识别从**纯远程 VLM（豆包 Seed 2.0 Pro）**改造为：

- **本地 OCR 引擎 = 主文字提取**：离线、可靠、零按次计费、确定性强（不依赖 token）。
- **VLM = 语义切分 + 兜底**：仅负责把本地 OCR 的文字+版面切成结构化题目；本地 OCR 整体失败时，VLM 直接看图。

这样即使 VLM 凭证缺失/宕机，系统仍能**离线产出文字**（前端可编辑），不会硬失败。

## 2. 引擎选型（已与用户确认）

| 角色 | 引擎 | 说明 |
|---|---|---|
| 主识别 · 互为备份 A | **RapidOCR**（ONNX） | CPU 友好、快、依赖轻（~15MB，无 paddle） |
| 主识别 · 互为备份 B | **PaddleOCR 3.0** | PP-OCRv5（中文印刷+复杂手写）+ PP-StructureV3（版面/表格/公式→LaTeX） |
| 语义切分 / 兜底 | **豆包 Seed 2.0 Pro** | 经 `coze-coding-dev-sdk` 的 `LLMClient`，`temperature=0.1` |

双本地引擎**同时运行、按置信度择优融合**（IoU>0.5 去重，保留高分），任一引擎失败不影响另一条。

## 3. 架构图

```
[前端 /ocr/*] → OcrController → OcrService
   ├─① LocalOcrClient (HTTP → OCR_ENGINE_URL 侧车, 平台单独部署)
   │     Sidecar(Python): RapidOCR ∥ PaddleOCR+PP-StructureV3 → 融合
   │     输出 {raw_text, text_regions[], layout[], tables[], formulas[], confidence, engine_used, low_confidence}
   ├─② 本地 OCR 成功(且非低置信) → 把 {raw_text, layout} 喂 VLM 做语义切分 → RecognizedItem[]
   └─③ 本地 OCR 失败/低置信 → VLM 直接看图(现有逻辑) → RecognizedItem[]
   （VLM 也不可用 → 退化为本地纯文字 item，前端可编辑，不硬失败）
```

一致性校验（`image.service.verifyOcrConsistency`）专用 `OcrService.recognizeRawItems`：
直接返回本地 OCR **原始文字区域**作为可比对题面（不经 VLM 重构，稳定可复现），VLM 仅兜底。

## 4. 输出契约（侧车 ↔ Node）

`ocr-engine/main.py` 的 `POST /recognize` 返回（见 `server/src/ocr/ocr.types.ts` 的 `LocalOcrResult`）：

```json
{
  "raw_text": "按阅读顺序拼接的全文",
  "text_regions": [{"text":"...","box":[x0,y0,x1,y1],"score":0.97}],
  "layout": [{"type":"text","box":[...],"text":""}],
  "tables": [], "formulas": [],
  "confidence": 0.95,
  "engine_used": ["rapidocr","paddleocr"],
  "low_confidence": false
}
```

Node 端 `LocalOcrClient`（`ocr-engine.client.ts`）：内置 `fetch` 调用，**任何失败返回 `null` 不抛错**，交由 `OcrService` 降级到 VLM。

## 5. 关键配置（环境变量，全 `process.env` 直读）

| 变量 | 默认 | 说明 |
|---|---|---|
| `OCR_ENGINE_URL` | `http://127.0.0.1:9000` | 本地侧车地址（Node 端）；同时作为自动摆正的 OCR 细化默认来源 |
| `OCR_ORIENT_URL` | 同 `OCR_ENGINE_URL` | 自动摆正（朝向修正）的 OCR 细化专用侧车地址，可单独指向真实侧车以避开 DRY_RUN 假数据 |
| `OCR_ORIENT_REFINE` | `1` | 关（=`0`）则摆正只用纯几何投影法、不调用 OCR 侧车 |
| `OCR_FALLBACK_TO_VLM` | `true` | 关掉则完全不用本地 OCR，退回纯 VLM |
| `OCR_LOW_CONF_THRESHOLD` | `0.6` | 低于则 `low_confidence=true` → 走 VLM 直接看图 |
| `OCR_ENGINE_MODE` | `both` | 侧车侧：`both`/`rapid`/`paddle` |
| `OCR_DEVICE` | `cpu` | 侧车侧：`cpu`/`gpu` |
| `OCR_DRY_RUN` | `0` | 侧车侧：不加载模型返回样例（契约验证） |
| `COZE_API_TOKEN` | — | VLM 凭证（由 coze-coding-dev-sdk 隐式消费） |

## 6. 部署形态

- **侧车独立部署**：`ocr-engine/` 作为独立进程（Dockerfile 已备），平台单独起；Node 单进程不变。
- **模型权重**：首次启动下载 PaddleOCR / RapidOCR 权重（需出网或预置 `MODEL_DIR`）；CPU 用 mobile 档。
- **降级链**：侧车宕机 → `LocalOcrClient` 返回 null → VLM 直接看图；VLM 无凭证 → 本地纯文字退化。

### 6.1 侧车守护（懒启动 + 空闲回收 + 资源紧张回收）

新增 `server/src/ocr/sidecar.supervisor.ts`：在 Node 侧托管侧车进程，**平时不占用资源，有人用才起、没人用就回收**。

- **按需启动**：`OcrService.recognizeLocalByUrls` / `recognizePageRegions` 经 `SidecarSupervisor.withSidecar()` 包裹；进入 OCR 调用时若侧车未运行，自动 `spawn` Python 侧车（`child_process`，监听 `OCR_ENGINE_URL` 解析出的 host:port），并通过 `/healthz` 探活就绪后才放行。
- **空闲回收**：超过 `OCR_IDLE_TIMEOUT_MS`（默认 15min）无 OCR 调用，自动 `SIGTERM` 回收侧车。
- **资源紧张回收**：当 `process.memoryUsage().rss` 超过 `OCR_SHUTDOWN_RSS_MB` 阈值、且当前无进行中的请求（`active===0`）时，以更短窗口 `OCR_TIGHT_IDLE_MS`（默认 2min）尽快回收。
- **请求进行中不杀进程**：`active>0` 时任何回收判定均跳过，保证单次 OCR 不被中断。
- **失败不阻断**：启动/探活失败返回 `null`，交由 `OcrService` 降级 VLM，主链路不抛错。
- **外部侧车兼容**：`OCR_SUPERVISE=0` 时 `withSidecar` 直接透传 `fn()`，行为与改造前完全一致（独立容器部署即此模式）。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `OCR_SUPERVISE` | `auto` | `1` 强制托管 / `0` 外部侧车透传 / `auto` 仅当 `ocr-engine/main.py` 存在且 `python3` 可用时启用 |
| `OCR_IDLE_TIMEOUT_MS` | `900000` | 空闲回收超时（15min） |
| `OCR_TIGHT_IDLE_MS` | `120000` | 资源紧张时的空闲容忍窗口（2min） |
| `OCR_SHUTDOWN_RSS_MB` | `0` | 内存 RSS 阈值（MB），`0`=禁用资源回收 |
| `OCR_MONITOR_MS` | `15000` | 回收巡检间隔 |
| `OCR_START_TIMEOUT_MS` | `30000` | 启动等待 `/healthz` 超时 |
| `OCR_PYTHON` | `python3` | 侧车解释器 |
| `OCR_ENGINE_DIR` | 自动推断 | `main.py` 所在目录 |

### 6.2 自动摆正（orientation · 0°/90°/180°/270° + 小角度）

`image-dewarp.ts` 的 `straightenImage` 现已内建**原生自动摆正**，作为流水线常驻能力（不依赖大模型）：

- **小角度倾斜（≤15°）**：`image-deskew.ts` 投影投票估计偏角并旋转（此前已有）。
- **90°/180°/270° 翻转**：新模块 `image-orient.ts`，两阶段：
  1. **纯几何核心（零依赖、常驻）**：`scoreOrientation` 用行/列投影峰差判定文字主轴是横排还是竖排（横排→0°、竖排→需转 90° 转正）。**确定性修掉 90/270 侧翻**，CPU 毫秒级、离线可用。
  2. **OCR 细化（最佳努力，CV 模型非大模型）**：90 vs 270、0 vs 180 属同一轴镜像、纯几何无法区分，用 OCR 侧车（`OCR_ORIENT_URL`/`OCR_ENGINE_URL`）比较两候选朝向的**去空白字符量**，取多者（正立文字更连贯、字符更多）。侧车不可达 / 是 DRY_RUN 假数据时自动放弃细化、回落纯几何。
- **触发**：所有 `straightenImage` 调用默认 `orient!==false` 即开启（生产调用方 `extractWrong`、`buildLayoutContext` 均只传 `{auto:true}`，自动受益，无需改动）。
- **实测**（英语作业两面横躺原图）：原样上传即自动转正 270°，正/背面判卷 recovered 到 wrong:12/correct:49 与 wrong:7/correct:10，与手动摆正结果一致；不再出现整页崩溃（此前原样上传 wrong:8/correct:4/unknown:34）。

> 验证（沙箱，DRY_RUN 侧车）：自动启动 / `/healthz` 探活 / 空闲 2.2s 回收 / 资源紧张 1.2s 回收 / `OCR_SUPERVISE=0` 透传，共 12 项全绿。

### 6.2 健康探针 + 告警埋点（让"侧车失联"成为可知事件）

§6.1 的降级链很优雅，但也带来隐患：**侧车宕机时系统静默退化到 VLM，从外部看"一切正常"，无人知晓侧车已失联**。为此新增 `server/src/ocr/ocr-health.ts`，把"健康态可见化"：

- **埋点（OcrTelemetry / InMemoryOcrTelemetry）**：每次本地 OCR 调用在 `LocalOcrClient.post` 层埋点——侧车 HTTP 成功记 `markSuccess`、失败（`http_4xx/5xx`、超时、异常）记 `markDegrade`；**滑动窗口（默认 5min）算出"侧车可用率 / 降级率"**，供监控面板与告警判据使用。`LocalOcrClient.getDiagnostics()` 暴露快照。
- **主动健康探针（OcrHealthProbe）**：独立于业务调用，定时（默认 30s）探 `LocalOcrClient.health()`（`/healthz`）。**连续失败达 `OCR_HEALTH_FAILS`（默认 3）次触发 `sidecar-unreachable` 告警；恢复后触发 `sidecar-recovered` 通知**。单次抖动（< 阈值）不误报。
- **「可用率跌到阈值自动告警」**：与"失联"解耦——侧车可能"活着但大量请求失败"（模型加载异常、超时雪崩），此时 `health()` 仍 ok，只看探针看不到问题。本能力在每次探活时顺带读取埋点滑动窗口的 `successRate()`，**低于 `OCR_AVAIL_WARN_THRESHOLD`（默认 0.8）、且窗口样本数 ≥ `OCR_AVAIL_MIN_SAMPLES`（默认 5）时，连续 `OCR_AVAIL_FAILS`（默认 3）次触发 `sidecar-low-availability`；恢复到阈值之上（或窗口无样本）时触发 `sidecar-availability-recovered`**。窗口无样本（空闲期）不评估，避免误报。
- **告警（OcrAlertSink）**：可插拔。默认 `ConsoleAlertSink`（`[ocr-alert]` 前缀打印，便于日志采集）；配 `OCR_ALERT_WEBHOOK_URL` 时走 `WebhookAlertSink`（POST JSON 到该 URL，如企业微信/飞书机器人），失败时回退 console 打印。
- **共享单例**：`LocalOcrClient` 与 `SidecarSupervisor` 通过 `getOcrTelemetry()`/`getOcrAlertSink()` 共用同一份埋点与告警，探针视图与调用埋点一致。
- **Supervisor 健康自检**：`SidecarSupervisor.tick()` 在侧车 running 但 `/healthz` 连续失败达 `OCR_UNHEALTHY_FAILS`（默认 3）时，触发 `sidecar-unhealthy` 告警并**自愈**（kill 僵死进程，让下次 `withSidecar` 自动重启）；`ensureReady` 启动失败则告警 `sidecar-startup-failed`。

`OcrService` 构造时给 `LocalOcrClient` 注入共享埋点/告警并 `startProbe()`，使探针随服务启动自动运行。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `OCR_AUTO_PROBE` | `true` | 是否随 `LocalOcrClient` 自动启动健康探针 |
| `OCR_HEALTH_PROBE_MS` | `30000` | 探针周期（ms） |
| `OCR_HEALTH_FAILS` | `3` | 探针连续失败达此次数才告警（防抖） |
| `OCR_UNHEALTHY_FAILS` | `3` | 守护进程自检：running 但 `/healthz` 连续失败达此次数则自愈 + 告警 |
| `OCR_AVAIL_WARN_THRESHOLD` | `0.8` | 「可用率跌阈值告警」阈值（0~1）；成功率滑动窗口低于此值触发 `sidecar-low-availability`；设 ≤0 关闭 |
| `OCR_AVAIL_MIN_SAMPLES` | `5` | 评估可用率所需最小窗口样本数，低于则视为无信号不告警（避免空闲误报） |
| `OCR_AVAIL_FAILS` | `3` | 可用率连续低于阈值的 tick 次数达此值才告警（防抖） |
| `OCR_ALERT_WEBHOOK_URL` | 空 | 配置后告警走 webhook，否则仅 console |
| `OCR_ALERT_WEBHOOK_TYPE` | `generic` | webhook 消息格式：`generic`=纯 JSON / `wecom`=企业微信机器人 / `feishu`=飞书机器人（见下） |

> **接真实告警渠道（企业微信机器人 / 飞书）**：`WebhookAlertSink` 按 `OCR_ALERT_WEBHOOK_TYPE` 组装平台要求的消息体——`wecom` 发 `{msgtype:"markdown",...}`、`feishu` 发 `{msg_type:"text",...}`、`generic` 保持 `{event,detail,ts}`（兼容自建/ n8n 等）。配置与签名、告警事件、部署建议详见 **`docs/design/云平台迁移与智能化-设计参考.md` §5**。

告警事件一览：`sidecar-unreachable`（探针失联）/ `sidecar-recovered`（恢复）/ `sidecar-low-availability`（存活但可用率跌破阈值）/ `sidecar-availability-recovered`（可用率恢复）/ `sidecar-unhealthy`（守护检测到僵死并自愈）/ `sidecar-startup-failed`（自动启动失败降级 VLM）。

> 验证（沙箱，DRY_RUN 侧车 + 注入探针）：埋点成功率/降级率滑动窗口 / 探针连续失败告警 + 恢复通知 + 单次抖动不误报 / 真实侧车调用成功且成功率=1 / 死端口探针触发 unreachable / 启动失败告警 startup-failed，共 9 项全绿。
>
> 另补「可用率跌阈值」验证：侧车 `health()=true`（存活）但埋点 `successRate=0.2`（<0.8、样本≥5）连续 3 tick 触发 `sidecar-low-availability`；灌入成功把 `successRate` 拉回 >0.8 后下一 tick 触发 `sidecar-availability-recovered`；全程不误报 `sidecar-unreachable`。
>
> 部署建议：独立容器部署侧车时设 `OCR_SUPERVISE=0`（交给编排自愈），但**仍保留 `OCR_AUTO_PROBE=true`**——探针与告警不依赖 supervisor，能跨部署形态持续监控侧车健康。

## 7. 已知边界（与升级方向关联）

- 本地 OCR 在**模糊/斜拍/低清照片**上同样会退化（与去手写是同一道坎），无魔法；真正根治见 `去手写-升级方向-低质量照片自适应.md`。
- VLM 仍是**语义切分**主力（用户已确认），故"纯离线出题"在 VLM 不可用时退化为纯文字，需用户手动归题。
- 双引擎融合初版用"置信度择优 + 版面块合并"，需真实作业样本调参。
- **真实中文/手写/表格精度**须在部署环境（有模型+token+真实图）实测作为验收门槛；沙箱 CPU 无 token 无法验证精度。

## 8. 沙箱实测记录（2026-10，真实运行）

本轮在沙箱内完成了**可本地验证的全部环节**，把架构从"mock 验证"推进到"真实运行"：

### 8.1 实测内容与结果

| 验证项 | 结果 | 说明 |
|---|---|---|
| RapidOCR 安装与导入 | ✅ | `rapidocr-onnxruntime`（包内自带 ONNX 模型，CPU 可跑） |
| 侧车 real 模式 | ✅ | `OCR_ENGINE_MODE=rapid`，PaddleOCR 缺席时自动跳过、不报错 |
| 清晰扫描件识别 | ✅ | `annot1-clean.png`：49 区、置信 **0.966**，"九年级物理练习卷"全文正确 |
| 低质量照片识别 | ✅ | 实拍语文卷（1080px 斜拍偏暗）：74 区、置信 **0.924**，印刷体表头/题干/表格全出 |
| Node↔Python 端到端 | ✅ | `LocalOcrClient.recognizeByBase64` → 侧车 → RapidOCR → 结构化 JSON，真实数据打通 |
| OcrService 生产路径降级 | ✅ | 集成测试 `INTEGRATION_PASS`：本地成功→VLM 失败(无 token)→**降级纯文字 9 items，未崩溃** |
| 类型检查 | ✅ | 改动的 4 个 TS 文件 0 错误（工程存量 28 个错误均在 probe/diag 调试脚本，与本次无关） |

### 8.2 实测中发现并修复的问题

1. **RapidOCR 新版返回结构变更**：新版返回 2-tuple `( [[box,text,score],...], meta )`，非旧版 3-tuple
   —— `_run_rapid` 已重写为三格式兼容（新 2-tuple / 旧 3-tuple / 对象式）。
2. **`OcrService` 构造期强依赖 VLM 凭证**：原构造函数立即 `new LLMClient()`，无 token 直接抛错，
   连"本地 OCR 主路径"都无法实例化 —— 已改为**懒加载** `getVlm()`（本地优先不因缺凭证而崩溃）。
3. **客户端默认 15s 超时会误杀本地 OCR**：CPU 推理实测单页 **~27s**（沙箱受限 CPU + 大图），
   15s 超时导致本地 OCR 被误判失败 —— 默认放宽至 **60s**，支持 `OCR_TIMEOUT_MS` 覆盖。

### 8.3 关键实测数据

- **CPU 单页延迟 ~27s**（清晰扫描件，沙箱受限 CPU）；侧车常驻后仍 ~26-29s/页 ——
  部署时建议 GPU 或缩小输入尺寸，并把 `OCR_TIMEOUT_MS` 设为 ≥60s。
- 本地 OCR 对**低质量照片的印刷文字**抽取稳健（conf 0.924）—— 与去手写在低质量照片上失效
  形成对照：OCR 只需"读字"，去手写需要"分离手写与印刷"，后者难度本质更高。

### 8.4 沙箱仍无法验证（需部署环境）

- PaddleOCR 3.0 重模型（paddlepaddle 安装体积大）→ 融合双引擎、版面/表格/公式能力未实测。
- VLM 语义切分质量（无 `COZE_API_TOKEN`）→ 7 字段切分准确率需部署环境评估。
- 大样本精度基准（准确率/召回）→ 需真实作业图集。
