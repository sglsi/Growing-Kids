# GK-QA-17 工程与编码规范

> 编号：GK-QA-17 ｜ 版本：v1.0 ｜ 日期：2026-10-27 ｜ 状态：**正文完成**
> 读者：全体（**含 AI 协作者**） ｜ 上游：ADD-04 ｜ 下游：无
> 定位：代码与协作纪律。🔴 **AI 协作者必须遵守本文，尤其第 9 章**。
> 本文升级自 `AGENTS.md`（后者保留过程记录与复盘，**冲突时以本文为准**并回写）。

---

## 1. 包管理与依赖

| 规则 | 说明 |
|---|---|
| 🔴 **必须 pnpm** | `package.json` 有 `preinstall: npx only-allow pnpm` 强制；**禁止 npm / yarn** |
| 新增依赖前先确认真的需要 | 每多一个依赖就多一份包体积与维护成本 |
| 依赖安装位置 | 隔离环境（venv、模型缓存）一律**放仓库外**，不污染全局（见第 8 章） |
| 升级后必须验证 | `pnpm tsc` + `pnpm build:weapp` 全绿 |

常用命令：

```bash
pnpm install                 # 安装（postinstall 会跑 weapp-tw patch）
pnpm validate                # lint + tsc 并行
pnpm build:weapp             # 构建小程序（含 gen-build-meta）
pnpm dev:weapp               # watch 模式
pnpm kill:all                # 清理所有开发进程
```

---

## 2. 目录与命名

### 2.1 目录约定

| 目录 | 放什么 | 准入条件 |
|---|---|---|
| `src/pages/<页面>/index.tsx` | 页面（有路由、有 `.config.ts`） | 需要在 `app.config.ts` 注册 |
| `src/components/<kebab-case>.tsx` | 业务组件 | 被 ≥2 处复用，或体积大到必须拆 |
| `src/components/ui/` | 基础件（49 个，shadcn 风格） | 无业务语义 |
| `src/services/` | 网络与身份 | **唯一的后端出入口** |
| `src/utils/` | 纯函数 | 无 React、无网络 |
| `src/lib/` | React hooks、主题、运行时设施 | — |
| `src/types/` | 全局类型 | — |
| `src/assets/tabbar/` | **仅** TabBar 图标 8 个 PNG | 其余图片一律走对象存储 |
| `server/src/<业务域>/` | 后端模块 | controller / service / types 分文件 |

### 2.2 命名

| 对象 | 风格 | 例 |
|---|---|---|
| 文件名 | kebab-case | `user-profile.tsx` |
| 组件 / 类型 / 接口 | PascalCase | `UserProfile` |
| 变量 / 函数 | camelCase | `getUserInfo` |
| 常量 | UPPER_SNAKE_CASE | `API_BASE_URL` |

### 2.3 组件库强制约束（lint 兜底）

🔴 **通用 UI 组件（按钮/输入框/弹窗/表单/菜单/卡片/Tabs/Toast/Skeleton…）必须优先用 `@/components/ui/*`**：

- 禁止用 `View` / `Text` + Tailwind 手搓；组件库缺失时**先补齐到 `src/components/ui/`** 再引用，不要在页面里临时造轮子；
- 页面级 ESLint 规则禁止直接从 `@tarojs/components` 导入 `Button` / `Input` / `Textarea` / `Label` / `Switch` / `Slider` / `Progress`；
- "赶时间"不是例外理由；`pnpm validate` 会报错。

---

## 3. 提交规范

### 3.1 格式

```
<type>(<scope>): <主题>

正文：改了什么 / 为什么 / 影响面
```

`type`：`feat` / `fix` / `style` / `refactor` / `docs` / `perf` / `test` / `chore` / `build`。

### 3.2 ⚠️ 按功能拆分 commit

`git add A B` 容易把两类改动混进一个提交——**一个提交只做一件事**。

**hunk 级拆分技法**（已验证可靠）：

```bash
git diff -U0 <file> > /tmp/all.patch
# awk 按 hunk 序号抽取 ⚠️ `@@` 头也要按需打印，否则 patch corrupt
git apply --cached --unidiff-zero <patch>
```

**多特性文件的顺序**：先提 1:1 替换类 hunk；新增类 hunk 在 commit 后重取 worktree-vs-index diff 拿校正行号再提。

### 3.3 提交前自检

```bash
git status --short        # 确认无多余文件混入（尤其 .env*、key/）
git diff --stat
pnpm validate             # lint + tsc
```

---

## 4. 推送纪律

🔴 **本地 `git commit` 照常；`git push` 等思傅明确指示**（思傅 2026-08-30 指定）。

origin 为 SSH（`git@github.com:...`）。沙箱内推送用：

```bash
GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null" git push
```

（沙箱写 `~/.ssh/known_hosts` 会被拒导致 `Host key verification failed`；绕开即可，无需提升权限。）

**推送后双向校验对齐**：

```bash
git rev-list --count origin/main..HEAD    # 本地领先，应为 0
git rev-list --count HEAD..origin/main    # 远端领先，应为 0
```

⚠️ **不要用 `git rev-list --count A B`**——那是并集大小，不是差异。

---

## 5. 前后端约定（违反即缺陷）

| # | 约定 |
|---|---|
| 1 | 前端路径必须带 **`/api`** 全局前缀；v2 起 `/api/v2`（常量在 `net.ts`，**禁止各 service 手写**） |
| 2 | 前端**禁止把 `undefined` 拼进 query**；后端一律走 `cleanStr` / `cleanDate` / `cleanInt` |
| 3 | 🔴 **所有查询与写入必须 `.eq('user_id', userId)`**（RLS 未启用，这是唯一隔离手段） |
| 4 | 🔴 **删除必须 `.select('id')` 并校验返回行数**（否则越权删除会"返回 200 但一行没删"） |
| 5 | **返回体含 `*_images` 的读端点必须过 `withUrls`** |
| 6 | **写操作成功后必须失效缓存**（见 DD-13 第 3 章） |
| 7 | 存储**只存 `file_key`**；打开/下载必须传 `file_key` 走代理 |
| 8 | 请求一律走 `Network.request`（**禁用 `Taro.request` / `uploadFile` / `downloadFile`**，lint 会拦） |
| 9 | 🔴 **`src/` 下禁止直接使用 `process.env`**（lint `no-restricted-syntax`；需要域名用全局注入的 `PROJECT_DOMAIN`） |

---

## 6. 前端编码纪律

| # | 纪律 | 原因 |
|---|---|---|
| 1 | `<View>` 绑交互，**`<Text>` 只展示** | Text 绑 onClick 会崩（Taro pure-text 处理） |
| 2 | 副作用进 `useEffect` + `cancelled` 守卫 | 渲染相位 setState 会被丢弃 |
| 3 | 子组件对首帧 null 数据做守卫（`{item && <Child/>}` 或可选链） | 详情页曾整页崩 |
| 4 | `downloadFile` 显式 `timeout: 30000` + 失败兜底复制链接 | 默认 60s 太久 |
| 5 | 可点击功能键字号 ≥ 12px | 小程序下限 |
| 6 | 浮层 z-index > 100 | 避免被悬浮保存条遮挡 |
| 7 | 🔴 **编辑态绝不暴露 LaTeX 源码** | 家长看不懂（见 DD-08 第 10 章） |
| 8 | 🔴 **光标位置只记 ref，绝不写进 state 再绑 `cursor`** | 微信原生 textarea 收到 cursor 变化会重定位；统一用 `utils/use-caret.ts` |
| 9 | 长文本输入无需再写 `maxlength`（`ui/textarea.tsx` 已默认 `-1`） | 微信 textarea **默认 140 字**，不显式给 `-1` 即静默截断 |
| 10 | 样式优先 Tailwind；**禁止硬编码 px**（`w-[340px]`、`style={{width:'200px'}}`） | Taro `pxtransform` 跨端单位转换，写 px 会不一致 |
| 11 | 禁止 Tailwind 任意值选择器里的 `[data-...]`、`~`、`[&>*]` | 会生成非法 WXSS 导致预览上传失败 |
| 12 | 列表内写操作一律 `load({ silent: true })` | 否则滚动位置丢失（DD-13 第 5 章） |

---

## 7. 后端编码纪律

| # | 纪律 | 原因 |
|---|---|---|
| 1 | 删除/更新必须 `.select()` 校验行数 | 见第 5 章第 4 条 |
| 2 | 🔴 **best-effort 分支的 catch 必须 `console.error` 打全错** | 静默吞错曾导致每次导出丢记录且无人知 |
| 3 | 新增读接口考虑接缓存 + 写后失效 | 见 DD-13 第 4 章 |
| 4 | 🔴 **新增带 `updated_at` 的表后必须重跑 `--force --only 0008_updated_at_trigger.sql`** | 该脚本只覆盖执行时已存在的表 |
| 5 | 迁移文件**编号必须唯一、只增不改** | 曾有两个 0003 导致拿错文件 |
| 6 | 新表外键 `user_id` 必须 `varchar(36)` | 写 `uuid` 报 42804 |
| 7 | 全局表写操作必须走 `requireAdmin()` | 知识库曾被任意篡改 |
| 8 | 日志不打印签名 URL / token / openid（`file_key` 可打） | 敏感信息 |

---

## 8. 仓库卫生

| # | 规则 |
|---|---|
| 1 | 🔴 **任何 1 万+ 文件的目录一律放仓库外**（venv、模型缓存）⇒ 否则微信开发者工具 **EMFILE** 编译必挂（`node_modules` 除外）。本项目 OCR venv 在仓库外 `D:/AI/gk-ocr-env/.venv-py` |
| 2 | 🔴 `.env*` **永不进 git**（`.gitignore` 已覆盖 `.env`、`.env.*`，仅 `!.env.example` 例外）；`key/` 已忽略 |
| 3 | **文档只登记密钥"位置"与轮换方式，绝不写值**；不把密钥贴进聊天/截图/工单 |
| 4 | 🔴 废弃副本 `D:/AI/Growing-Kids-miniapp` **不再打开 / 不再同步 / 不在其中构建** |
| 5 | 归档文档只增不改；新增文档按 GK-00 的编号与命名规则 |
| 6 | 新增环境变量**同步改 `.env.example`**，只写占位符 |
| 7 | 产物目录 `dist/` `dist-web/` 随构建覆盖；`packOptions.ignore` **不得忽略 `./assets`** |

---

## 9. 🔴 AI 协作边界（AI 协作者必读）

### 9.1 可自主决定

- 按本文规范编码；
- 跑测试与构建（`pnpm validate`、`pnpm build:weapp`、`tsc --noEmit`、`check:isolation`）；
- 修复明确 bug；
- 更新设计文档对应章节与项目记忆。

### 9.2 必须询问

| 事项 |
|---|
| 产品口径与取舍 |
| 破坏性变更 |
| **删除数据或文件** |
| **推送到远端** |
| 密钥相关操作（生成、轮换、读取实际值） |
| 涉及第三方配额的大批量调用（ima / LLM / 网盘） |

### 9.3 禁止

| 禁止项 | 说明 |
|---|---|
| **臆造接口或字段** | 一律以代码与 `migrations/` 为准 |
| 在文档里写密钥值 | 只写位置与轮换方式 |
| **绕过构建校验直接宣称完成** | 必须实跑 |
| **推送代码** | 等指示 |
| 为过检查而删检查 | 门禁豁免必须写清理由 |

### 9.4 交付前自检（按顺序）

```
1. tsc                          npx tsc --noEmit --skipLibCheck（前端）
                                cd server && npx tsc --noEmit --skipLibCheck -p tsconfig.json
2. build                        pnpm build:weapp
3. dist 特征串校验              grep -c "特征串" dist/pages/<页>/index.js
4. 重启后端并验 health 时间戳    curl --noproxy '*' http://127.0.0.1:3001/api/health
5. 更新设计文档与项目记忆
```

⚠️ **commit ≠ 发货**：前端必须重建 dist 并让开发者工具重新编译；真机调试**重新生成二维码并重新扫码**。

---

## 10. 文档同步纪律

| 改动类型 | 必须同步的文档 |
|---|---|
| 架构 / 契约级改动 | ADD-04（架构）、ADD-05（数据）、ADD-06（接口）、ADD-07（安全） |
| 交互 / 视觉变动 | SRS-02（+ 附录 C 视觉美学） |
| 前后端实现结构变动 | DD-08（前端）、DD-09（后端） |
| 缓存 / 性能机制变动 | DD-13 |
| 算法参数与阈值变动 | DD-10、DD-14 |
| 业务流程变动 | DD-14、SRS-03（用户手册） |
| **新踩的坑** | OPS-18（登记风险）+ 本文第 6 / 7 章（写成纪律） |
| 密钥位置 / 轮换方式变动 | ADD-07 第 4 章 |
| 发布 / 运维步骤变动 | QA-16 |

**原则**：**代码先行，文档后随**；以现状为真相，历史文档与代码冲突时以代码为准回写。

---

## 变更记录

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v0.0 | 2026-10-24 | 建立提纲（待审） |
| v1.0 | 2026-10-27 | **正文完成**：pnpm 纪律与常用命令、目录准入条件与命名、组件库强制约束（lint 兜底）、hunk 级 commit 拆分技法、推送纪律与双向校验、前后端 9 条约定、前端 12 条纪律（含光标 ref、maxlength、Tailwind 禁硬编码 px）、后端 8 条纪律、仓库卫生 7 条（含 EMFILE 与废弃副本）、AI 协作边界（可自主/必须询问/禁止/交付前自检 5 步）、文档同步对照表 |
