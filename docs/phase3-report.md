# Phase 3 · 增强 — 交付报告

> 依据《自动调正与智能高清重构方案》§八 Phase 3 行实施。
> 落点：`/workspace/push-ready/server/src/image/`。
> 上游基线：Phase 1 几何纠偏 18/18、Phase 2 智能高清 24/24 全绿。

---

## 一、总览：三项交付的最终判定

| # | 交付项 | 方案要求 | 实测判定 | 交付状态 |
|---|---|---|:--:|---|
| 1 | **DBNet 自动角点** | 神经网检测文档四角 | ✅ 经典等价管线实测 1.4px 误差 | **交付** |
| 2 | **曲面 dewarping（DocTr）** | 曲面展平 | ❌ 4 法实测改善全在噪声范围（+1.7%/−0.6%/+0.2%/−0.2%） | **撤下**（恒回落，不劣化）|
| 3 | **处理前后 OCR 一致性自动回退** | 一致性校验 + 自动回退 | ✅ 纯函数度量 + 编排落地，37 项断言通过 | **交付** |

**一句话**：自动角点补齐了「无手动拉框也能纠偏」的最后一环；OCR 一致性回退给智能高清装上「劣化即撤回」的安全阀；曲面 dewarp 诚实撤下——不交「看着能跑、实际变差」的代码。

**回归全绿**：v2 `18/18`、v3 `24/24`、v4 `37/37`，`nest build` 通过。

---

## 二、交付 1：自动角点检测（经典等价 DBNet）

**文件**：`image-corners.ts`（新）+ `image-cv.ts`（新，OpenCV 懒加载单例）+ `image-dewarp.ts`（接入）

**为什么是「经典等价」而不接真 DBNet**：部署沙箱对 GitHub / HuggingFace / PyTorch 的 TLS 全掐断，真实权重不可下载（前序 Phase 已确认）。于是用方案自身列出的经典管线实现同等能力，并留神经插槽。

**管线**：
```
sharp 解码 → 灰度 → 长边 resize ≤1024（坐标按比例还原）
→ Mat(CV_8UC1) → Canny(50,150) → morphologyEx(CLOSE,5×5)
→ findContours(RETR_EXTERNAL) → 最大 contourArea
→ approxPolyDP(0.02·peri)（顶点≠4 时 0.015/0.025/0.03 重试）
→ orderCorners → [tl, tr, br, bl]
```

**护栏**（任一不满足即返回 `null` → 回落 `needManual`）：

| 护栏 | 值 | 拦截的错误 |
|---|---|---|
| 面积占比 | ≥0.25 **且 ≤0.985** | 排除纯噪声、剔除满幅伪文档 |
| 贴边角点数 | ≥3 个贴边（tol=3px）则拒 | 排除整张图被当成文档 |
| 凸性 | 四叉积同号 | 排除自交/凹多边形 |
| 边长比 | maxEdge/minEdge ≤5 | 排除细长误检 |
| 宽高比 | ∈[0.3, 3.3] | 排除极端形状 |
| 最小边 | ≥60px | 排除碎块 |

**实测**（合成 400×300 透视四边形）：

| 用例 | 结果 |
|---|---|
| 透视四边形 | 返回 4 点，顺序正确，**最大误差 1.4px** |
| 纯噪声图 | `null`（不误检）|
| 面积过小文档 | `null` |
| 满幅贴边矩形 | `null` |
| OpenCV 不可用 | `null` 不抛（自动降级）|

---

## 三、交付 2：曲面 dewarping —— 实测不达标，**撤下**

**文件**：`image-curvedewarp.ts`（接口 + 神经插槽，`dewarpCurved` 恒返回 `null`）

**决策过程（用户预授权「实现并实测，不行就撤」）**：尝试 4 种经典参数化方法，全部失败：

| 方法 | 原理 | 实测结果 |
|---|---|---|
| 逐列暗像素质心中位 | 逐列求墨点质心作为位移 | 17.09 → **18.62**（变差）|
| 行投影互相关 | 相邻行互相关估位移 | 饱和到搜索边界 −30，不可用 |
| 列质心去线性趋势 | 拟合线性基线后取残差 | 残差幅值接近真值，但形状相关系数 **≈0.000**（形状错）|
| 文本基线二次曲线拟合 + 列位移场 | 二次拟合基线→列位移→重映射 | 4 组参数改善 **+1.7% / −0.6% / +0.2% / −0.2%**，全在噪声范围 |

**根本结论**：在无神经模型的前提下，经典方法**无法可靠估计非平面文档的弯曲场**。依「不达标即撤」原则：
- `dewarpCurved` 恒返回 `null`；
- 调用方 `straightenImage` 在 `curved=true` 时先试曲面、`null` 即**回落平面 homography**，行为与 Phase 1 **完全一致、绝不劣化**；
- 保留 `dewarpCurvedNeural` 神经插槽与完整失败记录（文件顶部注释），供生产环境接入 DocTr / DocUNet / DewarpNet。

> 这是一次**主动的负面交付**：不把不可靠代码伪装成功能上线。

---

## 四、交付 3：处理前后 OCR 一致性自动回退

**文件**：`image-quality.ts`（新，纯函数）+ `image.service.ts`（编排）+ `image.module.ts` / `ocr.module.ts`（注入）

**问题**：智能高清（SR）本质是像素级重采样 + 锐化，理论上只应**提升**可识别度。但极端情况下（过锐化振铃、色度分离、插值糊掉细笔画）可能让 VLM 识别结果变差。我们没有人工标注真值，于是用**自一致性**作代理指标。

**度量（纯函数，可单测）**：
```ts
export interface OcrConsistency { similar; charOverlap; countRatio; lengthRatio; score; detail }
compareRecognized(a, b, threshold = 0.75): OcrConsistency
```
- `charOverlap` = 题面**字符集 Jaccard** = |A∩B|/|A∪B|（对公式/符号敏感，正是「符号丢没丢」的关键信号）
- `countRatio` = min/max 题数（少识别一整题是严重劣化）
- `lengthRatio` = min/max 总字数
- `score = 0.5·charOverlap + 0.25·countRatio + 0.25·lengthRatio`，**≥0.75 判一致**

**编排**（`ImageService.verifyOcrConsistency`）：
1. 处理图先落存储取公网 URL（VLM 只吃 URL，不吃 Buffer）；
2. 原图与处理图**并行** `recognizeExamByUrls`（temperature=0.1）；
3. `compareRecognized` 打分；`score < 阈值` → **回退原图**，`debug.ocrFallback=true`。

**三条硬约束**（方案 §4）：
- **整体 try/catch**：OCR 任一步失败（网络/配额/超时）→ **默认接受处理图**（`ocrVerified:false`），**绝不阻塞**主流程；
- **超时保护**：`IMG_OCR_TIMEOUT_MS`（默认 45s），避免 VLM 抖动拖死 enhance；
- **开启范围**：仅 **enhance 默认开**（auto/erase 不启用）；`IMG_OCR_VERIFY=off` 或 `dto.verify_ocr=false` 可关。

**实测度量用例**：

| 场景 | 结果 |
|---|---|
| 完全相同 | score=1，一致 |
| 少一题 | countRatio=0.5，score=0.621 → **不一致** |
| 内容变乱码 | charOverlap=0.308，score=0.574 → **不一致** |
| 仅空白差异 | 归一化后 score=1，一致 |
| 双空 / 单侧空 | 1 / 0（边界不炸）|
| 非数组输入 | 不抛，返回 score 数值 |

---

## 五、灰度开关与环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `IMG_PIPELINE_MODE` | `gen` | `new`/`hybrid` 才启用几何纠偏与智能高清新路径 |
| `IMG_CV` | `on` | `off` 强制不加载 OpenCV WASM |
| `IMG_CORNERS` | `on` | `off` 关闭自动角点；`dbnet` 试神经插槽 |
| `IMG_CURVEDEWARP` | `classical` | `doctr` 预留（当前恒回落）|
| `IMG_OCR_VERIFY` | `on` | `off` 全局关闭 OCR 一致性校验 |
| `IMG_OCR_MIN_SCORE` | `0.75` | 一致性判定阈值 |
| `IMG_OCR_TIMEOUT_MS` | `45000` | OCR 校验超时 |
| `SR_MODE` / `ESPCN_WEIGHTS_URL` | `classical` / — | 智能高清推理模式（Phase 2）|

**DTO 新增**：`verify_ocr?: boolean`（仅 enhance 默认开）、`dewarp_curved?: boolean`（默认 false）。

---

## 六、测试与回归

| 套件 | 用例数 | 结果 |
|---|---|:--:|
| `run-image-v2.mjs`（Phase 1）| 18 | ✅ 18/18 |
| `run-image-v3.ts`（Phase 2）| 24 | ✅ 24/24 |
| `run-image-v4.ts`（Phase 3，新）| 37 | ✅ 37/37 |
| `npx tsc --noEmit` | — | ✅ 0 错 |
| `npx nest build` | — | ✅ 通过 |

**v4 覆盖**：角点（4 项 + 护栏 4 项 + 降级 2 项）、曲面（3 项，断言「恒 null / 不劣化」）、一致性（13 项）、源码一致性（13 项）。

---

## 七、诚实局限（写入台账）

1. **真实 DBNet / DocTr 未接入**：仅经典等价 + 神经插槽（部署沙箱权重不可得）。
2. **曲面 dewarp 未交付**：已知难点，4 法实测全败，主动撤下，`curved=true` 安全回落平面。
3. **OpenCV WASM 常驻内存 / 单核开销**：懒加载 + 长边限 1024 + 8s 超时降级。
4. **OCR 回退使 VLM 成本/延迟翻倍**：默认仅 enhance，可关，加超时。
5. **字符集 Jaccard 对公式/符号敏感 + VLM 输出随机性**：0.75 为起点，需线上调参。

---

## 八、变更文件清单

**新增**：`image-cv.ts`、`image-corners.ts`、`image-curvedewarp.ts`、`image-quality.ts`、`dynamic-tests/run-image-v4.ts`
**修改**：`image-dewarp.ts`、`image.service.ts`、`image.types.ts`、`image.module.ts`、`ocr/ocr.module.ts`、`server/package.json`
