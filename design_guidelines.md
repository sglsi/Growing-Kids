# 设计指南（错题巩固系统）

## 1. 品牌定位
面向中学生的错题巩固/强化系统。设计风格：纸感、安静、克制的"晚间自习错题本"。核心意象：米白纸张、墨黑钢笔、朱砂红批改、学科索引标签。

## 2. 配色方案（Tailwind / CSS 变量）
- 纸底 `bg-background`：`#FAF8F3`；墨字 `text-foreground`：`#2A2825`
- 卡片 `bg-card`（白）；主操作按钮：`bg-primary text-primary-foreground`（墨色）
- 朱砂批改色：变量 `--correct: #BE3E2D`，用法 `text-[var(--correct)]` / `bg-[var(--correct)]`，仅用于正确答案、关键标记
- 辅助纸区：`bg-muted`；弱文字：`text-muted-foreground`
- 边线：`border-border`（`#E4DED1`）；聚焦：朱砂红
- 语义色：destructive 沿用红色系；成功提示用 emerald-600

## 3. 学科索引色（固定映射，完整类名字符串）
语文 rose-600、数学 blue-600、英语 emerald-700、物理 cyan-600、化学 violet-600、生物 green-600、政治 red-700、历史 amber-600、地理 orange-700、其他 gray-500。
仅用于：学科标签胶囊、左侧色条、小圆点。每处只出现一处学科色。

## 4. 字体规范
- H1 页面标题：text-xl font-bold text-foreground
- 卡片标题/题干：text-base；正文：text-sm；辅助说明：text-xs text-muted-foreground
- 垂直排列的 Taro `Text` 必须加 `block`；行高放松（leading-relaxed）用于题干阅读

## 5. 间距系统
- 页面外边距：px-4；页面块间距：space-y-4 / gap-4
- 卡片内边距：p-4；列表项间距：divide + 卡片之间 mt-3
- 一律使用 Tailwind 预设间距，禁止任意值 px 尺寸

## 6. 组件使用原则（强制）
- 通用 UI 组件必须优先取自 `@/components/ui/*`：Button、Input、Textarea、Card、Badge、Tabs、Dialog、Select、Skeleton、Progress、Sonner/Toast、Separator、ScrollArea、Label、Field。
- 创建/重写页面前先拆分 UI 单元并映射到组件库；禁止用 View/Text 手搓按钮、输入框、卡片、标签、弹窗。
- 容器样式：rounded-2xl、细边框 border-border、极淡阴影（shadow-sm）或无阴影；纸片状。

## 7. 界面优化四项原则（强制 / 实施顺序）

按优先顺序：**易用性 → 美观性 → 简洁性 → 一致性**。每次界面改造都按此顺序审视与实施。

### 7.1 易用性（最高优先级）
让用户以最少的认知成本完成任务。规则：
- **主从分明**：每个入口页必须有 1 个主操作（视觉最强：`bg-primary`）+ ≤3 个次操作（紧凑 outline 按钮排成一行）。首页主操作 = 拍照识别；复习本主操作 = 扫描错题；document 主操作 = 生成报告。
- **流程可发现**：核心流程 3 步内可完成，不弹窗、不埋深。主操作给副文案说明用途（例：拍照/相册识别 → "拍下一道错题，自动整理"）。
- **错误友好**：失败用红色 toast + 一句原因 + 重试入口；空状态有"为什么空 + 下一步"两段文案与主操作按钮。
- **默认归类**：识别页 split / paper / doc 三种模式都有"默认归类学科"Picker，减少一次点击。
- **批量操作**：所有列表页（复习本 / 文档 / 资料库）支持批量选择，用统一的 `SelectionBar` + `CheckDot`。
- **新用户引导**：首页 / 文档 / 我的主操作需有副文案；首次空状态显示"导入/添加"按钮。

### 7.2 美观性
视觉节奏统一，留白克制。规则：
- **卡片化容器**：所有内容块用 `Card` 容器（`rounded-2xl border-border p-4`），禁止裸 `View 长条块。
- **数据卡片**：图标 + 大数字 + 小标签三段式（首页 `StatCard` / profile `MiniStat`）。
- **学科色克制**：学科色仅出现在学科胶囊圆点 / 标题左侧色条，每屏 ≤3 处。
- **图标系统化**：图标来自 `lucide-react-taro`，颜色用 `color` 属性（不是 `className` 上的 `text-*`），尺寸 16 / 18 / 20 三档。
- **避免任意值**：颜色 / 间距 / 圆角 / 边框全部用 Tailwind 预设类名，禁止 `w-[340px]` / `text-[14px]` / `p-[16px]`。
- **留白节奏**：页面块间距 `space-y-4`，卡片内 `p-4`，列表项之间 `gap-3`，禁止任意间距。

### 7.3 简洁性
去除冗余，让画面安静。规则：
- **学科胶囊不过度**：超过 4 个学科时换行而非挤压；"其他"折叠为下拉 chip。
- **次要按钮减半**：识别页 split 模式原本 8 个并列动作 → 改为题图 / 答图各 4 个分组（按 slot 内聚）。
- **TabBar 不超 4 段**：每个多 Tab 页面最多 3 段（汇总生成 / 我的文档 / …），资料库用图标按钮代替 Tab。
- **去除装饰性文案**：标题不要带括号补充说明（例：`共 X 条 · …` 拆到副标题或 tooltip）。
- **不展示未使用状态**：未用 useState 即不声明，避免冗余控制台提示；未使用 import 即删。

### 7.4 一致性
公用组件优先，保证跨页面统一。规则：
- **公用业务组件**（`src/components/*`，非 UI 库）：
  - `SubjectBadge`：学科胶囊（首页、复习本、document、profile、review-item-card 复用）。
  - `SegmentedTabs`：分段切换（识别 / document / subject 等多 Tab 页面复用）。
  - `SelectionBar`：批量选择状态条（首页、复习本、document、library 复用）。
  - `CheckDot`：选中圆点（review-item-card、document、library 复用）。
- **顶部 fixed 头**：背景 `bg-background`、底边线 `border-border`、左右内边距 `px-4`、高度一致；标题左侧 4px 学科色条可选。
- **底部 fixed 操作栏**：背景 `bg-background`、顶边线 `border-border`、内边距 `p-3`、避开 TabBar 用 `bottom: 50`，跨端固定写法见 `style` 跨端兼容表。
- **手搓禁止**：通用 UI（按钮、输入框、卡片、标签、弹窗、Tabs、Toast、分段切换）禁止用 View/Text 手搓，必须走 `@/components/ui/*` 或上述 4 个公用业务组件。
- **文案术语统一**：批量选择（不是"多选"）、错题本（不是"题目库"）、资料库（不是"文档库"）、默认归类（不是"自动分类"）。
- **错误与空状态术语统一**：空 = "暂无数据"，失败 = "识别失败，请重试"。

## 8. 导航结构
TabBar 三个页面：
- 首页 `pages/index/index`（House）：周报概览、学科入口、最近错题、拍照/相册识别主操作
- 错题本 `pages/subject/index`（NotebookPen）：学科 Tabs + 题目列表 + 搜索
- 文档 `pages/documents/index`（FileText）：按时间/学科导出 DOCX、周汇总报告
TabBar 页间跳转用 `switchTab`；详情/识别等普通页用 `navigateTo`。
图标：本地 PNG（src/assets/tabbar），未选 `#9A948A`、选中 `#BE3E2D`。

## 9. 状态展示
- 加载：Skeleton；空状态：线性图标 + 一句提示 + 主操作按钮
- 识别中：进度提示 + 分阶段文案；toast 反馈操作结果
- 列表底部留出 pb-24，避开任何固定栏

## 10. 小程序约束
- 图片资源走对象存储，仅 TabBar 图标本地存放；
- 打印/分享路径：后端生成 DOCX → TOS URL → 前端 downloadFile + openDocument（showMenu 可打印/转发）；
- 跨端：Taro 原生 Input/Textarea 用 View 包裹，样式放外层；平台差异做检测与 H5 降级。
