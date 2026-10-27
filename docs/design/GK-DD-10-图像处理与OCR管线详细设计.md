# GK-DD-10 图像处理与 OCR 管线详细设计

> 编号：GK-DD-10 ｜ 版本：v1.0 ｜ 日期：2026-10-27 ｜ 状态：**正文完成**
> 读者：算法 / 后端 ｜ 上游：ADD-04 ｜ 下游：DD-14、QA-15、OPS-18
> 定位：图像处理与识别的**算法权威说明**。专题报告（擦除 v21.8、智能高清方法论、OCR 架构、红笔检测）的结论并入本文，原文件保留为过程留档（见 GK-00 第 6.2 章）。
> 边界：前后端调用方式见 DD-08 / DD-09，业务流程见 DD-14，本文只讲算法与管线。

---

## 1. 文档目的与读者

覆盖"**图像进来 → 处理 → 识别 → 判错**"的全链路。

| 关注点 | 找谁 |
|---|---|
| 参数与阈值、算法原理 | **本文** |
| 端到端业务流程与状态机 | DD-14 |
| 接口契约 | ADD-06 |
| 子进程 / 侧车进程管理 | DD-09 第 11 章 |

---

## 2. 能力总览与入口

| 动作 | 后端端点 | 前端入口 | 引擎 / 实现 | 典型耗时 |
|---|---|---|---|---|
| 裁剪 / 旋转 | **无后端端点**（纯前端 Canvas） | `image-editor.tsx` | Canvas 2D | 毫秒级 |
| 自动调正（`auto`） | `POST /api/image/process` `action=auto` | `AI_ACTIONS.auto` | `image-dewarp.ts` 几何链（朝向→曲面→四角→UVDoc rectify→deskew→透视），失败回退图生图 | 亚秒~2s |
| 黑白（`enhance` + preset `bw`） | 同上 `action=enhance&enhance_preset=bw` | `ENHANCE_PRESETS`（默认档 `bw`） | 服务端**全局 Otsu** | 1~3s |
| 智能高清（`enhance`） | 同上 `action=enhance` | `AI_ACTIONS.enhance` | `image-superres.ts`：ESPCN 或 classical | 1~5s（受闸排队） |
| 去手写（`erase_v2`） | 同上 `action=erase_v2` | `AI_ACTIONS.erase_v2` | hybrid mask → 词级判别 → adaptive inpaint → 验收 | 2~6s |
| 去手写旧版（`erase`） | 同上 `action=erase` | — | 图生图兜底 | 10s+ |
| OCR 快识（`fast`） | `POST /api/image/ocr-page` `mode=fast` | 全页 OCR 面板 | RapidOCR 常驻进程（stdin/stdout 帧协议） | 声明 1~3s / 实测 9.5s |
| OCR 精识（`precise`） | 同上 `mode=precise` | 同上 | PP-StructureV3 侧车 HTTP `:9301` | 声明 15~20s / 实测 22.3s |
| 红笔判错 / 错题提取 | `POST /api/image/wrongq`、`/extract-wrong`、`/extract-wrong-recrop` | 错题整理页 | 色域 + 几何证据链（+ 可选 VLM） | 数秒/页 |

**灰度开关**：`IMG_PIPELINE_MODE` = `gen` | `hybrid` | `new`，**默认 `hybrid`**（`image.controller.ts:58-109`）。能力版本号 `IMAGE_CAPABILITIES_VERSION = 3`。

**探测与诊断**：`GET /api/image/capabilities`（返回 straighten / enhance / erase_v2 可用性）、`GET /api/image/ocr-diagnose`（双引擎连通性诊断）。

---

## 3. 管线架构

### 3.1 主链路编排（`image.controller.ts`）

```
process(action, image_url, ...)
 ├─ erase_v2  → image.service.eraseV2      （本地链路，唯一擦除实现）
 ├─ auto      → straighten                 （hybrid：失败才回退图生图）
 ├─ enhance   → enhance                    （⚠ 429/503 限流错误「直接抛出、不兜底」）
 └─ erase     → process                    （图生图兜底）
```

⚠️ `enhance` 命中限流时**不降级图生图**，是有意为之——避免用户误以为"AI 重画"成功。

### 3.2 各动作内部阶段

| 动作 | 阶段顺序 | 跳过 / 回退条件 |
|---|---|---|
| `auto` | 朝向 → 曲面(默认关) → 手动四角 → 自动四角 → UVDoc rectify → deskew → 透视残留 → 兜底 | 四角未命中 ⇒ 返回原图 + `notice` |
| `enhance` | YCbCr 分离 → 亮度增强(P0-1…P1) → SR 升采样 → 色度 cubic 上采样 → **OCR 一致性校验** → 不达标回退原图 | `verify_ocr=false` 跳过校验；`multi_modes=true` 跳过闸与 SR |
| `erase_v2` | hybrid mask → 词级 policy 过滤 → coverage 判定 → adaptive inpaint → blend → 相似性验收 | coverage ≤ 0.0001 原图返回；> 0.7 抛错 |
| `ocr-page` | 缓存查 → rectify(可选) → fast/precise → 分段 → 落库 | `force=true` 忽略缓存；`rectify=false` 跳过摆正 |

### 3.3 sharp 使用约定（踩坑沉淀）

| 约定 | 原因 |
|---|---|
| 取 raw 前 `ensureAlpha()`，写回前 `removeAlpha()` | 通道一致性 |
| ⚠️ **单通道 raw 会被 libvips 提升为 3 通道** | 掩码与图像通道数必须显式对齐（统一走 `alignMask`），否则静默错位 |
| 掩码写进 alpha 后用 `over` 合成 | 直接按通道写会破坏边缘 |
| `matchTone` strength **0.85** | 避免色调整体偏移过头 |

### 3.4 ⚠️ 坐标单位约定：四角归一化到 [0,1]

- **声明**：`image.types.ts:205-207`——归一化 `[0,1]`（相对原图）优先，服务端按原图尺寸还原为像素；**任一坐标 > 1 即判定为像素口径，不再缩放**（兼容旧调用方）。
- **实现**：`image.service.ts:1282-1294`。
- **价值**：前端在不同预览缩放/裁剪状态下拉框，服务端都能还原到**原图像素空间**，不依赖上传时的尺寸。

### 3.5 ⚠️ 历史事故：`keepFullCanvas` 下「像素量纲 margin 不可直接相加」

- 现场：`image-dewarp.ts:143-194`，关键行 `:161-170`。画布尺寸按**单位空间包围盒**算：`W = round(spanX × docW) + margin × 2`，而 `margin = max(2, round(max(w,h) × 0.02))` 是**像素**量纲。
- 曾把像素 margin 直接加到**单位坐标**上（或反之混用）⇒ 输出画布塌缩成 **37×39 像素**的"裂图"。
- **写死的规则**：单位空间（0~1 / 归一化包围盒）与像素空间之间**只允许一次显式换算**，任何 padding / margin 必须在换算**之后**以像素量纲相加。
- 两处调用方都必须遵守：`buildLayoutContext` 与 `image-perspective`。

---

## 4. 几何纠偏（自动调正 / 手动拉四角）

### 4.1 阶段顺序（`image-dewarp.ts:329-526`）

```
朝向 orient → 曲面 curved(默认关) → 手动四角 manual → 自动四角 auto
→ UVDoc rectify（侧车 /ppsv3/rectify）→ deskew → perspective（透视残留）→ 兜底
```

`method` 枚举：`manual | auto | curved | skew | rectify | rectify+skew | rectify+perspective | perspective | orient-only | none`。

⚠️ **兜底分支保留已完成的旋转结果**，不是简单返回原图（`:494-525`）。

### 4.2 四角自动检测（`image-corners.ts`）

| 阈值 | 值 |
|---|---|
| 检测前缩放上限 `DETECT_MAX_SIDE` | 1024 |
| 最小面积比 / 最大边长比 / 最短边 | 0.25 / 5 / 60px |
| 贴边容差 `BORDER_TOL` | 3 |
| 面积比 > 0.985 → 拒（视为整幅图） | — |
| ≥3 个角贴边 → 拒 | — |
| 凸性检查 + 宽高比 | 0.3 ~ 3.3 |
| Canny | (50, 150) |
| 形态学闭运算 | MORPH_CLOSE 5×5 |
| `approxPolyDP` epsilons | 依次尝试 0.02 / 0.015 / 0.025 / 0.03 / 0.04 |

**误差水平**：Phase 3 实测四角平均误差 **1.4px**。

⚠️ `detectCornersNeural`（DBNet 插槽）**恒返回 null**，当前 100% 走 Canny + 轮廓经典法。

### 4.3 单应变换

`orderCorners` → `solveHomography`（8×8 线性方程组高斯消元）→ `warpRaw`（**双线性反向重采样**）。

⚠️ **第二起事故：单应方向用反**（`image-dewarp.ts:66-83`）。反向采样需要目标→源的映射，正确写法是 `solveHomography(dst, ordered)`；曾写成源→目标，图像被"反着拉"。

### 4.4 deskew / perspective / orient 参数

| 模块 | 关键参数 |
|---|---|
| `image-deskew.ts` | `DESKEW_MAX_DEG 15`、`DESKEW_GUARD_DEG 3`、粗搜步 1°、精搜步 0.1°、峰值排除 2°、共识容差 2°、裁中心 0.7、`DESKEW_MIN_CONFIDENCE 0.1`、`EST_MAX_SIDE 800`、`DESKEW_MIN_APPLY_DEG 0.3`、`MAX_POINTS 60000` |
| `image-perspective.ts` | `EST_MAX_SIDE 800`、`PERSPECTIVE_MIN_STD_DEG 0.4`、`MIN_ROWS 3` |
| `image-orient.ts` | 用侧车 OCR 消歧 0/90/180/270（`ocrAngleFromSidecar`） |

### 4.5 手动四角（前端双模式）

- `cornerMode: 'rect' | 'quad'`——**矩形裁剪** 与 **四角透视**；`MIN_QUAD_AREA = 0.05`、`CORNER_HIT = 36`；
- 退化四角（自交/极扁）**不崩溃**；
- 后端按 §3.4 归一化口径还原。

### 4.6 失败回退

自动四角未命中 ⇒ 返回**原图 + `notice`**（`level: 'warn'`，引导手动拉框）。

⚠️ **`notice` 机制不可省**（`image.types.ts:269-276`）：凡是"没改动"的返回必须带 notice，否则前端静默替换 = 用户看到"点了没用"（历史上有五轮此类反馈）。

---

## 5. 黑白二值化：服务端 Otsu vs 客户端 Sauvola

⚠️ **两者算法不同是有意为之，不得"统一"**。

| 维度 | 服务端（出图） | 客户端（预览） |
|---|---|---|
| 算法 | **全局 Otsu** | **Sauvola 局部自适应** |
| 位置 | `image-doc-enhance.ts:842-870` | `image-editor.tsx:2629-2666` |
| 阈值 | Otsu 自动全局阈值；去噪点 `speckMax = max(3, round(0.15 × strokeWidth²))` | `k = 0.2`、`R = 128`，窗口 `max(15, 短边/15)` 取奇；3×3 中值；滑块 ±2px 形态学；自动反相 |
| 前置 | 背景归一化 → Sauvola **软映射** → 局部对比 → 自适应锐化 → 白点拉伸 | `normalizeIllumination`（Retinex） |
| 版面保护 | ✅ 图表/照片区自动保护，不被二值化 | ❌ 无 |

**为什么服务端从 Sauvola 换成全局 Otsu**（`image-doc-enhance.ts:819-828`，实测依据）：

| 指标 | Sauvola k=0.2 | 全局 Otsu | 基准 |
|---|---|---|---|
| 中间调残留 | 19.3% | **2.0%** | — |
| 噪点数 | 165 | **75** | — |
| ink 占比 | 5.60% | **4.93%** | 4.58% |

**结论**：客户端要零延迟、可调、所见即所得（Sauvola 局部适应强）；服务端要可复现、批量一致、噪点可控（全局 Otsu 在整页文档上更干净，ink 占比更贴近基准）。注意服务端**仍用 Sauvola 做软增强**（`:723-726`），只是最终硬二值化改用 Otsu。

配套：`detectMonoSource`（`maxSide 640`、`inkChromaP95Max 28`、`otsuSeparationMin 55`、`inkDarkness 40`）——命中单色源时智能默认档切到 `bw`。

---

## 6. 智能高清（超分）

### 6.1 ESPCN 模型

- 权重：`server/espcn-weights/espcn_weights_x{2,3,4}.json`（由 `convert_espcn_pb.py` 从 `ESPCN_xN.pb` 转换）；
- 结构：`conv1 5×5 1→64 ReLU` → `conv2 3×3 64→32 ReLU` → `conv3 3×3 32→scale² 线性` → **pixel shuffle** → `tanh × 255`；
- 其他引擎 `tatt` / `real-esrgan` 为**占位未实现**。

### 6.2 倍率 × 模式矩阵

| | classical | espcn |
|---|---|---|
| ×2 / ×3 / ×4 | Lanczos3 + 3×3 中值 + sharpen(σ **1.4**) | ESPCN x2 / x3 / x4 |

默认 `scale = 2`；模式默认读 `SR_MODE`。⚠️ **仅亮度通道走增强**，色度用 cubic 上采样（避免彩色边缘色晕）。

### 6.3 ⚠️ `multi_modes` 仅用于五模式预览

- 用途：一次产出 original / enhance / bw / brighten / gray 五种预览缩略图供用户自选（内部 `scale=1`）。
- ⚠️ **`multi_modes === true` 时直接 return，不走 SrGate、不做高清扩展、不做 OCR 校验**（`image.service.ts:1458-1492`）。
- **禁用**：不能拿 `multi_modes` 的结果当成品图；不能与 `verify_ocr` 同时生效。

### 6.4 OCR 一致性校验（安全网）

- 阈值 `OCR_CONSISTENCY_THRESHOLD = 0.75`（可用 `IMG_OCR_MIN_SCORE` 覆盖）；
- 评分公式：`score = 0.5 × charOverlap + 0.25 × countRatio + 0.25 × lengthRatio`；
- 不达标 ⇒ **回退原图**并弹窗提示；校验本身报错/超时 ⇒ **默认接受**（避免网络抖动误杀）；
- 超时 `IMG_OCR_TIMEOUT_MS` 默认 45000。

### 6.5 并发与排队（SrGate / SrUserQuota）

| 项 | 默认值 |
|---|---|
| 任务分级 `classifySr` | heavy = `scale ≥ 3` **或** espcn；cost = 1 / 2 / 3 |
| `SrGate.lightLimit` / `heavyLimit` / `queueMax` | 2 / 1 / 8 |
| `canRunNow` | 取 `max(limit, cost)`——**死锁修复**（cost 3 > limit 1 时不能永远等） |
| `SrGate.timeoutMs` | 20000 |
| `SrUserQuota` | 窗口 60s / 6 次 / 并发 1（busy retry 2000ms） |
| 总闸开关 | `IMG_SR_GATE` |

**两道防线表现**：① 用户级配额超限 → **429**；② 全局并发闸排队超时/队列满 → **503** + 降级建议（引导改选 ×2 轻任务）。

### 6.6 增强档位 TUNING

| 档位 | flatten | levelStretch | k | blend | sharpenAmount |
|---|---|---|---|---|---|
| weak | 0.90 | 0.50 | 0.15 | 0.50 | 0.40 |
| **medium（默认）** | 1.00 | 0.75 | 0.22 | 0.72 | 0.60 |
| strong | 1.00 | 0.95 | 0.30 | 0.90 | 0.90 |

---

## 7. 去手写（擦除 `erase_v2`）

> 本项目最复杂的算法。核心原则：**疑罪从无——宁可少擦，不可误擦**。

### 7.1 链路

```
buildHandwritingMask(eraseMode='hybrid')        image.service.ts:480-486
  → buildEraseMask(policy)                      :490（erase-mask-policy.ts:48-108）失败降级基础 mask
  → coverage 判定                               :499-534
  → inpaint('adaptive')                         :542
  → blendWithMask                               :546
  → unmodifiedRegionSimilarity 验收             :549
```

### 7.2 擦除模式 policy（服务端缺省 `word`）

| 模式 | 语义 | 端到端实测（4 卷） |
|---|---|---|
| **`word`（默认）** | 只擦词级判别器 `state === 1`（确信手写）的词；印刷(0) 与疑虑(2) 一律保留 | 擦净 34/44（77%）、插图受损 6/16、框外改动 90,881px（**损伤最低**） |
| `union_generic` | hybrid 经颜色无关印刷保护后 ∪ 词通道确信手写 | 召回 84%、损伤 95,783px |
| `union` | 旧三通道并集（黑笔/铅笔卷） | — |
| `color` | 仅彩色笔迹通道 + 印刷保护闸（红/蓝批改卷） | 误删降 52%~99%（union 下 mask 内 42.5% 是印刷） |

⚠️ 口径不一致待办：前端 `image-editor.tsx:1091` 按笔色透传 `erase_mode: colorPenMode ? 'color' : 'union'`，与服务端缺省 `word` 不同——这是有意保留的前端可选项，但两者命名容易混淆。

### 7.3 词级三态判别器

**三态**：`0 = PRINT（印刷）` / `1 = HANDWRITING（手写）` / `2 = UNCERTAIN（疑虑）`。

**决策顺序**：

1. `lineVeto` → **0**（整行否决）
2. `n < WORD_NOISE_N` → **2**（样本太少，无法判决）
3. `score ≥ TAU_HI && consensusOk` → **1**
4. `score ≤ TAU_LO` → **0**
5. 其余 → **2**

| 参数 | 值 |
|---|---|
| `TAU_HI` / `TAU_LO` | 0.55 / 0.22 |
| `CONSENSUS_TAU` / `CONSENSUS_NH` | `G16_TAU` ‖ 0.55 / `G16_NH` ‖ 2 |
| ⭐ `WORD_NOISE_N` | **12** |

**`WORD_NOISE_N = 12`（微型词噪声地板）的含义**：一个"词"若有效笔画样本少于 12，几何统计量（字高方差、笔画 cv、倾斜角）不具统计显著性 ⇒ 判为**疑虑(2)** 而非手写，配合 `word` policy 即"不擦"。

**特征权重**：字高 0.50 / 笔画 cv 0.15 / 笔画 dev 0.05 / 间距 0.08 / 强度 0.12 / 倾斜 0.05 / 锚点 0.05；基线与上伸部权重**已置 0**（当前不参与打分）。

**混合词印刷序列保护**：同时满足 `bh ∈ [0.85, 1.15] × 行字高`、`bw ≥ 1.9 × 行字高`、`|y1 − baseY1| ≤ 0.4 × 行字高`、≥2 个连通域 ⇒ 判印刷，防"手写词里夹着印刷字被连坐擦掉"。

### 7.4 v21.8 两处关键修复

| # | 修复 | 前后对比 |
|---|---|---|
| P0 | 微型词噪声地板（`WORD_NOISE_N`）与共识门协同 | 见下 |
| P1 | 混合词印刷序列保护 | 见下 |

修复说明原文见 `word-level-discriminator.ts:17-26`；完整复盘与前后数据见 `docs/reports/擦除修复-v21.8-验证记录.md`（链路表 `:11-19`、首跑 5/5 未过 `:23-29`、P0/P1 根因 `:33-46`、修复清单 `:50-60`、前后对照 `:64-77`、回归 `:91-102`）。

### 7.5 各阶段参数

| 阶段 | 参数 / 行为 |
|---|---|
| 背景估计 | 取最亮 **10%** 像素估纸色，带敏感度扫描 |
| 背景图 | 归一化卷积**两轮迭代** |
| inpaint 策略 | `median \| blur \| masked \| edge \| adaptive`（**默认 adaptive**：按区域分 `blank` 填底色 / `text` 结构延拓；无 text 区退化为 masked） |
| 合成 | `out = inpainted × (1 − m) + original × m`，mask 写进 alpha 用 `over` 合成 |
| 验收 | `unmodifiedRegionSimilarity`：`mask == 0` 为硬外区，容差 **2/255** |
| 覆盖率闸 | ≤ 0.0001 → 原图 + notice；> 0.7 → 抛错 |
| 人工补擦 | `manual_regions`（归一化 `{x,y,w,h}`）**无条件并入 mask**，优先级高于一切自动检测 |

⚠️ `manual_regions` 存在的理由：**黑笔手写 vs 黑色印刷在几何/色彩特征上全面重叠**，自动检测有理论上限；漏检零容忍场景只能靠人工确定性补刀。

### 7.6 ⚠️ T7 已知缺口（当前保持现状）

场景② 未过，残余 **38.27%**（2784px 紧邻印刷 + 2722px 纯连坐），即**手写压在印刷字上时像素级不可分**。

**产品决策：保持现状不修**（宁可少擦不可误擦），登记 `OPS-18 R-算法-01`。

---

## 8. OCR 双引擎与文本分段

### 8.1 对照

| 维度 | fast（RapidOCR） | precise（PP-StructureV3） |
|---|---|---|
| 进程模型 | **常驻子进程**，stdin/stdout 帧协议（4 字节长度 + 图；哨兵 `<<<OCR_RESULT>>>`） | **侧车 HTTP** `http://127.0.0.1:9301` |
| spawn 参数 | `--loop --op recognize --mode rapid --layout auto` | — |
| 超时 | `OCR_TOOL_TIMEOUT_MS` 默认 120s；自愈重试压到 60s | `PPSV3_TIMEOUT_MS` 默认 180s；health 3s |
| 精度 / 耗时 | 较低 / 声明 1~3s（实测 9.5s） | 最高 / 声明 15~20s（实测 22.3s） |
| 适用 | 快速预览、批量初筛、轻量部署 | 人工辅助整理、需要版面/表格/阅读序 |
| 引擎缺失 | 明确报错（不静默降级） | 明确报错 |

**默认选择**：`ocr-page` 的 `mode` **默认 `precise`**。

### 8.2 Python 侧车（`ocr-engine/main3.py`）

| 项 | 值 |
|---|---|
| 端口 | `PPSV3_PORT` 默认 **9301** |
| `PPSV3_UNWARP` / `ORIENT_CLS` | 默认 1，生产由 Node 注入 **0** |
| 版面模型 | `PP-DocLayout_plus-L` |
| CPU 降级 | det/rec 降为 mobile 档 |
| 端点 | `/healthz` `/ppsv3` `/ppsv3/rectify` `/vl/parse` `/orient` |

VL 调用有 **> 8GB 内存**门槛。侧车生命周期与环境变量透传见 DD-09 第 11 章。

### 8.3 ⚠️ `rectify` 默认 true，但"先裁剪再 OCR"必须传 false

`rectify` **默认 `true`**（`image.service.ts:997`）。

⚠️ **"先裁剪题目 → 再对裁剪图 OCR" 必须传 `false`**，否则二次透视可能塌缩——历史 37×39 裂图即由此而来。

### 8.4 文本分段规则

契约：`PageTextSegment = { text, box, col, kind, lines, source }`。

| 来源 | 做法 |
|---|---|
| **precise** | 直接取 PP-StructureV3 的 blocks（已含阅读序 + 区内行合并成段），`source = 'layout'` |
| **fast** | RapidOCR 无版面能力 ⇒ 行级 → **递归 XY-Cut** 定序 + 间隙/缩进/题号断段，`source = 'xycut'` |

| 常量 | 值 |
|---|---|
| `SAME_LINE_RATIO` / `SAME_LINE_GAP_RATIO` | 0.6 / 1.0 |
| `XY_V_GAP_RATIO` / `XY_H_GAP_RATIO` | 1.5 / 0.6 |
| `PARA_GAP_RATIO` / `PARA_INDENT_RATIO` | 1.5 / 2.0 |
| `MAX_XY_DEPTH` / `MIN_XY_ITEMS` | 6 / 2 |
| `Q_HEAD` 正则 | `^\s*(?:\d{1,2}\s*[.、．)）:：]\|[一二三四五六七八九十]{1,3}\s*[、．.])` |

### 8.5 结果缓存（`ocr_results`，见 ADD-05 第 4.11 节）

| 项 | 值 |
|---|---|
| `OCR_ENGINE_VERSION` | `process.env.OCR_ENGINE_VERSION ‖ 'gk-ocr-2026.10.25'` |
| key 构造 | `sha256(kind # mode # extra # engine_version # hashes)` |
| `ocr-page` 的 key 维度 | `kind:'page'` + `mode` + `extra: rectify \| no-rectify` |
| 单条上限 | `MAX_RESULT_BYTES` 512KB |

⚠️ **升级引擎/模型后必须改 `OCR_ENGINE_VERSION`**，否则旧产物继续被回放。`force=true` 忽略读取但**仍写入**（覆盖旧条目）。

---

## 9. 红笔检测与判错（verdict）

### 9.1 色域 mask 与形态分类（`wrongq-mark.ts`）

| 参数 | 值 |
|---|---|
| `chromaMin` | **14**（v6 实测：22 会漏细对勾） |
| `maxArea` | `(6 × medH)²` |
| 顺序 | **先排除红色家具，再闭运算** |

`classifyMark` 几何判据：

| 类型 | 判据 |
|---|---|
| underline | `aspect > 6` 且 `bh ≤ 0.3 × medH` |
| correction | `n > 300`（大团批改） |
| circle | `aspect 0.7~1.4`，`fill 0.25~0.75` |
| cross | `aspect 0.7~1.5`，`fill 0.12~0.5` |
| tick（勾） | `aspect 1.5~5`，`fill 0.12~0.7` |

### 9.2 ⭐ 组级门（防误判的关键）

```
correction = coreId >= 0 && geoOk && (members.length >= 2 || !isTickLike(marks[coreId]))
```

**单个类勾符号不足以判错，必须有 ≥2 个成员**——这是"勾 = 对、叉/圈 = 错"语义下的关键防误判闸。

### 9.3 判定与置信度（`wrongq-decide.ts`）

| 项 | 规则 |
|---|---|
| `isPlausibleSymbol` | `n ≥ 20`，`side ∈ [0.45, 2.5] × medH` |
| strong 簇 | `parts ≥ 8` 或 `ink ≥ 2 × medH²` |
| 置信度 | strong **0.9** / lineLed **0.78** / weak **0.6**；非簇路径 correction 0.7 / negStrong 0.6 / circled 0.55 / tick→correct 0.5 / unknown 0.3 |
| 兜底 | 非簇路径**一律 `suspect = true`** |

### 9.4 题号正则（`ocr-hierarchy.ts:66-94`）

| 顺序 | 正则 | kind |
|---|---|---|
| 1 | `/^第\s*([一二三四五六七八九十\d]{1,3})\s*(?:部分\|大题\|卷)/` | `part` |
| 2 | `/^[（(]\s*([一二三四五六七八九十]{1,3})\s*[）)]/` | `paren-cjk` |
| 3 | `/^([一二三四五六七八九十]{1,3})\s*[、，,．.]\s*/` | `cjk` |
| 4 | 首字符 ∈ `①`–`⑩`（扩至 ⑳） | `circled` |
| 5 | `/^[（(]\s*(\d{1,2})\s*[）)]/` | `arabic` |
| 6 | `/^(\d{1,2})\s*[、，,．.)）]\s*/` | `arabic` |

补充签名：`INSTRUCTION_RE`（含"汉译英/英译汉"）、3 位以上数字排除年份、`(?!\d)` 防小数误判。

### 9.5 误判兜底

- 人工改框：`POST /api/image/extract-wrong-recrop`；
- `boxFeedback`（`iou / area_delta_pct / offset`）作为**判定准确率的真实数据源**；
- 兜底原则：**不判错优于错判**。

---

## 10. 验收体系

### 10.1 数据集（如实说明）

| 项 | 事实 |
|---|---|
| 探针所用"GT" | **脚本内 SVG 合成 fixture**（`probe-erase-chain.ts:52-53`，`W=900, H=1200`，确定性 seed `42 / 7 / 99 / 2024`） |
| 真实卷 GT 图片 | `/workspace/worksheet-test/annotated`——**不在本仓库**，需单独挂载/同步后才能跑真实集回归 |
| verdict 探针真实样本 | `docs/reports/test-wrongq-sample.png`（**在仓库内**） |

### 10.2 五场景与阈值（`probe-erase-chain.ts:459-522`）

| 场景 | `residualMax`（残留上限） | `printDamageMax`（印刷损伤上限） | 附加 |
|---|---|---|---|
| ① | 0.55 | 0.03 | — |
| ② | 0.75 | 0.42 | **当前未过**（残余 38.27%，见 §7.6） |
| ③ | 0.60 | 0.04 | — |
| ④ | 0.85 | 0.04 | `illusKeepMin ≥ 0.9`（插图保留） |
| ⑤ | 0.005 | — | `noDetect`（应完全不检出手写） |

分类缓冲 `NEAR = 10px`；诊断开关 `PROBE_ERASE_DIAG = 1`。

### 10.3 探针脚本

| 脚本 | 用途 |
|---|---|
| `server/dynamic-tests/probe-erase-chain.ts` | 擦除链路五场景验收 |
| `server/dynamic-tests/probe-verdict.ts` | 判错 A1/A2/A3/B/C/D 五组 |
| `server/dynamic-tests/eval-real-erase.ts` | 真实图评估，`--img/--dir/--out`，墨量保留率 `inkKeep`，输出 `report.json` |

### 10.4 指标口径与回归门禁

| 门禁 | 口径 | 状态 |
|---|---|---|
| **G16** | 框外印刷误擦 **M ≤ 2.0%** | ✅ 明确；常量即 `G16_TAU` / `G16_NH` |
| **G15** | 擦净率（注释级：hwRecall 42/44 或 36/40） | ⚠️ **无独立数值门禁定义** |
| **G13** | structural/hybrid 通道"标尺不倒退" | ⚠️ **无独立数值门禁定义** |

**回归门禁（OPS-18）**：

- `R-算法-01`：T7 擦除 38% 保持现状；
- `R-算法-02`：**每次算法改动必须回归 G16**；
- `R-算法-03`：侧车冷启动延迟；
- `R-算法-04`：公式渲染为近似表达。

回归规模：`issue-three-image-features.md:174-190` —— **38 + 212 条断言**。

---

## 11. 性能与资源

### 11.1 输入保护（`image-preprocess.ts`）

| 项 | 值 |
|---|---|
| `MIN_TOTAL_PIXELS` / `MAX_TOTAL_PIXELS` | 3,686,400 / 16,777,216 |
| 宽高比范围 | 0.0625 ~ 16（容差 0.005） |

### 11.2 并发与超时

| 项 | 值 |
|---|---|
| 错题块 OCR 并发 `OCR_CONCURRENCY` | 4 |
| 单次切块上限 `MAX_EXTRACT_BLOCKS` | 60 |
| 图片下载超时 | 60000ms |
| OCR 一致性校验超时 | 45000ms |
| fast 工具超时 | 120s（自愈重试压到 60s） |
| precise 侧车超时 | 180s（health 3s） |
| SR 闸等待超时 | 20000ms |
| OpenCV WASM 加载超时 | 30000ms（`IMG_CV=off` 强制不加载） |

⚠️ `mapWithConcurrency`：块内串行、块间 ≤ limit 并发，结果**按原顺序**收集，不吞异常。

### 11.3 缩放天花板（内存保护）

| 环节 | 上限 |
|---|---|
| 四角检测 | `DETECT_MAX_SIDE` 1024 |
| 单色源检测 | 640 |
| deskew / perspective 估计 | `EST_MAX_SIDE` 800（采样点 ≤ 60000） |
| OCR 页图 | `maxEdge` 2000 |
| PDF 渲染 | `MAX_RENDER_EDGE` 4200，scale 2.0 |
| VL 模型门槛 | > 8GB 内存 |
| 前端上传 | 长边 1280 / q80 / canvas 1365 |

---

## 12. 已知缺口与后续方向

| 缺口 | 现状 | 去向 |
|---|---|---|
| T7 擦除场景残余 38.27% | 保持现状（2784px 紧邻 + 2722px 连坐） | `OPS-18 R-算法-01` |
| 黑笔手写 vs 黑色印刷 | 特征全面重叠 ⇒ 自动检测有**理论上限**，靠 `manual_regions` 人工补擦 | 同上 |
| **公式识别** | 渲染为近似表达，非结构化公式语义 | `OPS-18 R-算法-04` |
| 侧车冷启动 | 空闲 15min 回收，冷启动首次请求显著变慢 | `OPS-18 R-算法-03` |
| 曲面展开（curved dewarp） | 经典曲面法实测不达标已撤下；`dewarp_curved=true` 安全回落平面 | — |
| 神经四角检测 | `detectCornersNeural` 恒返回 null（DBNet 插槽未实现） | — |
| SR 引擎 tatt / real-esrgan | 未实现（占位） | — |
| 复杂版面（多栏 / 表格） | fast 通道无版面能力，靠递归 XY-Cut 近似 | — |
| 红笔判错正面样本命中低 | gt-front **1/6**（题号被 OCR 吞吃） | 见 DD-14 第 8 章 |
| G13 / G15 数值门禁 | **未定义**（仅注释级口径） | 建议补齐后登记 |

---

## 变更记录

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v0.0 | 2026-10-24 | 建立提纲（待审） |
| v1.0 | 2026-10-27 | **正文完成**：9 项能力总览与灰度开关、管线编排与 sharp/坐标两条铁律（含 37×39 裂图事故）、几何纠偏全参数与单应方向事故、黑白双算法有意不同的实测依据、超分模型与 SrGate 两道防线、擦除词级三态判别器与 `WORD_NOISE_N=12`、T7 缺口 38.27%、双引擎对照与 XY-Cut 分段、红笔组级门与题号正则、五场景验收阈值与 G16 门禁、性能参数全集、11 项已知缺口 |
