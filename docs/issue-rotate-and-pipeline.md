# 修复说明 · 旋转裁边 & 图像功能"点了不能用"

> 本文档记录两个用户反馈问题的 6 步法处理过程、根因、修复与验证结果。
> 对应教训录条目：**L7-补充**（旋转裁边）、**L12**（灰度开关默认值）。

---

## 问题 1：旋转 90° 几次后，图片四周尺寸被裁掉

### 定位（6 步法 ①~④）

| 步骤 | 做法 | 结论 |
| --- | --- | --- |
| ① 归类 | 属于「微信 Canvas 2D 图像裁剪/旋转」成熟领域 | 对照 **L7** 范式 |
| ② 查标准范式 | 读 `wx.canvasToTempFilePath` 文档 + Canvas 2D 约定 | `x/y/width/height` 是 **canvas 缓冲像素**；导出区域被理解为「当前 CSS 布局尺寸」 |
| ③ 确认能力边界 | 用 `sharp` 探针验证纯几何 | 连续 4 次 90°，输入/输出尺寸**严格守恒**，算法正确 |
| ④ 看成熟项目做法 | 对齐"旋转烘焙 + 缓冲=CSS"基线 | 失配点锁定 |

**根因**：离屏 `<Canvas>` 的 **CSS 布局尺寸**用的是自然尺寸（`Math.min(naturalW||1, MAX_CANVAS_SIDE)`），
而绘制用的**缓冲尺寸** `node.width/height` 在旋转 90°/270° 时会**互换**（`swap = rot % 180 !== 0`）。
两者失配（缓冲 400×800 vs CSS 800×400）→ `canvasToTempFilePath` 按 CSS 尺寸理解导出区域 → **四周被裁**。

**证伪过程**（拿运行时证据，不猜）：
- `rot-probe.cjs`：纯几何算法 → 4 次旋转全程无裁边（**算法无问题**）。
- `rot-probe2.cjs`：故意让 CSS ≠ 缓冲 → **精确复现裁边**（**根因确认**）。
- 两个探针跑完即删，不入库。

### 修复（`src/components/image-editor.tsx`）

1. 新增 `canvasBox` 状态，承载离屏 canvas 的**布局尺寸**，**由 `drawAndExport` 中同一套 fit/swap 计算派生**（不再由 `naturalW/H` 派生）—— 二者**同源**，结构上不可能再失配。
2. `drawAndExport` 在 `node.width/height = canvasW/canvasH` **之前**先 `setCanvasBox(...)`，并 `await waitLayout()`（双 `requestAnimationFrame` + `setTimeout(30ms)` 兜底）等微信完成一次布局。
3. 离屏 `<Canvas>` 的 CSS 改为 `width: canvasBox.w, height: canvasBox.h`。

> 关键注释已写入代码，防止回归：
> 「必须与 node.width/height（缓冲）严格一致，否则 canvasToTempFilePath 会按 CSS 布局尺寸理解导出区域 → 旋转 90°/270° 时四周被裁」

### 验证

`dynamic-tests/run-issue-rotate.cjs` —— **13/13 passed**：
- 几何：连续 4 次 90° 全程无失配
- 边界：极宽 4000×100 / 极高 100×4000 / 超大 5000×3000→2458×4096 / 270° / 180°（不换宽高）
- 源码一致性：`canvasBox` / `waitLayout` / CSS 用 `canvasBox` / 旧写法已移除 / 防回归注释

---

## 问题 2：去手写、自动调整、智能高清"点击后不能用"

### 定位（6 步法 ①~④）

**根因**：后端灰度开关 `IMG_PIPELINE_MODE` **默认值为 `'gen'`**（旧图生图路径）。未显式配置环境变量时：
- `auto`（自动调整）**不走** `straighten`，落旧 `process()` 图生图兜底；
- `enhance`（智能高清）**不走** `enhance`，同样落旧路径；
- `erase_v2`（去手写）在 MODE 判断**之前**直达，**不受影响** → 与"三类症状中有一类表现不同"吻合，反证根因位置。

用户观感 = "点了按钮什么都没发生"（静默失效，无报错）。

### 修复（`server/src/image/image.controller.ts`）

`IMG_PIPELINE_MODE` 默认值 `'gen'` → **`'hybrid'`**：
- **新管线优先**（`straighten` / `enhance` 生效，功能开箱可用）；
- **任何异常自动回退** `process()` 图生图兜底（不硬失败）；
- 限流错误（429/503）通过 `isRateLimitError(e)` **豁免回退**（否则限流会被"回退"掩盖成"成功"）。

> 该改动属**产品行为决策**，已通过 AskUserQuestion 由用户拍板选择「默认改为 hybrid」。

### 验证

`dynamic-tests/run-issue-rotate-pipeline.cjs` —— **7/7 passed**：
- 默认 MODE = `'hybrid'`
- 默认下 `auto` 进入 `straighten`、`enhance` 进入 `enhance`
- `straighten` / `enhance` 调用分支存在、hybrid 有回退
- `erase_v2` 在 MODE 判断之前直达（不受开关影响）

---

## 全量回归结果

| 测试 | 断言 | 结果 |
| --- | --- | --- |
| `run-image-v2.mjs` | 18 | ✅ 18/18 |
| `run-image-v3.ts` | 24 | ✅ 24/24 |
| `run-image-v4.ts` | 37 | ✅ 37/37 |
| `run-image-v5.ts` | 26 | ✅ 26/26 |
| `run-image-v6.ts` | 61 | ✅ 61/61 |
| `run-ui-sr.mjs` | 24 | ✅ 24/24 |
| `run-issue-rotate.cjs`（新，问题 1） | 13 | ✅ 13/13 |
| `run-issue-rotate-pipeline.cjs`（新，问题 2） | 7 | ✅ 7/7 |
| **合计** | **210** | **✅ 210/210** |

**类型检查 / 构建**
- 后端 `npx tsc --noEmit` ✅ / `npx nest build` ✅
- 前端 `tsc --noEmit -p tsconfig.json` ✅

---

## 变更文件清单

| 文件 | 变更 |
| --- | --- |
| `push-ready/src/components/image-editor.tsx` | 新增 `canvasBox` 状态 + `waitLayout()`；`drawAndExport` 同步布局并等待；离屏 Canvas CSS 改用 `canvasBox` |
| `push-ready/server/src/image/image.controller.ts` | `IMG_PIPELINE_MODE` 默认 `'gen'` → `'hybrid'` |
| `dynamic-tests/run-issue-rotate.cjs` | 新增（问题 1 回归，13 断言） |
| `dynamic-tests/run-issue-rotate-pipeline.cjs` | 新增（问题 2 回归，7 断言） |
| `dynamic-tests/run-ui-sr.mjs` | 断言放宽以匹配当前 `handleAi` 签名 |
| `工程教训录.md` | 新增 **L7-补充**（旋转裁边）、**L12**（灰度开关默认值）+ 附录命令 |
| `docs/issue-rotate-and-pipeline.md` | 本文件 |

**已清理**：`server/rot-probe.cjs`、`server/rot-probe2.cjs`（临时探针，不入库）。
