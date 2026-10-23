# GK-QA-17 工程与编码规范

> 编号：GK-QA-17 ｜ 版本：v0.0（提纲） ｜ 日期：2026-10-24 ｜ 状态：提纲待审
> 读者：全体（含 AI 协作者） ｜ 上游：ADD-04 ｜ 下游：无
> 定位：代码与协作纪律。**AI 协作者必须遵守本文**尤其第 9 章。本文升级自 `AGENTS.md`（后者并入后标注"已并入 QA-17"）。

---

## 1. 包管理与依赖

**要写**：**必须 pnpm**，禁止 npm / yarn；新增依赖前先确认是否真的需要；依赖安装位置纪律（隔离环境，不污染全局）；升级依赖后必须 tsc + build 验证。

## 2. 目录与命名

**要写**：
- 前端：`src/pages/<页面>/index.tsx`、`src/components/<kebab-case>.tsx`、`src/services/*`、`src/utils/*`、`src/lib/*`、`src/types/*`；仅 TabBar 图标可放 `src/assets/tabbar/`；
- 后端：`server/src/<业务域>/`，控制器 / 服务 / 类型分文件；
- 命名：组件与类型用 PascalCase，函数与变量 camelCase，文件 kebab-case；
- 新增目录/文件的准入条件（避免随手建文件导致结构腐化）。

## 3. 提交规范

**要写**：
- 提交信息格式：`<type>(<scope>): <主题>`，正文写"改了什么 / 为什么 / 影响面"；
- ⚠️ **按功能拆分 commit**：`git add A B` 容易把两类改动混进一个提交；
- **hunk 级拆分技法**（已验证可靠，第三次使用）：
  `git diff -U0 <file> > /tmp/all.patch` → awk 按 hunk 序号抽取（⚠️ `@@` 头也要按需打印，否则 patch corrupt）
  → `git apply --cached --unidiff-zero <patch>`；
  多特性文件的顺序：先提 1:1 替换类 hunk，新增类 hunk 在 commit 后重取 worktree-vs-index diff 拿校正行号再提；
- 提交前自检：`git status`、`git diff --stat` 确认没有多余文件混入。

## 4. 推送纪律

**要写**：本地 `git commit` 照常；**`git push` 等思傅明确指示**（思傅 2026-08-30 指定）；
origin 为 SSH（`git@github.com:...`），沙箱内推送用
`GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null" git push`；
推送后用 `git rev-list --count origin/main..HEAD` 与 `HEAD..origin/main` 双向校验（**不要用 `git rev-list --count A B`**，那是并集大小）。

## 5. 前后端约定

**要写**（全项目强制，违反即缺陷）：
- 前端路径必须带 `/api` 全局前缀；v2 起为 `/api/v2`（常量在 `net.ts`，禁止各 service 手写）；
- 前端禁止把 `undefined` 拼进 query；后端一律走 `cleanStr/cleanDate/cleanInt`；
- 所有查询与写入必须 `.eq('user_id', userId)`（RLS 未启用，这是唯一隔离手段）；
- 删除必须 `.select('id')` 并校验非空；
- 返回体含 `*_images` 的读端点必须过 `withUrls`；
- 写操作成功后必须失效缓存（见 DD-13 第 3 章）；
- 存储只存 `file_key`；打开/下载必须传 file_key 走代理。

## 6. 前端编码纪律

**要写**：
- `<View>` 绑交互，`<Text>` 只展示（Text 绑 onClick 会崩）；
- 副作用进 `useEffect`，带 `cancelled` 守卫（渲染相位 setState 会被丢弃）；
- 子组件对首帧 null 数据做守卫（延迟挂载或可选链）；
- `downloadFile` 显式 timeout 30s + 失败兜底；
- 可点击功能键字号 ≥ 12px；
- 浮层 z-index 必须 > 100；
- 编辑态绝不暴露 LaTeX 源码。

## 7. 后端编码纪律

**要写**：
- 删除/更新必须 `.select()` 校验；
- best-effort 分支的 catch 必须 `console.error` 打全错（静默吞错曾导致数据丢失无人知）；
- 新增读接口考虑是否接缓存 + 写后失效；
- 新增带 `updated_at` 的表后必须重跑 `0008_updated_at_trigger`；
- 迁移文件编号必须唯一、只增不改。

## 8. 仓库卫生

**要写**：
- ⚠️ 任何 1 万+ 文件的目录一律放仓库外（venv、模型缓存），否则微信开发者工具 EMFILE 编译必挂（node_modules 除外）；
- `.env*` 永不进 git；不把密钥贴进聊天/截图/文档（文档只登记密钥"位置"不写值）；
- ⚠️ 废弃副本 `D:/AI/Growing-Kids-miniapp` 不再打开、不再同步、不在其中构建；
- 文档只增不改地归档；新增文档按 GK-00 的编号与命名规则。

## 9. AI 协作边界

**要写**（AI 协作者必读）：
- **可自主决定**：按本文规范编码、跑测试与构建、修复明确 bug、更新设计文档对应章节；
- **必须询问**：产品口径与取舍、破坏性变更、删除数据或文件、推送到远端、密钥相关操作、涉及第三方配额的大批量调用；
- **禁止**：臆造接口或字段（一律以代码与 migrations 为准）、在文档里写密钥值、绕过构建校验直接宣称完成、推送代码；
- **交付前自检**：tsc → build → dist 特征串校验 → 需要时重启后端并验 health 时间戳 → 更新设计文档与项目记忆。

## 10. 文档同步纪律

**要写**：哪些改动必须同步更新哪些文档（架构/契约级改动 → ADD 系列；交互变动 → SRS-02；新坑 → OPS-18 + 本文第 6/7 章）。

## 变更记录

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v0.0 | 2026-10-24 | 建立提纲（待审） |
