# GK-DD-08 前端详细设计

> 编号：GK-DD-08 ｜ 版本：v0.0（提纲） ｜ 日期：2026-10-24 ｜ 状态：提纲待审
> 读者：前端 ｜ 上游：SRS-01、SRS-02、ADD-06 ｜ 下游：QA-15
> 定位：Taro 前端的结构说明 + **坑位地图**。缓存与性能细节引用 DD-13，接口契约引用 ADD-06，此处不重复。

---

## 1. 文档目的与读者

**要写**：本文讲"前端怎么实现"；交互规范看 SRS-02，接口看 ADD-06，缓存看 DD-13；三者冲突时以 SRS-02（交互）/ADD-06（契约）为准并回改本文。

## 2. 技术栈与构建

**要写**：
- Taro 4.1.9 + React 18；包管理**必须 pnpm**；
- 构建：`pnpm build:weapp`（约 30s），产物是仓库自己的 `dist/`，`project.config.json` 的 `miniprogramRoot` 指向 `./dist`；
- ⚠️ **commit ≠ 发货**：前端改完必须重建 dist，否则真机跑旧包。**交付前验证 dist 新鲜度**：`grep -c "特征串" dist/pages/<页>/index.js` + 首页「📦 包版本」角标 commit 是否等于最新 commit；随后开发者工具重新编译 + 真机调试**重新生成二维码并重新扫码**（旧码连旧会话）；
- ⚠️ 废弃副本 `D:/AI/Growing-Kids-miniapp` 勿再打开/同步/构建。
**素材**：项目记忆工程结构章节

## 3. 目录结构

**要写**：`pages/`（10 页）、`components/`（18 组件 + `ui/`）、`services/`（api / cache / net / auth / chat）、`utils/`（latex 等）、`lib/`（use-selection 等）、`types/`、`assets/`（仅 TabBar 图标），逐目录说明职责与准入条件。

## 4. 页面清单

**要写**：逐页表（页面 / 路径 / 职责 / 入参 / 主要状态 / 离开与返回行为）：
`index`（收件箱）、`subject`（学科与复习本）、`detail`（题目详情）、`recognize`（错题提取）、`library`（资料库）、`memory`（成长记忆）、`document`（文档导出）、`chat`（对话）、`profile`（账户）、`scan-login`（扫码登录）。
**待确认**：各页面对应的 TabBar 归属与入口（与 SRS-02 第 2 章保持一致）。

## 5. 组件清单

**要写**：18 个组件逐个：用途 / 主要 props / 被哪些页面复用 / 是否可跨页复用。重点展开：
- `question-card` / `review-item-card`：列表卡片（**必须渲染题面图**），「…」菜单项集合各页一致；
- `image-editor`：图片编辑与保存分流（kind=image 条目 vs 题面图）；
- `answer-editor` / `answer-sheet`：答案展示与填写；
- `math-symbol-bar` / `math-text` / `latex`：公式与符号；
- `material-picker`、`selection-bar`、`filter-header`、`range-picker`：通用交互件。
**素材**：`src/components/`

## 6. 状态管理与数据流

**要写**：
- 以局部 state 为主，**不引入全局状态库**（理由：项目规模与单人维护成本，见 ADD-04 ADR）；
- 跨页通信方式：URL 参数、缓存、事件；各自的适用与禁用场景；
- 数据流向：页面 → `services/api.ts` → 网络；缓存读写在 api 层收口（页面不直接碰缓存）。

## 7. 服务层

**要写**：
- `net.ts`：请求封装（统一 `/api` 前缀、**版本常量 `API_VERSION`**、超时、错误提示、鉴权头注入）；
- `api.ts`：所有业务接口 + **写后失效收口**（`invalidateAfter`，细节见 DD-13 第 3 章）；
- `cache.ts`：SWR 缓存（见 DD-13 第 2 章）；
- `auth.ts`：身份状态与三个切换点；
- `chat.ts`：对话流式处理；
- 打开/下载文件的统一入口（必须传 `file_key` 走代理）。
**素材**：`src/services/`

## 8. 缓存与数据加载

**要写**：只写页面侧用法（进入即读缓存、刷新回调、静默更新），机制引用 DD-13 第 2~5 章；并说明「写操作后必须 silent」的调用约定。

## 9. 列表滚动位置保持

**要写**：
- ScrollView 受控 `scrollTop` + ref 记录位置；
- `useDidShow` 单次恢复（避免每次返回都跳）；
- 从详情返回时用 `restoreItemIdRef` 按 id 锚回原条目；
- 与 DD-13 第 5 章 silent 刷新的配合关系（两套机制缺一不可）。
**素材**：`src/pages/subject/index.tsx`、`src/pages/index/index.tsx`

## 10. 数学公式与符号输入

**要写**：
- `utils/latex.ts`：零依赖实现（katex/temml 在 rich-text 环境不可用：无 svg、无伪元素、无字体）；渲染为 vlist 布局，根号用 `√` + border-top 近似；不支持时整行回退源码；
- **可读化双向转换**：`latexToReadable` / `readableToLatex`，编辑态**绝不显示 LaTeX 源码**；
  ⚠️ 已知易错点：`takeLastAtom` 正则必须认 `^{}`/`_{}`（否则 `\frac{x^2}{y_1}` 回转崩坏）、分数分母要吞紧随的上下标、`→` 后跟非字母原子时原样保留；
- `math-text.tsx`：无公式行走普通 Text，含公式行进 RichText；
- `math-symbol-bar.tsx`：四页签（常用符号 / 希腊字母 / 公式模板 / 常用序号），常用符号与希腊字母为网格排列、三行限高可上下滑动；插入位置跟随光标；
- 测试手法：latex.ts 保持零 import ⇒ 可 `npx tsc` 单编后用 node 跑用例。
**素材**：`src/utils/latex.ts`、`math-text.tsx`、`math-symbol-bar.tsx`

## 11. 图片编辑与保存链路

**要写**：
- 入口：列表点图片、详情页题面图/答案图/图片条目；
- 动作：裁剪 / 自动调正 / 智能高清 / 去手写 / 旋转 / 黑白；
- **保存分流**：kind=image 条目 → 原位替换该条目 file_key；题目条目 → 替换题面图（均**不新建条目**）；上传用 `attach` 语义（用 `save` 会重复建条目）；
- 删除图片：全量替换对应 key 数组（后端局部合并），只解引用不物理删文件。
**素材**：`image-editor.tsx`、`detail/index.tsx`、DD-12

## 12. 平台坑位清单

**要写**（每条：现象 / 根因 / 规避写法）：
- ⚠️ **`<Text>` 不绑 onClick**（Taro pure-text 处理会崩）⇒ 交互元素一律 `<View onClick>`，Text 只展示；
- ⚠️ **render 相位 setState 在小程序被丢弃**（曾导致弹窗空白）⇒ 副作用进 `useEffect` + `cancelled` 守卫；
- ⚠️ **首帧数据为 null** ⇒ 子组件必须 `{item && <Child/>}` 延迟挂载或内部可选链（详情页曾整页崩）；
- `downloadFile` 默认 60s 太久 ⇒ 显式 30s，失败兜底复制链接；
- 微信 UA 限制、域名校验、包体积、真机与模拟器差异。
**素材**：项目记忆前端约定章节

## 13. 性能与包体积

**要写**：主包限制、图片资源一律走对象存储（仅 TabBar 图标本地）、懒加载与分页；引用 DD-13 的性能基线。

## 变更记录

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v0.0 | 2026-10-24 | 建立提纲（待审） |
