# GK-QA-16 运维、发布与故障处置手册

> 编号：GK-QA-16 ｜ 版本：v1.0 ｜ 日期：2026-10-27 ｜ 状态：**正文完成**
> 读者：运维 / 开发 ｜ 上游：ADD-04、ADD-07、DD-09 ｜ 下游：无
> 定位：从本地到生产的路径 + **出问题时的第一本手册**（含原发布部署设计、运维手册、故障处置三份）。
> 密钥清单与轮换方式见 ADD-07 第 4 章（**本文不写密钥值**）；交付路由方案见 GK-OPS-19。

---

## 1. 环境划分

| 环境 | 后端地址 | 数据库 / 存储 | 密钥来源 | 域名校验 |
|---|---|---|---|---|
| **本地联调** | `http://192.168.3.242:3001`（`.env.local` 的 `PROJECT_DOMAIN`） | Supabase 新加坡 + `local` 驱动 | 本机 `.env` / `.env.secrets` | `urlCheck:false`（临时） |
| **体验版** | 同本地 或 云托管 | 同上 | 同上 | **开启** |
| **生产** | 微信云托管 `wx.cloud.callContainer`（改造点见第 5 章） | 同上 | 平台环境变量 / 解密脚本 | 开启 |

**本地联调前置条件**：真机需同 Wi-Fi + 防火墙放行 3001 + `urlCheck:false`；H5 端 `PROJECT_DOMAIN` 恒空串（同源）。

⚠️ **局域网 IP 变了必须改 `.env.local` 并重建前端**（编译期注入，改了不构建等于没改）。

---

## 2. 构建

### 2.1 前端

```bash
pnpm build:weapp          # = node scripts/gen-build-meta.mjs && taro build --type weapp
```

产物 `dist/`（`project.config.json` 的 `miniprogramRoot` 指向 `./dist`）。

⚠️ **交付前必须校验 dist 新鲜度**（两步）：

```bash
# ① 特征串
grep -c "特征串" dist/pages/<页>/index.js
# ② 首页「📦 包版本」角标 commit 是否等于最新 commit
git log -1 --format=%h
```

### 2.2 后端

```bash
cd server && npx nest build
```

### 2.3 类型检查

```bash
npx tsc --noEmit --skipLibCheck                                  # 前端
cd server && npx tsc --noEmit --skipLibCheck -p tsconfig.json    # 后端
```

（`node_modules` 的类型噪音由 `--skipLibCheck` 过滤。）

---

## 3. 配置与密钥

| 文件 | 内容 | 入部署包 |
|---|---|---|
| `server/.env` | 非敏感配置 | ✅ |
| `server/.env.secrets` | 🔴 敏感密钥 | ❌（只传 `.enc`） |
| `server/.env.migrate` | 迁移专用连接串（本地） | ❌ |
| `.env.local`（根） | 前端 `PROJECT_DOMAIN` | — |

⚠️ **改了 `.env.secrets` 必须重跑**：

```bash
node server/scripts/encrypt-env.mjs --verify
```

（只改明文不重新加密 ⇒ 部署出去的仍是旧密钥。含密钥轮换、refresh_token 变更。）

密钥全量表与轮换步骤见 **ADD-07 第 4 章**。

---

## 4. 小程序发布

### 4.1 为什么「开发者工具里一切正常」不等于「能发布」

当前项目长期处于**开发态**：`urlCheck:false` + 局域网 IP。按微信官方规则，开发者工具关闭域名校验后，模拟器与「真机调试」可请求任意 http 地址，**合法域名白名单与备案规则不生效**——这是开发阶段的正式豁免。因此下面三个断层一直被豁免掩盖，**第一次真正点「上传」时才会集中爆发**（2026-10-26 首次发布前体检发现）：

| 断层 | 开发态表现 | 体验版/正式版表现 |
|---|---|---|
| 打包裁剪误删 TabBar 图标 | 无感知（编译不过 packOptions 过滤） | 底部导航图标全空 |
| 未配置用户隐私保护指引 | 无感知（开发版豁免） | `chooseMedia` 直接失败 |
| AppSecret 泄露风险 + 无上传私钥 | 无感知 | 提审前必纠，CI 无法上传 |

> 判断依据记住两句话：**① packOptions 只在「上传/预览」打包时生效；② 开发版豁免 ≠ 体验版豁免。**

### 4.2 上传前三个必做的前置校验

**1. TabBar 图标必须进包**

- 判据：`project.config.json` **不得**存在 `packOptions.ignore` 命中 `./assets`（TabBar 图标位于 `dist/assets/tabbar/*.png`，微信小程序强制要求本地 PNG）；
- 现状：2026-10-26 已删除该 ignore 条目（根与 `dist/` 两份配置同步）；
- 验收：开发者工具「上传」→ 代码包详情页里 `assets/tabbar/` 的 8 个 PNG 在列。

**2. 隐私保护指引（`src/app.config.ts` 的 `__usePrivacyCheck__: true`）**

- 代码侧已完成：`utils/privacy.ts`（全局 `onNeedPrivacyAuthorization` 监听）+ `components/privacy-gate.tsx`（授权弹窗），一处注册全站生效；
- ⚠️ **还差 mp 后台一步（人工）**：设置 → 服务内容声明 → 用户隐私保护指引，勾选「相册」「摄像头」并保存发布。没做这步，`getPrivacySetting` 恒返回 `needAuthorization: false`，**用户点了同意也无效**。

**3. 密钥与上传私钥**

- ⚠️ **轮换 `WX_SECRET`**：mp 后台重置 → 写入 `server/.env.secrets` → **必须重跑 `encrypt-env.mjs`**；
- `key/private.appid.key` 放入 mp 后台下载的私钥；已加 `.gitignore` 保护（`key/`）。

### 4.3 上传体验版

- 版本号按 `YYYY.MM.DD`（或 `x.y.z`）递增，备注写清改动范围；
- ⚠️ **真机调试 / 体验版必须重新生成二维码并重新扫码**——旧码连的是旧会话，表现为「改了代码没生效」（见第 10 章剧本 3）；
- `urlCheck`：**生产必须开启**；提版本前必须确认已恢复；
- 域名白名单：`mp-api.app.workbuddy.host` 由平台自动注册，第三方服务商绑定勿解绑。

### 4.4 真机回归清单（每次提版本前必跑）

> 基础库：当前 `libVersion` = **3.17.4**，经检索核实（3.14.0 发布于 2026-01、3.15.1 于 2026-03、3.16.0 于 2026-05）**已属较新，无需升级**。但相邻版本有回归报到，**版本切换后务必重点验证带 ★ 的项**。

| # | 场景 | 关注点 |
|---|---|---|
| 1 | ★ 拍照 / 相册识题 | 隐私弹窗是否弹出、同意后能否真正选图 |
| 2 | ★ 详情页长题干输入 | textarea 是否光标跳末尾、末行被截断 |
| 3 | ★ 各页面 rpx 样式 | 相邻基础库有「动态行内 rpx 未换算成 px」的报到 |
| 4 | 答案 / 解题过程超长文本保存 | maxlength 放开后能否完整落库 |
| 5 | 导出 Word / PDF | 中文是否乱码（**务必确认服务进程带 OCR 三件套环境变量**） |
| 6 | TabBar 四个页切换 | 图标是否显示（对应 4.2 第 1 条） |
| 7 | 冷启动耗时 | 目标 < 1.5s；主包 918 KB / 2 MB，余量充足 |

---

## 5. 后端部署

### 5.1 当前形态：本地常驻

```
启动文件夹 GrowingKids-Wake.cmd（登录时调用 wake-server 无参启动器）
   → wake-server --daemon（:3002 常驻）
       · GET  /status          3001 是否在监听
       · POST /wake            需要时拉起后端
       · GET  /wait-ready      长轮询等待 3001 就绪（≤30s/次）
   → 后端 :3001（node dist/main -p 3001）
   → 前端 src/services/wake.ts：请求超时 → POST /wake → 等待就绪 → 自动重放
```

**为什么要"前端驱动"而非"看门狗每分钟轮询"**：看门狗每分钟的 node 窗口、以及后端重启时 spawn 的 OCR python 侧车窗口，会严重干扰用户操作（实锤闪窗）。改为前端驱动后**平时零窗口、零定时任务**，用户无感知。

**防误伤**：拉起前查重（已有进程但端口未起 → 等待，不重复拉）；单实例锁（`.wake-server.pid` + 进程存活校验）；拉起冷却 ≥10s（防 python 崩溃循环刷进程）。

**停用**：删除启动文件夹 `GrowingKids-Wake.cmd`，或 `touch server/logs/.wake-server-disabled` 后杀进程。

> ⚠️ 沙箱环境限制：Bash/后台进程命令结束即被无声杀；计划任务派生不受影响；`schtasks.exe` 被挡 ⇒ 用 PowerShell `Register-ScheduledTask`。

### 5.2 生产目标：微信云托管

⚠️ **两硬约束与改造点**：

1. **不支持 Compose** ⇒ NestJS 与 Python OCR 侧车必须打进**同一镜像**；
2. `callContainer` **文本 ≤100KiB、超时 15s** ⇒ 图片传输改走 `wx.cloud.uploadFile` 换 fileID。

⚠️ **`*.app.workbuddy.host` 不能当小程序 API 后端**（边缘网关拦 MicroMessenger UA + 无 ICP 备案），仅可用于浏览器/联调。

启动命令覆盖为：`node scripts/decrypt-env.mjs && npm run start`。

素材：`docs/后端托管与小程序发布-调研纪要.md`、`docs/迁移到腾讯云-方案与步骤.md`；三条路线与判断法见 **GK-OPS-19**（截至 2026-10-26 **未实施**）。

---

## 6. 部署包脚本

### 6.1 `deploy-pack.mjs`

```bash
node server/scripts/deploy-pack.mjs pack       # 部署前：挪走本地专属文件
node server/scripts/deploy-pack.mjs restore    # 部署后：挪回原位
node server/scripts/deploy-pack.mjs status     # 查看当前在架/挪出状态
```

- `pack`：把 `.env.secrets` / `.env.migrate` / `.local-storage` / `logs` 挪到 `<项目根>/.deploy-staging/`；
- 同时把 OCR 引擎等依赖**复制进 `server/`** 一起上传（`restore` 时清理，不入库）；
- ⚠️ `pack` 前会检查暂存区是否残留（残留 ⇒ 报错终止）；`pack` 后必须 `restore`，否则本地 OCR 引擎被清理。

### 6.2 `encrypt-env.mjs` / `decrypt-env.mjs`

```
.env.secrets --[AES-256-GCM, scrypt(AppID|用途串, 随机盐)]--> .env.secrets.enc
容器 startCmd: node scripts/decrypt-env.mjs && npm run start
```

⚠️ **边界声明**：派生因子 AppID 是公开的 ⇒ **防包泄露与自动扫描器，防不住平台运维与定向攻击**。真正的防护是轮换密钥本身。

---

## 7. 发布检查清单

> 提版本前逐条勾选。**带 ❗的是阻断项**——未通过禁止上传，其余为强烈建议。

### 7.1 阻断项（必过）

- [ ] ❗ **`WX_SECRET` 已轮换**，且 `encrypt-env.mjs` 已重跑
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
- [ ] ❗ **dist 新鲜度**：整树最大 mtime 晚于最后一次源码提交，且首页包版本角标 = 最新 commit
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
- [ ] 日志无新出现的 `[WARN]`/`[ERROR]`（重点看 best-effort 分支）
  ```bash
  tail -100 server/logs/wake-server.log
  ```

### 7.3 关键链路冒烟（真机，非模拟器）

- [ ] 登录 / 匿名建号 → 身份连续跨页面一致
- [ ] 拍照 → OCR 识别 → 中文正常（**无 `U+FFFD`**）
- [ ] 文档导入 → 识别 → 按序号勾选 → 保存 → 另存 Word
- [ ] 详情页：切换学科 → 左上角徽标即时变化 → 保存后生效
- [ ] 复习本批量选题 → 合成 PDF/Word（含 / 不含答案两种）
- [ ] 搜索 / AI 对话：违规词被拦截（内容安全生效），正常词可发送

### 7.4 网络环境变更时的注意

改用 DHCP 时，**真机后端地址会随局域网 IP 变化** ⇒ `.env.local` 的 `PROJECT_DOMAIN` 必须同步更新并**重建前端**。

---

## 8. 回滚方案

| 层 | 回滚方式 | 可逆性 |
|---|---|---|
| **前端** | `git checkout <上一个 commit>` → 重新 `pnpm build:weapp` → 开发者工具重新上传 | ✅ 完全可逆 |
| **后端** | 杀进程 → 检出旧代码 → `npx nest build` → 重启；镜像部署则回滚镜像版本 | ✅ 可逆 |
| **配置** | `.env.secrets` 改回旧值 → 重跑 `encrypt-env.mjs` | ✅ 可逆（但轮换过的密钥不能"改回"） |
| 🔴 **数据库迁移** | **不可逆** | ❌ |

### 8.1 ⚠️ 数据库迁移不可逆的应对

**"只增不改"的迁移纪律如何降低风险**：

- 迁移文件**只增不改** ⇒ 已执行的文件内容被 sha256 锁定，改了会被识别并跳过；
- 需要撤销时**写新的迁移文件**（如 `0017_drop_x.sql`），不回头改旧的；
- 全部用 `if not exists` 幂等写法 ⇒ 空库可一键重建全部结构（**只含结构，不含数据**）；
- 🔴 **删表 / 删列的迁移无法恢复数据** ⇒ 执行前必须备份（见 ADD-05 第 12 章）。

**回滚顺序**：先回滚后端（兼容旧数据）→ 再回滚前端 → 数据库结构一般**不回滚**（靠"只增不改"保证新旧代码都能跑）。

---

## 9. 监控与日志

### 9.1 健康检查

| 端点 / 脚本 | 用途 |
|---|---|
| `GET /api/health` | 服务存活（返回含时间戳，用于确认不是旧进程应答） |
| `GET /api/image/capabilities` | 图像处理能力（`straighten` / `enhance` / `erase_v2`） |
| `GET /api/image/ocr-diagnose` | OCR 双引擎连通性诊断 |
| `node server/scripts/health-probe.mjs` | 单次拨测，**失败 exit 1** |
| `node server/scripts/health-probe.mjs --watch 5` | 常驻轮询（分钟，默认 5） |

⚠️ 拨测设计要点：**OCR 侧车空闲 900s 被回收是设计行为** ⇒ 侧车不可用只降级记 warn，**不影响退出码**（否则计划任务天天误报）；只有 health 不可用才 warn + exit 1。

### 9.2 关键埋点清单

| 类别 | 必须打日志的点 |
|---|---|
| 🔴 **best-effort 分支** | 网盘同步、缓存读写、命中计数、内容安全检测——**必须 `console.error` 打全错** |
| 身份 | 登录成功（含迁移条数）、令牌验签失败、裸 `X-User-Id` 使用 |
| 隔离 | `requireAdmin` 未配置白名单（每次 warn） |
| 维护 | `[maintenance]` 三类任务的执行与结果 |
| 异常 | 5xx 落盘 `server/logs/error-YYYY-MM-DD.log` |

### 9.3 日志位置与轮转

| 日志 | 路径 | 轮转 |
|---|---|---|
| 异常 | `server/logs/error-YYYY-MM-DD.log` | 按天；单文件 >5MB 自动换号（`.2.log`） |
| 保活 | `server/logs/wake-server.log` | 无自动轮转，定期人工清理 |
| 拨测 | `server/logs/health-probe.log` | 无自动轮转，定期人工清理 |
| 后端输出 | `server/logs/backend-YYYY-MM-DD.log` | 按天 |

⚠️ `server/logs/` 已在 `.gitignore`。

### 9.4 无告警系统时的替代巡检

当前**没有外部告警通道** ⇒ 替代方案：

```bash
# 手动巡检（每次发布前后）
node server/scripts/health-probe.mjs; echo "exit=$?"
tail -50 server/logs/error-$(date +%F).log
tail -50 server/logs/wake-server.log
pnpm --filter server check:isolation
```

建议：把 `health-probe --watch` 挂到计划任务（PowerShell `Register-ScheduledTask`），日志落盘后人工定期翻。

---

## 10. 故障剧本

逐条「现象 → 判据命令 → 根因 → 处置 → 预防」：

### 剧本 1：Supabase IP 封锁导致全站 500

- **现象**：所有接口 500，日志出现连接超时。
- **判据**：`grep -i "fetch failed\|ETIMEDOUT" server/logs/error-*.log`
- **根因**：pooler IP 变更 / 短暂网络瞬断（曾误判为改动引入，用 `git stash` 对照实验证明是偶发）。
- **处置**：等待 20–90s 重试；`supabase-dns-pin.ts` 自愈重探。
- **预防**：首次连接失败是**预期行为**，不要据此判断"缺 key"。

### 剧本 2：后端改了不生效

- **现象**：改了 `server/src` 但接口行为没变。
- **判据**：`curl -s --noproxy '*' http://127.0.0.1:3001/api/health` 的时间戳是旧的。
- **根因**：⚠️ **后台任务停止后 node 子进程仍占端口** ⇒ 新进程 `EADDRINUSE`，health 由**旧进程**应答。
- **处置**：
  ```bash
  netstat -ano | grep :3001
  taskkill /PID <pid> /F
  node dist/main -p 3001
  ```
- **预防**：换构建后必须**杀后端再 POST `:3002/wake`**。

### 剧本 3：前端改了真机没变

- **现象**：代码改了但真机行为未变。
- **判据**：`grep -c "特征串" dist/pages/<页>/index.js`；首页包版本角标 commit。
- **根因**：① 没重建 dist；② 开发者工具未重新编译；③ **扫了旧二维码**（连的是旧会话）。
- **处置**：`pnpm build:weapp` → 开发者工具重新编译 → 真机调试**重新生成二维码并重新扫码**。

### 剧本 4：OCR 侧车 9301 无监听

- **现象**：端口 9301 无服务。
- **判据**：`curl --noproxy '*' http://127.0.0.1:9301/healthz`
- **根因**：**设计行为**——空闲 900s 回收、按需重启，不是故障。
- **处置**：无需处理；首次请求有冷启动延迟。`fast` 走常驻进程，不受影响。
- **预防**：拨测脚本对该项只 warn 不计退出码。

### 剧本 5：ima 配额打爆（220021）

- **现象**：知识库检索返回「今日调用次数已达上限」。
- **根因**：ima 按调用计数、**零命中也扣**、不可退避。
- **处置**：当日不再重试；引导改试联网搜题或 AI 解题。
- **预防**：`answer_cache` 持久化（同题同 mode 永不重复消耗）+ 调用预算 4 次/题。

### 剧本 6：真机连不上后端

- **判据**：小程序请求超时；`ping <局域网 IP>`。
- **根因**：IP 变了 / 防火墙未放行 / 不同 Wi-Fi / `.env.local` 未重建。
- **处置**：逐项核对 → 改 `PROJECT_DOMAIN` → **重建前端**。

### 剧本 7：微信框架噪声日志

- **现象**：`backgroundfetch privacy fail` errno 101。
- **处置**：**与本项目无关，忽略**。

### 剧本 8：识别结果为空 / 异常

- **判据**：OCR 输出出现 `U+FFFD`（乱码）或空结果。
- **根因**：① OCR 三件套环境变量未透传 ⇒ 落到系统 python 缺包；② 编码未走 `pythonEnv()`。
- **处置**：确认 `OCR_VENV_DIR` / `OCR_ENGINE_DIR` 已设；直接跑 `node dist/main` 时**必须手动带**。
- **预防**：日常用 `wake-server` 自动注入。

### 剧本 9：导出 / 合成报「没有可合成的图片」

- **根因**：素材含 WebP 等格式，`pdf-lib` 与 `docx` 只吃 PNG/JPEG。
- **处置**：合成前用 sharp 按 `hasAlpha` 转 PNG 或 JPEG(92)（代码已实现）。
- **预防**：见 DD-12 第 8.2 节两个已坐实的坑。

### 剧本 10：导出记录"生成了但文档库看不到"

- **根因（历史）**：docx 的 MIME 71 字符 > `varchar(64)` ⇒ 静默入库失败。
- **现状**：0013 已放宽至 128。若再现，检查 `mime_type` 长度。

---

## 11. 脚本清单

| 脚本 | 用途 | 命令 |
|---|---|---|
| `server/scripts/migrate.mjs` | 数据库迁移 | `node scripts/migrate.mjs [--ping\|--dry\|--force\|--only <file>]` |
| `server/scripts/check-isolation.mjs` | 数据隔离静态门禁 | `pnpm --filter server check:isolation` |
| `server/scripts/deploy-pack.mjs` | 部署打包前后处理 | `node scripts/deploy-pack.mjs <pack\|restore\|status>` |
| `server/scripts/encrypt-env.mjs` | 敏感环境变量加密 | `node scripts/encrypt-env.mjs [--verify]` |
| `server/scripts/decrypt-env.mjs` | 容器内还原（startCmd 调） | — |
| `server/scripts/wake-server.mjs` | 后端保活 | `node scripts/wake-server.mjs [--daemon]` |
| `server/scripts/health-probe.mjs` | 健康拨测 | `node scripts/health-probe.mjs [--watch N]` |
| `server/scripts/baidu-oauth.mjs` | 百度网盘授权 | 详见 `docs/百度网盘接入资料库-操作指引.md` |
| `server/scripts/setup-migrator-role.sql` | 创建低权迁移角色 | SQL Editor 执行 |
| `docs/install-ocr-env.ps1` / `.sh` | OCR 环境安装 | 详见脚本头部 |
| `docs/ocr-sidecar-selfcheck.sh` | OCR 侧车自检 | ⚠️ 超时 ≠ 缺包，勿重装 |
| `docs/补建缺失表-一键SQL.sql` | 应急补表 | SQL Editor 执行 |
| `docs/获取DATABASE_URL-操作指引.md` | 连接串获取 | — |

---

## 变更记录

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v0.0 | 2026-10-24 | 建立提纲（待审） |
| v0.1 | 2026-10-26 | 补齐第 4 章（小程序发布：三个断层与前置校验）与第 7 章（发布检查清单） |
| v1.0 | 2026-10-27 | **正文完成**：补齐三环境配置差异、前后端构建与 dist 新鲜度校验、密钥文件分工、本地常驻（wake-server 双角色 + 前端驱动）与云托管两硬约束、部署包脚本流程、四层回滚与迁移不可逆应对、健康检查端点与埋点清单（无告警时的替代巡检）、10 个故障剧本（新增导出合成与导出记录两条）、13 个脚本登记 |
