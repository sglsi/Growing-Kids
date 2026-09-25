# 前端改造交付说明（v4 · 统一 timeline + library + 匿名身份 + 微信登录）

> 依据：`server-v4/MIGRATION.md`（后端 §2 接口映射表）、`数据库重新设计-v4.md`（定稿）。
> 本目录 `app-v4/` 是按仓库 `sglsi/Growing-Kids` 的 `src/` 结构产出的**完整前端代码**，
> 可直接覆盖/新增到仓库 `src/` 下。未列出的文件保持原样不动。

---

## 1. 改动总览

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/types/index.ts` | ♻️ 重写 | 统一模型：`TimelineItem`(kind=image/question) / `LibraryDoc` / `DocItem` / `Overview` / `Paged<T>`；学科色板对齐后端 `red-500…gray-500`；新增 `formatTime/formatDate/truncate/itemStatus` |
| `src/services/api.ts` | ♻️ 重写 | 全接口按用户隔离；`X-User-Id` 自动捕获→持久化→后续携带；`questions/materials` → `timeline/library`；新增复习本、资料库、批量删 |
| `src/services/net.ts` | 🆕 | 身份头统一处理：`buildHeaders()` / `captureUserId()` / `getUserId()` / `openStorageFile()` / `isPdfFile()` |
| `src/services/auth.ts` | 🆕 | **微信登录服务**：`login()`(wx.login→/api/auth/login) / `logout()` / `fetchMe()` / `updateProfile()` / `promptLogin()` / 本地登录态读写 |
| `src/types/auth.ts` | 🆕 | 登录相关类型：`AuthUser` / `LoginResult` / `MigratedCount` / `AuthState` |
| `src/pages/profile/index.tsx` | 🆕 | **我的**（新页面）：登录/退出、昵称编辑、账号信息、数据概览 |
| `src/services/types.ts` | ♻️ 改写 | 兼容旧 import 路径，统一从 `@/types` 再导出 |
| `src/lib/use-selection.ts` | 🆕 | 长按进入多选、点选切换、退出清空 + `confirmDelete()`；导出 `formatTime` 等 |
| `src/components/review-item-card.tsx` | 🆕 | 图 / 题混排统一卡片（同时支持 kind=image 缩略图卡与 kind=question 题目卡） |
| `src/components/filter-header.tsx` | 🆕 | 学科 pill 横滚 + 关键词搜索（回车触发）+ 标签筛选 + 底部操作条 + 空状态卡 |
| `src/components/material-picker.tsx` | ♻️ 重写 | 底层改走 `GET /api/library`（旧 `fetchMaterials(type)` 已废弃） |
| `src/pages/index/index.tsx` | ♻️ 重写 | 首页：**顶部登录入口** + 统计卡（含复习本）+ 学科入口 + **统一收件箱**（图+题混排、批量删、加入复习本、图片预览） |
| `src/pages/subject/index.tsx` | ♻️ 重写 | **复习本**：`scope=review` + 学科/搜索/标签三筛 + 上拉分页(20/页) + 移出复习本 / 合成PDF / 删除 |
| `src/pages/library/index.tsx` | 🆕 | **资料库**（新页面）：外部 PDF/Word/TXT 列表、搜索、导入、软删 |
| `src/pages/detail/index.tsx` | ♻️ 重写 | 详情：题目态可编辑+联网搜题；**图片态**只读展示；加入/移出复习本；删除 |
| `src/pages/document/index.tsx` | ♻️ 改写 | 汇总生成（数据源改走 timeline）+ 我的文档 + 资料库入口 |
| `src/pages/recognize/index.tsx` | ♻️ 改写 | 文案改「保存到**最近题目**」；从资料库选文档；图片直存走 timeline |
| `src/app.config.ts` | ♻️ 改写 | 注册 `pages/library/index`、`pages/profile/index` |
| `src/components/question-card.tsx` | ⚠️ 废弃转发 | 保留一个转发导出指向 `review-item-card`，应用时可删除（见 §7） |

---

## 2. 接口映射（本前端实际调用 → 后端）

> 全部路径已与 `server-v4/src/**/*.controller.ts` 逐一比对，**26 个端点全部命中**。

| 前端方法 | 方法 + 路径 | 用途 |
|---|---|---|
| `fetchSubjects` | `GET /api/subjects` | 学科列表（空则后端自动铺默认学科） |
| `createSubject` / `updateSubject` / `deleteSubject` | `POST/PUT/DELETE /api/subjects[/:id]` | 学科增删改 |
| `fetchTimeline({scope:'recent'})` | `GET /api/timeline?scope=recent` | 统一收件箱（图+题，页 20） |
| `fetchTimeline({scope:'review'})` | `GET /api/timeline?scope=review` | **复习本**（支持 subject_id/tag/keyword） |
| `fetchTimelineDetail` | `GET /api/timeline/:id` | 单条详情 |
| `createTimeline` / `createQuestion` | `POST /api/timeline` | 新增（图片归档 / 题目） |
| `updateTimeline` / `updateQuestion` | `PUT /api/timeline/:id` | 更新（content 走 jsonb） |
| `deleteTimeline` / `batchDeleteTimeline` | `DELETE /api/timeline/:id` · `POST /api/timeline/batch-delete` | 软删 |
| `addToReviewBook` | `POST /api/timeline/review-book {ids}` | **加入复习本** |
| `removeFromReviewBook` | `DELETE /api/timeline/review-book {ids}` | **移出复习本** |
| `fetchOverview` | `GET /api/timeline/overview` | 首页统计（含 `review_total`） |
| `fetchLibrary` | `GET /api/library` | **资料库**列表 |
| `createLibraryDoc` | `POST /api/library` | 新增资料 |
| `deleteLibraryDoc` / `batchDeleteLibrary` | `DELETE /api/library/:id` · `POST /api/library/batch-delete` | 资料软删 |
| `uploadFile` | `POST /api/upload` | 图片→自动入 timeline(kind=image) 返回 `timeline_id`；文档→自动入 library 返回 `library_id` |
| `recognizePaper` / `recognizeSeparate` / `recognizeDocument` / `recognizePaperByUrl` / `recognizeDocumentByUrl` | `POST /api/ocr/*` | OCR 四类，未动 |
| `searchSolution` | `POST /api/search/solve` | 联网搜题 |
| `processImage` | `POST /api/image/process` | 自动调正 / 智能高清 / 去手写 |
| `exportDocument` | `POST /api/document/export` | 汇总导出 Word |
| `fetchDocuments` / `batchDeleteDocuments` / `deleteDocument` | `GET/POST/DELETE /api/documents*` | 我的文档 |
| `combineToPdf` | `POST /api/pdf/combine {ids}` | 图片合成 A4 PDF（ids 现指 timeline item id） |
| `login` | `POST /api/auth/login {code, anonymous_id?, nickname?, avatar_url?}` | **微信登录**（后端 code2session 换 openid + 迁移匿名数据） |
| `fetchMe` | `GET /api/auth/me` | **当前用户**（校验登录态有效性） |
| `updateProfile` | `PATCH /api/auth/profile` | **更新昵称/头像** |
| `logout` | `POST /api/auth/logout` | **退出登录**（服务端无状态） |

---

## 3. 匿名身份（X-User-Id）机制

后端在 `UserContextMiddleware` 里：**首次请求不带任何 header → 建匿名用户 → 响应头回传 `X-User-Id`**。
前端对接方式（已内建，无需业务代码关心）：

1. `net.buildHeaders()` 读取本地 `gk_user_id`（Taro storage），有则附加 `X-User-Id` 头；
2. 每次响应经 `captureUserId(res)` 解析响应头 `X-User-Id` 并写回本地；
3. 因此**首次请求匿名、后续请求自动续用同一身份**，用户全程无感知。

> ⚠️ 匿名数据后端保留 **1 天**（`maintenance` 每小时清理过期匿名用户及其对象存储文件）。
> 登录后匿名数据会自动迁移到正式账号（见 §3.1），1 天限制不再适用。

---

## 3.1 微信登录（v4 新增）

### 入口

- **首页顶部**：右上角头像/「登录」芯片。未登录点击 → 直接微信一键登录；已登录点击 → 进入「我的」。
- **我的页**（`pages/profile/index`）：完整登录/退出、昵称编辑、账号信息、数据概览。

### 前端调用链（`src/services/auth.ts`）

```
promptLogin()
  └─ login()
       ├─ wx.login()  → code                 # 只用 code，绝不直连 api.weixin.qq.com
       ├─ POST /api/auth/login {code, anonymous_id: 当前X-User-Id, ...profile}
       └─ setUserId(user.id) + 存本地登录态   # 身份切换到正式账号
```

### 关键点

- **AppSecret 绝不上前端**：微信官方禁止小程序直连 `api.weixin.qq.com`（不可加白 `request 合法域名`）。前端只 `wx.login()` 拿一次性 `code`，由后端 `code2session` 换 `openid`。
- **匿名数据自动迁移**：登录请求带上当前匿名 `user_id`（`anonymous_id`），后端把 `subjects / timeline_items / library_docs / documents` 四张表数据改挂到正式账号，并删除空壳匿名号。前端登录成功后 toast 提示迁移条数。
- **身份切换**：登录成功用后端返回的 `user.id` 覆盖本地 `gk_user_id`，此后所有请求自动带新身份。
- **退出**：清掉本地 `gk_user_id` 与登录态；下次请求自动获得新匿名身份（原正式数据保留在账号里，重新登录即恢复）。
- **登录态本地存储**：`gk_auth_state`（JSON：`{userId,nickname,avatarUrl,isAnonymous}`），供「我的」页秒开与顶部按钮态；每次进页会用 `GET /api/auth/me` 校验一次。
- **不需要拿到用户昵称/头像也能用**：`wx.getUserProfile` 已收紧，`login()` 的 `profile` 参数可选，用户可在「我的」页手动改昵称。

### 后端需配置

| 变量 | 说明 |
|---|---|
| `WX_APPID` | 微信小程序 AppID |
| `WX_SECRET` | 微信小程序 AppSecret（**仅服务端**） |

> 未配置时 `POST /api/auth/login` 返回 `400 服务端未配置 WX_APPID / WX_SECRET`。

---

## 3.2 H5 编译（用于浏览器预览 / 联调）

仓库本身已支持 H5（`@tarojs/plugin-platform-h5` + `dev:web`/`build:web` 脚本），
但 **Tailwind v4 样式在 H5 下会失效**，需按下面调整两处，否则页面能渲染 DOM 但布局全塌
（实测症状：CSS 里只有 1 条 `px-4` 规则）。

原因：`config/index.ts` 走的是 **postcss 链路**（`@tailwindcss/postcss`），而 Tailwind v4 的
`@source` 指令在该链路下**不生效**，扫不到 `src/**` 里的类名。

### 改法

```ts
// config/index.ts —— 换成官方 vite 插件（自带源码扫描）
// 小程序端仍用 weapp-tailwindcss，两者互不影响
import tailwindcss from '@tailwindcss/vite'

compiler: {
  type: 'vite',
  vitePlugins: [ tailwindcss() ],
},
```

```css
/* src/app.css —— H5 端入口替换 */
/* 小程序端原本是：@import url('weapp-tailwindcss'); */
@import 'tailwindcss';
@source '../../src';
```

依赖：`pnpm add -D @tailwindcss/vite`（v4.x）。

### utilities 不能分层（第三个必踩坑，最隐蔽）

**症状**：上面两步都做对了、类名也生成了，但 **flex 排列与 padding 全部失效**——
`.flex` 计算值是 `block`、`.px-4` 计算值是 `0px`，页面退化成「一堆竖着堆叠、没有内边距的块」，
看起来就像「设计/布局不对」，但其实是 CSS 被压掉了。

**定位过程**：往页面注入 `taro-view-core.flex{display:flex!important}` 后布局立刻恢复，
说明规则本身存在、只是被更高优先级的规则覆盖。

**根因**：Taro H5 在 `vendors.css` 里注入了一条**未分层**的全局 reset：

```css
* { margin: 0; padding: 0; }
```

而 `@import 'tailwindcss'` 会把 utilities 放进 `@layer utilities`。
CSS 层叠规则里 **未分层（unlayered）规则的优先级高于任何 `@layer` 内的规则**，
于是这条 reset 压过了所有 utilities，flex / padding / gap 统统归零。

**改法**：不要引入 `tailwindcss` 总入口，改为**分别导入三个子文件，并让 utilities 不分层**：

```css
/* src/app.css —— H5 端 */
/* theme / preflight 仍然分层（避免污染 Taro 自己的重置） */
@import 'tailwindcss/theme.css' layer(theme);
@import 'tailwindcss/preflight.css' layer(base);

/* ⚠️ utilities 故意不分层：
   Taro 的 reset（*{margin:0;padding:0}）是未分层规则，layer 内的规则会被它压过。
   去掉 layer() 后二者同为未分层，靠源码顺序 + specificity 正常生效。 */
@import 'tailwindcss/utilities.css';

@source '../../src';
```

验证方式（浏览器控制台）：

```js
// 修复前：block / 0px / 0px
// 修复后：flex  / 16px / 8px
getComputedStyle(document.querySelector('.flex-row')).display
getComputedStyle(document.querySelector('.px-4')).paddingLeft
getComputedStyle(document.querySelector('.gap-2')).gap
```

产物里应**搜不到** `@layer utilities{`。

### 尺寸基准（第二个必踩坑）

**症状**：样式生成正常，但 H5 下元素尺寸**完全不随视口缩放**，窄屏内容被"撑爆"、宽屏又显得拥挤。

**原因**：Tailwind v4 的长度 token 全是 **rem**（`--spacing: .25rem`、`--text-sm: .875rem`…），
而 Taro H5 的 `pxtransform` **只换算 px、不处理 rem**，所以尺寸恒为固定值。
小程序端没这问题：`weapp-tailwindcss` 会重新产出 `rpx`，由 Taro 正确换算。

**改法**：把尺寸 token 从 `rem` 改成 `vw`，直接按 750 设计稿映射到视口
（`1px(设计稿) = 100/750 vw = 0.13333vw`）。

```css
/* src/app.css —— 仅影响 H5；小程序端由 weapp-tailwindcss + rpx 处理 */
@theme {
  --spacing: 0.53333vw;       /* 原 0.25rem = 4px 设计稿 */

  --radius-sm:  0.53333vw;
  --radius-md:  0.8vw;
  --radius-lg:  1.06667vw;
  --radius-xl:  1.6vw;
  --radius-2xl: 2.13333vw;

  --text-xs:   1.6vw;         /* 12px 设计稿 */
  --text-sm:   1.86667vw;     /* 14px */
  --text-base: 2.13333vw;     /* 16px */
  --text-lg:   2.4vw;
  --text-xl:   2.66667vw;
  --text-2xl:  3.2vw;
}
```

> ⚠️ `@theme` **必须放在顶层**，不能嵌在 `@media` 里（Tailwind 不识别嵌套的 `@theme`）。

### 运行

```bash
pnpm build:web    # 产物 dist-web/
```

本地预览需要两个进程（仓库自带的 `devServer.proxy` 只在 dev 模式生效，
`build:web` 的静态产物要用一个带 `/api` 反代的静态服务）：

```bash
node /workspace/demo-run/static-with-proxy.mjs   # 单端口 :5000 同时托管 dist-web/ 并反代 /api → :3000
```

> **注**：`Taro.login()` 在浏览器里没有微信客户端，会直接失败——H5 端**无法验证真实微信登录**，
> 登录/迁移路径请用真机或微信开发者工具验证。若要在 H5 下点通登录链路做演示，可临时覆盖
> `Taro.login` 返回一个假 code（仅供本地演示，**不要提交进仓库**）。

### H5 与小程序端的已知差异（不影响小程序）

| 现象 | 原因 | 处理 |
|---|---|---|
| 页面内 `position:fixed; top:0` 的固定头部被 H5 内置导航栏（44px）盖住 | Taro H5 会额外渲染一个内置 navbar；小程序端无此导航栏，故页面内 `top:0` 就是真正的顶部 | 已在 `demo` 里用 `body.h5-navbar-visible` 前缀的 CSS 补偿（见下），**不进 app-v4** |
| 内容区首屏被导航栏吃掉 | 页面用内联 `paddingTop`（如 `168`/`110`/`84`）顶开固定头部，H5 下需再叠加 44px | 同上，按值覆盖 |
| ~~卡片内标签文字轻微重叠~~ | 实为上一节「utilities 被未分层 reset 压掉」的连带现象 | **已随 utilities 修复一并消失**，非渲染层差异 |

> 这些是 H5 专属的渲染管线差异，**小程序（weapp）端不存在**，因此交付代码 `app-v4/src` 里
> **不加任何 H5 hack**；只在 `/workspace/demo`（本地演示工程）里用 CSS 补偿。

补偿写法（仅 demo，注意两点：① `pxtransform` 会缩放 px，故用 `vw`；② 不要用
`:not([style*="bottom"])`，`border-bottom` 里也含 `bottom`）：

```css
/* 44px(navbar) / 750(设计稿) * 100 = 5.8667vw */
body.h5-navbar-visible .taro_page taro-view-core[style*="position: fixed"][style*="top: 0px"] {
  top: 5.8667vw !important;
}
/* 内容区按各自内联 paddingTop 叠加 44px */
body.h5-navbar-visible .taro_scroll_view_core[style*="padding-top: 168px"] {
  padding-top: 28.26667vw !important;   /* (44+168)/750*100 */
}
```

---

## 4. 应用步骤

1. **覆盖前端**：把本 `app-v4/src/**` 覆盖到仓库 `src/**`。
2. **删除旧文件**：`rm src/components/question-card.tsx`（已无引用）。
3. **确认后端已部署**：先完成 `server-v4` 的建表 + 后端覆盖（见其 MIGRATION.md §3）。
4. **构建校验**：在仓库根目录执行
   ```bash
   pnpm tsc        # 类型检查（应 0 error）
   pnpm lint:build # eslint --max-warnings=0
   pnpm build:weapp
   ```
5. **真机联调**（关键路径）：
   - 首次打开首页 → Network 面板确认响应头有 `X-User-Id`，且本地 storage 出现 `gk_user_id`
   - 拍照识别 → 保存 → 首页「最近题目」出现该题
   - 长按题目 → 加入复习本 → 「复习本」tab 能查到
   - 导入 PDF → 「资料库」出现；选多张图 → 合成 PDF → 「文档」出现
   - 杀掉小程序重进 → 数据仍在（同 `gk_user_id`）
  - **匿名建几条题 → 首页右上角登录 → toast 提示「已同步 N 条」→ 「最近题目」数据仍在（迁移成功）**
  - **「我的」页 → 编辑昵称 → 保存 → 首页顶部显示新昵称**
  - **「我的」页 → 退出登录 → 身份回到匿名（顶部显示「登录」）**
- **真机登录前置**：小程序后台配置 `WX_APPID`/`WX_SECRET` 到服务端环境变量；确认 `api.weixin.qq.com` 无需加白（服务端调用不受小程序域名限制）。

---

## 5. 校验清单

- [ ] `pnpm tsc` 0 error（本目录已用等价的独立类型检查验证：**0 error**）
- [ ] 无未使用导入（本目录已用脚本验证：**OK**）
- [ ] 26 个前端端点 ↔ 后端控制器逐一对应（已比对）
- [ ] 首页 / 复习本 / 资料库 / 文档 / 详情 / 我的 六页均能拉到数据
- [ ] 加入 / 移出复习本闭环可用
- [ ] 微信登录闭环可用（登录 → 匿名数据迁移 → 退出 → 回到匿名）
- [ ] 换一个 `X-User-Id` → 数据互不可见（多租户隔离）

> **已完成的离线验证**（沙箱内，非真机）：
> - H5 编译通过（716 modules）→ 首页 / 复习本 / 资料库 / 文档 / 我的 五页渲染正常
> - **布局与原版一致**：`.flex-row`→`flex`、`.px-4`→`16px`、`.p-4`→`16px`、`.gap-2`→`8px`（逐项 `getComputedStyle` 验证）
> - **固定头部不再被 H5 导航栏遮挡**：`headerTop = 44px`（=navbar 高度），首行内容 `top = 56px`
> - 匿名自动建号 + `X-User-Id` 回传 + 多租户隔离：通过
> - 登录 + 匿名数据迁移：通过（8 条记录迁移 / 旧身份清除 / 重复登录幂等）
> - 截图与验证脚本见 `/workspace/demo-screenshots/`、`/workspace/demo-run/`

---

## 6. 回滚

- 前端：`git revert` 到改造前 commit；或从 git 恢复 `src/components/question-card.tsx` 等旧文件。
- 与后端改造相互独立，前端接口层集中在 `src/services/api.ts`，回滚只需还原该文件 + 各页面。

---

## 7. 本目录的额外文件（不要复制进仓库）

| 路径 | 说明 |
|---|---|
| `local-check/types/deps.d.ts` | 沙箱内**本地类型检查专用**的依赖声明桩（`@tarojs/*`、`react`、`lucide-react-taro` 等）。仓库已装真实依赖，**不要复制** |
| `local-check/types/global.d.ts` | 检查桩：`PROJECT_DOMAIN` / `defineAppConfig` |
| `local-check/src/lib/utils.ts` | 检查桩：`cn()`（仓库已有真实实现） |
| `local-check/tsconfig.json` | 沙箱本地检查用 tsconfig（**不要复制**） |
| `scripts/check-unused.mjs` | 未使用导入自检脚本（可选保留，无害） |

> 校验方式：把 `local-check/types/**` 与 `local-check/src/lib/utils.ts` 临时放回，配一份 `tsconfig.json`
> （`paths: { "@/*": ["src/*"] }`，`types: []`）即可离线跑 `tsc --noEmit`。仓库内直接 `pnpm tsc` 更准。

---

## 8. 建议删除的旧文件

```bash
# v4 已无引用
rm src/components/question-card.tsx   # 被 review-item-card 取代（本包已附废弃转发，删了更干净）
```

> `src/services/api.ts` 中保留了少量**兼容包装**（`fetchQuestions` / `createQuestion` / `updateQuestion` /
> `deleteQuestion` / `fetchMaterials` / `saveQuestionAsImage`），它们内部已全部改走 v4 新接口。
> 若确认无历史调用，可一并删除以精简。
