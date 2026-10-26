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

### 4.1 为什么「开发者工具里一切正常」不等于「能发布」

当前项目长期处于**开发态**：`urlCheck:false` + 局域网 IP。按微信官方规则，开发者工具关闭域名校验后，
模拟器与「真机调试」可请求任意 http 地址，**合法域名白名单与备案规则不生效**——这是开发阶段的正式豁免。
因此下面三个断层一直被豁免掩盖，**第一次真正点「上传」时才会集中爆发**（2026-10-26 首次发布前体检发现）：

| 断层 | 开发态表现 | 体验版/正式版表现 |
|---|---|---|
| 打包裁剪误删 TabBar 图标 | 无感知（编译不过 packOptions 过滤） | 底部导航图标全空 |
| 未配置用户隐私保护指引 | 无感知（开发版豁免） | `chooseMedia` 直接失败 |
| AppSecret 泄露风险 + 无上传私钥 | 无感知 | 提审前必纠，CI 无法上传 |

> 判断依据记住两句话：**①packOptions 只在「上传/预览」打包时生效；②开发版豁免 ≠ 体验版豁免。**

### 4.2 上传前三个必做的前置校验

1. **TabBar 图标必须进包**
   - 判据：`project.config.json` **不得**存在 `packOptions.ignore` 命中 `./assets`
     （TabBar 图标位于 `dist/assets/tabbar/*.png`，微信小程序强制要求本地 PNG）。
   - 现状：2026-10-26 已删除该 ignore 条目（根与 `dist/` 两份配置同步）。
   - 验收：开发者工具「上传」→ 代码包详情页里 `assets/tabbar/` 的 8 个 PNG 在列。
2. **隐私保护指引（`src/app.config.ts` 的 `__usePrivacyCheck__: true`）**
   - 代码侧已完成：`utils/privacy.ts`（全局 `onNeedPrivacyAuthorization` 监听）
     + `components/privacy-gate.tsx`（授权弹窗），一处注册全站生效，业务调用点无需改动。
   - ⚠️ **还差 mp 后台一步（人工）**：设置 → 服务内容声明 → 用户隐私保护指引，
     勾选「相册」「摄像头」并保存发布。没做这步，`getPrivacySetting` 恒返回 `needAuthorization:false`
     （即"未声明"），用户点了同意也无效。
3. **密钥与上传私钥**
   - ⚠️ **轮换 `WX_SECRET`**：mp 后台重置 → 写入 `server/.env.secrets` →
     **必须重跑 `node server/scripts/encrypt-env.mjs`**（只改明文不加密等于没改）。
   - `key/private.appid.key` 放入 mp 后台下载的私钥；已加 `.gitignore` 保护（`key/`），
     此前的 0 字节占位文件已从索引移除。

### 4.3 上传体验版

- 版本号按 `YYYY.MM.DD`（或 `x.y.z`）递增，备注写清改动范围。
- ⚠️ **真机调试 / 体验版必须重新生成二维码并重新扫码**——旧码连的是旧会话，
  表现为「改了代码没生效」，见第 10 章故障剧本 3。
- `urlCheck`：**生产必须开启**；本地联调可临时关闭，但提版本前必须确认已恢复为开启。
- 域名白名单：`mp-api.app.workbuddy.host` 由平台自动注册，第三方服务商绑定勿解绑。

### 4.4 真机回归清单（每次提版本前必跑）

> 基础库版本说明：当前 `libVersion` 为 **3.17.4**，经检索核实（3.14.0 发布于 2026-01、
> 3.15.1 于 2026-03、3.16.0 于 2026-05）**已属较新版本，无需升级**。
> 但社区对相邻版本有若干回归报到，**版本切换后务必重点验证下面带 ★ 的项**。

| # | 场景 | 关注点 |
|---|---|---|
| 1 | ★ 拍照 / 相册识题（recognize） | 隐私弹窗是否弹出、同意后能否真正选图 |
| 2 | ★ 详情页长题干输入 | textarea 是否出现光标跳末尾、末行被截断 |
| 3 | ★ 各页面 rpx 样式 | 相邻基础库有「动态设置的行内 rpx 未换算成 px」的报到，看是否错版 |
| 4 | 答案 / 解题过程超长文本保存 | maxlength 放开后是否能完整落库 |
| 5 | 导出 Word / PDF | 中文是否乱码（务必确认带 **OCR 三件套环境变量**的服务进程） |
| 6 | TabBar 四个页切换 | 图标是否显示（对应 4.2 第 1 条） |
| 7 | 冷启动耗时 | 目标 < 1.5s；当前主包 910 KB / 2 MB，余量充足 |

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

> 用法：提版本前逐条勾选。**带 ❗的是阻断项**——未通过禁止上传，其余为强烈建议。

### 7.1 阻断项（必过）

- [ ] ❗ **`WX_SECRET` 已轮换**，且 `encrypt-env.mjs` 已重跑
      （⚠️ 只改明文不重新加密，发布出去的加密包里仍是旧值）
- [ ] ❗ **`project.config.json` 无 `packOptions.ignore` 命中 `./assets`**（根与 `dist/` 两份都要查）
      ```bash
      grep -n "packOptions" -A 6 project.config.json dist/project.config.json
      ```
- [ ] ❗ **`__usePrivacyCheck__: true` 已在 `app.config.ts`**，且 **mp 后台隐私保护指引已发布**
      ```bash
      grep -n "usePrivacyCheck" src/app.config.ts
      ```
- [ ] ❗ **包内无明文密钥**
      ```bash
      grep -rEno "(sk-[A-Za-z0-9]{10,}|SUPABASE_SERVICE[A-Z_]*=[^\s]{8,})" dist/ | head
      ```
- [ ] ❗ **dist 新鲜度**：`dist/` 整树最大 mtime 晚于最后一次源码提交，且首页包版本角标 = 最新 commit
      ```bash
      git log -1 --format=%h && find dist -newermt "-10 minutes" | wc -l
      ```

### 7.2 后端与健康

- [ ] 后端 health 时间戳是刚刚（非旧进程应答）
      ```bash
      curl -s --noproxy '*' http://127.0.0.1:3001/api/health
      ```
- [ ] 拨测脚本单次通过、退出码 0
      ```bash
      node server/scripts/health-probe.mjs; echo "exit=$?"
      ```
- [ ] 日志无新出现的 `[WARN]`/`[ERROR]`（重点看 best-effort 分支，它们静默失败）
      ```bash
      tail -100 server/logs/wake-server.log
      ```

### 7.3 关键链路冒烟（真机，非模拟器）

- [ ] 登录 / 匿名建号 → 身份连续跨页面一致
- [ ] 拍照 → OCR 识别 → 中文正常（**无 `\uFFFD`**）
- [ ] 文档导入 → 识别 → 按序号勾选 → 保存 → 另存 Word
- [ ] 详情页：切换学科 → 左上角徽标即时变化 → 保存后生效
- [ ] 复习本批量选题 → 合成 PDF/Word（含 / 不含答案两种）
- [ ] 搜索 / AI 对话：违规词被拦截（内容安全生效），正常词可发送

### 7.4 网络环境变更时的注意

> **本节说明**：改用 DHCP 时，**真机后端地址会随局域网 IP 变化**，`.env.local` 的
> `PROJECT_DOMAIN` 必须同步更新并**重建前端**（编译期注入，改了不构建等于没改）。

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
