# GK-QA-16 运维、发布与故障处置手册

> 编号：GK-QA-16 ｜ 版本：v0.0（提纲） ｜ 日期：2026-10-24 ｜ 状态：提纲待审
> 读者：运维 / 开发 ｜ 上游：ADD-04、ADD-07、DD-09 ｜ 下游：无
> 定位：从本地到生产的路径 + 出问题时的第一本手册。**含原发布部署设计、运维手册、故障处置三份**。

---

## 1. 环境划分

**要写**：三套环境配置差异表（前端后端地址 / 数据库 / 存储 / 密钥来源 / 域名校验）：
| 环境 | 后端地址 | 说明 |
|---|---|---|
| 本地联调 | `http://192.168.3.242:3001`（`.env.local` 的 `PROJECT_DOMAIN`） | 真机需同 Wi-Fi + 防火墙放行 3001 + `urlCheck:false`；H5 端恒空串 |
| 体验版 | 同本地 或 云托管 | 每次需重新扫码 |
| 生产 | 微信云托管 `wx.cloud.callContainer` | 改造点见第 5 章 |
- ⚠️ 局域网 IP 变了必须改 `.env.local` 并重建前端。

## 2. 构建

**要写**：
- 前端：`pnpm build:weapp` ⇒ 产物 `dist/`；⚠️ **交付前必须校验 dist 新鲜度**（`grep -c "特征串" dist/pages/<页>/index.js` + 首页「📦 包版本」角标 commit = 最新 commit），否则真机跑旧包；
- 后端：`cd server && npx nest build`；
- 类型检查：前后端分别 `tsc --noEmit`（node_modules 噪音需过滤）。

## 3. 配置与密钥

**要写**：`.env` / `.env.secrets` / `.env.migrate` / `.env.local` 的分工；⚠️ **改了 `.env.secrets` 必须重跑 `node server/scripts/encrypt-env.mjs`**；密钥清单与轮换方式指向 ADD-07 第 4 章（**本文不写密钥值**）。

## 4. 小程序发布

**要写**：上传体验版、域名白名单（`mp-api.app.workbuddy.host` 由平台自动注册，第三方服务商绑定勿解绑）、`urlCheck` 生产必须开启、真机调试**必须重新生成二维码并重新扫码**（旧码连旧会话）、版本号与包版本角标。

## 5. 后端部署

**要写**：
- 当前：本地常驻（后台任务），仅用于联调；
- 生产目标：**微信云托管**，⚠️ 两硬约束与改造点：
  1. 不支持 Compose ⇒ NestJS 与 Python OCR 侧车必须打进**同一镜像**；
  2. `callContainer` 文本 ≤100KiB、超时 15s ⇒ 图片传输改走 `wx.cloud.uploadFile` 换 fileID；
- ⚠️ **`*.app.workbuddy.host` 不能当小程序 API 后端**（边缘网关拦 MicroMessenger UA + 无 ICP 备案），仅可用于浏览器/联调；
- 启动：`node dist/main`；容器 startCmd 覆盖为 `node scripts/decrypt-env.mjs && npm run start`。
**素材**：`docs/后端托管与小程序发布-调研纪要.md`、`迁移到腾讯云-方案与步骤.md`

## 6. 部署包脚本

**要写**：`deploy-pack.mjs pack|restore|status` 的流程（打包前后把 `.env.secrets` / `.env.migrate` / `.local-storage` / `logs` 挪到 `<项目根>/.deploy-staging/`）、`encrypt-env.mjs` / `decrypt-env.mjs` 的使用与边界（防包泄露与扫描器，防不住平台运维与定向攻击）。

## 7. 发布检查清单

**要写**：逐条可勾选，含 ⚠️ **轮换 `WX_SECRET`**、包内无明文密钥、`urlCheck` 已开、dist 新鲜度、后端 health 时间戳、关键链路冒烟（登录/录入/搜题/导出）、阻断项定义。

## 8. 回滚方案

**要写**：前端版本回退（重新构建上一 commit 的 dist）、后端镜像/进程回退、⚠️ **数据库迁移不可逆**（说明哪些操作无法回滚，以及"只增不改"的迁移纪律如何降低风险）。

## 9. 监控与日志

**要写**：健康检查端点、关键埋点清单（best-effort 分支必须打全错）、日志位置与轮转、当前无告警系统时的替代巡检方式。

## 10. 故障剧本

**要写**：逐条「现象 → 判据命令 → 根因 → 处置 → 预防」：
1. **Supabase IP 封锁导致全站 500** → 看错误特征 → `supabase-dns-pin.ts` 自愈重探，必要时手动触发；
2. **后端改了不生效** → `netstat -ano | grep :3001` 找 PID → `taskkill` → 重启 → 验 health 时间戳（⚠️ 后台任务停止后子进程仍占端口，新进程 EADDRINUSE 而 health 由旧进程应答）；
3. **前端改了真机没变** → 校验 dist 特征串 → 重新编译 → 重新扫码；
4. **OCR 侧车 9301 无监听** → 确认是设计行为（空闲 900s 回收、按需重启）而非故障；fast 走常驻进程不受影响；
5. **ima 配额打爆（220021）** → 专属文案、当日不再重试；
6. **真机连不上后端** → 检查 IP、防火墙、同 Wi-Fi、`.env.local` 是否重建；
7. **微信框架噪声日志**（`backgroundfetch privacy fail` errno 101）→ 与本项目无关，忽略；
8. **识别结果为空/异常** → 检查三 OCR 环境变量是否透传、venv 路径是否在仓库外。

## 11. 脚本清单

**要写**：逐个登记用途与可执行命令：`docs/install-ocr-env.ps1|sh`、`docs/ocr-sidecar-selfcheck.sh`、`docs/补建缺失表-一键SQL.sql`、`docs/获取DATABASE_URL-操作指引.md`、`server/scripts/migrate.mjs`、`deploy-pack.mjs`、`encrypt-env.mjs`。

## 变更记录

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v0.0 | 2026-10-24 | 建立提纲（待审） |
