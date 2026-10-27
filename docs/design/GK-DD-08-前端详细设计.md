# GK-DD-08 前端详细设计

> 编号：GK-DD-08 ｜ 版本：v1.0 ｜ 日期：2026-10-27 ｜ 状态：**正文完成**
> 读者：前端 ｜ 上游：SRS-01、SRS-02、ADD-06 ｜ 下游：QA-15
> 定位：Taro 前端的结构说明 + **坑位地图**。缓存与性能细节引用 DD-13，接口契约引用 ADD-06，此处不重复。

---

## 1. 文档目的与读者分工

本文讲"**前端怎么实现**"。三份文档的分工与冲突裁决：

| 文档 | 管什么 |
|---|---|
| **SRS-02** | 交互与视觉规范（应该长什么样、怎么交互） |
| **ADD-06** | 接口契约（前后端怎么对话） |
| **DD-13** | 缓存与性能机制（SWR / mem-cache / silent 刷新） |
| **本文** | 目录结构、页面与组件清单、状态与数据流、平台坑位 |

⚠️ **冲突裁决**：交互问题以 SRS-02 为准，契约问题以 ADD-06 为准，并回来改本文（代码先行、文档后随）。

---

## 2. 技术栈与构建

| 项 | 值 |
|---|---|
| 框架 | **Taro 4.1.9 + React 18** |
| 包管理 | **必须 pnpm**（混用 npm/yarn 会破坏 workspace 与 lock） |
| 构建 | `pnpm build:weapp`（约 30s）= `node scripts/gen-build-meta.mjs && pnpm exec taro build --type weapp` |
| 产物 | 仓库自己的 `dist/`；`project.config.json` 的 `miniprogramRoot` 指向 `./dist` |
| 图标库 | `lucide-react-taro` |
| UI 基础件 | `components/ui/`（shadcn 风格，49 个） |

### 2.1 ⚠️ commit ≠ 发货（交付前必做）

前端改完**必须重建 dist**，否则真机跑的是旧包。生效链：

```
pnpm build:weapp  →  开发者工具重新编译  →  真机调试「重新生成二维码并重新扫码」
```

（旧二维码连的是旧会话，扫了等于没更新。）

**验证 dist 新鲜度两步**：

1. `grep -c "特征串" dist/pages/<页>/index.js`（特征串 = 本次改动里的一个独有字符串）；
2. 首页底部「📦 包版本」角标 → 点击查看 `git：<commit>` 是否等于最新 commit。

`BUILD_META`（`src/build-meta.ts`，构建时由 `scripts/gen-build-meta.mjs` 生成，**勿手改**）提供 `commit` / `time` / `label` 三个字段，角标与弹窗都读它。

⚠️ 废弃副本 `D:/AI/Growing-Kids-miniapp` **勿再打开 / 同步 / 构建**。

---

## 3. 目录结构

```
src/
├── pages/          页面（10 个目录，13 个页面路径）
├── components/     业务组件 21 个 + ui/ 基础件 49 个
├── services/       api / auth / cache / chat / memory / net / types / wake
├── utils/          answer-merge / latex / privacy / url / use-caret
├── lib/            hooks/ measure / platform / theme / use-selection / utils
├── types/          全局类型
├── assets/         ⚠️ 只有 TabBar 图标（其余图片一律走对象存储）
├── shared/         auth-token 等前后端共用约定
├── build-meta.ts   构建时生成（勿手改）
└── app.config.ts / app.tsx / app.css
```

**准入条件（写新文件前先看放哪儿）**：

| 目录 | 放什么 | 不放什么 |
|---|---|---|
| `pages/` | 有路由、有页面配置的页面 | 复用组件 |
| `components/` | 被 ≥2 处复用、或体积大到必须拆的业务块 | 纯展示的基础件（放 `ui/`） |
| `components/ui/` | 无业务语义的基础件（button、dialog…） | 业务规则 |
| `services/` | 网络与身份，**唯一的后端出入口** | UI 逻辑 |
| `utils/` | 纯函数（无 React、无网络） | 有副作用的东西 |
| `lib/` | React hooks 与主题等运行时设施 | 纯函数（放 `utils/`） |
| `assets/` | **仅 TabBar 图标**（8 个 PNG） | 任何内容图片 |

---

## 4. 页面清单

TabBar 四项：首页 / 复习本 / 文档 / 记忆。

| 页面 | 路径 | TabBar | 职责 | 入参 | 离开/返回行为 |
|---|---|---|---|---|---|
| **index** | `pages/index/index` | ✅ 首页 | 统一收件箱（最近题目）：筛选、搜索、加复习本、删除、跳详情 | — | 从详情返回**按 id 锚回**原位 |
| **subject** | `pages/subject/index` | ✅ 复习本 | 复习本列表 + 学科管理 + 合成 PDF/Word 四选弹层 | — | 同上 |
| **document** | `pages/document/index` | ✅ 文档 | 导出物列表（docx/pdf）、导出打印、打开/分享 | — | 列表内操作 `silent` |
| **memory** | `pages/memory/index` | ✅ 记忆 | 成长记忆列表（分类/时间筛选） | — | 同上 |
| **detail** | `pages/detail/index` | — | 题目详情：题干/答案/解析编辑、图片管理、错因、AI 讲解 | `id` | 返回时写 `restoreItemIdRef` |
| **recognize** | `pages/recognize/index` | — | **错题提取主流程**（三种模式：整卷 / 分栏 / 文档） | — | 最大页面（2080 行） |
| **library** | `pages/library/index` | — | 资料库：上传/导入文档、选取作为答案附件 | — | — |
| **chat** | `pages/chat/index` | — | AI 对话（提问、追问） | — | — |
| **chat/admin** | `pages/chat/admin` | — | 知识库管理（受 `requireAdmin` 保护） | — | — |
| **memory/detail** | `pages/memory/detail` | — | 记忆详情 | `id` | — |
| **memory/edit** | `pages/memory/edit` | — | 记忆编辑（正文 + 媒体） | `id?` | — |
| **profile** | `pages/profile/index` | — | 账户：登录/登出、身份信息、配额、清空缓存 | — | — |
| **scan-login** | `pages/scan-login/index` | — | H5 扫码登录的手机端落地页（授权） | `token` | — |

⚠️ `recognize` 未挂在 TabBar，从首页「+」进入——这是刻意设计：错题提取是**重流程**，不该占一个常驻入口。

---

## 5. 组件清单

### 5.1 业务组件（21 个）

| 组件 | 用途 | 复用页 | 行数 |
|---|---|---|---|
| `image-editor` | **图片编辑主件**：裁剪 / 自动调正 / 智能高清 / 去手写 / 旋转 / 黑白 + 保存分流 | recognize、detail、index | **2814**（最大） |
| `answer-editor` | 答案编辑（附件：图/文档/文本） | detail | 525 |
| `wrongq-box-editor` | 错题框选编辑器（整卷/分栏模式的框叠加与调整） | recognize | 400 |
| `review-item-card` | 复习本列表卡片（**必须渲染题面图**） | subject | 300 |
| `wrongq-ocr-panel` | 识别结果面板（逐条校对） | recognize | 217 |
| `filter-header` | 筛选头（学科 / 标签 / 时间范围） | index、subject、library、memory | 207 |
| `math-symbol-bar` | 公式符号输入条（四个页签） | detail、recognize、memory/edit | 206 |
| `wrongq-text-panel` | 识别文本草稿面板 | recognize | 163 |
| `material-picker` | 资料库选取器（选作答案附件） | detail、recognize | 131 |
| `privacy-gate` | 隐私授权弹窗（全局，同意键是原生 button + `openType=agreePrivacyAuthorization`） | 全局 | 121 |
| `subject-picker-sheet` | 学科选择底部弹层 | detail、recognize、index | 83 |
| `range-picker` | 时间范围选择 | index、memory | 87 |
| `rename-dialog` | 重命名弹窗 | library、document | 82 |
| `answer-solution-editor` | **答案 + 解题过程合并编辑器**（详情页用） | detail | 77 |
| `math-text` | 公式文本渲染（无公式走 Text，含公式走 RichText） | 全局 | 66 |
| `selection-bar` | 多选操作条（含 `CheckDot` 复选点） | index、library、recognize | 63 |
| `answer-sheet` | 答题卡展示 | detail | 59 |
| `subject-badge` | 学科色标 | 全局 | 55 |
| `segmented-tabs` | 分段页签 | recognize、document | 45 |
| `memory-card` | 记忆卡片 | memory | 175 |
| `qr-login-modal` | 扫码登录弹窗（H5 侧） | — | 179 |
| `question-card` | 题目卡片（**转发壳**，实际逻辑在 review-item-card） | index | 12 |

### 5.2 三个必须展开的重点

**① 列表卡片（`review-item-card` / `question-card`）**

- **必须渲染题面图**——只显示题干文字会让"图片题目"看起来像空条目；
- 「…」菜单项集合**各页一致**：加/移出复习本、改学科、删除、导出；
- 卡片本身不持有写逻辑，通过回调交给页面（便于页面统一走 `silent` + `invalidateAfter`）。

**② `image-editor`：保存分流（易错）**

| 来源 | 保存行为 |
|---|---|
| `kind=image` 条目 | 原位替换该条目的 `file_key` |
| 题目条目 | 替换题面图（`content.question_images`） |

⚠️ **两者都不新建条目**；上传 purpose 用 **`attach`**——用 `save` 会重复建一条"最近题目"，首页同一题显示两行。

**③ `answer-solution-editor` + `utils/answer-merge.ts`**

详情页的答案与解题过程**合并为一个编辑框**：页面持唯一草案 `answerDraft`，保存时按行首「解析：」等小标题切回 `content.answer` / `content.solution`。

⚠️ **铁律：子组件不得持有第二份可编辑副本**——那正是"点了保存没存上"的根因。详见 12.4。

---

## 6. 状态管理与数据流

### 6.1 不引入全局状态库

**以局部 `useState` 为主**，不引入 Redux / Zustand / MobX。理由（ADD-04 ADR）：项目规模与单人维护成本下，全局状态库带来的收益小于其心智负担；跨页通信用下列三种轻量方式已够。

### 6.2 跨页通信方式

| 方式 | 适用 | 禁用 |
|---|---|---|
| **URL 参数** | 传 id、mode 等少量标量 | 传对象/数组（长度与转义都不可靠） |
| **缓存（SWR 域）** | 读数据的跨页共享 | 当作写通道（写必须走接口） |
| **ref + `useDidShow`** | 返回时恢复滚动位置 / 触发一次刷新 | 存放业务状态（页面销毁即失） |

### 6.3 数据流向（单向）

```
页面/组件  →  services/api.ts（唯一后端出入口）  →  Network.request
                     ↕
              services/cache.ts（SWR 缓存，api 层内部收口）
```

⚠️ **页面不直接碰缓存**：读缓存、写缓存、失效缓存全在 `api.ts` / `auth.ts` 里完成。页面只管调 API 与渲染——这是保证"失效不漏"的结构性前提。

---

## 7. 服务层（`src/services/`）

| 文件 | 职责 | 行数 |
|---|---|---|
| `api.ts` | **全量业务接口**（唯一后端出入口）+ `invalidateAfter` 写后失效收口 + `withTimeout` 超时包装 | 1648 |
| `auth.ts` | 身份状态与三个切换点（login / applyLoginUser / logout），切换必 `clearAllCache()` | 237 |
| `cache.ts` | SWR 缓存：key 结构、TTL、LRU、按域失效（详见 DD-13 第 2 章） | 139 |
| `net.ts` | 请求头构造（`buildHeaders` 注入三个身份头）、响应头捕获（`captureUserId`）、`openStorageFile` 打开文档 | 133 |
| `wake.ts` | 后端保活：探测失败自动唤醒并重放请求（配合 `wake-server`） | 119 |
| `memory.ts` | 成长记忆的本地草稿与媒体处理 | 288 |
| `chat.ts` | 对话流式处理 | 38 |
| `types.ts` | 服务层共享类型 | 18 |

### 7.1 `net.ts` 要点

- 统一 **`/api` 前缀**（后端 `setGlobalPrefix('api')`）；
- 身份头三件套：`X-Auth-Token`（服务端签发，**优先**）> `X-User-Id`（过渡兼容）> `X-Device-Id`（设备锚点）；
- `captureUserId(res)` 从响应头回捞 `X-User-Id` 与续签后的 `X-Auth-Token` 并覆盖本地 ⇒ 滑动不过期；
- ⚠️ **打开文档必须传 `file_key` 走代理** `/api/storage/files/{key}`：手机直连 Supabase 新加坡实测 60s 超时。失败兜底 = 复制公网 URL 到剪贴板。

### 7.2 上传要点

```ts
uploadFile(filePath, {
  purpose: 'save' | 'temp' | 'memory' | 'attach',   // ⚠️ 见 ADD-05 5.4 语义表
  archiveTo: 'library',                              // 可选：图片也归档到资料库
  fileName: '真实文件名.pdf',                        // ⚠️ 中文名必须走 formData.original_name
})
```

⚠️ **中文文件名**：微信 `uploadFile` 的 multipart filename 取的是临时路径名（`tmp_xxx.pdf`），后端拿不到真实名。必须走 `formData.original_name`（表单字段值 UTF-8 安全，不像 `Content-Disposition` 头会被按 latin1 读成乱码）。

⚠️ **客户端粗压**：上传前压到长边 ≤1600 / q80。服务端仍会 sharp 精压（权威压缩点），客户端压缩失败**不影响最终体积**。

---

## 8. 缓存与数据加载（页面侧用法）

机制见 DD-13 第 2~5 章，此处只写**页面侧调用约定**：

1. **进入即读缓存**：`useEffect` 里先 `cacheGet` 同步渲染首帧，再后台请求刷新；
2. **刷新回调**：请求成功后 `cacheSet` 回写；
3. **静默更新**：列表内写操作一律 `load({ silent: true })`；
4. 🔴 **写操作后必须 silent**：不 silent 会走骨架屏 → 滚动位置丢失（DD-13 第 5 章）。

---

## 9. 列表滚动位置保持

两套机制配合，**缺一不可**：

| 机制 | 治理场景 | 实现要点 |
|---|---|---|
| **silent 刷新** | 列表内操作（不跨页） | `load({ silent: true })`，见 DD-13 第 5 章 |
| **按 id 锚回** | 从详情页返回（跨页） | `restoreItemIdRef` + `useDidShow` 单次恢复 |

### 9.1 按 id 锚回的实现

```ts
const scrollRef = useRef(0)                 // onScroll 里持续记录当前位置
const [scrollTop, setScrollTop] = useState(0)
const restoreItemIdRef = useRef('')         // handleOpen 时写入当前条目 id
const restoredRef = useRef(false)           // 只恢复一次，避免每次返回都跳

// useDidShow：
if (!restoredRef.current && restoreItemIdRef.current) {
  pendingRestoreIdRef.current = restoreItemIdRef.current
  restoredRef.current = true
}
// 数据到位后：createSelectorQuery 量出该条目的 top，算出目标 scrollTop
```

⚠️ **Taro 受控 `scrollTop` 的坑**：值不变不触发滚动 ⇒ 必须先偏移再归位（先设一个不同的值，再设目标值）。

⚠️ **恢复判定只看 `restoreItemIdRef`**：列表内操作不写它 ⇒ 不会误滚。

---

## 10. 数学公式与符号输入

### 10.1 为什么自研（`utils/latex.ts`）

katex / temml 在小程序 rich-text 环境**不可用**：无 SVG、无伪元素、无自定义字体。因此自研零依赖实现：

- 渲染为 **vlist 布局**，根号用 `√` + `border-top` 近似；
- 不支持时**整行回退源码**（但编辑态绝不显示源码，见下）；
- 渲染出口组件：`math-text.tsx`——无公式行走普通 `Text`，含公式行进 `RichText`。

### 10.2 可读化双向转换

`latexToReadable` / `readableToLatex`：**编辑态绝不显示 LaTeX 源码**（家长看不懂 `\frac{x^2}{y_1}`）。

⚠️ 三个已知易错点（改前先跑用例）：

1. `takeLastAtom` 正则**必须认 `^{}` / `_{}`**，否则 `\frac{x^2}{y_1}` 回转崩坏；
2. 分数分母要**吞紧随的上下标**；
3. `→` 后跟非字母原子时**原样保留**。

⚠️ **不做全量回转**：`cases` / `aligned` 等复杂环境回转只能近似成纯文本。详情页保存时，**未改动的段沿用库里原 LaTeX**，只在用户改动处做可读↔LaTeX 转换（`utils/answer-merge.ts`）。

### 10.3 符号条（`math-symbol-bar.tsx`）

四个页签：常用符号 / 希腊字母 / 公式模板 / 常用序号。常用符号与希腊字母**网格排列、三行限高可上下滑动**；插入位置**跟随光标**。

⚠️ **光标位置只记 ref，绝不写进 state 再绑 `cursor`**——微信原生 textarea 收到 `cursor` 变化会重定位，输入法组词/回车场景给的位置不可靠（缺省 `-1` ≈ 定位末尾）。统一用 `utils/use-caret.ts`：仅程序化插入时 `request(pos)` 一次性定位。

### 10.4 测试手法

`latex.ts` 保持**零 import** ⇒ 可 `npx tsc` 单编后用 node 直接跑用例（不需要小程序环境）。

---

## 11. 图片编辑与保存链路

### 11.1 入口

列表点图片 / 详情页题面图 / 答案图 / `kind=image` 条目。

### 11.2 动作

裁剪 · 自动调正 · 智能高清 · 去手写 · 旋转 · 黑白（算法与管线见 DD-10）。

### 11.3 保存分流（易错，已在 5.2 展开）

| 来源 | 行为 |
|---|---|
| `kind=image` 条目 | 原位替换该条目 `file_key` |
| 题目条目 | 替换题面图 `content.question_images` |

均**不新建条目**；上传 purpose 用 `attach`。

### 11.4 删除图片

**全量替换对应 key 数组**（后端 `PUT /api/timeline/:id` 是局部合并 ⇒ 传新数组即删除），只**解引用**不物理删文件（物理删由 GC 依 `ref_count` 决定，见 ADD-05 第 9 章）。

---

## 12. 平台坑位清单

### 12.1 ⚠️ `<Text>` 不绑 `onClick`

Taro 的 pure-text 处理会崩。⇒ **交互元素一律 `<View onClick>`**，`Text` 只用于展示。

### 12.2 ⚠️ render 相位 setState 被丢弃

曾导致弹窗空白。⇒ 副作用必须进 `useEffect` + `cancelled` 守卫：

```ts
useEffect(() => {
  let cancelled = false
  load().then((d) => { if (!cancelled) setData(d) })
  return () => { cancelled = true }
}, [dep])
```

### 12.3 ⚠️ 首帧数据为 null

详情页曾整页崩。⇒ 子组件必须 `{item && <Child/>}` 延迟挂载，或内部全程可选链。

### 12.4 ⚠️ 光标跳末尾（详情页编辑）

**禁止在 `onInput` 里把光标写进 state 再绑 `cursor`**（见 10.3）。统一 `use-caret.ts`。

### 12.5 ⚠️ Textarea 默认 140 字截断

微信小程序 `textarea` **默认 maxlength = 140**，不显式给 `-1` 即静默截断。`components/ui/textarea.tsx` 已默认 `maxlength={-1}`；新增长文本输入无需再写，除非要限长。

### 12.6 ⚠️ `downloadFile` 默认 60s 太久

显式 `timeout: 30000`；失败兜底复制链接到剪贴板（比干等 60s 体验好，也便于诊断）。

### 12.7 其它

| 坑 | 处置 |
|---|---|
| 域名校验 | 生产必须在 mp 后台配 request 合法域名；`urlCheck:false` **仅开发** |
| ⚠️ 开发版豁免 ≠ 体验版豁免 | 三个断层（打包裁图标 / 隐私未声明 / 密钥）**首次真点「上传」时才集中爆发**，见 QA-16 第 4、7 章 |
| `packOptions.ignore` 不得忽略 `./assets` | TabBar 图标在 `dist/assets/tabbar/`；**只在上传/预览生效、编译无感** ⇒ 本地看不出来 |
| 包体积 | 主包 < 2MB；图片一律走对象存储，本地只留 TabBar 8 个 PNG |
| 真机与模拟器差异 | 后端域名 `PROJECT_DOMAIN=http://192.168.3.242:3001`（IP 变要改）；需同 Wi-Fi + 防火墙放行 3001 |
| 基础库 | libVersion **3.17.4 无需升级**（实证 3.14.0/2026-01、3.15.1/2026-03、3.16.0/2026-05），只做回归 |
| `src/` 下禁用 `process.env` | lint 规则 `no-restricted-syntax`；跨平台判断用 API 存在性检测（`lib/platform.ts`） |

---

## 13. 性能与包体积

- **主包限制 2MB**，当前 918 KB（2026-10-26）；
- **图片资源一律走对象存储**，本地 `assets/` 只有 TabBar 图标 8 个 PNG；
- 长列表分页 + `ScrollView`；列表图片用 `thumb_key`（WebP ≤400 宽）；
- 首屏走 SWR（0 网络等待）；
- 完整基线、优化记录与回归检查项见 **DD-13 第 1、8、9 章**。

---

## 变更记录

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v0.0 | 2026-10-24 | 建立提纲（待审） |
| v1.0 | 2026-10-27 | **正文完成**：技术栈与「commit ≠ 发货」验证两步、目录结构与准入条件、13 个页面清单（TabBar 归属与返回行为）、21 个业务组件清单与三个重点展开、状态管理与单向数据流、服务层逐文件职责与上传要点、滚动位置两套机制、公式自研与三个易错点、图片保存分流、平台坑位 7 条 + 其它 6 条 |
