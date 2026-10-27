# GK-QA-16 运维、发布与故障处置手册

> 编号：GK-QA-16 ｜ 版本：v1.2 ｜ 日期：2026-10-27 ｜ 状态：**正文完成 · 已补数据库备份/演练与两个计划任务 · 已补隐私指引申报操作手册**
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
- ⚠️ **还差 mp 后台一步（人工，唯一无法自动化的一步）**：完整操作手册见 **4.5**（含入口判断、逐项勾选、可复制文案、验证方法、留痕表）。
  **不要再按「设置 → 服务内容声明」这个路径找**——`2026-10-27` 实测该路径已不存在；且**小程序未发布上线时入口1 提交也不生效**，必须走提审页的入口2。
- 要勾的是 **4 项**（不是 2 项）：选中的照片或视频信息、摄像头、选中的文件、**剪切板**。漏掉剪切板 ⇒ 运行时 `errno 112`，用户点「复制」静默失败。

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

### 4.5 用户隐私保护指引申报（mp 后台 · 唯一人工步骤）

> **这一节是照着做的操作手册**，不是风险分析。风险判定与残留风险见 `GK-OPS-18` 的 `R-合规-05`。
> 定位：**发布阻断项**。不做这一步，代码侧再正确也不生效——`getPrivacySetting` 恒返回 `needAuthorization: false`，用户点了同意也无效；
> 更隐蔽的是运行时直接抛 `errno 112`，表现成「点了拍照毫无反应」。
> 关联：`R-已关闭-11`（开发版豁免 ≠ 体验版豁免）——**这一项只会在真机/体验版爆发，开发阶段测不出来**。

#### 4.5.1 ⚠️ 先判断该走哪个入口（走错等于白做）

微信有**两个**入口，改的不是同一份协议。**选错入口是这一项最常见的失败原因**，因为它不会有任何报错，只是"点了半天没变化"。

| 入口 | 位置 | 改的是哪一份 | 生效条件 |
|---|---|---|---|
| **入口1** | mp 后台 **左下角头像 → 账号设置 →（基础设置 →）服务内容声明 → 用户隐私保护指引 → 去完善** | **现网版本**的隐私协议 | 审核通过后生效。⚠️ **小程序没有线上版本时，审核通过也不生效、页面显示空白**。官方口径：「目前未发布小程序无法更新用户隐私保护指引内容」 |
| **入口2** | **管理 → 版本管理 → 提交代码审核 → 信息填写页面底部「用户隐私保护指引设置」** | **本次提审版本**的隐私协议 | 随本次**代码审核通过 + 发布上线**一起生效 |

**判断方法（一句话）**：

- **没发布过线上版本 → 必须走入口2**（本项目当前就是这种状态，见 `R-技术-07` 本期不发正式版的决策）；
- **已有线上版本、只想补声明 → 走入口1**。

> ⚠️ 入口1 的旧路径写作「设置 → 基础设置 → 服务内容声明」。2026-10-27 实测**该路径已不存在**，认准「**服务内容声明**」和「**用户隐私保护指引**」这两个词去找，不要按旧菜单名硬找。
> ⚠️ 点「去完善」后页面没反应，通常是浏览器拦了弹窗——看地址栏右侧的拦截提示并放行。

#### 4.5.2 前置条件

| # | 条件 | 说明 |
|---|---|---|
| 1 | 能在 [mp.weixin.qq.com](https://mp.weixin.qq.com) 登录**该小程序的管理员账号** | **不是**开发者工具里的登录态。不是管理员则看不到「用户隐私保护指引」入口 |
| 2 | 已用开发者工具上传过代码（有开发版本） | 入口2 挂在「提交审核」流程里，没有版本就进不去 |
| 3 | 小程序内《隐私政策》文本已是最新版 | 平台会**比对**小程序内政策与这里填的内容。当前版本 `2026-10-27-r2`，含备份披露与 AI 开关说明 |

#### 4.5.3 操作步骤（照此逐步执行）

| 步 | 操作 | 注意 / 判据 |
|---|---|---|
| **1** | 按 4.5.1 选定入口，进入「用户隐私保护指引」 | 未上线 → 入口2；已上线 → 入口1 |
| **2** | 开发者工具「上传」代码 → 后台「管理 → 版本管理」找到该开发版本 → **提交审核** | 不用真的等审核通过才填，信息填写页里就能配 |
| **3** | 在信息填写页拉到底，找到「用户隐私保护指引设置」，选**「采集用户隐私」** | 选「不采集」会直接导致后续各项灰掉 |
| **4** | 在「处理的信息」清单里，**只勾这 4 项**：<br>① 收集你选中的照片或视频信息<br>② 访问你的摄像头<br>③ 收集你选中的文件<br>④ 剪切板 | ❌ **不要勾**位置、录音、通讯录、微信运动、手机号、日历——代码零调用，勾了等于虚假声明，**反而增加驳回风险**（依据见 4.5.4） |
| **5** | 给 4 项分别填「用途说明」，**原样粘贴** 4.5.5 的四段文案 | 每段都写了"不会读取其他内容"这类边界，比笼统写"用于功能实现"更容易过 |
| **6** | 填「信息保存期限」，**原样粘贴** 4.5.6 那段 | ⚠️ **不能写"永久"**；必须与小程序内《隐私政策》「保存多久」一节**逐字一致**，平台会比对 |
| **7** | 展开「第三方信息共享」，按 4.5.7 的表**逐条添加**（接收方 / 共享内容 / 用途） | 共 5 条。百度网盘要加**两条**：用户文档 + 运维备份，漏一条就是漏报 |
| **8** | 点「提交」，等审核（通常 1–2 个工作日，首次可能更久） | 提交后状态为"审核中"，**不要重复提交** |
| **9** | 审核通过 → **发布上线**（走入口2 的话，到这一步才真正生效） | 只审核不发布 = 没生效 |
| **10** | 等 5–10 分钟，按 4.5.8 验证，并把结果填进 4.5.9 留痕表 | 后台显示"已通过"**不等于**客户端已生效 |

#### 4.5.4 为什么恰好是这 4 项（按代码实测，不是按猜测）

| 官方清单项 | 代码依据 | 是否必勾 |
|---|---|---|
| **相册（选中的照片或视频信息）** | `Taro.chooseMedia({ sourceType: ['camera','album'] })`、`Taro.chooseImage({ sourceType: ['album','camera'] })` | ✅ 必勾 |
| **摄像头** | 同上，`sourceType` 含 `camera` | ✅ 必勾 |
| **选中的文件** | `Taro.chooseMessageFile()`（从微信聊天选 PDF/图片导入资料库；`library` 与 `answer-editor` 各一处） | ✅ 必勾 |
| **剪切板** | `Taro.setClipboardData()`（复制图片链接、复制 OCR 文本） | ✅ **必勾**（见下方） |
| 位置 / 录音 / 通讯录 / 微信运动 / 手机号 / 日历 | 代码**零调用**（`getLocation` / `startRecord` / `chooseAddress` 均无命中） | ❌ 不要勾 |

> ⚠️ **剪切板只写不读，为什么还必须勾（2026-10-27 查证官方口径）**：
> 官方隐私接口清单把 `wx.setClipboardData` 与 `wx.getClipboardData` **同列在「剪切板」一项下**，看的是"有没有调用这个接口"，**不是"读还是写"**。
> 不声明的后果不是"审核挑刺"，而是**运行时直接失败**：`setClipboardData:fail api scope is not declared in the privacy agreement`（`errno 112`）⇒ 用户点「复制」没反应。
> 官方说明：**声明后约 5 分钟生效**。

> ⚠️ **改动代码后必须回来复查这张表**：新增任何 `chooseMedia` / `chooseImage` / `chooseMessageFile` / `setClipboardData` / `getLocation` 等隐私接口调用，都要同步回来改勾选项，并同步改小程序内《隐私政策》。
> 自检命令：`grep -rn "chooseMedia\|chooseImage\|chooseMessageFile\|setClipboardData\|getLocation\|startRecord" src/ --include=*.ts --include=*.tsx`

#### 4.5.5 四项用途说明（可原样粘贴）

| 项 | 文案 |
|---|---|
| 相册 | `用于选择您已保存的照片，识别其中的题目并生成错题记录。不会读取相册中的其他内容。` |
| 摄像头 | `用于拍摄纸质作业或试卷，识别题目文字。仅在您主动点击拍摄时调用。` |
| 选中的文件 | `用于从微信聊天中选择您已收到的 PDF/图片文件，导入资料库进行题目识别。不会读取聊天记录。` |
| 剪切板 | `用于将识别结果、图片链接等内容写入您的剪贴板以便粘贴，不读取剪贴板中的任何内容。` |

#### 4.5.6 信息保存期限（与政策逐字一致，不能写"永久"）

```
账号存续期间保存；您注销账号后即删除。用于识别缓存的图片特征值与识别结果因采用内容寻址、
可能被其他用户复用，保留至无任何用户引用为止。当前政策版本另说明：加密数据库备份最多保留
14 天，注销后数据可能在此期间留存。
```

> 最后那句「备份最多保留 14 天」是 `R-技术-06` 运维备份带来的新事实（备份是**整体加密文件**，无法按人摘除）。
> 它必须同时出现在小程序内《隐私政策》第七节，否则平台比对会不一致。

#### 4.5.7 第三方信息共享（5 条，少一条就是漏报）

| # | 接收方 | 共享内容 | 用途 | 受 AI 开关控制 |
|---|---|---|---|---|
| 1 | Supabase（新加坡） | 账号 ID、题目文本、图片文件 | 数据存储（主存储） | 否 |
| 2 | ima 知识库 | 题目文本 | 教辅检索 | ✅ 受 `ai_enabled` 控制 |
| 3 | 大模型服务商 | 题目文本、对话内容 | 解题与答疑 | ✅ 受 `ai_enabled` 控制 |
| 4 | 百度网盘（用户文档） | 用户主动保存的文档文件 | 用户自己开启的云端归档副本 | 否 |
| 5 | 百度网盘（运维备份） | **数据库全量导出（已整体加密）** | 运维灾备，防止数据丢失 | 否 |

> ⚠️ 第 5 条是 2026-10-27 新增的处理活动。**加密了也必须声明**——接收方是第三方，处理活动就存在。
> 声明口径务必带上「运营方不以可读形式访问备份内容」这句。
> ⚠️ 第 1 条涉及**数据出境**（新加坡区域），平台会单独问，不要漏。

#### 4.5.8 验证方法（不做这步等于没验）

| # | 动作 | 通过判据 |
|---|---|---|
| 1 | 后台保存后**等 5–10 分钟**（配置下发有延迟） | — |
| 2 | 开发者工具「清缓存 → 全部清除」→ 重新编译 | / |
| 3 | 手机**删除小程序**（开发版/体验版/正式版都删）后重新进入 | 避免吃旧缓存 |
| 4 | 首次点「拍照识题」 | **应弹出隐私授权弹窗**；不弹 = 没生效 |
| 5 | 同意后点一次「复制链接」 | 有复制成功提示，**不是** `errno 112` 静默失败 |
| 6 | 代码侧看 `Taro.getPrivacySetting()` | 首次未同意时返回 `needAuthorization: true`；**恒为 `false` 就是没生效** |

> ⚠️ **开发版/开发工具验证不算数**：`urlCheck:false` + 开发版豁免让隐私校验在开发阶段不生效（见 4.1）。
> 只有**真机 + 体验版或正式版**的验证结果可信。

#### 4.5.9 留痕表（每次申报/变更都记一行）

| 日期 | 入口 | 版本号 | 勾选项 | 提交时间 | 通过时间 | 验证结果 | 操作人 |
|---|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |  |

> 这是发布阻断项，必须有记录。`R-合规-05` 的关闭依据就是这张表被填满。

#### 4.5.10 ❌ 五个最容易做错的地方

| # | 错法 | 后果 | 正确做法 |
|---|---|---|---|
| 1 | **走入口1 但小程序还没发布过** | 审核通过也不生效，页面空白，白等 1–2 天 | 按 4.5.1 判断，未上线走**入口2** |
| 2 | **只改平台指引，不改小程序内《隐私政策》** | 两者内容不一致，平台比对出问题 | 两份是不同东西（平台声明 vs 应用内文本），改一份必须同步另一份 |
| 3 | **只勾相册摄像头，漏掉剪切板和选中的文件** | 点「复制」静默失败（`errno 112`）；选文件页面报错 | 4 项一个都不能少，剪切板**只写也必须勾** |
| 4 | **审核通过就以为完事** | `errno 112` 是**运行时**报的，不在审核阶段报 | 必须做 4.5.8 的 6 步验证 |
| 5 | **以为开发版测过就行** | 开发版豁免让隐私校验不生效 | 必须真机 + 体验版/正式版验（`R-已关闭-11` 同款坑） |

#### 4.5.11 ⚠️ 与「本期不发正式版」决策的冲突（发版前必须先拍板）

官方口径：**未发布上线的小程序无法更新用户隐私保护指引，审核通过也不生效**。
而 `R-技术-07` 已决策**本期不发正式版**。两者叠加 ⇒ 这一项按原计划做不完，只有两条路：

| 方案 | 做法 | 代价 | 适合 |
|---|---|---|---|
| **A. 本期发一版** | 走入口2，随本次提审 + 发布一起生效 | 等于提前启动 `R-技术-07` 那 9 项前提（备案域名、`urlCheck:true`、密钥轮换…） | 本来就打算近期上线 |
| **B. 本期不发版，接受"未验证"** | 体验版临时把 `app.config.ts` 的 `__usePrivacyCheck__` 设为 `false`，让拍照/选文件在体验版可用；隐私弹窗验证**推迟到真正发版那一次** | 隐私弹窗在真机上**始终没验过**，等于把"一上线就炸"的坑留到最后一天 | 继续在本机开发 |

> ⚠️ **方案 B 的直接后果**：当前 `app.config.ts` 是 `__usePrivacyCheck__: true`。**指引未生效时开 true，体验版调 `chooseMedia` 会直接抛 `errno 112`**（官方 FAQ 也建议未上线时先设 `false`）。
> 而 `src/pages/recognize/index.tsx` 的 `chooseImage` 是 `catch {}` **把一切错误当作用户取消静默吞掉** ⇒ 表现成「点了拍照毫无反应、无任何提示」，极难排查。
> ⇒ **无论选 A 还是 B，都建议给 `errno 112` 补一条明确提示**（A 也可能因配置下发延迟在发版当天短暂命中）。

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
  ```bash
  cd server && node scripts/rotate-wx-secret.mjs --check
  # 期望：密文中 WX_SECRET 与明文一致 ✅
  # 若要轮换：--secret <mp 后台重置出来的 32 位>
  ```
- [ ] ❗ **最近一次备份在 48 小时内，且最近一次演练通过**（见 9.5）
  ```bash
  tail -1 server/logs/backup-$(date +%F).log          # 期望 "ok":true
  ls -lt server/backups/*.gkbk | head -3
  cd server && node scripts/db-restore.mjs --verify     # 期望 18/18 表哈希一致
  ```
- [ ] ❗ **`project.config.json` 无 `packOptions.ignore` 命中 `./assets`**（根与 `dist/` 两份都要查）
  ```bash
  grep -n "packOptions" -A 6 project.config.json dist/project.config.json
  ```
- [ ] ❗ **`__usePrivacyCheck__: true` 已在 `app.config.ts`**
  ```bash
  grep -n "usePrivacyCheck" src/app.config.ts
  ```
- [ ] ❗ **mp 后台隐私保护指引已提交并随本次版本上线（4 项全勾，不是 2 项）**
  逐项打勾后参照 **4.5** 执行；填完在 4.5.9 留痕表记一行。
  - [ ] 收集你选中的照片或视频信息
  - [ ] 访问你的摄像头
  - [ ] 收集你选中的文件
  - [ ] 剪切板
  - [ ] 第三方共享 5 条已填（含百度网盘运维备份、Supabase 数据出境）
  - [ ] 真机体验版/正式版已验证：隐私弹窗正常弹出、点「复制」不报 `errno 112`
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
| `GET /api/health/runtime` | **运行态自检**：`cache.backend`（memory/redis）、`ticketStore`、`tokenEnabled`、`strictToken`、`uptime`。**不含任何密钥值**，可对外 |
| `GET /api/image/capabilities` | 图像处理能力（`straighten` / `enhance` / `erase_v2`） |
| `GET /api/image/ocr-diagnose` | OCR 双引擎连通性诊断 |
| `node server/scripts/health-probe.mjs` | 单次拨测，**失败 exit 1** |
| `node server/scripts/health-probe.mjs --watch 5` | 常驻轮询（分钟，默认 5） |

⚠️ **两个端点都是公开路由，不需要令牌**（`user-context.ts` 的 `PUBLIC_ROUTES`）。这是刻意的：拨测脚本不带令牌，若健康检查也要求令牌就会返回 401 ⇒ 巡检误判后端已挂 ⇒ 触发无意义重启。**改身份中间件时绝不要把健康检查纳入鉴权**。

⚠️ 拨测设计要点：**OCR 侧车空闲 900s 被回收是设计行为** ⇒ 侧车不可用只降级记 warn，**不影响退出码**（否则计划任务天天误报）；只有 health 不可用才 warn + exit 1。

⚠️ `/api/health` 的返回结构**不要改**（拨测脚本按它解析）；要加运行态信息请加到 `/api/health/runtime`。

### 9.2 关键埋点清单

日志由 `server/src/shared/logger.ts` 的 `installLogTee()` **接管 `console.*`** 统一落盘（JSON 行），并叠加 `accessLog()` 中间件。因此**普通 `console.log/warn/error` 就会自动进日志文件，不需要改调用方式**。

**访问日志字段**（每请求一行，`kind: "access"`）：

| 字段 | 含义 | 用途 |
|---|---|---|
| `trace` | 请求追踪号 | 把同一次请求的后续日志串起来（`grep <trace>`） |
| `method` / `path` / `status` | 方法、路径、状态码 | 定位 4xx/5xx 集中点 |
| `ms` | 耗时 | 性能排查 |
| `user` / `role` | 用户 id 与角色 | 判断是"某用户特有"还是"全局" |
| `slow` | 慢请求标记 | 先看 `slow:true` 的行，别从头翻 |

**业务埋点（必须打全错的地方）**：

| 类别 | 必须打日志的点 | 为什么不能省 |
|---|---|---|
| 🔴 **best-effort 分支** | 网盘同步、缓存读写、命中计数、内容安全检测 | 这些分支**失败不中断主流程** ⇒ 不打日志就等于静默失效，用户只会看到"功能时好时坏" |
| 身份 | 登录成功（含迁移条数）、令牌验签失败、裸 `X-User-Id` 被拒 | 验签失败突然变多 = 有人在试伪造令牌；裸头被拒变多 = 有老客户端没升级 |
| 管理员 | `requireAdmin` 拒绝（403）、`CHAT_ADMIN_IDS` 兼容命中 | 前者可能是越权尝试；后者说明还有环境没迁到 `role` |
| 隔离 | 查询漏写 `.eq('user_id')`（门禁脚本侧，非运行期） | 由 `check:isolation` 兜底，见 9.4 |
| 维护 | `[maintenance]` 三类任务的执行与结果；**账号注销的 dry-run 与真删回执** | 注销是真删不可逆，必须有回执可查 |
| 缓存 | 缓存后端降级（Redis 不可用回落内存）、票据存储降级（db 回落内存） | **降级必须能看见**，否则多副本时会出现"数据不一致但没人知道" |
| 异常 | 5xx | 见 9.3 的位置 |

⚠️ **刻意不记的东西：请求 body**。题图 base64 动辄数 MB，记进日志会把磁盘写炸。要排查内容问题请从 `blob_objects` 取原图。

### 9.3 日志位置与轮转

| 日志 | 路径 | 轮转 / 保留 |
|---|---|---|
| **统一应用日志**（含访问日志与全部 `console.*`） | `server/logs/app-YYYY-MM-DD.log` | **按天**；单文件 > **8MB** 自动换号（`app-YYYY-MM-DD.2.log` → `.3.log`…）；保留 **7 天**，启动时 + 每 **6 小时**清扫 |
| 异常 | `server/logs/error-YYYY-MM-DD.log` | 按天；同上清扫 |
| 保活 | `server/logs/wake-server.log` | 无自动轮转，定期人工清理 |
| 拨测 | `server/logs/health-probe.log` | 无自动轮转，定期人工清理 |

- 统一日志是 **JSON 行**，便于 `grep` / `jq`，不再是混排文本。
- ⚠️ `server/logs/` 已在 `.gitignore`。

**常用查询**（`jq` 可选，`grep` 已够用）：

```bash
# 今天所有 5xx
grep '"status":5' server/logs/app-$(date +%F).log

# 某用户的全部请求
grep '"user":"<user-id>"' server/logs/app-$(date +%F).log

# 慢请求（按 ms 降序看前 20）
grep '"slow":true' server/logs/app-$(date +%F).log | tail -20

# 定位一次请求的全链路
grep '<trace-id>' server/logs/app-$(date +%F).log

# 身份类异常（伪造令牌 / 裸头被拒 / 管理员拒绝）
grep -E 'TOKEN_INVALID|拒绝未签名|requireAdmin' server/logs/app-$(date +%F).log
```

### 9.4 无告警系统时的替代巡检

⚠️ **诚实说明：当前没有外部告警通道**。日志齐了但没人盯着看，"事后能查"不等于"出事会通知"。以下为替代动作：

```bash
# 手动巡检（每次发布前后）
node server/scripts/health-probe.mjs; echo "exit=$?"
curl --noproxy '*' -s http://127.0.0.1:3001/api/health/runtime
tail -50 server/logs/error-$(date +%F).log
grep '"status":5' server/logs/app-$(date +%F).log | tail -20
tail -50 server/logs/wake-server.log
pnpm --filter server check:isolation
```

`/api/health/runtime` 的判读：

| 字段 | 正常值 | 异常含义 |
|---|---|---|
| `cache.backend` | `memory`（单机）/ `redis`（已扩容） | 配了 `REDIS_URL` 却显示 `memory` ⇒ Redis 连不上，已静默降级 |
| `ticketStore` | `auto(db 优先)` | 显示降级到 memory ⇒ `login_tickets` 表不可用（未跑 0012 / 网络异常），多副本会丢票 |
| `strictToken` | `true` | `false` 说明 `AUTH_STRICT_TOKEN=false` 还开着，**裸头可伪造，不得带上线** |
| `uptime` | 持续增长 | 突然归零 = 进程刚重启（配合 `R-已关闭-02` 查是不是崩了） |

建议：把 `health-probe --watch` 挂到计划任务（PowerShell `Register-ScheduledTask`），日志落盘后人工定期翻。数据库备份走同一套计划任务机制，见 **9.5**。

### 9.5 数据库备份与恢复演练

⚠️ **先说清楚为什么不是 `pg_dump`**：本机未装 PostgreSQL 客户端，`pg_dump` 在计划任务里"找不到命令"是典型的**静默失败**——任务状态显示成功、备份目录为空，等到真要用的时候才发现三个月没备份。所以备份是**纯 Node 实现**（复用后端已有的 `pg` 驱动），不依赖任何外部二进制。

**一句话原理**：连库开一个 `repeatable read read only` 快照 → 逐表以 `ctid` 键集分页导出 NDJSON → gzip → AES-256-GCM 加密 → 落盘 + 传百度网盘 → **立刻读回自检**。

#### 9.5.1 两个计划任务

| 任务名 | 频率 | 命令 | 作用 |
|---|---|---|---|
| `GrowingKids-DB-Backup` | 每日 **03:30** | `node scripts/db-backup.mjs --quiet` | 备份 + 上传 + 保留策略 |
| `GrowingKids-DB-Drill` | 每周日 **04:30** | `node scripts/db-restore.mjs --verify` | 空库恢复演练 + 内容比对 |

注册（**只需一次**，脚本自带 UTF-8 BOM，缺 BOM 时 PS 5.1 会按 GBK 读中文注释并解析崩溃）：

```powershell
cd server/scripts
powershell -ExecutionPolicy Bypass -File register-backup-task.ps1
```

脚本给出的几个关键取舍，**不要"优化"掉**：

| 取舍 | 理由 |
|---|---|
| node 路径必须是系统安装目录（`D:\Program Files\nodejs\node.exe`） | 指向 `.workbuddy\binaries\` 会在 WorkBuddy 升级时被清理 ⇒ 任务每天"成功"但什么也不做 |
| `-LogonType Interactive` | 本机 node/python 在用户目录下，S4U 账户跑起来找不到命令（静默失败的另一种形态） |
| `-StartWhenAvailable` | 笔记本 03:30 可能在睡眠，醒来补跑 |
| `-MultipleInstances IgnoreNew` | 防上次没跑完又叠一次 |

#### 9.5.2 日常判读

```bash
# 最近一次备份结果（一行 JSON）
tail -1 server/logs/backup-$(date +%F).log

# 本地备份清单
ls -lh server/backups/

# 最近一次演练结果
tail -1 server/logs/drill-$(date +%F).log
```

**退出码语义**（计划任务的 `LastTaskResult` 直接对应）：

| 码 | 含义 | 要不要管 |
|---|---|---|
| `0` | 全链路成功 | 不用 |
| `1` | 致命失败（连不上库 / 口令缺失 / 自检不通过） | **要管**，当天就得看 |
| `2` | **本地备份成功，网盘上传失败** | 要管，但不紧急——本地还有一份，异地那份缺了 |

#### 9.5.3 备份文件格式 `GKBK`

```
 4B 魔数 "GKBK" │ 1B 版本 │ 16B scrypt 盐 │ 12B GCM IV │ 16B 认证标签 │ 密文
                                                              密文 = gzip(NDJSON)
```

选 **GCM** 而非 CBC 的理由只有一句：**备份最怕的不是打不开，是能打开但内容是错的**。GCM 的认证标签会把"文件被截断/篡改/半个字节损坏"变成硬失败，而不是解出一堆看似正常的坏数据。

**口令**：`BACKUP_PASSPHRASE` 在 `.env.secrets`。首次运行若无此变量，脚本会自动生成 32 字节 base64url 口令追加进去，并把明文写一份到 `server/backups/KEY-ESCROW.txt`。

> 🚨 **`KEY-ESCROW.txt` 是唯一的口令明文留存**。口令丢了 = 所有备份永久打不开（不是"难恢复"，是**打不开**）。请把它另存到密码管理器或打印留存。`server/backups/` 已在 `.gitignore`。

#### 9.5.4 三种恢复模式

```bash
cd server
node scripts/db-restore.mjs --inspect                      # 只读：解密后列出表/行数，不连库
node scripts/db-restore.mjs --verify                       # 演练：建空库→跑迁移→灌数据→逐表比对
node scripts/db-restore.mjs --netdisk --verify             # 演练：从网盘下载那份，验证异地备份可用
node scripts/db-restore.mjs --apply --target <url> --yes   # 真恢复（打到生产还要 --force-prod）
```

**`--verify` 怎么做到"不碰生产"**：用 postgres 超级用户（`rolcreatedb=true`，`migrator` 无此权限）建一个**固定名**空库 `gk_rehearsal`，跑完整迁移链再灌数据，逐表比对 **行内容多重集 sha256**（把行 JSON 排序后取哈希，与插入顺序无关，只比内容）；结束在 `finally` 里 `drop schema public cascade` + `create schema public` 清空——**库名固定、schema 清空**，所以既不会越积越多，也不会残留第二份用户数据。

> ⚠️ 两个已知坑：① **不要用 `drop database`**——Supabase pooler 会话滞留会让它稳定报 `is being accessed by other users`，实测重试 10 次 50 秒仍失败；② `schema_migrations` **不在 `migrations/` 里**（它是 `migrate.mjs` 自己建的记账表），空库恢复必须显式先建，改一边必须改另一边。

#### 9.5.5 实测基线（2026-10-27）

| 项目 | 结果 |
|---|---|
| 单次备份 | 18 表 / 519 行 / NDJSON 297.6 KB → 加密后 **64 KB**，**2.6s** |
| 计划任务实跑 | `LastTaskResult = 0`，5.8s 产出并上传 |
| 恢复演练 | 16 个迁移全过 → **18/18 表内容哈希完全一致**，8–9s |
| 从网盘恢复 | 下载 → 解密 → 空库恢复 → 同样 **18/18 一致** |
| 演练幂等 | 第二次显示"复用演练库 / schema 已清空"，结束 `public 表数量: 0` |

#### 9.5.6 发布前必须重跑一次演练

`--verify` 不只是"备份能解开"，它同时验证了**迁移链在空库上能不能跑通**（`R-工程-09`：`migrations/` 是 schema 唯一真相源）。所以每次发版前跑一次，等于顺手做了一次 schema 回归。这条已列入 7.1 阻断项。


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

### 剧本 11：备份"每天都在跑"，但其实一直在失败

- **症状**：计划任务状态 `0x0`（成功），`server/backups/` 里却是空的，或最后一份是几周前的。
- **根因（三种，按概率排序）**：
  1. **node 路径指向 `\.workbuddy\binaries\`** —— WorkBuddy 升级清理该目录后，任务"执行成功、什么也没做"。→ 检查任务动作里的 node 绝对路径，必须是系统安装目录。
  2. **任务注册成了 S4U/无登录运行** —— 本机 node/python 在用户目录，找不到命令。→ `-LogonType Interactive`。
  3. **退出码 2 被当成失败忽略** —— 2 = 本地成功、网盘失败。本地有备份，异地没有。
- **判断**：
  ```bash
  tail -5 server/logs/backup-*.log          # 每个自然日一行 JSON
  schtasks /query /tn GrowingKids-DB-Backup /v /fo LIST | grep -E "结果|上次运行"
  ```
- **恢复动作**：`Start-ScheduledTask -TaskName GrowingKids-DB-Backup`，5–10 秒后看日志与 `server/backups/` 是否有新 `.gkbk`。

### 剧本 12：备份文件解不开

- **症状**：`db-restore.mjs` 报「口令不对，或备份文件已损坏（GCM 校验不通过）」。
- **按顺序排除**：
  1. **口令变了**：`BACKUP_PASSPHRASE` 在 `.env.secrets`，与备份时用的不是同一个 → 对比 `server/backups/KEY-ESCROW.txt`。
  2. **文件被截断**：对比本地文件与网盘上的 `size`（备份脚本上传后会回读 size 核对，日志里有 `uploadSize`）。不一致就重下。
  3. **真的损坏**：换一个更早的备份（本地默认保留 14 份）。
- ⚠️ **GCM 校验不通过就是"不要用"**，不是"试试能不能打开"。这是选 GCM 而非 CBC 的全部意义。
- ⚠️ 如果口令确实丢了且 `KEY-ESCROW.txt` 也没了，**所有历史备份永久失效**——这种情况只能从 Supabase 控制台的数据库备份恢复（免费套餐无此能力，见 `R-技术-06`）。

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
| `server/scripts/db-backup.mjs` | **数据库备份**（快照→NDJSON→GCM→本地+网盘→自检） | `node scripts/db-backup.mjs [--no-upload] [--keep N] [--out <path>] [--quiet]` |
| `server/scripts/db-restore.mjs` | **恢复 / 演练** | `node scripts/db-restore.mjs [--inspect\|--verify\|--apply --target <url> --yes] [--netdisk] [--force-prod]` |
| `server/scripts/register-backup-task.ps1` | **注册两个备份计划任务**（带 UTF-8 BOM，勿删 BOM） | `powershell -ExecutionPolicy Bypass -File register-backup-task.ps1` |
| `server/scripts/rotate-wx-secret.mjs` | **WX_SECRET 轮换助手** | `node scripts/rotate-wx-secret.mjs [--check\|--secret <32位>]` |
| `server/scripts/lib/gk-env.mjs` | 脚本公用环境加载器（.env / .env.migrate / .env.secrets 合并） | 被上面几个引用 |
| `server/scripts/lib/backup-format.mjs` | `GKBK` 加密格式读写与口令托管 | 被 backup/restore 引用 |
| `server/scripts/lib/netdisk.mjs` | 百度网盘最小客户端（纯 Node，备份用） | 被 backup/restore 引用 |
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
| **v1.1** | 2026-10-27 | **补数据库备份与恢复演练整章（9.5）**（`R-技术-06` 落地）：为什么不走 `pg_dump`（计划任务里静默失败）、`GKBK` 文件格式与选 GCM 的理由、口令托管与丢失后果、两个计划任务的注册与四项不可优化的取舍、退出码 0/1/2 语义、三种恢复模式、`--verify` 如何不碰生产（固定库名 `gk_rehearsal` + `drop schema` 而非 `drop database`）、实测基线五项；**新增故障剧本 11/12**（备份天天"成功"其实一直失败 / 备份解不开）；**7.1 阻断项新增「48 小时内备份 + 演练通过」**；`WX_SECRET` 项改为单命令 `rotate-wx-secret.mjs --check`；第 11 章脚本清单补 6 条（含 `lib/` 三个）。订正 9.4 末尾已过时的 "每日 `pg_dump`" 表述 |
| **v1.2** | 2026-10-27 | **新增 4.5「用户隐私保护指引申报（mp 后台 · 唯一人工步骤）」完整操作手册**（`R-合规-05` 落地抓手）：4.5.1 **两个入口的判断树**——查证官方口径后确认「**未发布上线的小程序无法更新隐私指引，审核通过也不生效**」，故本项目当前只能走**提审页的入口2**，原 4.2 写的「设置 → 服务内容声明」路径已于 2026-10-27 实测不存在；4.5.2 前置三条件；4.5.3 **10 步操作表**；4.5.4 为什么恰好是这 4 项（附代码依据 + 自查 grep 命令）与「剪切板只写也必须勾」的官方依据；4.5.5 四段可粘贴文案；4.5.6 保存期限（含备份 14 天披露）；4.5.7 第三方共享 5 条（含百度网盘运维备份、Supabase 数据出境）；4.5.8 **6 步验证表**（真机 + 体验版才算数）；4.5.9 留痕表；4.5.10 五个最容易做错的地方；4.5.11 与「本期不发正式版」的 A/B 冲突及方案 B 会命中 `errno 112` 的后果。<br>**订正 4.2 第 2 条**（旧路径 + 「只勾相册摄像头」的错，改为 4 项 + 指向 4.5）；**7.1 阻断项**把隐私一项从"一句话"拆成 6 个可勾选子项 |
