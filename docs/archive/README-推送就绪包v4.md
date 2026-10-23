# 推送就绪包（v4）

这个目录是**已经组装好、可直接覆盖到仓库的文件集**，只等一条能写入的通道。

## 为什么还没推上去

两条独立的阻断，都在我的权限/网络之外：

| # | 阻断 | 证据 |
|---|---|---|
| 1 | **GitHub 连接器是只读的** | 建分支 / 写文件均返回 `403 Resource not accessible by integration`。`gh auth status` 显示未登录，环境里也没有任何 GitHub token |
| 2 | **沙箱出网 TLS 被拦** | `git ls-remote https://github.com/...` → `gnutls_handshake() failed`；`curl https://api.github.com` → `SSL_ERROR_SYSCALL`（连接被重置）。这也是本任务最初 `git clone` 失败的原因 |

结论：**不是没准备好，是通道不通**。读取能走连接器，写入不能。

## 目录内容

```
push-ready/
├── src/                  # → 覆盖仓库 src/
├── server/               # → 覆盖仓库 server/（已排除 src/storage，保留仓库既有实现）
├── migrations/           # → 新建 migrations/
│   ├── 0001_review_book.sql
│   └── 0002_fresh_schema.sql
├── docs/                 # → 新建 docs/
│   └── 数据库重新设计-v4.md
├── MIGRATION-frontend.md # 前端落地说明
└── MIGRATION-server.md   # 后端落地说明
```

共 83 个文件。

## 怎么用

### 方式 A：连接器恢复写权限后（推荐）

告诉我一声，我用连接器直接提交，无需你操作。

### 方式 B：在你本机执行

```bash
# 1) 取到本目录（从沙箱下载 / 或复制到本机）
# 2) 在仓库根目录执行覆盖
cd /path/to/Growing-Kids

git checkout -b feat/v4-unified-timeline

# 前端
cp -r /path/to/push-ready/src/.        ./src/

# 后端（注意：不要覆盖 src/storage）
cp -r /path/to/push-ready/server/src/. ./server/src/
cp    /path/to/push-ready/server/package.json \
      /path/to/push-ready/server/tsconfig.json \
      /path/to/push-ready/server/nest-cli.json ./server/
cp -r /path/to/push-ready/server/types/. ./server/types/

# 迁移与文档
mkdir -p migrations docs
cp /path/to/push-ready/migrations/*.sql ./migrations/
cp /path/to/push-ready/docs/*.md        ./docs/

git add -A
git commit -m "feat(v4): 统一 timeline 模型 + 资料库 + 匿名身份 + 微信登录"
git push -u origin feat/v4-unified-timeline
```

### 方式 C：用本仓库里的 git bundle

同目录下的 `v4.bundle` 是一个自包含的 git 仓库快照，可直接拉取：

```bash
git remote add v4 /path/to/v4.bundle
git fetch v4
git checkout -b feat/v4-unified-timeline v4/main
git push -u origin feat/v4-unified-timeline
```

## 落地后必做

1. **执行 SQL 迁移**：先跑 `migrations/0002_fresh_schema.sql`（v4 全新表结构）。
2. **配置环境变量**（`server/.env`）：`WX_APP_ID` / `WX_APP_SECRET` / Supabase 连接信息。
3. **校验**：
   ```bash
   pnpm tsc          # 类型检查，应 0 error
   pnpm lint:build   # eslint --max-warnings=0
   pnpm build:weapp
   ```
4. **真机联调**关键路径见 `MIGRATION-frontend.md` §4。

## 已完成的离线验证

在沙箱内用 H5 构建 + 本地 Mock 后端验证过（非真机）：

- H5 编译通过（717 modules，exit=0）
- 五页渲染与原版设计 1:1 对齐（`.flex-row`→flex、`.px-4`→16px 等逐项实测）
- 匿名自动建号 → `X-User-Id` 回传 → 多租户隔离：8 项全过
- 微信登录 + 匿名数据迁移：通过（8 条记录迁移 / 旧身份清除 / 重复登录幂等）

> 注意：`src/storage/` 未包含在内。它属于仓库既有实现，`server-v4` 的判断是沿用而非重写；
> 若你的 v4 需要改存储层，请单独确认后再动。
