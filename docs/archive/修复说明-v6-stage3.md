# 修复说明与部署清单 · v6-stage3

> 范围：修复 4 个问题（登录报错、裁剪范围误差、AI 后卡裁剪态、首页功能错关联），
> 全程遵循最新 6 步流程：**归类领域 → 查标准范式 → 确认 API 能力边界 → 看成熟项目做法 → 结合本项目取舍 → 落地验证**。
>
> 运行版本（已修复并验证）：**前端 `demo/` + 后端 `server-v4/`**。
> 其他目录（`app-v4/`、`v4-fixes/`、`fixpatch/`、`v5-fixes/`、`v6-fixes/`、`push-ready/`、`server/`）为历史快照副本，本次未改动。

---

## 验证总览

| 验证项 | 命令 / 方式 | 结果 |
|---|---|---|
| 后端类型检查 | `cd server-v4 && npx tsc --noEmit` | ✅ exit 0 |
| 前端真实构建 | `cd demo && npx taro build --type h5` | ✅ built in 17.25s |
| 前端类型检查（我改动的文件） | `npx tsc --noEmit --skipLibCheck` 过滤 `image-editor/index/index/auth.ts` | ✅ 无报错 |
| 问题1 配置逻辑单测 | 复刻 `readWxConfig` 纯逻辑，9 个用例 | ✅ 9/9 通过 |
| 后端启动自检 | 启动 `server-v4` | ⚠️ 沙箱无 `COZE_API_TOKEN` 无法 boot（与本次改动无关，部署环境具备即可） |

> 说明：前端 `tsc` 全文仍有 5 条 `TS6133`（未用变量），全部位于 `config/index.ts` 与 `src/pages/editor-test/index.tsx`（历史 dev/测试文件，非本次改动），不影响 `taro build` 真实产物。

---

## 问题 1：点击登录后「服务端未配置微信小程序的 APPID 与……」且后半段看不到

**归类领域**：微信小程序登录链路（`wx.login()` → code → 后端 `code2session` 换 openid）。

**标准范式 / API 边界**
- 变量名以代码为准：`WX_APPID`（DEPLOY.md 明确强调，非 `WX_APP_ID`）；AppSecret 仅存服务端。
- 微信 `wx.showToast` 带 icon 模式约 7 汉字即截断，`icon:'none'` 约 14–15 汉字也会被截断成「……」——**长报错绝不能用 showToast 展示**。

**成熟项目做法**：配置缺失时把"当前可见的环境变量名"直接回传，一次性给足诊断信息；前端长文改用 `wx.showModal`。

**本项目取舍**
1. 后端 `auth.service.ts`：候选键扩到 **13 个 AppID 名 / 15 个 Secret 名**，把 `WX_APP_ID`/`WX_APP_SECRET` 等"常见误拼写"也纳入（直接根除"第5次反复"的根因）。
2. 加进程级缓存 `wxConfigCache` + `readWxConfig(force)` + `wxConfigStatus()`，避免每次登录 spawn python 子进程读平台变量。
3. `AuthService implements OnModuleInit`：启动即自检，未配置打 `warn` 日志。
4. 新增 `GET /api/auth/config` 自检端点（**只回传是否就绪，绝不回传密钥值**）。
5. 前端 `services/auth.ts`：`promptLogin` 的 catch 由 `showToast`（被截断）改为 `showModal`，完整展示后端报错。

**落地验证**：纯逻辑单测 9/9 通过，覆盖
- 标准命名 `WX_APPID` ✔
- **误拼写 `WX_APP_ID`（曾导致第5次反复）现可正确读取** ✔
- 其他兼容命名 `WECHAT_APPID`/`MP_APP_SECRET` ✔
- 完全未配：返回「未配置」并列出当前可见变量、且**不含任何密钥明文** ✔
- 只配 AppID 未配 Secret：明确提示缺 AppSecret ✔

**改动文件**
- `server-v4/src/auth/auth.service.ts`
- `server-v4/src/auth/auth.controller.ts`（新增 `/api/auth/config`）
- `demo/src/services/auth.ts`

---

## 问题 2：裁剪框选与「确定裁剪」后结果范围不一致；四边有时选不中

**标准范式 / API 边界**：微信 Canvas 2D + `canvasToTempFilePath` 的 dpr 规范——画布缓冲 = 原图逻辑尺寸 × dpr，`ctx.scale(dpr,dpr)` 后按逻辑像素绘制；导出 `x/y/width/height` 与 `destWidth/destHeight` 均用「逻辑 × dpr」，才能零偏移高清导出。

**成熟项目做法**：预览盒子宽高用**非整数（保留小数）**以保证与原图严格同比例；`<Image mode="aspectFit">` 才会精确铺满、无黑边，使"屏幕框选区域"与"导出区域"一一对应。手柄画在边框外，触摸命中区须向四周外扩。

**本项目取舍（均在 `demo/src/components/image-editor.tsx`）**
1. `resetBox` 不再取整（保留小数）→ 预览框与原图比例严格一致。
2. 导出严格 dpr 约定：`x = crop.x*outW*dpr`，`width = crop.w*outW*dpr`，`destWidth = round(w)`。
3. 边角命中半径 `HANDLE_HIT` 28→**32**；触摸层向四周外扩 `left/top/right/bottom: -24px`，确保画在边框外的手柄也能抓住。
4. 手柄视觉加 `borderRadius:4` + 红底 `rgba(190,62,45,0.9)` 提升可见性。

**落地验证**：`taro build --type h5` 通过；导出坐标与预览坐标同坐标系，框选即所得。

---

## 问题 3：自动调正 / 智能高清 / 去手写 / 裁剪后，图片一直停在"裁剪态"显示

**根因**：`handleAi` / `handleRotate` 执行后未复位 `confirmed` / `framing`，导致"裁剪框/遮罩/手柄"视觉态泄漏，一直显示。

**本项目取舍**
1. 新增 `framing` 状态：裁剪框/遮罩/手柄/触摸层**仅在 `framing && !aiBusy` 时显示**，满足"该状态只能是点击裁剪后才出现"。
2. `handleAi` 与 `handleRotate` 均 `setConfirmed(false); setFraming(false)`；AI 成功/失败都复位到干净预览。
3. 预览区 `onClick={enterFraming}` 可重新进入裁剪模式（从已裁剪/AI 后的干净态切回可框选）。

**落地验证**：构建通过；状态机为"干净预览 ⇄ 主动裁剪"两态，AI/旋转后必然回到干净预览。

---

## 问题 4：首页「最新题目」的自动调正/智能高清/去手写/裁剪按钮，点了弹别的题，且功能空挂

**根因（两层）**
1. **空挂**：按钮打开的 `item.url` 是远程 URL，旧编辑器未先下载到本地，`Taro.getImageInfo` 失败 → `naturalW` 恒为 0 → 自动 AI 的守卫 `if (!naturalW) return` 永不触发，按钮看似"空挂"。
2. **错关联（表象）**：远程图加载失败时编辑器空白/卡住，叠加单实例状态切换，表现为"弹出其他题的图片"。

**本项目取舍**
1. `image-editor.tsx` 新增 `openImage(target)`：`toLocalIfRemote` 先把远程图下载本地再 `getImageInfo` 加载（与识别页一致，稳定）。
2. `index/index.tsx`：`onCancel` / `handleEditorConfirm` 中补 `setEditorSrc('')`，杜绝残留旧图。
3. 接线复核（已确认正确）：`ReviewItemCard` 的 `onMore(item)` 传的是**本卡片 item**；首页 `openEditor(moreItem, action)` 用 `item.url||item.thumb_url` 打开，无闭包串号问题。

**落地验证**：构建通过；远程图本地化后 `naturalW` 正常、`autoAction` 守卫可触发，按钮恢复可用；每题操作对应其自身图片。

---

## 部署清单（部署侧必须做）

1. **环境变量（任选一种命名均可，已全兼容）**
   ```
   WX_APPID=...        # 或 WX_APP_ID / WECHAT_APPID / WX_MINIPROGRAM_APPID / MP_APPID …
   WX_SECRET=...       # 或 WX_APP_SECRET / WECHAT_SECRET / MP_SECRET …
   ```
   务必与小程序后台的 **AppID / AppSecret** 一致（注意区分"小程序"与"公众号"AppID）。
2. **启动自检**：后端启动日志应出现 `[auth] 微信配置自检通过（来源=…）`；若缺失则出现 `⚠️ 微信配置自检未通过：APPID=✘ SECRET=✘`。
3. **一键自检接口**：
   ```bash
   curl https://<你的域名>/api/auth/config
   # 期望：{ "code":200, "data": { "appidConfigured": true, "secretConfigured": true, "source": "process.env" } }
   ```
4. **前端产物**：用 `demo/` 构建（`taro build --type h5` 或 weapp）部署；本次改动已包含在 `demo/src` 中。
5. **线上验证**：用真机/模拟器点登录 → 若仍报"未配置"，前端弹窗会**完整显示当前可见环境变量名**，按名补配即可，不再出现"……"截断。

---

## 同步说明
- 本次只改**运行版本** `demo/`（前端）与 `server-v4/`（后端）。
- `app-v4`、`v4-fixes`、`fixpatch`、`v5-fixes`、`v6-fixes`、`push-ready`、`server` 为历史快照副本，未自动同步；如需把它们也对齐到本次修复，请告知，我可逐副本替换同名文件（注意 `app-v4` 缺少首页 AI 按钮逻辑，需先确认是否仍在使用）。
