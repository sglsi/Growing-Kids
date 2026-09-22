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

## 7. 导航结构
TabBar 三个页面：
- 首页 `pages/index/index`（House）：周报概览、学科入口、最近错题、拍照/相册识别主操作
- 错题本 `pages/subject/index`（NotebookPen）：学科 Tabs + 题目列表 + 搜索
- 文档 `pages/documents/index`（FileText）：按时间/学科导出 DOCX、周汇总报告
TabBar 页间跳转用 `switchTab`；详情/识别等普通页用 `navigateTo`。
图标：本地 PNG（src/assets/tabbar），未选 `#9A948A`、选中 `#BE3E2D`。

## 8. 状态展示
- 加载：Skeleton；空状态：线性图标 + 一句提示 + 主操作按钮
- 识别中：进度提示 + 分阶段文案；toast 反馈操作结果
- 列表底部留出 pb-24，避开任何固定栏

## 9. 小程序约束
- 图片资源走对象存储，仅 TabBar 图标本地存放；
- 打印/分享路径：后端生成 DOCX → TOS URL → 前端 downloadFile + openDocument（showMenu 可打印/转发）；
- 跨端：Taro 原生 Input/Textarea 用 View 包裹，样式放外层；平台差异做检测与 H5 降级。
