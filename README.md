# Growing-Kids（成长学习伙伴）

面向中小学生的错题巩固微信小程序：拍照收录错题 → 图像增强与 OCR 识别 → 题目归档与复习本 → 答案检索与导出。

> 技术底座：前端 Taro 4 + React 18 + TypeScript；后端 NestJS + Supabase（Postgres）对象存储；图像/OCR 为 Python 侧车（RapidOCR 常驻进程 + PP-StructureV3 服务）。

---

## 1. 仓库结构

```
Growing-Kids/
├── src/                 小程序前端（Taro）        → 10 个页面：index/recognize/subject/detail/library/memory/document/chat/profile/scan-login
├── server/              后端服务（NestJS）        → 24 个模块，全局路由前缀 /api
├── migrations/          数据库迁移 SQL（编号唯一，由 migrate.mjs 执行）
├── docs/
│   ├── design/          ★ 现行设计文档体系（19 份 GK 文档）
│   ├── reports/         专题技术报告：算法方法论、验证报告、调研纪要（22 份 + 样图）
│   ├── archive/         历史归档：一次性交付包说明、单次修复记录（只增不改）
│   └── install-ocr-env.*、ocr-sidecar-selfcheck.sh、补建缺失表-一键SQL.sql …（运维脚本）
└── 根目录若干历史设计稿  已加「已并入 GK-XX」标注，仅作决策凭据留档
```

## 2. 文档体系

**唯一索引**：[`docs/design/GK-00-设计文档总纲.md`](docs/design/GK-00-设计文档总纲.md)

编号规则 `GK-<类别码>-<序号>`，共 19 份：

| 层 | 编号 | 内容 |
|---|---|---|
| 总纲 | GK-00 | 设计文档总纲（名录 + 编制维护规范 + 进度跟踪） |
| L1 需求产品 | GK-SRS-01 ~ 03 | 需求规格 / 交互视觉规范 / 用户手册 |
| L2 架构概要 | GK-ADD-04 ~ 07 | 系统架构 / 数据库 / 接口规格 / 安全隐私 |
| L3 详细设计 | GK-DD-08 ~ 14 | 前端 / 后端 / 图像 OCR 管线 / AI 答案 / 存储生命周期 / 缓存性能 / 错题提取 |
| L4 质量工程 | GK-QA-15 ~ 17 | 测试策略 / 运维发布与故障处置 / 工程编码规范 |
| L5 项目运维 | GK-OPS-18 | 风险与技术债登记册 |

- 找现行规范 → `docs/design/`；找算法依据与验证数据 → `docs/reports/`；找历史决策过程 → `docs/archive/` 与带标注的根目录历史稿。
- 历史稿与 GK 文档冲突时，**一律以 GK 文档为准**（GK 文档以代码现状为基准编写）。

## 3. 常用命令

```bash
# 前端：构建小程序（改完前端必须跑，产出仓库自己的 dist/）
pnpm build:weapp

# 后端：编译 + 启动本地 3001（小程序联调固定端口，必须带 OCR 三件套环境变量）
cd server && npx nest build
cd server && OCR_VENV_DIR="D:/AI/gk-ocr-env/.venv-py" \
  PADDLE_PDX_CACHE_HOME="D:/AI/gk-ocr-env/.cache-paddlex" \
  XDG_CACHE_HOME="D:/AI/gk-ocr-env/.cache-xdg" node dist/main -p 3001

# 数据库迁移
node server/scripts/migrate.mjs --ping          # 探活
node server/scripts/migrate.mjs --dry           # 预演
node server/scripts/migrate.mjs                 # 执行
```

## 4. 开发纪律（要点，完整版见 GK-QA-17）

- **包管理器**：只用 `pnpm`，禁止 npm / yarn。
- **commit ≠ 发货**：改完前端必须 `pnpm build:weapp` 并核对 `dist/` 新鲜度，再去微信开发者工具重新编译。
- **改后端必须重编译 + 重启 3001**：旧进程常占端口导致 EADDRINUSE，重启前先 `netstat -ano | grep :3001` 找到 PID 杀掉。
- **数据隔离靠代码层 `.eq('user_id', userId)`**：RLS 未启用，这是唯一隔离手段。
- **密钥**：`.env` / `.env.secrets` 永不进 git；`WX_SECRET` 已随部署包暴露过，**正式发布前必须轮换**。

## 5. 当前状态

- 设计文档体系：19 份**提纲已完成**，正文编制中（进度见 GK-00 第 4 章进度跟踪表）。
- 后端：本地 3001 运行；生产拟迁移微信云托管（未备案域名不可作小程序 API 后端）。
