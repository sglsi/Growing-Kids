# 修复说明 · 旋转裁边 & 图像功能点了不能用

> **⭐ 第六轮修复（图像功能反馈闭环）**：
> 1. **新增能力自检端点** `GET /api/image/capabilities` —— 部署新版后端后，浏览器访问
>    `https://你的域名/api/image/capabilities`，返回 `{"code":200,...,"version":3}` 即为新版；
>    返回 404 = 线上仍是旧版（这就是此前多轮「不能用」的最可能原因，现在可一测便知）。
> 2. **AI/图像功能失败时弹窗显示完整错误**（HTTP 状态码 + 后端消息），并自动检测服务版本——
>    不再是一闪而过的 toast，用户截图即可反馈闭环。
> 3. **「更多」选错图已修**：编辑保存由「新建条目+软删旧条目」改为**原位替换**（PUT file_key），
>    条目位置不再变动，不会再打开别的题目的图。
> 4. **四角拉框后保存不再误裁**：quad 模式下保存直接用成品，绝不按无关的矩形内缩框裁剪。
> 说明：自动调正 / 智能高清 / 去手写均为**程序自有本地功能**（几何纠偏、超分锐化、手写检测修复），
> 不依赖外部 AI 服务；旧版后端缺失这些模块时会误落外部兜底而失败——用 capabilities 端点可立即验证。

> **⚠️ v3 紧急更正（2026-09-27 晚）**：v2 的「CSS 固定 1365 方框」方案被用户实测**证伪**——
> 裁剪跑飞（飞到框选范围之外）、旋转逐次放大（转一次放大一次）。
> 真根因：**微信 `canvasToTempFilePath` 的 x/y/width/height 是「CSS 显示尺寸」口径**，
> CSS(固定1365) ≠ 缓冲(动态) 时，传缓冲口径坐标被按 CSS 口径解释 → 区域错位 + 拉伸。
> v3 方案：**选区直接画满缓冲（九参 drawImage）+ CSS 同步为缓冲（轮询实测确认）+ 全区域导出**，
> 对坐标口径完全免疫（仿真验证：三种候选口径下输出全部正确，详见 `run-issue-crop-geom.cjs`）。
> 对应教训录：**L15**（CSS≠缓冲=一切错位的根源）、L14（预览对≠保存对）、L13（发布链）。

---

## 〇、v3 修复：裁剪跑飞 / 旋转逐次放大 / 四角拉框无确认按钮

### 1. 裁剪跑飞（「飞到框选范围之外，随意裁一块」）

| 版本 | 方案 | 实测结果 |
| --- | --- | --- |
| v1 | CSS 动态 + rAF 等布局 | 时序挂起 → 旋转四周被裁 |
| v2 | CSS 固定 1365 方框 + 按缓冲口径传区域 | **CSS 口径解释 → 错位跑飞**（仿真复现：只取到 56.3% 宽） |
| **v3** | **选区画满缓冲 + CSS=缓冲 + 全区域导出** | **三种口径仿真下输出全部正确** ✅ |

v3 关键改动（`drawAndExport` 重写）：
```ts
// 1) 缓冲 = 成品：九参 drawImage 把选区精确画满缓冲（Canvas 规范保证，数学零偏移）
ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH)
// 2) CSS 同步为缓冲（setCanvasCss + waitCanvasCss 轮询 boundingClientRect 实测确认）
// 3) 全区域导出：无论内部按 CSS / CSS×dpr / 缓冲哪种口径解释，都收敛到全缓冲
Taro.canvasToTempFilePath({ canvas, x: 0, y: 0, width: expW, height: expH,
                             destWidth: outW, destHeight: outH, ... })
```

### 2. 旋转逐次放大（「转一次放大一次」）

与 1 同根因：v2 每次旋转烘焙的输出被 CSS/缓冲失配拉伸，`getImageInfo` 读回更大尺寸 → 下次旋转基于更大图 → **累积放大**。
v3 下仿真验证：连续 4 次旋转 `1080×1920 → 1365×768 → 768×1365 → 1365×768 → 768×1365`，**尺寸稳定交替、面积从不增大**。

另加两道防御：
- **img 实际尺寸校正**：`drawImage` 源坐标以 `img.width/height`（实际文件）为准，state 漂移（EXIF/解码差异/竞态）时自动重算；
- **复合场景安全网**：`rot≠0 且裁剪` 时明确报错（运行时不会发生：旋转按钮会把旋转烘焙进图片再归零），宁可报错不出错图。

### 3. 四角拉框没有确认按钮

v2 的 quad 模式拉完四角**没有任何确认入口**（用户不知道下一步）。
v3：quad 模式下把「确定裁剪」按钮**替换为「确认四角」**（Check 图标 + 主色高亮），点击即带 `manual_corners` 提交「自动调正」做透视压平；切回矩形模式则恢复「确定裁剪」。引导文案同步更新：「拖动四个圆点框住试卷四角，拉完点『确认四角』」。

**四角拉框使用方法**：
1. 点底部「四角拉框」进入四角模式（按钮变主色，四个红点默认内缩 8%）；
2. 拖动四个圆点，分别对准**试卷/纸张的四个角**；
3. 点「确认四角」→ 自动提交后端做透视压平（100% 保真，不重画）；
4. 想放弃拉框就再点一次「四角拉框」切回矩形模式。

### 验证

- `dynamic-tests/run-issue-crop-geom.cjs` —— **40/40**：三种口径仿真全区域导出正确；反向复现 v2 跑飞（56.3%）；4 组图尺寸×crop 的映射数学；旋转 4 次无放大；源码一致性。
- `dynamic-tests/run-issue-rotate.cjs` —— **20/20**：几何复算 + 边界 + v3 源码断言。
- `dynamic-tests/run-issue-save-crop.cjs` —— **15/15**（保存链路状态机，不受本轮影响）。

---

## 一、问题 1：旋转 90° 后**保存的图**四周被裁（v2 已修复，v3 保留）

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

- [ ] 框选裁剪：拖框到图片某个明显位置（如题目角落）→「确定裁剪」→ 裁出的**就是框里的内容**（不跑飞）
- [ ] 旋转 90° ×4 → 图片尺寸稳定交替、**不逐次放大**、内容完整
- [ ] 旋转 1~2 次后**保存** → 打开保存的图：四边完整、内容与预览一致
- [ ] 点「四角拉框」→ 拖四个圆点对准纸张四角 → 点「确认四角」→ 出纠偏结果
- [ ] 点「自动调整」→ 出结果（或提示手动拉四角）
- [ ] 点「智能高清」→ 选 x2 → 出结果
- [ ] 点「去手写」→ 出结果，非手写区域保持原样

---

## 四、变更文件清单

| 文件 | 变更 |
| --- | --- |
| `push-ready/src/components/image-editor.tsx` | **v3：drawAndExport 重写**（选区画满缓冲 + CSS 同步缓冲 + 全区域导出）；waitCanvasCss 轮询确认；img 实际尺寸防御校正；quad 模式「确认四角」按钮；handleSave 统一判断（v2 修复保留） |
| `push-ready/server/src/image/image.controller.ts` | `IMG_PIPELINE_MODE` 默认 `'gen'` → `'hybrid'`（v2 修复保留） |
| `dynamic-tests/run-issue-crop-geom.cjs` | **新增（v3 核心）**：口径仿真 + 反向复现跑飞 + 映射数学 + 旋转无放大，40 断言 |
| `dynamic-tests/run-issue-rotate.cjs` | 重写（v3：CSS 动态同步断言，20 断言） |
| `dynamic-tests/run-issue-save-crop.cjs` | 保留（保存链路状态机，15 断言） |
| `dynamic-tests/run-issue-pipeline-e2e.ts` | 保留（问题 2 端到端，14 断言） |
| `dynamic-tests/run-issue-rotate-pipeline.cjs` | 保留（问题 2 静态检查，7 断言） |
| `工程教训录.md` | 新增 **L15**（CSS≠缓冲=一切错位的根源；连错两次的复盘） |

**本轮总回归**：见文末「五、回归汇总」。

---

## 五、回归汇总（v3，全绿）

| 测试 | 断言 | 覆盖 |
| --- | --- | --- |
| `run-issue-crop-geom.cjs` | 40 | 三种口径仿真、反向复现跑飞、映射数学、旋转无放大、v3 源码一致性 |
| `run-issue-rotate.cjs` | 20 | 旋转几何复算、边界、v3 源码一致性 |
| `run-issue-save-crop.cjs` | 15 | 保存链路状态机（五条路径 + 反向复现） |
| `run-issue-rotate-pipeline.cjs` | 7 | 问题 2 静态检查 |
| `run-issue-pipeline-e2e.ts` | 14 | 问题 2 路由分流 + 真跑 straighten |
| `run-issue-nochange-e2e.ts` | 8 | 三条「图片没变」路径真跑 |
| `run-issue-autodetect.ts` | 4 | 自动四角检测真跑 |
| **合计** | **108** | **全部通过** |

> 另有历史回归（识别/登录/PDF/配额/存储等）沿用 `dynamic-tests/` 其余脚本，本轮未触碰对应代码。

---

## 六、第七轮追加：三大自有功能的链路体检（另见 `issue-three-image-features.md`）

用户明确「去手写 / 自动调正 / 智能高清**都不是 AI 功能，是程序自有功能**」，
并要求系统检查实现途径、修复、验证。本轮真跑真实源码，暴露并修复 4 个缺陷：

| # | 缺陷 | 修复 |
| --- | --- | --- |
| ① | 自动调正唯一检测路径（找纸张外框）在**纸面占满画面**时恒不命中 → 100% 原样返回 | 新增 `image-deskew.ts`（文本行投影倾斜估计）作兜底 |
| ② | 去手写色域阈值只认彩色笔；**黑笔/铅笔覆盖率恒为 0** → 原样返回 | 新增 `maskFromDarkInk`，与色域 mask 取并集 |
| ③ | sharp `raw:{channels:1}` 操作后实为 **3 通道**，按单通道索引 → mask 纵向错位 | 新增 `alignMask()` 统一取通道 0（替换 8 处重复片段） |
| ④ | 三处「安全原样返回」分支前端一律当成功静默处理 → 用户零信息 | 后端带 `debug.notice`，前端弹窗告知 |

**量化效果**

- 自动调正：纸面占满画面的倾斜图 `needManual=false method=skew rotate=4.5° 置信 1.00`（修复前 `method=none`）
- 去手写：黑笔 0.00% → **2.70%**；铅笔 0.00% → **2.58%**；蓝笔 1.54% → 2.78%；
  三个反例（纯印刷 / 大号标题 / 整页手写）仍全部 0%（护栏守住）
- 智能高清：锐度相对纯放大 **+31.2%**，改动像素 4.25%

**回归**：新增 `dynamic-tests/run-issue-three-features.ts`（38 断言全绿）；
既有 10 个脚本共 212 断言保持全绿。

**教训录**：新增 **L18**（单一检测路径在最常见输入下恒不命中 = 功能等价于不存在）、
**L19**（sharp 单通道 raw 的通道陷阱）。
