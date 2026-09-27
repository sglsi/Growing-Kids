# 修复说明 · 旋转裁边 & 图像功能点了不能用

> **重要更正**：本文档早期版本把问题 1 归因于"canvas 尺寸失配"，并推断"改错了目录"。
> 经用户反馈「**旋转预览正常，保存后才裁**」后重新定位，**真根因在保存链路的状态机**（见下）。
> 对应教训录：**L7-补充**（旋转裁边）、**L12**（灰度开关默认值）、**L14**（预览对 ≠ 保存对）。

---

## 一、问题 1：旋转 90° 后**保存的图**四周被裁

### 关键线索（用户提供，是定位的转折点）

> **「旋转过程中预览正常；旋转完成后保存，存下来的图四周被裁。」**

这一条把范围从"旋转/canvas 几何"**缩小到"保存链路"**——预览用的是正确的结果，只有落库那一步又裁了一刀。

### 真根因

```ts
const DEFAULT_CROP: Rect = { x: 0.05, y: 0.08, w: 0.9, h: 0.84 }   // 内缩框！
```

保存链路的状态机走错了分支：

1. 旋转后 `handleRotate` 把 `crop` **重置为 `DEFAULT_CROP`**（内缩 5%~8%），并置 `confirmed=false`、`framing=false`；
2. 旧的 `handleSave` 判断是：
   ```ts
   const imgSrc = confirmed ? currentSrc : await exportEdited()   // ❌
   ```
   `confirmed=false` ⇒ 走 `exportEdited()` ⇒ **按 `crop`（刚被重置成内缩的 `DEFAULT_CROP`）导出** ⇒ **四周被裁**。

所以：**预览正确**（用的是 `currentSrc`，完整），**保存错误**（又按内缩框裁了一刀）。旋转次数越多、越明显。

> 注：`handleConfirm` 早已用正确判断 `const pendingCrop = showFrame && !confirmed` 修过同类问题，
> 但 `handleSave` **没同步修** —— 同一个 bug 存在两份实现，只改了一处。

### 修复（`src/components/image-editor.tsx`）

| 项 | 内容 |
| --- | --- |
| **handleSave** | 与 `handleConfirm` 统一：`const pendingCrop = showFrame && !confirmed`；**只有"主动裁剪且未确认"才按框裁**，否则直接用 `currentSrc`（成品） |
| **handleRotate** | 结果即成品 → `setConfirmed(true)` + `setFraming(false)`（原来错设为 `false`） |
| **handleAi** | 同上：AI 成功后 `setConfirmed(true)`（原来错设为 `false`） |

**顺带保留的 canvas 加固**（独立于本 bug，属预防性修复）：CSS 显示尺寸固定为 1365 方框 + 导出显式传参 + 上限 4096→1365（官方安全值）+ `waitLayout` 去 rAF（防永久挂起）。

### 验证

`dynamic-tests/run-issue-save-crop.cjs` —— **15/15 passed**：状态机仿真覆盖「旋转后/AI 后/主动裁剪/已确认/AI 中」五条路径，并**反向复现**旧实现（内缩框二次裁剪 → 左右各裁 5%、上下各裁 8%）。

---

## 二、问题 2：去手写 / 自动调整 / 智能高清点了不能用

### 根因

后端灰度开关 `IMG_PIPELINE_MODE` **默认 `'gen'`**（旧图生图路径）。未配环境变量时：
- `auto` / `enhance` **不走**新管线（`straighten` / `enhance`），落旧 `process()`；
- `erase_v2` 在 MODE 判断**之前**直达 → 不受影响（与"三类症状里有一类不同"吻合）。

### 修复（`server/src/image/image.controller.ts`）

`IMG_PIPELINE_MODE` 默认值 `'gen'` → **`'hybrid'`**（新管线优先 + 异常自动回退 `process()` 兜底；
限流错误 429/503 通过 `isRateLimitError(e)` **豁免回退**）。

### 验证

`dynamic-tests/run-issue-pipeline-e2e.ts` —— **14/14 passed**：
- 默认下三个 action 都进正确路径 ✅
- `gen` 模式确实关掉新功能（反例复现）✅
- `hybrid` 异常回退 / `new` 原样抛错 / 限流不被吞 ✅
- **真跑 `straightenImage`**（真造像素）：665×963 输出、宽高比 0.691 ✅

---

## 三点五、⭐ 系统性诊断：「点了有'处理中'提示，很快消失，图片没变」

> 用户现象：**点去手写 / 自动调整 / 智能高清，出现"…处理中"提示，但很快消失，图片和之前一模一样。**
> 本轮用「直接实例化 ImageService + 真跑处理逻辑」的方式端到端定位（见 `run-issue-nochange-e2e.ts`）。

### 决定性证据：线上后端很可能是旧版

| | `push-ready`（新） | `server-v4`（旧，已归档） |
| --- | --- | --- |
| controller 有 `straighten`/`enhance` 路由 | **有（5 处）** | **无（0 处，仅注释）** |
| service 有 `straighten`/`enhance` 方法 | **有（2 个）** | **无（0 个）** |

旧版 controller 里 `auto`/`enhance` **一律落到 `process()`**（Coze 图生图）。而沙箱真跑 `process()`：

```
抛错：API key is required. Set COZE_API_TOKEN   ← 耗时仅 33ms！
```

**这精确解释了「提示很快消失」**：`process()` 33ms 就失败 → 前端 toast 一闪 → `currentSrc` 回退原图 → **图片没变**。

### 三条「图片没变」的路径（真跑验证）

| 功能 | 原样返回/失败的条件 | 真跑结果 |
| --- | --- | --- |
| **去手写** `erase_v2` | 未检测到手写（`coverage ≤ 0.0001`）→ 原样返回；且 **VLM 失败降级色域阈值时检出率低**（实测 0.65%） | 真跑：VLM 失败→色域阈值→**差异仅 0.54%**（几乎没擦） |
| **自动调整** `straighten` | 无四角且自动检测未命中 → `needManual` → **原样返回** | 真跑：**真实场景图检测成功**（倾斜纸张→4 角→纠偏 711×1039）✅；纯色背景图则返回 null |
| **智能高清/兜底** `process` | 依赖外部 Coze AI；key 缺失/失效 → **抛错** | 真跑：**33ms 抛错** ← 与"提示很快消失"完全吻合 |

### 结论

1. **「提示很快消失 + 图片没变」的最可能原因：线上后端是旧版**（没有 `straighten`/`enhance`），`auto`/`enhance` 全走 `process()` 且 Coze 不可用 → 秒失败。
   → **必须把 `push-ready/server/src/` 部署上去**，并确认 `IMG_PIPELINE_MODE` 不是 `gen`。
2. **自动四角检测是好的**（真实场景图实测可用），旧版的"没反应"是**没有这条路由**。
3. **去手写的降级路径偏弱**：VLM 不可用时色域阈值检出率低 → 擦除效果不明显。这是**功能增强项**（见下节）。

### 待办（功能增强，非阻塞）

- [ ] **去手写**：VLM 不可用时的色域阈值算法偏弱（实测仅检出 0.65% 手写）。建议增强色彩/笔迹检测（如蓝色笔迹的色相分离），或确保 VLM 链路可用。
- [ ] **自动调整**：纯色/低对比背景图检测不到纸张边缘时会走 `needManual`；建议前端在该情况下给出更明确的引导（当前已弹 modal）。

---

## 三、部署验证清单（照做即可）

### 1. 后端（管问题 2）

- [ ] 把 `server/` 覆盖到仓库对应目录
- [ ] **检查线上环境变量**：`IMG_PIPELINE_MODE` **不要**设为 `gen`
  ```bash
  env | grep IMG_PIPELINE_MODE      # 期望：无输出，或 = hybrid / new
  ```
- [ ] 重新构建并重启：`pnpm build:server` → `npm run start:prod`

### 2. 前端（管问题 1）

- [ ] 把 `src/` 覆盖到仓库对应目录
- [ ] **重新构建**：`pnpm build:weapp`
- [ ] **验证新代码进了包**：`grep -o "1365" dist/pages/**/index.js | head`
- [ ] 微信开发者工具**重新上传体验版/正式版**（只改源码不上传 = 真机看不到）

### 3. 真机回归

- [ ] 旋转 90° ×4 → **保存** → 打开保存的图：四边完整
- [ ] 点「自动调整」→ 出结果（或提示手动拉四角）
- [ ] 点「智能高清」→ 选 x2 → 出结果
- [ ] 点「去手写」→ 出结果，非手写区域保持原样

---

## 四、变更文件清单

| 文件 | 变更 |
| --- | --- |
| `push-ready/src/components/image-editor.tsx` | **handleSave 统一判断（真根因修复）**；旋转/AI 后 `confirmed=true`；canvas 加固（固定 1365 方框、显式导出、去 rAF） |
| `push-ready/server/src/image/image.controller.ts` | `IMG_PIPELINE_MODE` 默认 `'gen'` → `'hybrid'` |
| `dynamic-tests/run-issue-save-crop.cjs` | **新增**（问题 1 真根因，15 断言） |
| `dynamic-tests/run-issue-rotate.cjs` | 重写（canvas 加固，15 断言） |
| `dynamic-tests/run-issue-pipeline-e2e.ts` | 新增（问题 2 端到端，14 断言） |
| `dynamic-tests/run-issue-rotate-pipeline.cjs` | 保留（问题 2 静态检查，7 断言） |
| `工程教训录.md` | 修正 **L7-补充**；新增 **L13**（改错目录）、**L14**（预览对≠保存对） |

**总回归**：241/241 passed（9 个测试文件）。
