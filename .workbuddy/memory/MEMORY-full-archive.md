# Growing-Kids 长期约定（r15）

> 详细过程见：`docs/reports/`（实测报告）、`docs/design/method/`（提案单/台账）、`docs/design/GK-QA-16-*.md`（运维手册）、教训录 L<n>。本文件只留**判据、红线、踩过的坑**。
> ⚠️ **本文件上限约 32KB（超了会被注入截断）**：新增先想「能不能只写进 docs 再在这里留一行指针」，别把过程铺进来。

## 0 定位与流程
- 家长主用、孩子次要。改「学习行为」功能先过 20a §5.1 三问决策器 + §6.2 M1–M11；证据查 20b。
- 流程 GK-OPS-22（L0/L1/L2＋提案单 `method/proposals/P-NNN`＋台账 D 号）；⚠️ 先查台账再评审。
- 缺口序 C3 错因 > C2 信心 > C1 掌握梯度 > C5 交错。⛔ 励志推送／智能排程／"算出 ZPD"／打卡时长激励。

## 1 环境
- **commit≠发货**：前端 `build:weapp` → 开发者工具重编译 → 真机重扫码；🔴 **后端同样要换 `server/dist` 到 L3 并重启 `gk-api`**；验 dist 用 grep 特征串。
- 后端 `npx nest build` → 杀 3001 → `POST :3002/wake`（⚠️ `/wait-ready` **只等不拉**，必须先 wake 再 wait）。OCR venv 在仓库外 `D:/AI/gk-ocr-env`。
- #117 spawn OCR python 必走 `pythonEnv()`、stdout 走 `decodeEngineChunk()`；判据：中文绝不出现 U+FFFD。
- **push 等思傅指示；本地 commit 照常。**
- 🔴 **两套库别搞混（11-05 踩过）**：**生产 = L3 `42.192.36.120`** → `SUPABASE_URL=http://127.0.0.1:8080`(PostgREST→本地 PG `gk`) + `STORAGE_DRIVER=local` + `STORAGE_PUBLIC_BASE_URL=http://42.192.36.120`，密钥 `/etc/gk/secrets.env`。**本地 `server/.env` + `.env.migrate` 仍指 Supabase 云 `yjsuzunoxvyrblhuigpv`，那是迁库遗留的开发库、不是现网**（本地 3001、verify 套件都读它 ⇒ 造的号只进开发库）。L3 PG 只听 `127.0.0.1:5432`、外网仅 22/80 ⇒ 本地直连不上生产。凡「现网数据/删除」**必须 ssh 上 L3** 执行；删前先 `sudo -n -u gk node scripts/db-backup.mjs --no-upload`。

## 2 数据红线
- 无 RLS ⇒ 查询必须 `.eq('user_id', userId)`；删除加 `.select('id')` 校行数；`check:isolation` 是门禁。
- 新表外键 `user_id` 必须 varchar(36)；建表后 `--force --only` 重跑迁移。⚠️ `shared/schema.ts` 是 `@ts-nocheck` 死代码，真相源只有 `migrations/`。
- ⚠️ 空串 ≠ NULL：外键从 state 回写前 `trim()` 判空（`timeline_items` 已踩）。
- 迁移用低权 migrator（`.env.migrate`）；pooler 改密码后首连必失败，重试即通。
- 管理员 `users.role`(0017)＋`requireAdmin()` fail-closed；提权唯一入口 `promote-admin.mjs`；⚠️ role 单独 `select("role")`。
- 去重：`blob_objects` 内容寻址＋ref_count；`(user_id,file_hash)` 查重**必须在 ingest 之前**；改引擎/切分 ⇒ 必改 `OCR_ENGINE_VERSION`。
- 存储 key 只 ASCII；含 `*_images` 的读端点必须过 `withUrls`；合成导出只吃 PNG/JPEG。
- 🔴 **媒体读端点必须 `res.sendFile`，禁手写 `createReadStream().pipe()`**：pipe 不给 `Content-Length`、不处理 Range（带 Range 仍回 200）⇒ 图片没事，微信 `InnerAudioContext` **播不动**。判据：`curl -D - -H 'Range: bytes=0-1023'` 应回 206 + `Content-Range`。前端另两条：`obeyMuteSwitch=false`、`onError` 必打 `errCode`。见 QA-16 §6.4。

## 3 接口与前端
- 前缀 `/api/`；禁传 undefined 进 query；中文名 `original_name=encodeURIComponent(name)`。`/api/upload`：`save`=建条目，`attach`=只持久化，附件类必须 attach。
- ⚠️ 隐私接口失败禁 `catch {}`：用 `reportChooseFail()`（errno 112=隐私未生效）；先 `await guardPrivacy()`。
- 🚨 `__usePrivacyCheck__` 是自锁开关：true 且平台未代配 ⇒ 基础库挂起所有隐私接口 ⇒「点了没反应」。默认关。Taro 4.1.9 只有 `.d.ts`，取 API 走 `globalThis.wx`。
- ⚠️ 头像昵称不能直取：原生 `button open-type=chooseAvatar` + `input type=nickname`（`ui/Button` 基于 View，openType 无效）。头像只存 key，`<Image src>` 过 `storageFileUrl(key)`。
- 🔴 **输入框光标（11-02 十三/十四轮定型，教训录 L30，门禁 M12＋M18-11）**：①表面规则＝**下发值≠原生文本就改回去、光标甩末尾**。②**两层病根**：(a) Taro `restoreStateIfNeeded` 在 `finishEventHandler` 里拿 `event.detail.value` 对比 fiber 的 `props.value`，React 18 对事件 setState 批处理 ⇒ props.value 停上一拍 ⇒ 刚打的字被改回（英文逐字符/连删必现，中文一次上屏侥幸没事）；(b) 就算 `flushSync()` 让 props.value 同步了，**视图层晚到的 setData 才是终极凶手**（payload 每次提交都塞 `value`，`FormElement.dispatchEvent` 的 INPUT 分支又 `this.value=val` 且 `setAttribute` 不判等 ⇒ 每键多一次 setData，后到的旧值覆盖新字）。③**治法＝两个 pnpm 补丁**：`patches/@tarojs__react@4.1.9.patch`（payload 里与元素当前值相同的 value 摘掉）＋`patches/@tarojs__runtime@4.1.9.patch`（INPUT 只同步 `this.props.value`，不 setAttribute）；组件侧**丢掉 `detail.value` 非字符串的 input 事件**（视图层回声，照抛就是 `setContent('')` ⇒ 清空）；input 里用 `flushSync()`。🚨 **payload 绝不能返回 null**：`commitUpdate` 提前返回 ⇒ `__reactProps$` 不更新 ⇒ **整段文本写成空串**（实测连打 16 字长度 0）；返回 `[]` 才对。④⛔ 延迟上抛／不传 value／`defaultValue`／运行时改写 `FormElement[Symbol.hasInstance]`（打断 Babel `_classCallCheck` ⇒ 白屏）。⑤`focus={false}` 是**强制失焦**、`cursor={-1}` 是**置末尾**、写 `undefined` 也留键 ⇒ **条件展开**；`cursor` 只在变化那拍算定位请求。工具 `server/scripts/ide-write-stack.mjs`。
- ⚠️ `ui/textarea.tsx`：maxlength 默认 -1；`style` 只落外壳；内置 `cursorSpacing=24`/`showConfirmBar`/`adjustPosition`/`disableDefaultPadding`；`autoHeight` 时只能 `minHeight`（内外两层都给）。**外壳禁挂 `onTouchStart`**（打断长按选区）。✅ 全仓输入框统一走它，新增一律不加新实现。
- ⚠️ 法律文案（协议/隐私）必须走 `components/legal-text.tsx`：constants 用 `**强调**`，直塞 `<Text>` 会原样显示星号。
- ⚠️ 程序化插入：`request(pos)`＋`refocus()` 造 focus 边沿；setState 与 `setShot` 要在**同一事件回调**；refocus 边沿 60ms。
- ⚠️ Taro 4.1.9：**Text 不绑 onClick（用 View）**；首帧数据可 null；render 相位 setState 被丢弃；字号下限 12px。
- 🔴 `downloadFile`/`uploadFile` 只补域名不注入令牌 ⇒ 打自家 `/api` 的下载必须 `header: buildHeaders()`；公网签名直链**不要**带头。
- 🔴 service 层必须自己 `unwrap`；调用方出现 `(res as any).data?.data` 就是契约断了。驼峰/snake 也在 service 层转完。
- **M18 前端红线**：Text onClick／downloadFile header／禁双重解包／引 guardPrivacy／maxlength=-1／禁 process.env／禁空 catch／列表 finally 解 loading／引 guardPolicy／同意键禁硬编码／多行输入框 onInput 当场 setState。
- 令牌：**X-Auth-Token 唯一被采信身份**，裸 X-User-Id 一律 401；CORS 必暴露它。新增免登录端点必须同步 `PUBLIC_ROUTES`。
- 必须关 HTTP 协商缓存（ETag ⇒ 304 空 body ⇒ `unwrap` 当失败 ⇒ 列表静默不刷新）。列表 `silent` 只约束「开始」，解除骨架无条件、由最后一个在途请求做（计数不用布尔）。
- 🔴 **`navigateBack` 回来的页面不会重新 mount** ⇒ `useEffect` 不重跑 ⇒ 停旧数据。凡「编辑/新增页返回后要看新内容」，一律补 `useDidShow` + `firstShowRef` 跳首帧，用 `silent: true` 刷新。已落 `memory/index`、`memory/detail`，同类照抄。
- ⚠️ 小程序端**音视频不能用原生小写标签**（被 Taro 当自定义元素 ⇒ 点了没反应）。音频 `Taro.createInnerAudioContext()`（`useDidHide` 里 `stop()+destroy()`；`useUnloadEffect` 不在 `@tarojs/taro` 类型导出里）；视频用 `@tarojs/components` 的 `<Video>` 且**必须给确定高度**。
- ⚠️ `<Image>` / `<Video poster>` **不发请求头** ⇒ 服务端只回 `cover_key` 时前端拼不出地址（整片白图）。列表接口应由服务端 `getPublicUrl()` 直接给 `*_url`，前端留 `storageFileUrl(key)` 兜底。
- ⚠️ 存储读端点 MIME 表要覆盖 mp4/mov/mp3/m4a/aac/wav：一律 `application/octet-stream` 时 `<Video>`/`InnerAudioContext` **不报错也不播**。
- 🚨 微信 request/uploadFile **超时上限 60s** ⇒ >60s 走 `POST /api/jobs` 202+轮询；`uploadFile` 无解 ⇒ 压缩减体积。
- 新增任务类型同步 5 处：`jobs.types`／`jobs.controller`／`jobs.service`／`jobs.module`／前端 `POLL_MAX_MS`。闸门拦在**提交阶段**；任务只在内存跑，**重启即 failed**。
- 🔴 业务隐私同意必须真拦写操作：`guardPolicy(action)` 与 `guardPrivacy` **串行两道**。⚠️ `guardPolicy` 的「去同意」**跳页面** `pages/privacy/index?from=guard`，不走 App 根弹层。
- 🚨 **App 根渲染出的兄弟节点根本不挂到页面**（`AppWrapper = h(App, props, elements)`）⇒ `<PolicyConsent/>` 挂 `app.tsx` 等于死代码（`useEffect` 里 `setVisible(true)` 也被丢）。现在挂首页 + `useState(() => !hasAgreedPolicy())` 首帧画。`privacy-gate`/`Toaster` 同理不生效（前者仅兜底、后者零引用）。二级页由 `guardPolicy` 跳页面兜底。
- `/auth/me` 带 `role`（单独查）；管理入口按 role 渲染，权限由 `requireAdmin` 兜底。答案+解题合并一框，页面持唯一草案。
- **「资料库搜题」= 先自有资料（本库索引）→ 后 ima**（`mode=kb`）：走 `requireUserId()` 不拦 AI 开关；网盘挂了原样落 ima。🔴 **搜索只查本库 `netdisk_files`，要正文才去网盘读**：`netdisk-index.mjs --user <uuid> --apply` 递归列 `/学生` 只落文件名/路径（零下载）；实测遍历 12,501 目录/65,835 文件/1,415s（4 并发），检索端到端 0.5s（deep=0 热）/ deep=1 首查 3.2s / 缓存 1.3s。前端 `source='netdisk'` 采纳记 `library`。
- 🔴 **改 `note` 或 result 字段结构 ⇒ 必 bump `answer-search.service.ts` 的 `CACHE_VERSION`**（参与 `qHash`）：`answer_cache` 把整个 result 按 `(user_id,q_hash,mode)` 存着，命中原样返回 ⇒ build+部署+重启全做了用户还看到旧文案。判据：拿**没问过的新题**测。见 QA-16 §6.3.5。
- 记忆列表 `/api/memories` 服务端支持 `subject_id`/`since`/`tag`（**无 `until`**）。列表缓存 key 必须带筛选条件，否则切筛选先闪一屏旧缓存。
- 🔴 **索引日常靠 `gk-netdisk-index.timer`（周日 04:23，gk 账号，`/etc/gk/index.env` 给 uuid）**：`--budget-ms 5400000`＋`--full-clean`＋第二个 ExecStart 跑 `library-index-text.mjs`。**默认增量**（`--full` 强制全量）：目录 mtime 也写进 `netdisk_files`（`is_dir=true`），子目录 mtime 相同就整棵子树不发请求 ⇒ 日常 0.8~3s（全量 1,445s）。`method=listall` **不可用**（errno 20020），也没有 webhook。⚠️ 增量看不见「内容替换」，换教材版本用 `--full`。⚠️ 隐私政策承诺「每周一次同步」⇒ **停 timer 就是承诺不兑现**。
- 🔴 **三条防误删护栏**：① `--root` 不以 `/` 开头或含 `:`/`\` 直接退出（Git Bash 会把 `/学生/最新` 转成 `D:/Program Files/...`，列 0 条被判「完整遍历」，`--full-clean` **把 65,890 行全删了**）；② 本轮零文件不清库；③ 待删超库内一半要 `--force-clean`。教训：凡「遍历完整才删」必须同时校验「遍历真的走过了」。
- ⚠️ **用户可见面统一叫「资料库」，不出现「百度网盘」**；但**隐私政策第四节第三方接收方清单必须保留「百度网盘」**（法定披露）。
- ⚠️ **trgm 索引只在少条件时生效**：一次检索展开 8~12 个 `ilike` ⇒ PG 改选并行顺序扫描（6.5 万行 450ms）；单条件才走索引（3~10ms）。
- ⚠️ 隐私政策两处副本必须逐字一致，有校验手段：抽 `privacy-policy.ts` 关键行去 `**`/列表符号/空白后断言能在 `docs/legal/隐私政策.md` 里 `includes`（曾抓出「备案材料比客户端多两段」）。
- **自有资料库也能搜内容**：`library_docs` 0023 起有 `text_content`/`text_status`，入库异步抽正文，`keyword` 同时匹配 name 与正文；存量用 `POST /api/library/index-text`。
- 🔴 **抽正文失败不许标 `none`**：`none`=确认无文字层、不再重试。环境类失败（`no-python`/`no-script`/`timeout`）必须保持 `pending`（11-03 真踩：脚本没带 `OCR_PYTHON`，7 条被洗成 none，靠 `--force` 救回）。
- 🔴 **网盘凭证是运营者单账号**（生产 `BAIDU_*` = 思傅本人）：隐私 r5 写「你自己网盘」当前成立，**出现第二个真实用户即变成披露不实**（R-合规-08 硬前置：改 per-user OAuth / 关掉非运营者检索 / 改文案，三选一）。
- 🔴 **导航**：tab = 首页／复习本／**资料**／记忆。「资料」= `pages/library`（tab 只能 `switchTab`，`navigateTo` 会被拒）；汇总生成+导出在 `pages/summary`；面客说「资料」不说「文档」。
- ⚠️ **键盘遮挡**：`lib/use-keyboard-avoid.ts`（量 rect → 加 `scrollTop`＋键盘高度作内容底部留白）。微信 `adjustPosition` 只上推**页面**，本项目是固定高度 `ScrollView` 内部滚动 ⇒ 对底部输入框无效，必须自己滚。
- 🔴 **原生 button 三种例外**（`ui/Button` 基于 View，`openType` 无效）：头像 `chooseAvatar`、意见反馈 `contact`、同意键 `agreePrivacyAuthorization`。⚠️ `contact` 只在真机生效；须 mp 后台配客服人员。⚠️ button 默认边框是 `::after`，`border:none` 去不掉 ⇒ 用 `.gk-plain-btn::after{border:none}`。

## 4 AI 与品牌
- ⚠️ `users.ai_enabled`(0018) **默认 false**；`requireAiEnabled()` 拦 chat/message、answer-search、search/solve；改开关必须 `invalidateUserFlags()`。
- 个人主体 ⇒ AI 入口整体收起（`AI_PUBLIC_ENTRY=false`）。名统一**成长学童**，`陕ICP备2026030931号-1X`。
- 品牌令牌 `--brand`/`--brand-foreground` #0B3D2E/`--brand-text` #0B7A55；`utils/latex.ts` 编辑态不显示源码。网盘归档 `LIBRARY_NETDISK_SYNC=true` **只写不读**。

## 4A L3 托管（42.192.36.120，Ubuntu 24.04.4 / 4核4G60G）
- 栈：PG17.11(SSL) → PostgREST12.2.3 → Caddy(8080/80) → Node 3000 → OCR venv。代码根 `/opt/gk/server`（OCR 按 `__dirname/../../..` 找根 ⇒ 布局必须 `/opt/gk/{server,migrations,ocr-engine}`）。
- 🔴 `STORAGE_DRIVER=local` 同步两处：`PUBLIC_ROUTES` 加 `/^\/api\/storage\/files\//`（`<Image src>` 不发头 ⇒ 全 401 白图）＋ `STORAGE_PUBLIC_BASE_URL`（否则兜底 `127.0.0.1` ⇒ 整片空白**无报错**）。
- 🔴 Caddy 站点块**必须用 `handle` 包住** `file_server`，否则 `/api` 反代不生效。
- 🔴 `PROJECT_DOMAIN` 是**编译期常量**，改 `.env.local` 必须重建。⚠️ 微信白名单只收 HTTPS 域名，**IP 填不进去**。
- 🔴 Linux 下 `OCR_VENV_DIR` 不生效 ⇒ 必设 `OCR_PYTHON` + `PPSV3_PYTHON`；另补 `PADDLE_PDX_CACHE_HOME`/`XDG_CACHE_HOME`。
- 🔴 **手工部署只换 `dist` 会漏文件**：改 `ocr-engine/*.py` 必须单独 scp 到 `/opt/gk/ocr-engine/`（`dist` 里没有）。漏传时**接口不报错**，静默降级。判据：`hits[].hit` 有没有 `content`，或 `journalctl | grep pdf-tool` 看 `unrecognized arguments`。见 QA-16 §6.1.1。用户是 `ubuntu`（不是 root），`/opt/gk` 要 `sudo -n`。
- ✅ 精准线 3.2.2+oneDNN：有效开关是 **PaddleX 层 `PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT`**（须在 import paddleocr 前设）。现网 `/opt/gk/.venv-py322`：9.63→**2.41s/页**、RSS 1610MB。回退=改 `PPSV3_PYTHON`。别用 `--once` 冷启动口径。
- 🔴 两条链路两个脚本：快速=rapid→`main.py`，精准=PP-StructureV3→`main3.py`，**补丁两处都改**；PP-StructureV3 另需 `paddlex[ocr]`。`withPpsv3Gate` 并发闸门防两个 1.6~1.8GB python 同时起 OOM。
- 🔴 `--mode both` 会重复文本 ⇒ 生产 `OCR_ENGINE_MODE=rapid`。判 OCR 好坏**看置信度不看区数**。
- 搬数据在云主机做；校验 `PGTZ=UTC` +「两侧 pg_dump 排序比字节」；`--disable-triggers` 的 dump 只能 `postgres` 导入 + `--single-transaction`。外网只暴露 22/80。

### 4A-1 生产备份
- 🔴 **`gk_backup` 必须 `bypassrls`**：`ocr_results` 有 RLS 无 policy ⇒ 否则**静默 0 行**。
- 🔴 口令丢了=备份永久作废：有历史备份+缺口令就**抛错**，须 `--new-passphrase`；恢复用 `ensurePassphrase(false)`。记 `sha256(口令)前12位`→`KEY-FINGERPRINTS.txt`。
- 🔴 `KEY-ESCROW.txt` 只有一个槽位 ⇒ 旧代次必然无副本；口令与数据同机 ⇒ 交付前让人抄走离线保管。
- 🔴 百度网盘分片按会员档：4/16/**32MB**，片数 ≤1024，上传超时 300s；恢复解包必须 `--no-overwrite-dir`。
- DB 每日 03:17(keep 14)、文件周日 03:47(keep 6)，`Persistent=true`，产物 `/var/lib/gk/backups`。**库与文件缺一不可**。

### 4A-2 结果指标
- 🔴 唯一够格指标 = **到期首次作答正确率（按档位）** ⇒ `0021 review_events` + `review()` 埋点。
- 🔴 口径：①按 `(item_id, due_on)` 取**最早**一条；②只算 `due_on <= 作答本地日`。M15 守着。
- 埋点失败**不得阻断作答**；软删题目**不**级联删事件。每档 ≥30 样本才出数；**当前 0 行**。
- 凭据：`.env.migrate`=gk_owner 可写；`.env.secrets` 的 `BACKUP_DATABASE_URL`=gk_backup 只读。

## 5 发布与托管
- 发版前轮换 WX_SECRET（`rotate-wx-secret.mjs`），**轮换后必跑 encrypt-env.mjs**。
- 🚨 开发管理已托管第三方 ⇒ 域名白名单配不了 ⇒ **发正式版必须先解除托管**；隐私走方案 W（QA-16 4.5.13）。
- **服务类目**：现「教育服务 > 教育信息展示」（已通过）；功能实质是工具 ⇒ 建议**保留 + 追加一个工具类目**（个人主体零资质）。⛔ 别删教育信息展示。**开发者联系方式两个来源别混**：①管理员手机号 = mp「成员管理 → 修改」；②「更多资料」页展示的是**隐私指引**的「用户怎么联系你」。
- 🔴 备案：轻量须包月≥3月、**L3 到期⇒备案失效**；个人主体**不碰前置审批**⇒文案**禁教育/培训/课程/辅导**，纯 API 会被驳回；**小程序备案 ≠ 域名备案**（域名 `deep-root.cn` 已于 11-04 过管局），首页 `server/www/index.html` footer 挂真实号＋`beian.miit.gov.cn` 链接。**公安联网备案待办**：32 位「数据码」**不是完成证明**（30 日有效的关联凭据），判据是拿到 `陕公网安备…号`。⚠️ 后缀与小程序不同（网站 `-2` / 小程序 `-1X`）。🔴 **首页 `<title>`/`<h1>` 必须与备案站名逐字一致**（曾写「学习记录」属驳回原因第 2 条）；**改站名先做变更备案**。要素真相源与操作步骤见 `docs/reports/公安联网备案操作指引.md` §2.4。
- ✅ 迁库零改查询（`.from()` 无参 `getSupabaseClient()`）⇒ 自签两枚 HS256 JWT。🔴 `SUPABASE_URL` 必须 `http://127.0.0.1:8080`；`service_role` 必须 **BYPASSRLS**。
- 💰 L3：188 档 + 同价续费 + 升配 3.5 折 ⇒ 三年 ¥649。先续费后升配、费用须 ¥0、只升不降。
- 装机坑：PGDG 用腾讯镜像；PostgREST `db-uri` 必须 TCP+密码；Caddy 写 IP 须 `bind 127.0.0.1`；首页须 `:80`；swap `swappiness` 60→10。
- 隐私指引 5 项，同意键必须原生 `button openType=agreePrivacyAuthorization`。`pnpm release:check`（--prepare/--revert）上传后**记得 revert**；生产 `WAKE_ENABLED=0`。

## 6 测试（GK-QA-21）
- 套件 `server/scripts/verify/`：21 模块 260+ 用例，新模块丢 `modules/NN-x.mjs` 自动发现；`pnpm verify:ci`。`harness.api()` 对幂等方法重试一次，POST 与超时不重试。
- **M16 三条硬门**：提案单六栏+引用可解析／禁用宣称词／镜像参数逐字一致。门只守结构，归因只有人能判。
- **造数据铁律**：同内容文件会命中去重 ⇒ 每次造图/PDF 必须内容不同。
- UI 实测通道：`server/scripts/ide-cdp.mjs` + `ide-*.mjs`（`--project dist --remote-debugging-port=9222`）；进程须在**同一个 `run_in_background` 任务**里启动+保活；停在启动窗口用 `ide-open-project.mjs`。
- ⚠️ 输入：一律 `Input.insertText`（`dispatchKeyEvent` 无 beforeinput，换行用 `insertText('\n')`）；**insertText 绕过输入法组合、且比真机快得多 ⇒ 测不出时序竞争**。不支持 `Input.imeSetComposition`。
- ⚠️ 光标判据：给原生 textarea 的 `value` setter 打桩，看**下发值 vs 原生文本**（`same:false` 就是故障本体），见 `ide-caret-ime.mjs`。
- 🔴 **测试期禁用真登录**：`/auth/login` 会把匿名号数据**整体迁移**进正式账号。切身份只换令牌：`ide-account.mjs use real|anon`。
- 🔴 判图必须真载：`<Image>` 编译成 `<wx-image>` + 内层 div `background-image`，`document.images` 恒为 0。
- ⚠️ IDE 自动化四坑：①鼠标事件必带 `buttons:1`；②「没反应」先查闸门 `gk_policy_agreed_v1`（`wx.showModal` 不在 DOM）；③`chooseMedia` 走 Promise；④选图必经裁剪编辑器，出口是「保存并替换原图」。

## 7 复习排程（C4）
- 真相源 `timeline/review.ts`（零 import）；列在 `timeline_items`(0019)。五档 **1→3→7→14→28 天**毕业；**做对推进、做错归零**；基准=上次复习时间。
- ⚠️ `content.review_count` 已废 ⇒ 读列；前端不自算 plan。改间隔表触发 M15 —— 三处同步：20b §4.3/§5.2.1、20a M8、断言。

## 8 CI / OCR 真值 / 导出
- CI：`gate`=build:server→build:weapp→`M12 M13 M16`；`api-core` 需 5 secret 才跑 M01–M08/M15。
- OCR GT `scripts/ocr-gt/`：退出码 2 = 环境跑不起来；`knownIssue`=xfail；`R-算法-07` 竖式符号行丢失（未修）。行级阅读序=按行中心聚视觉行、行内按 x。
- 导出口径：`include_answers` 不传 = 不含答案；验它只能解包 .docx。
- 🔴 **PDF 只有 paddle**：`recognizePdfDoc` 固定走 ppsv3，**没有 rapid 选项**；UI「快速/精准」只作用于单页图片。
- 🔴 PDF 页数上限取严：`OCR_PDF_MAX_SCANNED_PAGES=8`（硬截断不报错）+ 300s÷26s≈11 ⇒ **有效 8 页**；文字层 50 页。

## 9 方法论（20a 规范层 / 20b 证据层）
- **M11**：连续天数/停留时长只作引导性展示，不得作判定标准或硬门槛。
- 🚨 **20b 第 7 章标题不可动**：`method-gates.mjs` 用正则算文献号上界，重排 ⇒ `refMax=0` ⇒ H1 **静默跳过**。
- 批量改文档：脚本 +「命中 1 次」断言，别逐个 Edit；历史变更记录原表述要保留。
- 引用：准则 `GK-SRS-20a M<n>`，证据 `GK-SRS-20b 文献 <n>`。改准则走 **L2**：提案单 P 号 + 台账 D 号 + 20a 升主版本 + 20b 补条目 + 全仓引用同步 + GK-00 变更记录。
- 工作方法：同一 bug 改到第三版就**停下建复现模型**（L27）；平台规则必须从**源码/文档**抠（L28）。修烦恼型 bug 前先写"最坏会怎样"，最坏是内容丢失就先改到最坏只是"烦恼依旧"才准上真机。
- 🚨 **测试通道决定结论上限**：`insertText` 绕开输入法、且比真机快 ⇒ 「全绿」只覆盖它走过的路径（L30）。

## 10 年级属性与按年级检索（P-005 / D-008 / 0025）
- 口径：12 档连续编号（小1–6 / 初7–9 / 高10–12）；真相源 `server/src/shared/grade.ts`，前端镜像 `src/constants/grades.ts`（**不跨端 import**），一致性由 **M26** 守（⛔ 不是 H3）。
- 三列语义不同：`users.grade`=当前年级（可改）／`grade_confirmed_year`=最近确认的学年起始年（9/1 东八区）／`timeline_items.grade`·`library_docs.grade`=**创建时快照**（升学不回溯）。
- 🔴 四条铁律：①扩散只看本年级**精确**命中数（含 NULL 会永不扩散）②`grade is null` **必须始终可见**③`normalizeGrade` **先挡空串**（`Number('')===0` 会落成一年级）④计数失败按 **0**。
- 🔴 界面筛掉用户内容 ⇒ **必须自带回退开关**（首页「✕ 显示全部年级」/资料库「· 显示全部」），且**开关本身也必须点得动**（曾写成 `<Text onClick>` ⇒ M18 拦下、真机没反应；改 `<View>` 后重传 `2026.11.04.5`）。
- 🔴 复习本／记忆／识别页**一律不传 grade**：到期复习必须看到所有到期题。
- 学年只给 `grade_rollover` **建议**，绝不后台改数（M11）。
- ⚠️ 新增「用户属性」字段必须查所有**按 user_id 搬数据**的迁移路径：`qr-login.migrateAnonymous` 只 update user_id，带不走 `users` 上的列 ⇒ 已补 `adoptGrade()`。
- ✅ `0025_grade.sql` **两库均已执行**（L3 于 11-04 21:26）。
- 🔴 **本地 commit ≠ 生产有代码**：年级功能曾因「生产库没 0025 **且** 生产 dist 没 `setGrade`」⇒ `PUT /settings/grade` 404 ⇒ 前端弹「保存失败」。排查先 `grep` 生产 dist 特征串；部署按 QA-16 §6.1.1「**先跑迁移、再换 dist 并重启 gk-api**」，旧 dist `mv` 成 `.bak-<时间戳>`。SSH：`ubuntu@42.192.36.120`，`sudo -n -u gk node /opt/gk/server/scripts/migrate.mjs --only <file>`（`--ping`/`--dry` 先验）。
- ⚠️ `gradeLabel()` 恒返回 **string**，未选年级是空串 `''` 不是 null。
- 🔴 **`users` 行数 ≠ 真实用户规模**：生产 197 = 196 匿名 + 1 正式（11-05 已清 117 个零数据空壳 → 80）；`findOrCreateByDeviceId()` 对每个新 `X-Device-Id` 自动建匿名号（TTL 30 天）。⚠️ **528 道题挂在 29 个匿名号上**是真机联调数据，**不能删**。
- 🔴 **异步任务提交闸门必须与同步端点同口径**：`POST /api/jobs` 曾**按 type 一刀切** `requireAiEnabled` ⇒ `mode=kb` 提交即 403 ⇒ 点了没反应。凡新增走 jobs 的通道，闸门按 `params.mode` 分流，**别按 type 一刀切**（`search`/`ai`/`search-solve` 仍必须 403）。M17 有回归。⚠️ 只改后端时**小程序包不用重传**，但 L3 必须换 `dist` + `restart gk-api`。

## 11 CDP 抓 IDE 日志的噪音判据
- 🔴 `remote-debug/appservice` target 会刷一批 `ReferenceError: wx is not defined`（`taro.js` → 几乎每个页面 js 顶层），那是注入器 eval 时没注入 `wx`，**不是崩了**；判据＝主逻辑层 `appservice/mainframe` 里 `typeof wx === "object"`、`getCurrentPages()` 正常。`devtools_app.html` 的 Protocol Error 同样是噪音。
- 读历史日志用 `Log.enable`（会**回放**）＋ `Runtime.consoleAPICalled`/`exceptionThrown`；`<wx-image>` 的「不再支持 HTTP」警告多来自存量绝对 URL。
- ⚠️ 「点击没反应」先查 `gk_policy_agreed_v1` 是否等于当前 `PRIVACY_POLICY_VERSION`（版本变更让旧同意失效）⇒ `guardPolicy` 弹原生 `showModal`（不在 DOM）/跳 `pages/privacy/index?from=guard`。

## 12 资料库搜题：原题判定硬闸（P-006 / D-009）
- 🔴 **旧病**：`mode=kb` 把「同专题教辅片段」当「本题答案」——`answer` 是另一道题的【分析】、`solution` 是文件名列表、却 `verified:true`。根因：主题词召回 + bigram「主题相似」打分 + `hits.length>0` 即 `verified:true`，**没有原题判定阈值**。
- 真相源 `server/src/shared/question-match.ts`（零 import）：`normalizeForMatch`/`extractDistinctive`/`isSameQuestion`/`judge`/`locateSolution`。🔴 **粗筛 keys 只收 ≥4 字长锚点**（短数值/字母只进 anchors）；🔴 `locateSolution` 按「锚点共现最多 → 解析标记优先 → 段更长」并把【答案】结论前置。
- `match_level = exact | topic | none`；🔴 **硬闸无数据源豁免**：网盘、`library_docs.text_content`、自有题库、**ima 语义检索**都必须过 `isSameQuestion()/judge()`（初版漏了 ima，M27 有 🔴 断言）。`topic` 必须 `answer:''`、`verified:false`、`solution` 不当解题过程渲染。
- 前端 `answer-editor.tsx`：分档标题 + **采纳双保险**（隐藏按钮＋保存前拦「非本题答案，不能采纳」）。
- `kb` 顺序：自有题库同题答案 → `library_docs.text_content` → 网盘 `exact` → ima（过闸）→ 兜底同主题资料；新增查库必须 `.eq('user_id', userId)`。
- 🔴 **前后端必须同步发货**：只换后端时旧前端拿到 `answer:''` 仍会「采纳」空答案，比不修更糟。
- 边界：ima 高亮片段短会多判 `topic`；`²` vs `^2` 归一化未统一；**只有 C（开放 AI 解题）才能保证解出这道题**，需改隐私政策 r5 + 重新同意 + 评估主体/备案，明确不做。

## 13 资料库正文索引（P-008 / D-011 · 方案 A 已完成）
- 🔴 **真天花板**：`searchLocal()` 只 `name/path ilike` ⇒ 题干词不在文件名里就**永远进不了候选池**，`judge()` 再准也用不上；`MAX_DEEP_FILES=3` 让 20 份候选只看 3 份。
- 🔴 **可抽率矩阵（50 份实测）**：docx **≈100%**；pdf **<1MB 90% / 1-5MB 0% / 5-20MB 12.5% / 20-40MB 0%** ⇒ **别再规划「全量抽 pdf」**，486GB 里绝大多数抽出来 0 字。`.doc` 10,503 份无解（L3 未装 `soffice/antiword/catdoc`），单独立项。
- ✅ **方案 A 已完成（11-06）**：docx 全量 + pdf<1MB + txt = 候选 **11,184 份 / 10.6GB**，实际抽完 **`ok` 10,454（93.5%）**、`none` 732、**候选池 `pending` 归零**，正文 **9,450.3 万字**。按类型 docx **98.8%**（均 11,372 字）/ pdf<1MB **82.9%**（均 3,564 字）/ txt **86.5%**。可抽量预估 10,441 → 实际 10,454（**+0.12%**，量的部分已落定）。成本：下载是唯一主项（0.9s + size_MB/10 ≈ 10MB/s），抽取几乎免费（69~149ms/份）。
- 🔴 **召回增量（全案目的证明）**：`AB=6` 文件名 **0** / 正文 **196**；`安培定则` 0/74；`游标卡尺` 0/14；`平行四边形` 129/1,102（仅正文 1,054，**放大 8.5×**）；`勾股定理` 70/817；`一元二次方程` 221/566。⇒ 题干符号片段在文件名里根本不可能出现。⚠️ **召回代码仍未改**，这 10,454 份正文只是躺在库里。
- 🔴 **正文 `ilike` 无索引 = 2.8 秒/词**（94MB 正文、78,430 行 Seq Scan）⇒ 题干 8~12 个 key 就是 **22~34 秒/次检索**，微信 60s 余量不够重试。所以 **`0026` trigram 是「前置条件」不是「优化项」**；且**短 key（2~3 字）必须显式排除**（trigram 只对 ≥4 字中文走索引，正好与 `extractDistinctive().keys` 只收 ≥4 字对齐）。
- 🔴 `netdisk-extract-text.mjs` 铁律：**默认 dry-run、`--apply` 才写**；**只写三列**；**环境类失败绝不写 `none`**（写 none=永久判死）；游标按 `id` 推进；口径必须与 `ensureText()` 逐字一致（`textOnly`/`maxPages:200`/50 字/200k 截断）。`M30` 14 条钉死。
- 🔴 **写库回滚锚点必留**（每次跑前记 `date -u`）：收尾段 `11-06 04:00:15+00`、续抽 `11-05 16:15:09+00`、试抽 `11-05 15:42:47+00`。撤销 = `update netdisk_files set text_content=null, text_status='pending', text_updated_at=null where text_updated_at > '<锚点>'`。**不记锚点就无法精确回滚。**
- 🔴 **PostgreSQL `text` 不接受 U+0000**：文件夹一个 NUL 整条 `update` 抛 `invalid byte sequence for encoding "UTF8": 0x00` ⇒ 该文档永远 `pending`，**一直重试一直失败，伪装成「环境失败」**。治法：`writeRow()` 统一过 `stripNul()`＋txt 分支**先剥 NUL 再判字数**（NUL 不在 `\s` 里会被算成有效字符 ⇒ 全 NUL 文件误判 `ok`）。M30 已加断言。
- ⚠️ **dry-run 的耗时模型系统性偏乐观**：只算下载+抽取，**没算 `GAP_MS=300ms` 节流与网盘时段差异** ⇒ 实测 1.41~1.74s/份（比预估慢 26~46%）。**引用它给的「串行约 X 小时」一律乘 1.4~1.5。**
- ⚠️ `netdisk-index.mjs` 的 upsert **不碰 `text_content/text_status`**（安全）；但 `--full-clean` 会 `delete` 行 ⇒ **连带丢已抽正文**，抽取前后禁跑。
- 🔴 **L3 跑长任务的铁律**：①`ssh host 'node x.mjs'` 的远端进程挂前台会话，**断连即 SIGHUP 被杀**（实测 03:07 `Connection reset`，日志截断在 1,550/2,297）⇒ 必须远端 `nohup` + 远端日志，另开 ssh 轮询；②`.env.migrate` 是 `600 gk:gk`，`ubuntu` 直跑必 `EACCES` ⇒ 写库脚本必须 `sudo -u gk -H bash -c '…'`。
- ⏸ 未批准（全在检索侧，一项没动）：`0026` trigram 迁移、`searchLocal()` 加正文召回、`keyHits` 加权、深挖走缓存。**不做这四步，9,450 万字对用户毫无价值。**


===== SNAPSHOT r17 2026-11-06 (full MEMORY.md before trim; do not delete) =====
# Growing-Kids 长期约定（r16 · 精简索引）

> 只留**判据、红线、踩过的坑的完整表述**在 `MEMORY-full-archive.md`（33KB，按需 Read）；本文件留**结论 + 定位指针**，保证注入不截断。
> 详细过程：`docs/reports/`、`docs/design/method/`、`docs/design/GK-QA-16-*.md`、教训录 L<n>。
> ⚠️ 新增先想「能不能只写进 docs 再在这里留一行指针」。

## 0 定位与流程
- 家长主用、孩子次要。改「学习行为」先过 20a §5.1 三问决策器 + §6.2 M1–M11；证据查 20b。
- GK-OPS-22（L0/L1/L2＋提案单 `method/proposals/P-NNN`＋台账 D 号）；⚠️ **先查台账再评审**。
- 缺口序 C3 错因 > C2 信心 > C1 掌握梯度 > C5 交错。⛔ 励志推送／智能排程／"算出 ZPD"／打卡时长激励。
- **push 等思傅指示；本地 commit 照常。**

## 1 环境
- 🔴 **commit≠发货**：前端 `build:weapp`→开发者工具重编译→真机重扫码；后端换 `server/dist` 到 L3 **并重启 `gk-api`**；验 dist 用 grep 特征串。
- `npx nest build`→杀 3001→`POST :3002/wake`（`/wait-ready` **只等不拉**，必须先 wake）。OCR venv 在仓库外 `D:/AI/gk-ocr-env`。
- #117 spawn OCR python 必走 `pythonEnv()`、stdout 走 `decodeEngineChunk()`；判据：中文绝不出现 U+FFFD。
- 🔴 **两套库别搞混**：**生产 = L3 `42.192.36.120`** → `SUPABASE_URL=http://127.0.0.1:8080`(PostgREST→本地 PG `gk`) + `STORAGE_DRIVER=local`，密钥 `/etc/gk/secrets.env`。**本地 `server/.env` + `.env.migrate` 仍指 Supabase 云 `yjsuzunoxvyrblhuigpv`，是迁库遗留的开发库、不是现网**（本地 3001、verify 套件读它 ⇒ 造的号不污染 L3）。L3 PG 只听 `127.0.0.1:5432`、外网仅 22/80。凡「现网数据/删除」**必须 ssh 上 L3**；删前先 `sudo -n -u gk node scripts/db-backup.mjs --no-upload`。

## 2 数据红线
- 无 RLS ⇒ 查询必须 `.eq('user_id', userId)`；删除加 `.select('id')` 校行数；`check:isolation` 是门禁。
- 新表外键 `user_id` 必须 varchar(36)；建表后 `--force --only` 重跑迁移。⚠️ `shared/schema.ts` 是 `@ts-nocheck` 死代码，**真相源只有 `migrations/`**。
- 空串 ≠ NULL：外键从 state 回写前 `trim()` 判空。迁移用低权 migrator；pooler 改密码后首连必失败，重试即通。
- 管理员 `users.role`(0017)＋`requireAdmin()` fail-closed；提权唯一入口 `promote-admin.mjs`；role 单独 `select("role")`。
- 去重：`blob_objects` 内容寻址＋ref_count；`(user_id,file_hash)` 查重**必须在 ingest 之前**；改引擎/切分 ⇒ 必改 `OCR_ENGINE_VERSION`。
- 存储 key 只 ASCII；含 `*_images` 的读端点必须过 `withUrls`；合成导出只吃 PNG/JPEG。
- 🔴 **媒体读端点必须 `res.sendFile`**，禁手写 `createReadStream().pipe()`（不给 Content-Length / 不处理 Range ⇒ 微信 `InnerAudioContext` 播不动）。判据 `curl -H 'Range: bytes=0-1023'` 应回 206。前端 `obeyMuteSwitch=false`、`onError` 必打 `errCode`。QA-16 §6.4。

## 3 接口与前端
> 光标补丁、Taro 细节、隐私组件的完整原理见 `MEMORY-full-archive.md` §3（勿删，踩过三轮）。

- 前缀 `/api/`；禁传 undefined 进 query；中文名 `encodeURIComponent`。`/api/upload`：`save`=建条目，`attach`=只持久化（附件类必须 attach）。
- 🔴 **输入框光标**（11-02 定型，门禁 M12＋M18-11）：**两个 pnpm 补丁缺一不可** —— `patches/@tarojs__react@4.1.9.patch`（payload 里与元素当前值相同的 value 摘掉；**绝不能返回 null**，要返回 `[]`，否则整段文本写成空串）＋`patches/@tarojs__runtime@4.1.9.patch`（INPUT 只同步 `this.props.value`，不 setAttribute）；组件 input 里 `flushSync()` 同步刷 setState，**丢掉 `detail.value` 非字符串的事件**（视图层回声会清空）。⛔ 延迟上抛／不传 value／`defaultValue`／运行时改写 `Symbol.hasInstance`（白屏）。`focus={false}`=强制失焦、`cursor={-1}`=置末尾 ⇒ **条件展开**。工具 `ide-write-stack.mjs`。
- ✅ 全仓输入框统一 `ui/Textarea`：maxlength 默认 -1、`style` 只落外壳、外壳禁挂 `onTouchStart`、`autoHeight` 只能 `minHeight`。新增一律走它。
- 🔴 `downloadFile`/`uploadFile` 只补域名不注入令牌 ⇒ 打自家 `/api` 的下载必须 `header: buildHeaders()`；公网签名直链**不要**带头。
- 🔴 service 层必须自己 `unwrap`；调用方出现 `(res as any).data?.data` 就是契约断了。驼峰/snake 也在 service 层转完。
- **M18 红线**：Text onClick（用 View）／downloadFile header／禁双重解包／guardPrivacy／maxlength=-1／禁 process.env／禁空 catch／列表 finally 解 loading／guardPolicy／同意键禁硬编码。
- 令牌：**X-Auth-Token 唯一被采信身份**，裸 X-User-Id 一律 401；CORS 必暴露它；新增免登录端点同步 `PUBLIC_ROUTES`。
- 必须关 HTTP 协商缓存（ETag⇒304 空 body⇒`unwrap` 当失败⇒列表静默不刷新）。列表 `silent` 只约束「开始」，解除骨架无条件、由最后一个在途请求做。
- 🔴 **`navigateBack` 回来的页面不会重新 mount** ⇒ 编辑/新增页返回后要看新内容，补 `useDidShow` + `firstShowRef` 跳首帧 + `silent:true` 刷新。已落 `memory/index`、`memory/detail`。
- ⚠️ 音视频**不能用原生小写标签**（Taro 当自定义元素）：音频 `Taro.createInnerAudioContext()`（`useDidHide` 里 stop+destroy）；视频用 `<Video>` 且**必须给确定高度**。`<Image>`/`<Video poster>` **不发请求头** ⇒ 列表接口服务端直接给 `*_url`，前端 `storageFileUrl(key)` 兜底。存储读端点 MIME 表要覆盖 mp4/mov/mp3/m4a/aac/wav。
- 🚨 微信 request/uploadFile **超时上限 60s** ⇒ >60s 走 `POST /api/jobs` 202+轮询。新增任务类型同步 5 处（`jobs.types/controller/service/module` + 前端 `POLL_MAX_MS`）；闸门拦在**提交阶段**；任务只在内存跑，重启即 failed。
- 🔴 业务隐私同意必须真拦写操作：`guardPolicy(action)` 与 `guardPrivacy` **串行两道**；「去同意」跳 `pages/privacy/index?from=guard`。
- 🚨 **App 根渲染的兄弟节点根本不挂到页面**（`AppWrapper = h(App, props, elements)`）⇒ `<PolicyConsent/>` 挂 `app.tsx` 等于死代码；现挂首页 + `useState(() => !hasAgreedPolicy())` 首帧画。`privacy-gate`/`Toaster` 同理。
- ⚠️ 隐私接口失败禁 `catch {}`（用 `reportChooseFail()`，errno 112）；`__usePrivacyCheck__` 是自锁开关，默认关；Taro 4.1.9 取 API 走 `globalThis.wx`；头像昵称用原生 `button open-type=chooseAvatar` + `input type=nickname`（`ui/Button` 基于 View，openType 无效）；法律文案走 `components/legal-text.tsx`。
- **「资料库搜题」= 先自有资料（本库索引）→ 后 ima**（`mode=kb`）：走 `requireUserId()` 不拦 AI 开关。🔴 **搜索只查本库 `netdisk_files`，要正文才去网盘读**：`netdisk-index.mjs --user <uuid> --apply` 只落文件名/路径（零下载）；检索端到端 0.5s（热）/ 3.2s（deep=1 首查）。前端 `source='netdisk'` 采纳记 `library`。
- 🔴 **改 `note` 或 result 字段结构 ⇒ 必 bump `answer-search.service.ts` 的 `CACHE_VERSION`**（参与 `qHash`）：`answer_cache` 把整个 result 按 `(user_id,q_hash,mode)` 存着，命中原样返回。判据：拿**没问过的新题**测。QA-16 §6.3.5。
- 🔴 **索引日常靠 `gk-netdisk-index.timer`**（周日 04:23，gk 账号）：`--budget-ms 5400000`＋`--full-clean`＋第二 ExecStart 跑 `library-index-text.mjs`。默认增量（目录 mtime 剪枝 ⇒ 日常 0.8~3s），`--full` 全量（1,445s）。⚠️ 增量看不见「内容替换」；`method=listall` 不可用（errno 20020），无 webhook。⚠️ 隐私政策承诺「每周一次同步」⇒ **停 timer 就是承诺不兑现**。
- 🔴 **三条防误删护栏**：① `--root` 不以 `/` 开头或含 `:`/`\` 直接退出（Git Bash 会转换路径 ⇒ 列 0 条被判「完整遍历」，`--full-clean` **把 65,890 行全删了**）；② 本轮零文件不清库；③ 待删超库内一半要 `--force-clean`。教训：凡「遍历完整才删」必须同时校验「遍历真的走过了」。
- ⚠️ 用户可见面统一叫「资料库」不出现「百度网盘」；**但隐私政策第四节第三方接收方清单必须保留「百度网盘」**（法定披露）。两处副本逐字一致有校验（抽 `privacy-policy.ts` 关键行去 `**`/空白后断言 `docs/legal/隐私政策.md` includes）。
- ⚠️ **trgm 索引只在少条件时生效**：一次检索展开 8~12 个 `ilike` ⇒ PG 改选并行顺序扫描；单条件才走索引（3~10ms）。**别以为装了 pg_trgm 就不慢。**
- `library_docs` 0023 起有 `text_content`/`text_status`，`keyword` 同时匹配 name 与正文；存量用 `POST /api/library/index-text` 补。
- 🔴 **抽正文失败不许标 `none`**：`none`=确认无文字层、不再重试；环境类失败（`no-python`/`no-script`/`timeout`）必须保持 `pending`。
- 🔴 **网盘凭证是运营者单账号**（生产 `BAIDU_*` = 思傅本人）：出现第二个真实用户即使隐私 r5 披露不实（R-合规-08 硬前置：per-user OAuth / 关掉非运营者检索 / 改文案，三选一）。
- 🔴 **导航**：tab = 首页／复习本／**资料**(`pages/library`)／记忆；tab 页只能 `switchTab`。汇总生成+导出在 `pages/summary`；面客说「资料」不说「文档」。
- ⚠️ 键盘遮挡用 `lib/use-keyboard-avoid.ts`（`adjustPosition` 对固定高度 ScrollView 无效）。🔴 原生 button 三种例外：头像 `chooseAvatar`、意见反馈 `contact`（仅真机）、同意键 `agreePrivacyAuthorization`；button 默认边框是 `::after`，`border:none` 去不掉。
- `/auth/me` 带 `role`（单独查）；答案+解题合并一框，页面持唯一草案。 `/api/memories` 支持 `subject_id`/`since`/`tag`（**无 `until`**），列表缓存 key 必须带筛选条件。

## 4 AI 与品牌
- ⚠️ `users.ai_enabled`(0018) **默认 false**；`requireAiEnabled()` 拦 chat/message/answer-search/search/solve；改开关必须 `invalidateUserFlags()`。
- 个人主体 ⇒ AI 入口整体收起（`AI_PUBLIC_ENTRY=false`）。名统一**成长学童**，`陕ICP备2026030931号-1X`。
- 品牌 `--brand` #0B3D2E / `--brand-text` #0B7A55；`utils/latex.ts` 编辑态不显示源码。网盘归档 `LIBRARY_NETDISK_SYNC=true` **只写不读**。

## 4A L3 托管（42.192.36.120，Ubuntu 24.04.4 / 4核4G60G）
- 栈：PG17.11 → PostgREST12.2.3 → Caddy → Node 3000 → OCR venv。代码根 `/opt/gk/server`（OCR 按 `__dirname/../../..` 找根 ⇒ 布局必须 `/opt/gk/{server,migrations,ocr-engine}`）。用户 `ubuntu`（不是 root），`/opt/gk` 要 `sudo -n`。
- 🔴 `STORAGE_DRIVER=local` 同步两处：`PUBLIC_ROUTES` 加 `/^\/api\/storage\/files\//` ＋ `STORAGE_PUBLIC_BASE_URL`（否则兜底 `127.0.0.1` ⇒ 白图**无报错**）。
- 🔴 Caddy 站点块**必须用 `handle` 包住** `file_server`。🔴 `PROJECT_DOMAIN` 是**编译期常量**，改 `.env.local` 必须重建；微信白名单只收 HTTPS 域名。
- 🔴 Linux 下 `OCR_VENV_DIR` 不生效 ⇒ 必设 `OCR_PYTHON` + `PPSV3_PYTHON`，另补 `PADDLE_PDX_CACHE_HOME`/`XDG_CACHE_HOME`。
- 🔴 **手工部署只换 `dist` 会漏文件**：改 `ocr-engine/*.py` 必须单独 scp 到 `/opt/gk/ocr-engine/`；漏传**接口不报错、静默降级**。判据 `hits[].hit` 有没有 `content`。QA-16 §6.1.1。
- ✅ 精准线 3.2.2+oneDNN：有效开关是 **PaddleX 层 `PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT`**（须在 import paddleocr 前设）：9.63→**2.41s/页**、RSS 1610MB。别用 `--once` 冷启动口径。
- 🔴 两条链路两个脚本：快速=rapid→`main.py`，精准=PP-StructureV3→`main3.py`，**补丁两处都改**；`withPpsv3Gate` 并发闸门防 OOM。🔴 `--mode both` 会重复文本 ⇒ 生产 `OCR_ENGINE_MODE=rapid`。判 OCR 好坏**看置信度不看区数**。
- 搬数据在云主机做；校验 `PGTZ=UTC` +「两侧 pg_dump 排序比字节」；`--disable-triggers` 的 dump 只能 `postgres` 导入 + `--single-transaction`。
- **生产备份**：`gk_backup` 必须 `bypassrls`（`ocr_results` 有 RLS 无 policy ⇒ 否则静默 0 行）；口令丢了=备份永久作废，有历史备份+缺口令就**抛错**；`KEY-ESCROW.txt` 只有一个槽位 ⇒ 旧代次必然无副本；百度网盘分片按会员档 4/16/**32MB**、≤1024 片、超时 300s，恢复解包 `--no-overwrite-dir`；DB 每日 03:17(keep 14)、文件周日 03:47(keep 6)，`Persistent=true`。
- **结果指标**：唯一够格 = **到期首次作答正确率（按档位）** ⇒ `0021 review_events` + `review()` 埋点。口径①按 `(item_id, due_on)` 取**最早**一条②只算 `due_on <= 作答本地日`；埋点失败**不得阻断作答**；每档 ≥30 样本才出数；**当前 0 行**。

## 5 发布与托管
- 发版前轮换 WX_SECRET（`rotate-wx-secret.mjs`），**轮换后必跑 encrypt-env.mjs**。`pnpm release:check` 上传后**记得 revert**；生产 `WAKE_ENABLED=0`。
- 🚨 开发管理已托管第三方 ⇒ 域名白名单配不了 ⇒ **发正式版必须先解除托管**。
- **服务类目**：现「教育服务 > 教育信息展示」（已通过），建议**保留 + 追加工具类目**，⛔ 别删。联系方式两个来源别混（管理员手机号 vs 隐私指引「用户怎么联系你」）。
- 🔴 备案：轻量须包月≥3月、**L3 到期⇒备案失效**；个人主体文案**禁教育/培训/课程/辅导**；**小程序备案 ≠ 域名备案**；首页 footer 挂真实号＋`beian.miit.gov.cn`。**公安联网备案待办**：32 位数据码不是完成证明，判据是拿到 `陕公网安备…号`。🔴 首页 `<title>`/`<h1>` 必须与备案站名**逐字一致**，改站名先做变更备案。要素真相源 `docs/reports/公安联网备案操作指引.md` §2.4。
- ✅ 迁库零改查询（`.from()` 无参）⇒ 自签两枚 HS256 JWT。🔴 `SUPABASE_URL` 必须 `http://127.0.0.1:8080`；`service_role` 必须 **BYPASSRLS**。
- 💰 L3：188 档 + 同价续费 + 升配 3.5 折 ⇒ 三年 ¥649；先续费后升配、费用须 ¥0、只升不降。装机坑：PGDG 用腾讯镜像；PostgREST `db-uri` 必须 TCP+密码；Caddy 写 IP 须 `bind 127.0.0.1`；swap `swappiness` 60→10。

## 6 测试（GK-QA-21）
- 套件 `server/scripts/verify/`：21 模块 260+ 用例，新模块丢 `modules/NN-x.mjs` 自动发现；`pnpm verify:ci`。`harness.api()` 对幂等方法重试一次，POST 与超时不重试。
- **M16 三条硬门**：提案单六栏+引用可解析／禁用宣称词／镜像参数逐字一致。门只守结构，归因只有人能判。**造数据铁律**：同内容文件会命中去重 ⇒ 每次造图/PDF 内容必须不同。
- UI 实测通道 `ide-cdp.mjs` + `ide-*.mjs`；进程须在**同一个 `run_in_background` 任务**里启动+保活。输入一律 `Input.insertText`（**绕开输入法组合、比真机快 ⇒ 测不出时序竞争**）。光标判据：给 textarea 的 `value` setter 打桩看「下发值 vs 原生文本」。
- 🔴 **测试期禁用真登录**：`/auth/login` 会把匿名号数据整体迁移进正式账号；切身份只换令牌 `ide-account.mjs use real|anon`。
- 🔴 判图必须真载：`<Image>` 编译成 `<wx-image>` + 内层 div `background-image`，`document.images` 恒为 0。IDE 四坑：鼠标事件带 `buttons:1`／「没反应」先查 `gk_policy_agreed_v1`／`chooseMedia` 走 Promise／选图必经裁剪编辑器。

## 7 复习排程（C4）
- 真相源 `timeline/review.ts`；五档 **1→3→7→14→28 天**，做对推进、做错归零，基准=上次复习时间。
- ⚠️ `content.review_count` 已废 ⇒ 读列；前端不自算 plan。改间隔表触发 M15 —— 三处同步：20b §4.3/§5.2.1、20a M8、断言。

## 8 CI / OCR 真值 / 导出
- CI：`gate`=build:server→build:weapp→`M12 M13 M16`；`api-core` 需 5 secret 才跑 M01–M08/M15。
- OCR GT `scripts/ocr-gt/`：退出码 2 = 环境跑不起来；`knownIssue`=xfail；`R-算法-07` 竖式符号行丢失（未修）。
- 导出口径：`include_answers` 不传 = 不含答案；验它只能解包 .docx。
- 🔴 **PDF 只有 paddle**：`recognizePdfDoc` 固定走 ppsv3，UI「快速/精准」只作用于单页图片。🔴 PDF 页数上限取严：`OCR_PDF_MAX_SCANNED_PAGES=8` + 300s÷26s≈11 ⇒ **有效 8 页**。

## 9 方法论（20a 规范层 / 20b 证据层）
- **M11**：连续天数/停留时长只作引导性展示，不得作判定标准或硬门槛。
- 🚨 **20b 第 7 章标题不可动**：`method-gates.mjs` 用正则算文献号上界，重排 ⇒ `refMax=0` ⇒ H1 **静默跳过**。
- 批量改文档：脚本 +「命中 1 次」断言，别逐个 Edit；历史变更记录原表述要保留。引用：准则 `GK-SRS-20a M<n>`，证据 `GK-SRS-20b 文献 <n>`；改准则走 **L2**（提案单 + 台账 + 20a 升主版本 + 20b 补条目 + 全仓引用同步 + GK-00 变更记录）。
- 工作方法：同一 bug 改到第三版就**停下建复现模型**（L27）；平台规则必须从**源码/文档**抠（L28）；修烦恼型 bug 前先写「最坏会怎样」，最坏是内容丢失就先改到最坏只是「烦恼依旧」。🚨 **测试通道决定结论上限**（L30）。

## 10 年级属性（P-005 / D-008 / 0025）
- 12 档连续编号；真相源 `server/src/shared/grade.ts`，前端镜像 `src/constants/grades.ts`（**不跨端 import**），M26 守（⛔ 不是 H3）。
- 三列语义不同：`users.grade`=当前（可改）／`grade_confirmed_year`=学年起始年（9/1 东八区）／`timeline_items.grade`·`library_docs.grade`=**创建时快照**（升学不回溯）。
- 🔴 四条铁律：①扩散只看本年级**精确**命中数（含 NULL 会永不扩散）②`grade is null` **必须始终可见**③`normalizeGrade` **先挡空串**（`Number('')===0`）④计数失败按 **0**。🔴 复习本／记忆／识别页**一律不传 grade**。
- 🔴 界面筛掉用户内容 ⇒ **必须自带回退开关**且开关本身点得动（曾写 `<Text onClick>` 被 M18 拦、真机没反应）。学年只给 `grade_rollover` **建议**，绝不后台改数（M11）。
- ⚠️ 新增「用户属性」字段必须查所有**按 user_id 搬数据**的迁移路径（`qr-login.migrateAnonymous` 只 update user_id ⇒ 已补 `adoptGrade()`）。⚠️ `gradeLabel()` 恒返回 string，未选是 `''`。
- 🔴 **本地 commit ≠ 生产有代码**：年级功能曾因「生产库没 0025 **且** dist 没 `setGrade`」⇒ `PUT /settings/grade` 404。排查先 `grep` 生产 dist 特征串；部署按 QA-16 §6.1.1「**先跑迁移、再换 dist 并重启 gk-api**」，旧 dist `mv` 成 `.bak-<时间戳>`。SSH：`sudo -n -u gk node /opt/gk/server/scripts/migrate.mjs --only <file>`（`--ping`/`--dry` 先验）。只改后端时**小程序包不用重传**。
- 🔴 **`users` 行数 ≠ 真实用户规模**：生产 80 = 196 匿名中清掉 117 个零数据空壳后 + 1 正式；`findOrCreateByDeviceId()` 对每个新 `X-Device-Id` 自动建匿名号（TTL 30 天）。⚠️ **528 道题挂在 29 个匿名号上**是联调数据，**不能删**。
- 🔴 **异步任务提交闸门必须与同步端点同口径**：`POST /api/jobs` 曾按 type 一刀切 `requireAiEnabled` ⇒ `mode=kb` 提交即 403。闸门按 `params.mode` 分流（`search`/`ai`/`search-solve` 仍 403），M17 有回归。

## 11 CDP 抓 IDE 日志的噪音判据
- 🔴 `remote-debug/appservice` 会刷一批 `ReferenceError: wx is not defined`（注入器 eval 没注入 wx），**不是崩了**；判据＝主逻辑层 `appservice/mainframe` 里 `typeof wx === "object"`。
- 读历史日志用 `Log.enable`（会**回放**）＋ `Runtime.consoleAPICalled`/`exceptionThrown`。⚠️「点击没反应」先查 `gk_policy_agreed_v1` 是否等于当前 `PRIVACY_POLICY_VERSION`。

## 12 资料库搜题：原题判定硬闸（P-006 / D-009）
- 🔴 **旧病**：`mode=kb` 把「同专题教辅片段」当「本题答案」（`answer` 是另一道题的【分析】、`verified:true`）。根因：主题词召回 + bigram「主题相似」打分 + `hits.length>0` 即通过，**没有原题判定阈值**。
- 真相源 `server/src/shared/question-match.ts`（零 import）：`normalizeForMatch`/`extractDistinctive`/`isSameQuestion`/`judge`/`locateSolution`。🔴 **粗筛 keys 只收 ≥4 字长锚点**；🔴 `locateSolution` 按「锚点共现最多 → 解析标记优先 → 段更长」并把【答案】结论前置。
- `match_level = exact | topic | none`；🔴 **硬闸无数据源豁免**：网盘、`library_docs.text_content`、自有题库、**ima 语义检索**都必须过 `isSameQuestion()/judge()`（M27 有 🔴 断言）。`topic` 必须 `answer:''`、`verified:false`。
- `kb` 顺序：自有题库同题答案 → `library_docs.text_content` → 网盘 `exact` → ima（过闸）→ 兜底同主题资料；新增查库必须 `.eq('user_id', userId)`。
- 🔴 **前后端必须同步发货**：只换后端时旧前端拿到 `answer:''` 仍会「采纳」空答案，比不修更糟。前端 `answer-editor.tsx` 有分档标题 + 采纳双保险。
- 边界：ima 高亮片段短会多判 `topic`；`²` vs `^2` 归一化未统一；**只有开放 AI 解题才能保证解出这道题**，需改隐私政策 r5 + 重新同意，明确不做。

## 13 资料库正文索引（P-008 / D-011 · 方案 A 已完成）
- 🔴 **真天花板**：`searchLocal()` 只 `name/path ilike` ⇒ 题干词不在文件名里就**永远进不了候选池**，`judge()` 再准也用不上；`MAX_DEEP_FILES=3` 让 20 份候选只看 3 份。
- 🔴 **可抽率矩阵（50 份实测）**：docx **≈100%**；pdf **<1MB 90% / 1-5MB 0% / 5-20MB 12.5% / 20-40MB 0%** ⇒ **别再规划「全量抽 pdf」**。`.doc` 10,503 份无解（L3 未装 soffice/antiword/catdoc），单独立项。
- ✅ **方案 A 已完成（11-06）**：docx 全量 + pdf<1MB + txt = 候选 **11,184 份 / 10.6GB**，实际 **`ok` 10,454（93.5%）**、`none` 732、候选池 `pending` 归零，正文 **9,450.3 万字**。docx **98.8%**（均 11,372 字）/ pdf<1MB **82.9%** / txt **86.5%**。可抽量预估 10,441 → 实际 10,454（**+0.12%**）。成本：下载是唯一主项（0.9s + size_MB/10），抽取 69~149ms/份。
- 🔴 **召回增量（全案目的证明）**：`AB=6` 文件名 **0** / 正文 **196**；`安培定则` 0/74；`游标卡尺` 0/14；`平行四边形` 129/1,102（仅正文 1,054，**8.5×**）；`勾股定理` 70/817；`一元二次方程` 221/566。⚠️ **召回代码仍未改**。
- 🔴 **正文 `ilike` 无索引 = 2.8 秒/词**（94MB、78,430 行 Seq Scan）⇒ 8~12 个 key 就是 **22~34 秒/次**。⚠️ 但「装了 trigram 就毫秒级」**尚未验证**：记忆 §3 已踩过「一次展开 8~12 个 ilike ⇒ PG 改选并行顺序扫描」。**短 key（2~3 字）必须显式排除**。
- 🔴 `netdisk-extract-text.mjs` 铁律：**默认 dry-run、`--apply` 才写**；**只写三列**；**环境类失败绝不写 `none`**；游标按 `id` 推进；口径与 `ensureText()` 逐字一致（`textOnly`/`maxPages:200`/50 字/200k 截断）。`M30` 14 条钉死。
- 🔴 **写库回滚锚点必留**（跑前记 `date -u`）：收尾 `11-06 04:00:15+00`、续抽 `11-05 16:15:09+00`、试抽 `11-05 15:42:47+00`。撤销 = `update netdisk_files set text_content=null, text_status='pending', text_updated_at=null where text_updated_at > '<锚点>'`。
- 🔴 **PostgreSQL `text` 不接受 U+0000**：夹一个 NUL 整条 `update` 抛 `invalid byte sequence ... 0x00` ⇒ 永远 `pending`、**伪装成「环境失败」**。治法：`writeRow()` 统一 `stripNul()`＋txt 分支**先剥 NUL 再判字数**。M30 已加断言。
- ⚠️ **dry-run 耗时模型系统性偏乐观**（没算 `GAP_MS=300ms` 节流）⇒ 实测 1.41~1.74s/份，比预估慢 26~46%；引用它的「串行约 X 小时」一律乘 1.4~1.5。
- ⚠️ `netdisk-index.mjs` 的 upsert **不碰 `text_content/text_status`**（安全）；但 `--full-clean` 会 `delete` 行 ⇒ **连带丢已抽正文**，抽取前后禁跑。
- 🔴 **L3 跑长任务的铁律**：①`ssh host 'node x.mjs'` 远端进程挂前台会话，**断连即 SIGHUP 被杀** ⇒ 必须远端 `nohup` + 远端日志，另开 ssh 轮询；②`.env.migrate` 是 `600 gk:gk`，`ubuntu` 直跑必 `EACCES` ⇒ 写库脚本必须 `sudo -u gk -H bash -c '…'`。
- 🔴 **四步方案评审（11-06，完整版见 `docs/reports/资料库正文召回-检索侧四步方案评审.md` §0/§3/§4 ＋ 今日日志）**：方向对但**顺序错、缺前置阶段**。实测 1 道真题现网 `judge()` 判出 **3 个 exact 全是别的题解析（0/3）**：`countAnchorHits()` 统计全文、`locateSolution()` 对段内 `anchorsHit` 无下限、`judge():229` 只要求「文中有任意【解析】」；「条件同、设问不同」也不识别。`extractDistinctive().keys` 是去标点拼接串（`ACABD点`）而 `text_content` 含标点 ⇒ 正文 `ilike` **0 命中**，运行时归一化 **3 分 06 秒** ⇒ 必须预计算 `text_flat`（归一化体积 77.1%）。「深挖走缓存」**已是既成事实**（`ensureText():487`），真需求是 `MAX_DEEP_FILES` 3→20~30、删 `coverage<0.2` 闸门、禁在线下载。`name/path` 18 个 OR 实测 **615ms / 15,123 行**而 `.limit(500)` 无排序任意截断 ⇒ §17「毫秒级」是未验证推断。
- ✅ **最优方案 = 新增「题目级切分」层**（四步完全没有）：按 `【例N】`/`N．`/`问题N`/`【答案】` 切 chunk，锚点共现限定 chunk 内。重排 **P0 正确性前置（验收集＋判定口径＋设问一致性＋误判归零闸门）→ P1 `text_flat`＋切分＋1,000 份索引样本实验 → P2 双通道召回＋锚点共现统一打分 → P3 扩大深挖＋`CACHE_VERSION` v4→v5**；建议单开 `P-009`/`D-012`。**业界调研（报告 §7）强印证**：作业帮专利 `CN113505786A` 原文「基于空间位置对第一文本数据进行切割拆分，确定待检索的题干内容」；TextIn 把「解析张冠李戴」列为行业卡点且根因不在 OCR；查重专利 `CN121031565` 用人工复核库动态调阈最大化 F1；各家统一「一题一对象＋多级漏斗＋置信度闸门」。⛔ **别搬**向量库/Reranker/LLM 兜底（4 核 4G、`ai_enabled` 默认 false、个人主体 AI 入口收起；且题干是用户自录原题、非拍照 OCR，无语义变式需求）。
- 🔴 **合规红线（双减）**：《双减意见》§15 明禁「拍照搜题」，2021-12-13 教育部要求相关作业 App 暂时下线、整改经省级审核才恢复备案；小猿搜题因此更名「小猿答疑」并改定位为「中小学家长辅导答疑」。⇒ `exact` 才放解析 / `topic` 答案必须为空 **既是正确性红线也是合规红线**；`answer` 带来源文件名/位置；孩子可见面前置引导。报告 §6 新增**第 7 项待拍板**（呈现层合规验收断言）。
- ⏸ **四步仍全部未批准**，七项待拍板；两轮只读评审，未改检索代码、未建索引、未写生产数据。**不做检索侧改造，9,450 万字对用户毫无价值；但先做召回改造会让用户拿到假答案，比没有更糟。**


===== r18 完整快照（2026-11-06，归档前）=====
# Growing-Kids 长期约定（r18 · 精简索引）

> **完整表述在 `MEMORY-full-archive.md`**（60KB，含 r17 全文快照，按需 Read）。本文件只留**判据/红线 + 一行指针**。
> 详细过程：`docs/reports/`、`docs/design/method/`、`docs/design/GK-QA-16-*.md`、教训录 L<n>。
> ⚠️ 新增前先想「能不能只写进 docs，这里留一行指针」。

## 0 流程
- 家长主用、孩子次要。改「学习行为」先过 20a §5.1 三问决策器 + §6.2 M1–M11；证据查 20b。
- GK-OPS-22（L0/L1/L2＋提案单 `method/proposals/P-NNN`＋台账 D 号）；⚠️ **先查台账再评审**；动 `question-match.ts` 前须建档。
- 缺口序 C3 错因 > C2 信心 > C1 掌握梯度 > C5 交错。⛔ 励志推送／智能排程／"算出 ZPD"／打卡时长激励。
- **push 等思傅指示；本地 commit 照常。**

## 1 环境
- 🔴 **commit≠发货**：前端 `build:weapp`→开发者工具重编译→真机重扫码；后端换 `server/dist` 到 L3 **并重启 `gk-api`**；验 dist 用 grep 特征串。只改后端时小程序包不用重传；部署按 QA-16 §6.1.1「先迁移、再换 dist 并重启」，旧 dist `mv` 成 `.bak-<时间戳>`。
- `npx nest build`→杀 3001→`POST :3002/wake`（`/wait-ready` **只等不拉**）。OCR venv 在仓库外 `D:/AI/gk-ocr-env`。#117 spawn OCR python 必走 `pythonEnv()`、stdout 走 `decodeEngineChunk()`；判据：中文绝不出现 U+FFFD。
- 🔴 **两套库别搞混**：**生产 = L3 `42.192.36.120`** → `SUPABASE_URL=http://127.0.0.1:8080`(PostgREST→本地 PG `gk`) + `STORAGE_DRIVER=local`，密钥 `/etc/gk/secrets.env`。**本地 `server/.env` + `.env.migrate` 仍指 Supabase 云 `yjsuzunoxvyrblhuigpv`，是迁库遗留的开发库、不是现网**（本地 3001、verify 套件读它 ⇒ 造的号不污染 L3）。L3 PG 只听 `127.0.0.1:5432`、外网仅 22/80。凡「现网数据/删除」**必须 ssh 上 L3**；删前先 `sudo -n -u gk node scripts/db-backup.mjs --no-upload`。

## 2 数据红线
- 无 RLS ⇒ 查询必须 `.eq('user_id', userId)`；删除加 `.select('id')` 校行数；`check:isolation` 是门禁。
- 新表外键 `user_id` 必须 varchar(36)；建表后 `--force --only` 重跑迁移。⚠️ `shared/schema.ts` 是 `@ts-nocheck` 死代码，**真相源只有 `migrations/`**。空串 ≠ NULL：外键回写前 `trim()` 判空。迁移用低权 migrator；pooler 改密码后首连必失败，重试即通。
- 管理员 `users.role`(0017)＋`requireAdmin()` fail-closed；提权唯一入口 `promote-admin.mjs`；role 单独 `select("role")`。
- 去重：`blob_objects` 内容寻址＋ref_count；`(user_id,file_hash)` 查重**必须在 ingest 之前**；改引擎/切分 ⇒ 必改 `OCR_ENGINE_VERSION`。存储 key 只 ASCII；含 `*_images` 的读端点必须过 `withUrls`；合成导出只吃 PNG/JPEG。
- 🔴 **媒体读端点必须 `res.sendFile`**，禁手写 `createReadStream().pipe()`（不给 Content-Length / 不处理 Range ⇒ 微信 `InnerAudioContext` 播不动）。判据 `curl -H 'Range: bytes=0-1023'` 应回 206。前端 `obeyMuteSwitch=false`、`onError` 必打 `errCode`。QA-16 §6.4。
- 🔴 **PostgreSQL `text` 不接受 U+0000**：夹一个 NUL 整条 `update` 抛 `invalid byte sequence ... 0x00` ⇒ 永远 `pending`、伪装成「环境失败」。落库前统一 `stripNul()`。

## 3 接口与前端
> 光标补丁、Taro 细节、隐私组件**完整原理**见归档 §3（勿删，踩过三轮）。

- 前缀 `/api/`；禁传 undefined 进 query；中文名 `encodeURIComponent`。`/api/upload`：`save`=建条目，`attach`=只持久化（附件类必须 attach）。
- 🔴 **输入框光标**：**两个 pnpm 补丁缺一不可** —— `patches/@tarojs__react@4.1.9.patch`（与元素当前值相同的 value 摘掉；**绝不能返回 null**，要 `[]`，否则整段文本写成空串）＋`patches/@tarojs__runtime@4.1.9.patch`（INPUT 只同步 `props.value`，不 setAttribute）；组件 input 里 `flushSync()`，**丢掉 `detail.value` 非字符串的事件**。⛔ 延迟上抛／不传 value／`defaultValue`／运行时改 `Symbol.hasInstance`（白屏）。`focus={false}`=强制失焦、`cursor={-1}`=置末尾 ⇒ **条件展开**。工具 `ide-write-stack.mjs`；门禁 M12＋M18-11。
- ✅ 全仓输入框统一 `ui/Textarea`：maxlength 默认 -1、`style` 只落外壳、外壳禁挂 `onTouchStart`、`autoHeight` 只能 `minHeight`。
- 🔴 `downloadFile`/`uploadFile` 只补域名不注入令牌 ⇒ 打自家 `/api` 的下载必须 `header: buildHeaders()`；公网签名直链**不要**带头。🔴 service 层必须自己 `unwrap`；调用方出现 `(res as any).data?.data` 就是契约断了；驼峰/snake 在 service 层转完。
- **M18 红线**：Text onClick（用 View）／downloadFile header／禁双重解包／guardPrivacy／maxlength=-1／禁 process.env／禁空 catch／列表 finally 解 loading／guardPolicy／同意键禁硬编码。
- 令牌：**X-Auth-Token 唯一被采信身份**，裸 X-User-Id 一律 401；CORS 必暴露它；新增免登录端点同步 `PUBLIC_ROUTES`。必须关 HTTP 协商缓存（ETag⇒304 空 body⇒`unwrap` 当失败⇒列表静默不刷新）；列表 `silent` 只约束「开始」。
- 🔴 **`navigateBack` 回来的页面不重新 mount** ⇒ 编辑/新增页返回后要 `useDidShow` + `firstShowRef` 跳首帧 + `silent:true` 刷新。
- ⚠️ 音视频**不能用原生小写标签**：音频 `Taro.createInnerAudioContext()`（`useDidHide` 里 stop+destroy）；视频用 `<Video>` 且**必须给确定高度**。`<Image>`/`<Video poster>` **不发请求头** ⇒ 列表接口服务端直接给 `*_url`。MIME 表覆盖 mp4/mov/mp3/m4a/aac/wav。
- 🚨 微信 request/uploadFile **超时上限 60s** ⇒ >60s 走 `POST /api/jobs` 202+轮询。新增任务类型同步 5 处；闸门拦在**提交阶段**；任务只在内存跑，重启即 failed。
- 🔴 业务隐私同意必须真拦写操作：`guardPolicy(action)` 与 `guardPrivacy` **串行两道**；「去同意」跳 `pages/privacy/index?from=guard`。🚨 **App 根渲染的兄弟节点根本不挂到页面** ⇒ `<PolicyConsent/>` 挂 `app.tsx` 等于死代码，现挂首页 + `useState(() => !hasAgreedPolicy())` 首帧画。`privacy-gate`/`Toaster` 同理。
- ⚠️ 隐私接口失败禁 `catch {}`（errno 112）；`__usePrivacyCheck__` 默认关；Taro 4.1.9 取 API 走 `globalThis.wx`；头像昵称用原生 `button open-type=chooseAvatar` + `input type=nickname`；法律文案走 `components/legal-text.tsx`。
- **「资料库搜题」= 先自有资料 → 后 ima**（`mode=kb`）：走 `requireUserId()` 不拦 AI 开关。🔴 **搜索只查本库 `netdisk_files`，要正文才去网盘读**：`netdisk-index.mjs --user <uuid> --apply` 只落文件名/路径（零下载）。前端 `source='netdisk'` 采纳记 `library`。
- 🔴 **改 `note` 或 result 字段结构 ⇒ 必 bump `answer-search.service.ts` 的 `CACHE_VERSION`**（参与 `qHash`）：`answer_cache` 把整个 result 按 `(user_id,q_hash,mode)` 存着、命中原样返回。判据：拿**没问过的新题**测。QA-16 §6.3.5。
- 🔴 **索引日常靠 `gk-netdisk-index.timer`**（周日 04:23，gk 账号）：`--budget-ms 5400000`＋`--full-clean`＋第二 ExecStart 跑 `library-index-text.mjs`。默认增量（0.8~3s），`--full` 全量（1,445s）。⚠️ 增量看不见「内容替换」；`method=listall` 不可用（errno 20020），无 webhook。⚠️ 隐私政策承诺「每周一次同步」⇒ **停 timer 就是承诺不兑现**。
- 🔴 **三条防误删护栏**：① `--root` 不以 `/` 开头或含 `:`/`\` 直接退出（Git Bash 会转换路径 ⇒ 列 0 条被判「完整遍历」，`--full-clean` **把 65,890 行全删了**）；② 本轮零文件不清库；③ 待删超库内一半要 `--force-clean`。教训：凡「遍历完整才删」必须同时校验「遍历真的走过了」。
- ⚠️ 用户可见面统一叫「资料库」不出现「百度网盘」；**但隐私政策第四节第三方接收方清单必须保留「百度网盘」**（法定披露）。两处副本逐字一致有校验。
- ⚠️ **trgm 索引只在少条件时生效**：一次展开 8~12 个 `ilike` ⇒ PG 改选并行顺序扫描；单条件才走索引（3~10ms）。`library_docs` 0023 起有 `text_content`/`text_status`，`keyword` 同时匹配 name 与正文；存量用 `POST /api/library/index-text` 补。
- 🔴 **抽正文失败不许标 `none`**：`none`=确认无文字层、不再重试；环境类失败（`no-python`/`no-script`/`timeout`）必须保持 `pending`。
- 🔴 **网盘凭证是运营者单账号**（生产 `BAIDU_*` = 思傅本人）：出现第二个真实用户即使隐私 r5 披露不实（R-合规-08 硬前置：per-user OAuth / 关掉非运营者检索 / 改文案，三选一）。
- 🔴 **导航**：tab = 首页／复习本／**资料**(`pages/library`)／记忆；tab 页只能 `switchTab`。汇总生成+导出在 `pages/summary`；面客说「资料」不说「文档」。⚠️ 键盘遮挡用 `lib/use-keyboard-avoid.ts`。🔴 原生 button 三种例外：头像 `chooseAvatar`、意见反馈 `contact`（仅真机）、同意键 `agreePrivacyAuthorization`；button 默认边框是 `::after`，`border:none` 去不掉。
- `/auth/me` 带 `role`（单独查）；答案+解题合并一框，页面持唯一草案。 `/api/memories` 支持 `subject_id`/`since`/`tag`（**无 `until`**），列表缓存 key 必须带筛选条件。

## 4 AI 与品牌
- ⚠️ `users.ai_enabled`(0018) **默认 false**；`requireAiEnabled()` 拦 chat/message/answer-search/search/solve；改开关必须 `invalidateUserFlags()`。个人主体 ⇒ AI 入口整体收起（`AI_PUBLIC_ENTRY=false`）。名统一**成长学童**，`陕ICP备2026030931号-1X`。
- 品牌 `--brand` #0B3D2E / `--brand-text` #0B7A55；`utils/latex.ts` 编辑态不显示源码。网盘归档 `LIBRARY_NETDISK_SYNC=true` **只写不读**。

## 4A L3 托管（42.192.36.120，Ubuntu 24.04.4 / 4核4G60G）
- 栈：PG17.11 → PostgREST12.2.3 → Caddy → Node 3000 → OCR venv。代码根 `/opt/gk/server`（OCR 按 `__dirname/../../..` 找根 ⇒ 布局必须 `/opt/gk/{server,migrations,ocr-engine}`）。用户 `ubuntu`（不是 root），`/opt/gk` 要 `sudo -n`。
- 🔴 `STORAGE_DRIVER=local` 同步两处：`PUBLIC_ROUTES` 加 `/^\/api\/storage\/files\//` ＋ `STORAGE_PUBLIC_BASE_URL`（否则兜底 `127.0.0.1` ⇒ 白图**无报错**）。🔴 Caddy 站点块**必须用 `handle` 包住** `file_server`。🔴 `PROJECT_DOMAIN` 是**编译期常量**，改 `.env.local` 必须重建；微信白名单只收 HTTPS 域名。
- 🔴 Linux 下 `OCR_VENV_DIR` 不生效 ⇒ 必设 `OCR_PYTHON` + `PPSV3_PYTHON`，另补 `PADDLE_PDX_CACHE_HOME`/`XDG_CACHE_HOME`。
- 🔴 **手工部署只换 `dist` 会漏文件**：改 `ocr-engine/*.py` 必须单独 scp 到 `/opt/gk/ocr-engine/`；漏传**接口不报错、静默降级**。判据 `hits[].hit` 有没有 `content`。
- ✅ 精准线 3.2.2+oneDNN：有效开关是 **PaddleX 层 `PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT`**（须在 import paddleocr 前设）：9.63→**2.41s/页**、RSS 1610MB。别用 `--once` 冷启动口径。🔴 两条链路两个脚本：快速=rapid→`main.py`，精准=PP-StructureV3→`main3.py`，**补丁两处都改**；`withPpsv3Gate` 并发闸门防 OOM。🔴 `--mode both` 会重复文本 ⇒ 生产 `OCR_ENGINE_MODE=rapid`。判 OCR 好坏**看置信度不看区数**。
- 搬数据在云主机做；校验 `PGTZ=UTC` +「两侧 pg_dump 排序比字节」；`--disable-triggers` 的 dump 只能 `postgres` 导入 + `--single-transaction`。
- **生产备份**：`gk_backup` 必须 `bypassrls`（`ocr_results` 有 RLS 无 policy ⇒ 否则静默 0 行）；口令丢了=备份永久作废，有历史备份+缺口令就**抛错**；`KEY-ESCROW.txt` 只有一个槽位 ⇒ 旧代次必然无副本；百度网盘分片按会员档 4/16/**32MB**、≤1024 片、超时 300s，恢复解包 `--no-overwrite-dir`；DB 每日 03:17(keep 14)、文件周日 03:47(keep 6)，`Persistent=true`。
- **结果指标**：唯一够格 = **到期首次作答正确率（按档位）** ⇒ `0021 review_events` + `review()` 埋点。口径①按 `(item_id, due_on)` 取**最早**一条②只算 `due_on <= 作答本地日`；埋点失败**不得阻断作答**；每档 ≥30 样本才出数；**当前 0 行**。
- 🔴 **L3 跑长任务铁律**：①`ssh host 'node x.mjs'` 远端进程挂前台会话，**断连即 SIGHUP 被杀** ⇒ 必须远端 `nohup` + 远端日志，另开 ssh 轮询；②`.env.migrate` 是 `600 gk:gk`，`ubuntu` 直跑必 `EACCES` ⇒ 写库脚本必须 `sudo -u gk -H bash -c '…'`。

## 5 发布与托管
- 发版前轮换 WX_SECRET（`rotate-wx-secret.mjs`），**轮换后必跑 encrypt-env.mjs**。`pnpm release:check` 上传后**记得 revert**；生产 `WAKE_ENABLED=0`。🚨 开发管理已托管第三方 ⇒ 域名白名单配不了 ⇒ **发正式版必须先解除托管**。
- **服务类目**：现「教育服务 > 教育信息展示」（已通过），建议**保留 + 追加工具类目**，⛔ 别删。联系方式两个来源别混。
- 🔴 备案：轻量须包月≥3月、**L3 到期⇒备案失效**；个人主体文案**禁教育/培训/课程/辅导**；**小程序备案 ≠ 域名备案**；首页 footer 挂真实号＋`beian.miit.gov.cn`。**公安联网备案待办**：判据是拿到 `陕公网安备…号`。🔴 首页 `<title>`/`<h1>` 必须与备案站名**逐字一致**，改站名先做变更备案。要素真相源 `docs/reports/公安联网备案操作指引.md` §2.4。
- ✅ 迁库零改查询（`.from()` 无参）⇒ 自签两枚 HS256 JWT。🔴 `SUPABASE_URL` 必须 `http://127.0.0.1:8080`；`service_role` 必须 **BYPASSRLS**。
- 💰 L3：188 档 + 同价续费 + 升配 3.5 折 ⇒ 三年 ¥649；先续费后升配、费用须 ¥0、只升不降。装机坑：PGDG 用腾讯镜像；PostgREST `db-uri` 必须 TCP+密码；Caddy 写 IP 须 `bind 127.0.0.1`；swap `swappiness` 60→10。

## 6 测试（GK-QA-21）
- 套件 `server/scripts/verify/`：新模块丢 `modules/NN-x.mjs` 自动发现；`pnpm verify:ci`。`harness.api()` 对幂等方法重试一次，POST 与超时不重试。纯函数模块用 tsc 单编后 require（M12/M15/M26/M27/M28）。
- **M16 三条硬门**：提案单六栏+引用可解析／禁用宣称词／镜像参数逐字一致。门只守结构，归因只有人能判。**造数据铁律**：同内容文件会命中去重 ⇒ 每次造图/PDF 内容必须不同。
- UI 实测通道 `ide-cdp.mjs` + `ide-*.mjs`；进程须在**同一个 `run_in_background` 任务**里启动+保活。输入一律 `Input.insertText`（**绕开输入法组合 ⇒ 测不出时序竞争**）。🔴 **测试期禁用真登录**：`/auth/login` 会把匿名号数据整体迁移进正式账号；切身份只换令牌 `ide-account.mjs use real|anon`。
- 🔴 判图必须真载：`<Image>` 编译成 `<wx-image>` + 内层 div `background-image`，`document.images` 恒为 0。IDE 四坑：鼠标事件带 `buttons:1`／「没反应」先查 `gk_policy_agreed_v1`／`chooseMedia` 走 Promise／选图必经裁剪编辑器。

## 7–11 其它
- **复习排程 C4**：真相源 `timeline/review.ts`；五档 **1→3→7→14→28 天**，做对推进、做错归零。`content.review_count` 已废 ⇒ 读列；前端不自算 plan。改间隔表触发 M15（三处同步）。
- **CI**：`gate`=build:server→build:weapp→`M12 M13 M16`；`api-core` 需 5 secret 才跑 M01–M08/M15。OCR GT 退出码 2 = 环境跑不起来；`R-算法-07` 竖式符号行丢失（未修）。导出口径：`include_answers` 不传 = 不含答案。🔴 **PDF 只有 paddle**：`recognizePdfDoc` 固定走 ppsv3；`OCR_PDF_MAX_SCANNED_PAGES=8` + 300s÷26s≈11 ⇒ **有效 8 页**。
- **方法论**：**M11** 连续天数/停留时长只作引导性展示，不得作判定标准或硬门槛。🚨 **20b 第 7 章标题不可动**：`method-gates.mjs` 用正则算文献号上界，重排 ⇒ `refMax=0` ⇒ H1 **静默跳过**。批量改文档用脚本 +「命中 1 次」断言。引用：准则 `GK-SRS-20a M<n>`，证据 `GK-SRS-20b 文献 <n>`；改准则走 **L2**。工作方法：同一 bug 改到第三版就**停下建复现模型**（L27）；平台规则必须从**源码/文档**抠（L28）；🚨 **测试通道决定结论上限**（L30）。
- **年级属性 P-005/D-008/0025**：12 档；真相源 `shared/grade.ts`，前端镜像 `constants/grades.ts`（**不跨端 import**），M26 守。三列语义不同：`users.grade`=当前／`grade_confirmed_year`=学年起始年（9/1）／`timeline_items.grade`·`library_docs.grade`=**创建时快照**。🔴 四条铁律：①扩散只看本年级**精确**命中数②`grade is null` **必须始终可见**③`normalizeGrade` **先挡空串**④计数失败按 **0**。🔴 复习本／记忆／识别页**一律不传 grade**。界面筛掉用户内容 ⇒ **必须自带回退开关**。学年只给 `grade_rollover` **建议**，绝不后台改数。⚠️ 新增用户属性字段必须查所有按 user_id 搬数据的迁移路径（`adoptGrade()`）。🔴 **本地 commit ≠ 生产有代码**：曾因「生产库没 0025 **且** dist 没 `setGrade`」⇒ 404，排查先 grep 生产 dist 特征串。`sudo -n -u gk node /opt/gk/server/scripts/migrate.mjs --only <file>`（`--ping`/`--dry` 先验）。
- 🔴 **`users` 行数 ≠ 真实用户规模**：生产 80 = 196 匿名中清掉 117 个零数据空壳后 + 1 正式；`findOrCreateByDeviceId()` 对每个新 `X-Device-Id` 自动建匿名号（TTL 30 天）。⚠️ **528 道题挂在 29 个匿名号上**是联调数据，**不能删**。🔴 **异步任务提交闸门必须与同步端点同口径**：`POST /api/jobs` 曾按 type 一刀切 `requireAiEnabled` ⇒ `mode=kb` 提交即 403；按 `params.mode` 分流，M17 有回归。
- **CDP 噪音**：`remote-debug/appservice` 会刷一批 `ReferenceError: wx is not defined`，**不是崩了**；判据＝主逻辑层 `appservice/mainframe` 里 `typeof wx === "object"`。读历史日志用 `Log.enable`（会**回放**）。

## 12 资料库搜题：原题判定硬闸（P-006 / D-009）
- 🔴 **旧病**：`mode=kb` 把「同专题教辅片段」当「本题答案」（`answer` 是另一道题的【分析】、`verified:true`）。根因：主题词召回 + bigram「主题相似」打分 + `hits.length>0` 即通过，**没有原题判定阈值**。
- 真相源 `server/src/shared/question-match.ts`（**零依赖单文件**，M27 用 tsc 单编后 require ⇒ 不能加 import）。🔴 **粗筛 keys 只收 ≥4 字长锚点**。
- `match_level = exact | topic | none`；🔴 **硬闸无数据源豁免**：网盘、`library_docs.text_content`、自有题库、**ima 语义检索**都必须过 `isSameQuestion()/judge()`（M27 有 🔴 断言）。`topic` 必须 `answer:''`、`verified:false`。
- `kb` 顺序：自有题库同题答案 → `library_docs.text_content` → 网盘 `exact` → ima（过闸）→ 兜底同主题资料；新增查库必须 `.eq('user_id', userId)`。
- 🔴 **前后端必须同步发货**：只换后端时旧前端拿到 `answer:''` 仍会「采纳」空答案，比不修更糟。前端 `answer-editor.tsx` 有分档标题 + 采纳双保险。
- 边界：ima 高亮片段短会多判 `topic`；`²` vs `^2` 归一化未统一；**只有开放 AI 解题才能保证解出这道题**，明确不做。
- 🔴 **合规红线（双减）**：《双减意见》§15 明禁「拍照搜题」，2021-12-13 教育部要求相关作业 App 暂时下线、整改经省级审核才恢复备案；小猿搜题因此更名「小猿答疑」并改定位「中小学家长辅导答疑」。⇒ `exact` 才放解析 / `topic` 答案必须为空 **既是正确性红线也是合规红线**；`answer` 带来源；孩子可见面前置引导。

## 13 资料库正文索引（P-008 / D-011 · 方案 A 已完成）
- 🔴 **真天花板**：`searchLocal()` 只 `name/path ilike` ⇒ 题干词不在文件名里就**永远进不了候选池**；`MAX_DEEP_FILES=3` 让 20 份候选只看 3 份。
- 🔴 **可抽率矩阵（50 份实测）**：docx **≈100%**；pdf **<1MB 90% / 1-5MB 0% / 5-20MB 12.5% / 20-40MB 0%** ⇒ **别再规划「全量抽 pdf」**。`.doc` 10,503 份无解（L3 未装 soffice/antiword/catdoc），单独立项。
- ✅ **方案 A 已完成（11-06）**：docx 全量 + pdf<1MB + txt = 候选 **11,184 份 / 10.6GB**，实际 **`ok` 10,454（93.5%）**、`none` 732、候选池 `pending` 归零，正文 **9,450.3 万字**。docx **98.8%** / pdf<1MB **82.9%** / txt **86.5%**。可抽量预估偏差 **+0.12%**。
- 🔴 **召回增量（全案目的证明）**：`AB=6` 文件名 **0** / 正文 **196**；`安培定则` 0/74；`游标卡尺` 0/14；`平行四边形` 129/1,102（仅正文 1,054，**8.5×**）；`勾股定理` 70/817；`一元二次方程` 221/566。⚠️ **召回代码仍未改**。
- 🔴 **正文 `ilike` 无索引 = 2.8 秒/词**（94MB、78,430 行 Seq Scan）⇒ 8~12 个 key 就是 **22~34 秒/次**。⚠️ 「装了 trigram 就毫秒级」**尚未验证**。**短 key（2~3 字）必须显式排除**。
- 🔴 `netdisk-extract-text.mjs` 铁律：**默认 dry-run、`--apply` 才写**；**只写三列**；**环境类失败绝不写 `none`**；游标按 `id` 推进；口径与 `ensureText()` 逐字一致。`M30` 14 条钉死。
- 🔴 **写库回滚锚点必留**（跑前记 `date -u`）：收尾 `11-06 04:00:15+00`、续抽 `11-05 16:15:09+00`、试抽 `11-05 15:42:47+00`。撤销 = `update netdisk_files set text_content=null, text_status='pending', text_updated_at=null where text_updated_at > '<锚点>'`。
- ⚠️ **dry-run 耗时模型系统性偏乐观**（没算 `GAP_MS=300ms` 节流）⇒ 实测慢 26~46%；引用「串行约 X 小时」一律乘 1.4~1.5。⚠️ `netdisk-index.mjs` 的 upsert **不碰 `text_content/text_status`**（安全）；但 `--full-clean` 会 `delete` 行 ⇒ **连带丢已抽正文**，抽取前后禁跑。

## 14 检索侧方案评审与业界对照（11-06，完整见 `docs/reports/资料库正文召回-检索侧四步方案评审.md`）
- 🔴 **四步方向对但顺序错、缺前置阶段**。实测 1 道真题现网 `judge()` 判出 **3 个 exact 全是别的题解析（0/3）**：`countAnchorHits()` 统计全文、`locateSolution()` 对段内 `anchorsHit` 无下限、`judge():229` 只要求「文中有任意【解析】」；「条件同、设问不同」也不识别。`extractDistinctive().keys` 是去标点拼接串（`ACABD点`）而 `text_content` 含标点 ⇒ 正文 `ilike` **0 命中**，运行时归一化 **3 分 06 秒** ⇒ 必须预计算 `text_flat`。「深挖走缓存」**已是既成事实**（`ensureText():487`）。`name/path` 18 个 OR 实测 **615ms / 15,123 行**而 `.limit(500)` 无排序任意截断 ⇒ §17「毫秒级」是未验证推断。
- ✅ **最优方案 = 新增「题目级切分」层**：按 `【例N】`/`N．`/`问题N`/`【答案】` 切 chunk，锚点共现限定 chunk 内。重排 **P0 正确性前置 → P1 `text_flat`＋切分＋1,000 份索引样本实验 → P2 双通道召回＋统一打分 → P3 扩大深挖＋缓存 bump**。
- ✅ **业界调研（报告 §7）强印证**：作业帮专利 `CN113505786A` 原文「基于空间位置对第一文本数据进行切割拆分，确定待检索的题干内容」；TextIn 把「解析张冠李戴」列为行业卡点且根因不在 OCR；查重专利 `CN121031565` 用人工复核库动态调阈最大化 F1；各家统一「**一题一对象＋多级漏斗＋置信度闸门**」。⛔ **别搬**向量库/Reranker/LLM 兜底（4 核 4G、`ai_enabled` 默认 false、个人主体 AI 入口收起；且题干是用户自录原题、非拍照 OCR，无语义变式需求）。可搬三条：**一题一对象＋来源位置／多因子校验（锚点共现＋设问一致＋相邻解析段）／未达标不放行**。
- ✅ **P-009 / D-012 已实施（11-06，判定层）**：见报告 §8 与 `P-009` 提案单。仅 P0 判定口径落代码；**P1/P2/P3 仍未批准**，未建索引、未改召回、未写生产数据、未部署。


===== 2026-11-06 P1 改判说明 =====
D-012 / 报告 §8.5 中「P1/P2/P3 一律不启动」是当时的拍板范围，作为历史事实保留在 P-009 提案单、D-012 台账与 M31 静态断言里，本归档不复制。D-013 追加记录 P1 改判为已批准（仅工程管控层），真相源 P-010 提案单 + 报告 §9 + M32。


===== r19 完整快照（2026-11-07，r20 压缩前）=====
# Growing-Kids 长期约定（r19 · 索引）

> **完整表述在 `MEMORY-full-archive.md`**（85KB，含 r17/r18 全文快照）；本文件只留**判据 / 红线 + 一行指针**。详细过程在 `docs/reports/`、`docs/design/method/`、`docs/design/GK-QA-16-*.md`、教训录 L<n>。
> ⚠️ 新增前先想「能不能只写进 docs，这里留一行指针」。

## 0 流程
- 家长主用、孩子次要。改「学习行为」先过 20a §5.1 三问决策器 + §6.2 M1–M11；证据查 20b。
- GK-OPS-22（L0/L1/L2＋提案单 `method/proposals/P-NNN`＋台账 D 号）；⚠️ **先查台账再评审**；动 `question-match.ts` 前须建档。
- 缺口序 C3 错因 > C2 信心 > C1 掌握梯度 > C5 交错。⛔ 励志推送／智能排程／"算出 ZPD"／打卡时长激励。
- **push 等思傅指示；本地 commit 照常。**

## 1 环境
- 🔴 **commit≠发货**：前端 `build:weapp`→开发者工具重编译→真机重扫码；后端换 `server/dist` 到 L3 **并重启 `gk-api`**；验 dist 用 grep 特征串。只改后端时小程序包不用重传；部署按 QA-16 §6.1.1「先迁移、再换 dist 并重启」，旧 dist `mv` 成 `.bak-<时间戳>`。
- `npx nest build`→杀 3001→`POST :3002/wake`（`/wait-ready` **只等不拉**）。OCR venv 在仓库外 `D:/AI/gk-ocr-env`。#117 spawn OCR python 必走 `pythonEnv()`、stdout 走 `decodeEngineChunk()`；判据：中文绝不出现 U+FFFD。
- 🔴 **两套库别搞混**：**生产 = L3 `42.192.36.120`** → `SUPABASE_URL=http://127.0.0.1:8080`(PostgREST→本地 PG `gk`) + `STORAGE_DRIVER=local`，密钥 `/etc/gk/secrets.env`。**本地 `server/.env` + `.env.migrate` 仍指 Supabase 云 `yjsuzunoxvyrblhuigpv`，是迁库遗留的开发库、不是现网**（本地 3001、verify 套件读它 ⇒ 造的号不污染 L3）。L3 PG 只听 `127.0.0.1:5432`、外网仅 22/80。凡「现网数据/删除」**必须 ssh 上 L3**（QA-16 §3.1）；删前先 `sudo -n -u gk node scripts/db-backup.mjs --no-upload`。

## 2 数据红线
- 无 RLS ⇒ 查询必须 `.eq('user_id', userId)`；删除加 `.select('id')` 校行数；`check:isolation` 是门禁。
- 新表外键 `user_id` 必须 varchar(36)；建表后 `--force --only` 重跑迁移。⚠️ `shared/schema.ts` 是 `@ts-nocheck` 死代码，**真相源只有 `migrations/`**。空串 ≠ NULL：外键回写前 `trim()` 判空。迁移用低权 migrator；pooler 改密码后首连必失败，重试即通。
- 管理员 `users.role`(0017)＋`requireAdmin()` fail-closed；提权唯一入口 `promote-admin.mjs`；role 单独 `select("role")`。
- 去重：`blob_objects` 内容寻址＋ref_count；`(user_id,file_hash)` 查重**必须在 ingest 之前**；改引擎/切分 ⇒ 必改 `OCR_ENGINE_VERSION`。存储 key 只 ASCII；含 `*_images` 的读端点必须过 `withUrls`；合成导出只吃 PNG/JPEG。
- 🔴 **媒体读端点必须 `res.sendFile`**，禁手写 `createReadStream().pipe()`（不给 Content-Length / 不处理 Range ⇒ 微信 `InnerAudioContext` 播不动）。判据 `curl -H 'Range: bytes=0-1023'` 应回 206。前端 `obeyMuteSwitch=false`、`onError` 必打 `errCode`。QA-16 §6.4。
- 🔴 **PostgreSQL `text` 不接受 U+0000**：夹一个 NUL 整条 `update` 抛 `invalid byte sequence ... 0x00` ⇒ 永远 `pending`、伪装成「环境失败」。落库前统一 `stripNul()`（txt 还要**先剥 NUL 再判字数**）。

## 3 接口与前端
> 光标补丁、Taro 细节、隐私组件**完整原理**见归档 §3（勿删，踩过三轮）。

- 前缀 `/api/`；禁传 undefined 进 query；中文名 `encodeURIComponent`。`/api/upload`：`save`=建条目，`attach`=只持久化（附件类必须 attach）。
- 🔴 **输入框光标**（完整原理见归档 §3）：**两个 pnpm 补丁缺一不可** `patches/@tarojs__react@4.1.9.patch`（同值 value 摘掉、**绝不能返回 null** 要 `[]`）＋`patches/@tarojs__runtime@4.1.9.patch`（INPUT 只同步 `props.value`）；组件 input 用 `flushSync()` + **丢弃 `detail.value` 非字符串的事件**。⛔ 延迟上抛／不传 value／`defaultValue`／改 `Symbol.hasInstance`（白屏）。`focus={false}`=失焦、`cursor={-1}`=末尾 ⇒ **条件展开**。工具 `ide-write-stack.mjs`；M12＋M18-11。
- ✅ 全仓输入框统一 `ui/Textarea`：maxlength 默认 -1、`style` 只落外壳、外壳禁挂 `onTouchStart`、`autoHeight` 只能 `minHeight`。
- 🔴 `downloadFile`/`uploadFile` 只补域名不注入令牌 ⇒ 打自家 `/api` 的下载必须 `header: buildHeaders()`；公网签名直链**不要**带头。🔴 service 层必须自己 `unwrap`；调用方出现 `(res as any).data?.data` 就是契约断了；驼峰/snake 在 service 层转完。
- **M18 红线**：Text onClick（用 View）／downloadFile header／禁双重解包／guardPrivacy／maxlength=-1／禁 process.env／禁空 catch／列表 finally 解 loading／guardPolicy／同意键禁硬编码。
- 令牌：**X-Auth-Token 唯一被采信身份**，裸 X-User-Id 一律 401；CORS 必暴露它；新增免登录端点同步 `PUBLIC_ROUTES`。必须关 HTTP 协商缓存（ETag⇒304 空 body⇒`unwrap` 当失败⇒列表静默不刷新）；列表 `silent` 只约束「开始」。
- 🔴 **`navigateBack` 回来的页面不重新 mount** ⇒ 编辑/新增页返回后要 `useDidShow` + `firstShowRef` 跳首帧 + `silent:true` 刷新。
- ⚠️ 音视频**不能用原生小写标签**：音频 `Taro.createInnerAudioContext()`（`useDidHide` stop+destroy）；视频用 `<Video>` 且**必须给确定高度**。`<Image>`/`<Video poster>` **不发请求头** ⇒ 列表接口服务端直接给 `*_url`。MIME 覆盖 mp4/mov/mp3/m4a/aac/wav。🚨 微信 request/uploadFile **超时上限 60s** ⇒ >60s 走 `POST /api/jobs` 202+轮询；新增任务类型同步 5 处，闸门拦在**提交阶段**，任务只在内存跑、重启即 failed。
- 🔴 业务隐私同意必须真拦写操作：`guardPolicy(action)` 与 `guardPrivacy` **串行两道**；「去同意」跳 `pages/privacy/index?from=guard`。🚨 **App 根渲染的兄弟节点根本不挂到页面** ⇒ `<PolicyConsent/>` 挂 `app.tsx` 是死代码，现挂首页 + `useState(() => !hasAgreedPolicy())` 首帧画；`privacy-gate`/`Toaster` 同理。⚠️ 隐私接口失败禁 `catch {}`（errno 112）；`__usePrivacyCheck__` 默认关；Taro 4.1.9 取 API 走 `globalThis.wx`；头像昵称用原生 `button open-type=chooseAvatar` + `input type=nickname`；法律文案走 `components/legal-text.tsx`。
- **「资料库搜题」= 先自有资料 → 后 ima**（`mode=kb`）：走 `requireUserId()` 不拦 AI 开关。🔴 **搜索只查本库 `netdisk_files`，要正文才去网盘读**：`netdisk-index.mjs --user <uuid> --apply` 只落文件名/路径（零下载）。前端 `source='netdisk'` 采纳记 `library`。
- 🔴 **改 `note` 或 result 字段结构 ⇒ 必 bump `answer-search.service.ts` 的 `CACHE_VERSION`**（参与 `qHash`）：`answer_cache` 把整个 result 按 `(user_id,q_hash,mode)` 存着、命中原样返回。判据：拿**没问过的新题**测。QA-16 §6.3.5。当前 **v6**（P-010；口径变更/被标 rejected 的对象都要让老缓存失效）。
- 🔴 **索引日常靠 `gk-netdisk-index.timer`**（周日 04:23，gk 账号）：`--budget-ms 5400000`＋`--full-clean`＋第二 ExecStart 跑 `library-index-text.mjs`。默认增量 0.8~3s、`--full` 1,445s。⚠️ 增量看不见「内容替换」；`method=listall` 不可用（errno 20020）；**停 timer = 隐私政策「每周同步」承诺不兑现**。
- 🔴 **防误删三护栏**：① `--root` 不以 `/` 开头或含 `:`/`\` 直接退出（Git Bash 转路径 ⇒ 列 0 条被判完整遍历，`--full-clean` **删光 65,890 行**）②本轮零文件不清库 ③待删超半数要 `--force-clean`。教训：凡「遍历完整才删」必须同时校验「遍历真的走过了」。
- ⚠️ 面客统一叫「资料库」不出现「百度网盘」；**但隐私政策第四节第三方接收方清单必须保留「百度网盘」**（法定披露，两处副本逐字一致有校验）。⚠️ **trgm 索引只在少条件时生效**：8~12 个 `ilike` ⇒ PG 改选并行顺序扫描，单条件才走索引。`library_docs` 0023 起有 `text_content`/`text_status`，`keyword` 同时匹配 name/正文。
- 🔴 **抽正文失败不许标 `none`**（`none`=确认无文字层、不再重试）：环境类失败 `no-python`/`no-script`/`timeout` 必须保持 `pending`。🔴 **网盘凭证是运营者单账号**（`BAIDU_*` = 思傅本人）：出现第二个真实用户即使隐私 r5 披露不实（R-合规-08 硬前置：per-user OAuth／关掉非运营者检索／改文案，三选一）。
- 🔴 **导航**：tab = 首页／复习本／**资料**(`pages/library`)／记忆，tab 页只能 `switchTab`；汇总生成+导出在 `pages/summary`；面客说「资料」不说「文档」。⚠️ 键盘遮挡用 `lib/use-keyboard-avoid.ts`。🔴 原生 button 三种例外：头像 `chooseAvatar`／意见反馈 `contact`（仅真机）／同意键 `agreePrivacyAuthorization`；默认边框是 `::after`，`border:none` 去不掉。
- `/auth/me` 带 `role`（单独查）；答案+解题合并一框，页面持唯一草案。`/api/memories` 支持 `subject_id`/`since`/`tag`（**无 `until`**），列表缓存 key 必须带筛选条件。

## 4 AI 与品牌
- ⚠️ `users.ai_enabled`(0018) **默认 false**；`requireAiEnabled()` 拦 chat/message/answer-search/search/solve；改开关必须 `invalidateUserFlags()`。个人主体 ⇒ AI 入口整体收起（`AI_PUBLIC_ENTRY=false`）。名统一**成长学童**，`陕ICP备2026030931号-1X`。
- 品牌 `--brand` #0B3D2E / `--brand-text` #0B7A55；`utils/latex.ts` 编辑态不显示源码。网盘归档 `LIBRARY_NETDISK_SYNC=true` **只写不读**。

## 4A L3 托管（42.192.36.120，Ubuntu 24.04.4 / 4核4G60G）
- 栈：PG17.11 → PostgREST12.2.3 → Caddy → Node 3000 → OCR venv。代码根 `/opt/gk/server`（OCR 按 `__dirname/../../..` 找根 ⇒ 布局必须 `/opt/gk/{server,migrations,ocr-engine}`）。用户 `ubuntu`（不是 root），`/opt/gk` 要 `sudo -n`。
- 🔴 `STORAGE_DRIVER=local` 同步两处：`PUBLIC_ROUTES` 加 `/^\/api\/storage\/files\//` ＋ `STORAGE_PUBLIC_BASE_URL`（否则兜底 `127.0.0.1` ⇒ 白图**无报错**）。🔴 Caddy 站点块**必须用 `handle` 包住** `file_server`。🔴 `PROJECT_DOMAIN` 是**编译期常量**，改 `.env.local` 必须重建；微信白名单只收 HTTPS 域名。
- 🔴 Linux 下 `OCR_VENV_DIR` 不生效 ⇒ 必设 `OCR_PYTHON` + `PPSV3_PYTHON`，另补 `PADDLE_PDX_CACHE_HOME`/`XDG_CACHE_HOME`。
- 🔴 **手工部署只换 `dist` 会漏文件**：改 `ocr-engine/*.py` 必须单独 scp 到 `/opt/gk/ocr-engine/`；漏传**接口不报错、静默降级**。判据 `hits[].hit` 有没有 `content`。
- ✅ 精准线提速开关是 **PaddleX 层 `PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT`**（须在 import paddleocr 前设）：9.63→**2.41s/页**。别用 `--once` 冷启动口径。🔴 两条链路两个脚本：快速=rapid→`main.py`，精准=PP-StructureV3→`main3.py`，**补丁两处都改**；`withPpsv3Gate` 并发闸门防 OOM。🔴 `--mode both` 重复文本 ⇒ 生产 `OCR_ENGINE_MODE=rapid`；判好坏**看置信度不看区数**。
- 搬数据在云主机做；校验 `PGTZ=UTC` +「两侧 pg_dump 排序比字节」；`--disable-triggers` 的 dump 只能 `postgres` 导入 + `--single-transaction`。
- **生产备份**：`gk_backup` 必须 `bypassrls`（否则 `ocr_results` 静默 0 行）；口令丢了=备份永久作废，有历史备份+缺口令就**抛错**；`KEY-ESCROW.txt` 只有一个槽位 ⇒ 旧代次必然无副本；网盘分片 4/16/**32MB**、≤1024 片、超时 300s，恢复解包 `--no-overwrite-dir`；DB 每日 03:17(keep 14)、文件周日 03:47(keep 6)。
- **结果指标**：唯一够格 = **到期首次作答正确率（按档位）** ⇒ `0021 review_events` + `review()` 埋点。口径①按 `(item_id, due_on)` 取**最早**一条②只算 `due_on <= 作答本地日`；埋点失败**不得阻断作答**；每档 ≥30 样本才出数；**当前 0 行**。
- 🔴 **L3 跑长任务铁律**：①`ssh host 'node x.mjs'` 远端进程挂前台会话，**断连即 SIGHUP 被杀** ⇒ 必须远端 `nohup` + 远端日志，另开 ssh 轮询；②`.env.migrate` 是 `600 gk:gk`，`ubuntu` 直跑必 `EACCES` ⇒ 写库脚本必须 `sudo -u gk -H bash -c '…'`。

## 5 发布与托管
- 发版前轮换 WX_SECRET（`rotate-wx-secret.mjs`），**轮换后必跑 encrypt-env.mjs**。`pnpm release:check` 上传后**记得 revert**；生产 `WAKE_ENABLED=0`。🚨 开发管理已托管第三方 ⇒ 域名白名单配不了 ⇒ **发正式版必须先解除托管**。
- **服务类目**：现「教育服务 > 教育信息展示」（已通过），建议**保留 + 追加工具类目**，⛔ 别删。联系方式两个来源别混。
- 🔴 备案：轻量须包月≥3月、**L3 到期⇒备案失效**；个人主体文案**禁教育/培训/课程/辅导**；**小程序备案 ≠ 域名备案**；首页 footer 挂真实号＋`beian.miit.gov.cn`；**公安联网备案待办**（判据＝拿到 `陕公网安备…号`）。🔴 首页 `<title>`/`<h1>` 必须与备案站名**逐字一致**。要素真相源 `docs/reports/公安联网备案操作指引.md` §2.4。
- ✅ 迁库零改查询（`.from()` 无参）⇒ 自签两枚 HS256 JWT。🔴 `SUPABASE_URL` 必须 `http://127.0.0.1:8080`；`service_role` 必须 **BYPASSRLS**。
- 💰 L3 已完成：188 档 + 同价续费 + 升配 3.5 折 ⇒ 三年 ¥649（先续费后升配、费用须 ¥0）。装机坑：PGDG 用腾讯镜像；PostgREST `db-uri` 必须 TCP+密码；Caddy 写 IP 须 `bind 127.0.0.1`；swap `swappiness` 60→10。

## 6 测试（GK-QA-21）
- 套件 `server/scripts/verify/`：新模块丢 `modules/NN-x.mjs` 自动发现；`pnpm verify:ci`（= M12 M13 M16）；前端门禁 `pnpm verify:gate`（+M18）。`harness.api()` 对幂等方法重试一次，POST 与超时不重试。纯函数模块用 tsc 单编后 require（M12/M15/M26/M27/M31）。
- **M16 三条硬门**：提案单六栏+引用可解析／禁用宣称词／镜像参数逐字一致（只验机器能判的）。门只守结构，归因只有人能判。**造数据铁律**：同内容文件会命中去重 ⇒ 每次造图/PDF 内容必须不同。
- UI 实测通道 `ide-cdp.mjs` + `ide-*.mjs`；进程须在**同一个 `run_in_background` 任务**里启动+保活。输入一律 `Input.insertText`（**绕开输入法组合 ⇒ 测不出时序竞争**）。🔴 **测试期禁用真登录**：`/auth/login` 会把匿名号数据整体迁移进正式账号；切身份只换令牌 `ide-account.mjs use real|anon`。
- 🔴 判图必须真载：`<Image>` 编译成 `<wx-image>` + 内层 div `background-image`，`document.images` 恒为 0。IDE 四坑：鼠标事件带 `buttons:1`／「没反应」先查 `gk_policy_agreed_v1`／`chooseMedia` 走 Promise／选图必经裁剪编辑器。
- ⚠️ 前端 `npx tsc --noEmit -p tsconfig.json`（根）**会报一堆 node_modules 第三方声明错**，属既有噪音；正确门禁是 `pnpm verify:gate` + `pnpm lint:build`；后端用 `server/` 下的 `tsc --noEmit` + `npx nest build`。

## 7 其它
- **复习排程 C4**：真相源 `timeline/review.ts`；五档 **1→3→7→14→28 天**，做对推进、做错归零。`content.review_count` 已废 ⇒ 读列；前端不自算 plan。改间隔表触发 M15（三处同步）。
- **CI**：`gate`=build:server→build:weapp→`M12 M13 M16`；`api-core` 需 5 secret 才跑 M01–M08/M15。OCR GT 退出码 2 = 环境跑不起来；`R-算法-07` 竖式符号行丢失（未修）。导出口径：`include_answers` 不传 = 不含答案。🔴 **PDF 只有 paddle**：`recognizePdfDoc` 固定走 ppsv3，`OCR_PDF_MAX_SCANNED_PAGES=8` ⇒ **有效 8 页**。
- **方法论**：**M11** 连续天数/停留时长只作引导性展示，不得作判定标准或硬门槛。🚨 **20b 第 7 章标题不可动**：`method-gates.mjs` 用正则算文献号上界，重排 ⇒ `refMax=0` ⇒ H1 **静默跳过**；批量改文档用脚本 +「命中 1 次」断言。引用：准则 `GK-SRS-20a M<n>`／证据 `GK-SRS-20b 文献 <n>`；改准则走 **L2**。教训 L27 同一 bug 改到第三版**停下建复现模型**、L28 平台规则从**源码/文档**抠、L30 **测试通道决定结论上限**。
- **年级属性 P-005/D-008/0025**：12 档；真相源 `shared/grade.ts`＋前端镜像 `constants/grades.ts`（不跨端 import），M26 守。`users.grade`=当前／`grade_confirmed_year`=学年起始年／`timeline_items.grade`·`library_docs.grade`=**创建时快照**（升学不改旧记录）。🔴 铁律：扩散只看本年级精确命中数／`grade is null` 始终可见／`normalizeGrade` 先挡空串／计数失败按 0；复习本／记忆／识别页**不传 grade**；筛掉用户内容必须自带回退开关。⚠️ 新增用户属性字段要查所有按 user_id 搬数据的路径（`adoptGrade()`）。
- 🔴 **本地 commit ≠ 生产有代码**：曾因「生产库没 0025 **且** dist 没 `setGrade`」⇒ 404，排查先 grep 生产 dist 特征串。`sudo -n -u gk node /opt/gk/server/scripts/migrate.mjs --only <file>`（`--ping`/`--dry` 先验）。
- 🔴 **`users` 行数 ≠ 真实用户规模**：生产 80 = 196 匿名中清掉 117 个零数据空壳后 + 1 正式；`findOrCreateByDeviceId()` 对每个新 `X-Device-Id` 自动建匿名号（TTL 30 天）。⚠️ **528 道题挂在 29 个匿名号上**是联调数据，**不能删**。🔴 **异步任务提交闸门必须与同步端点同口径**：`POST /api/jobs` 曾按 type 一刀切 `requireAiEnabled` ⇒ `mode=kb` 提交即 403；按 `params.mode` 分流，M17 有回归。
- **CDP 噪音**：`remote-debug/appservice` 会刷一批 `ReferenceError: wx is not defined`，**不是崩了**；判据＝主逻辑层 `appservice/mainframe` 里 `typeof wx === "object"`。读历史日志用 `Log.enable`（会**回放**）。

## 8 资料库搜题：原题判定硬闸（P-006 / D-009）
- 🔴 **旧病**：`mode=kb` 把「同专题教辅片段」当「本题答案」（`answer` 是另一道题的【分析】、`verified:true`）。根因：主题词召回 + bigram「主题相似」打分 + `hits.length>0` 即通过，**没有原题判定阈值**。
- 真相源 `server/src/shared/question-match.ts`（**零依赖单文件**，M27/M31 用 tsc 单编后 require ⇒ **不能加 import**）。🔴 **粗筛 keys 只收 ≥4 字长锚点**。判定阈值 `MATCH_MIN_LONG_ANCHORS=3` / `MATCH_MIN_LONG_RATIO=0.4`。
- `match_level = exact | topic | none`；🔴 **硬闸无数据源豁免**：网盘、`library_docs.text_content`、自有题库、**ima 语义检索**都必须过原题判定（M27 有 🔴 断言）。`topic` 必须 `answer:''`、`verified:false`。
- `kb` 顺序：自有题库同题答案 → `library_docs.text_content` → 网盘 `exact` → ima（过闸）→ 兜底同主题资料；新增查库必须 `.eq('user_id', userId)`。
- 🔴 **前后端必须同步发货**：只换后端时旧前端拿到 `answer:''` 仍会「采纳」空答案，比不修更糟。前端 `answer-editor.tsx` 有分档标题 + 采纳双保险。
- 边界：ima 高亮片段短会多判 `topic`；`²` vs `^2` 归一化未统一；**只有开放 AI 解题才能保证解出这道题**，明确不做。
- 🔴 **合规红线（双减）**：《双减意见》§15 明禁「拍照搜题」；小猿搜题因此更名「小猿答疑」并改定位「中小学家长辅导答疑」。⇒ `exact` 才放解析 / `topic` 答案必须为空 **既是正确性红线也是合规红线**；`answer` 带来源；孩子可见面前置引导。

## 9 资料库正文索引（P-008 / D-011 · 方案 A 已完成）
> 数字 / 落地记录 / 回滚锚点见 `P-008` 提案单、`docs/reports/资料库正文索引-B方案可行性与成本测算.md` §13–§17。

- 🔴 **真天花板**：`searchLocal()` 只 `name/path ilike`、`MAX_DEEP_FILES=3` ⇒ 题干词不在文件名里永远进不了候选池。可抽率：docx≈100%、pdf<1MB 90%、≥1MB 0~12.5% ⇒ 别规划全量抽 pdf；`.doc` 10,503 份无解。
- ✅ 方案 A 完成（11-06）：`ok` **10,454（93.5%）**、正文 **9,450.3 万字**、候选池归零；`AB=6` 文件名 0/正文 196、`平行四边形` 129/1,102。**召回代码仍零改动**。
- 🔴 正文 `ilike` 无索引 **2.8s/词**；keys 是去标点串（`ACABD点`）而正文含标点 ⇒ **0 命中**，运行时归一化 **3 分 06 秒** ⇒ 必须预计算 `text_flat`。「装 trigram 就毫秒级」**未验证**；短 key（2~3 字）必须排除。
- 🔴 `netdisk-extract-text.mjs`：默认 dry-run、`--apply` 才写、只写三列、环境失败绝不写 `none`、按 id 游标、口径与 `ensureText()` 逐字一致；M30 14 条钉死。回滚锚点必留（收尾 `11-06 04:00:15+00` 等三个，见报告）；撤销用 `text_updated_at > 锚点` 三列置空。
- ⚠️ dry-run 耗时偏乐观（漏算 `GAP_MS=300`）⇒ 串行耗时乘 **1.4~1.5**；`--full-clean` 会 delete 行 ⇒ 抽取前后禁跑。

## 10 检索侧评审 / 判定层（P-009 / D-012）
> 真相源：报告 §0–§8、`P-009`、`D-012`、`M31`；详细过程见 `MEMORY-full-archive.md`。

- 🔴 原四步顺序错：实测 1 道真题全文级 `judge()` 判出 **3 个 exact 全是别的题解析（0/3）**。业界（报告 §7）统一「一题一对象＋多级漏斗＋置信度闸门」，**没人拿题干比整篇文档**；TextIn 指「解析张冠李戴」根因不在 OCR 而在对应关系。⛔ 别搬向量库/Reranker/LLM 兜底。
- ✅ P0 已实施：`question-match.ts` 切分 / `SourceLocation` / 设问 / `judgeObjects()`，`judge()` 委托且返回结构不变；两处正文接入并带 `source_location`；M31 15/15、M27 21/21、M30 14/14。
- 🔴 **六条准入硬闸（串联否决，禁改加权求和）**：≥3 长锚点／对象题干 ≤6000 字／设问一致（冲突硬否决，unknown 锚点率 0.4→**0.55**）／锚点共现**限对象内**／相邻解析段 ≥8 字且不串题号／来源唯一（并列⇒降级）。`topic/none` 一律 `answer:''`、无 `source_location`。
- 🔴 **「未达标不放行」= 举证责任倒置**（不是 Top-1 / 调阈值）＋成本不对称＋准入非排序。两层：单次六条布尔；上线准入＝**误判归零（一票否决）＋召回 ≥90%＋定位 100%＋P95<3s**。实测负例 0/4、正例 28/28、定位 28/28。
- 🔴 **残余风险仍未消除**：合成「题干 A + 别人解析」**仍放行**；40/40 ROC 证明关系信号做不到零误判＋高召回（`solutionLink` 对本题/他人解析**同分**）⇒ 纯文本无版面坐标时**无法证明解析归属**，软信号不得进放行判据。

## 11 结构化切分入库（P-010 / D-013 · 11-06，P1 已实施）
> 真相源：报告 **§9**、`P-010`、`D-013`、`M32`。

- ✅ **思傅拍板**：P0 实跑核查通过后「再进行 P1 的结构化切分入库」⇒ D-013 把 P1 从未批准**改判为已批准（仅工程管控层）**。台账追加式，不改 P-009/D-012 历史口径（M31 断言保留）。启动 P1 不违反「未达标不放行」：§8.5 拦的是**召回变宽**，P1 做的是**判定收紧**，只减不增 exact。
- ✅ 落地：`migrations/0026_question_objects.sql`（一题一行＋`object_fingerprint`/`source_revision`/`link_status`/`engine_version`/字符区间，唯一键 `(user_id,source_type,source_id,object_index)`）；`scripts/question-objects-build.mjs`（默认 dry-run、`--apply` 才写、**只写目标表**、复用 `dist/shared/question-match.js` 作唯一切分真相源且产物旧即退出、幂等 upsert、三条防误删护栏、NUL 清洗）；`shared/question-object-store.ts`（唯一取数口，必带 `.eq('user_id',userId)`，`QUESTION_OBJECTS_STRICT` 默认 0 回退 P0）；`judgeStoredObjects()` + `selectUnique()` 供 P0/P1 共用；两处 service 走 `judgeWithStore()`；`CACHE_VERSION` **v5→v6**；**M32 16/16**。
- 🔴 **口径**：`library_docs` 判定层 `.slice(0,60_000)` ⇒ 构建脚本对 library 也按 60k 算 `source_revision`，否则对象永远判「过期」。M32 静态断言钉住。
- ✅ **真实入库（本地开发库，非现网）**：`migrate.mjs --only 0026... --force` → `--from-fixture --apply --user <真实 uuid>` 写 **40 行/4 来源**，重跑仍 40 行；回读 40 个唯一指纹、复算零偏差、无重复、源表行数未变。**未连 L3、未写生产数据、未部署**。
- 🔴 **P1 新增能力（P0 做不到）**：可复算审计（篡改即拒）／正文变更自动失效／**误判定点排除**（一个对象标 `rejected` ⇒ 它永不 exact，同文档其它题照常）。即业界说的「对应关系工程管控」。
- 🔴 **P1 未消除什么**：纯文本无版面坐标，原始文本流本身串了解析，结构化照样绑一起——M32 保留「重算指纹后的别人解析仍 `exact=true`」实证断言。彻底消除需版面坐标（未批准）；`strict=0` 期间未铺量来源仍回退 P0。
- 🔴 **仍锁**：第二层上线准入未全绿 ⇒ `QUESTION_OBJECTS_STRICT=1`、P2（0026 正文索引/text_flat/双通道召回/keyHits）、P3（放宽 MAX_DEEP_FILES/呈现层前置）**一律不动**；L3 全量 `--apply`（10,454 份）须思傅单独拍板 + 备份。


===== 2026-11-07 09:20 部署改判说明 =====
D-013 追加记录 1 / 报告 §9.6 / QA-16 v1.43 中「铺量≠生效、dist 仍是 11-04 旧版、不批准部署」是当时的拍板范围，作为历史事实保留。09:20 思傅拍板「部署新 dist 让这批数据真正进入判定链路」⇒ 由 D-013 追加记录 2 + 报告 §9.7 + QA-16 v1.44 记录改判，真相源为这三处。本归档不复制其内容。


===== r20 完整快照（2026-11-07 10:50，r21 压缩前）=====
# Growing-Kids 长期约定（r20 · 紧凑索引）

> 完整表述在 `MEMORY-full-archive.md`（111KB，含 r17/r18/r19 全文快照）、`docs/reports/`、`docs/design/method/`、`docs/design/GK-QA-16-*.md`、教训录 L<n>。本文件只留**判据 / 红线 + 指针**；⚠️ 新增前先想「能不能只写进 docs，这里留一行」。归档里的 `§N` 是旧编号，按标题找。

## 0 流程
- 家长主用、孩子次要；改「学习行为」先过 20a §5.1 三问 + §6.2 M1–M11，证据查 20b。GK-OPS-22（L0/L1/L2＋提案单 `method/proposals/P-NNN`＋台账 D 号）；**先查台账再评审**；动 `question-match.ts` 前须建档。
- 缺口序 C3 错因 > C2 信心 > C1 掌握梯度 > C5 交错。⛔ 励志推送／智能排程／"算出 ZPD"／打卡时长激励。**push 等思傅指示；本地 commit 照常。**

## 1 环境
- 🔴 **commit≠发货**：前端 `build:weapp`→开发者工具重编译→真机重扫码；后端换 `server/dist` 到 L3 **并重启 `gk-api`**（QA-16 §6.1.1：先迁移、再换 dist 并重启，旧 dist `mv` 成 `.bak-<时间戳>`，验 dist 用 grep 特征串）；只改后端时小程序包不用重传。
- 本地 `npx nest build`→杀 3001→`POST :3002/wake`（`/wait-ready` 只等不拉）。OCR venv 在仓库外 `D:/AI/gk-ocr-env`；spawn OCR python 必走 `pythonEnv()`、stdout 走 `decodeEngineChunk()`（判据：中文无 U+FFFD）。
- 🔴 **两套库别搞混**：**生产＝L3 `42.192.36.120`** → `SUPABASE_URL=http://127.0.0.1:8080`（PostgREST→同机 PG `gk`）+ `STORAGE_DRIVER=local`，密钥 `/etc/gk/secrets.env`；**本地 `server/.env` / `.env.migrate` 指 Supabase 云 `yjsuzunoxvyrblhuigpv`，是迁库遗留开发库、非现网**。L3 PG 只听 `127.0.0.1:5432`、外网仅 22/80 ⇒ 现网数据查询/删除**必须 ssh 上 L3**（QA-16 §3.1），删前先 `db-backup.mjs --no-upload`。

## 2 数据红线
- 无 RLS ⇒ 查询必须 `.eq('user_id', userId)`；删除加 `.select('id')` 校行数；`check:isolation` 是门禁。新表外键 `user_id` 必须 varchar(36)；真相源**只有 `migrations/`**（`shared/schema.ts` 是死代码）；空串≠NULL，回写前 `trim()`；迁移用低权 migrator，建表后 `--force --only` 重跑。
- 管理员 `users.role`＋`requireAdmin()` fail-closed，提权唯一入口 `promote-admin.mjs`；role 单独 `select("role")`。去重：`blob_objects` 内容寻址＋ref_count，`(user_id,file_hash)` 查重**必须在 ingest 前**；改引擎/切分必改 `OCR_ENGINE_VERSION`；存储 key 只 ASCII；含 `*_images` 的读端点过 `withUrls`。
- 🔴 **媒体读端点必须 `res.sendFile`**（禁 `createReadStream().pipe()`：无 Content-Length / 不处理 Range ⇒ 微信音频播不动）；判据 `curl -H 'Range: bytes=0-1023'` 回 206；前端 `obeyMuteSwitch=false`、`onError` 打 `errCode`。QA-16 §6.4。
- 🔴 **PG `text` 不接受 U+0000**：夹 NUL 整条 update 抛 `0x00` ⇒ 永远 `pending`、伪装成环境失败。落库前 `stripNul()`（txt 先剥 NUL 再判字数）。

## 3 资料库检索正确性主线（P-006 → P-010）
> 真相源：`docs/reports/资料库正文召回-检索侧四步方案评审.md` §0–§9、`docs/reports/资料库正文索引-B方案可行性与成本测算.md`、`P-006/008/009/010`、`D-009/011/012/013`、QA-16 §6.1.1–§6.1.4。

**P-006 硬闸**：`mode=kb` 曾把同专题片段当本题答案（根因：主题词召回 + bigram「主题相似」+ `hits.length>0` 即通过，无原题阈值）。真相源 `server/src/shared/question-match.ts`（**零依赖单文件**，M27/M31 用 tsc 单编后 require ⇒ 不能加 import）；粗筛 keys 只收 ≥4 字长锚点，阈值 `MATCH_MIN_LONG_ANCHORS=3` / `MATCH_MIN_LONG_RATIO=0.4`。`match_level = exact|topic|none`；🔴 **硬闸无数据源豁免**（网盘 / `library_docs.text_content` / 自有题库 / **ima** 都要过）、`topic` 必须 `answer:''`+`verified:false`；`kb` 顺序＝自有题库同题答案→library_docs→网盘 exact→ima→兜底；新增查库必带 `.eq('user_id',userId)`。🔴 **前后端必须同步发货**（只换后端时旧前端会「采纳」空答案，比不修更糟）。🔴 **双减合规**（《双减意见》§15 禁拍照搜题）⇒ `exact` 才放解析 / `topic` 答案为空**既是正确性也是合规红线**，答案带来源、孩子可见面前置引导。边界：ima 片段短多判 `topic`、`²` vs `^2` 未统一、**只有开放 AI 解题才能保证解出这道题**（明确不做）。

**P-008 正文索引（方案 A 已完成 11-06）**：🔴 真天花板＝`searchLocal()` 只 `name/path ilike` + `MAX_DEEP_FILES=3` ⇒ 题干词不在文件名里永远进不了候选池。可抽率 docx≈100%、pdf<1MB 90%、≥1MB 0~12.5% ⇒ 别规划全量抽 pdf；`.doc` 10,503 份无解。实绩 `ok` **10,454（93.5%）**、正文 **9,450.3 万字**；`AB=6` 文件名 0/正文 196；**召回代码仍零改动**。🔴 正文 `ilike` 无索引 2.8s/词；keys 是去标点串而正文含标点 ⇒ 0 命中、运行时归一化 3 分 06 秒 ⇒ 必须预计算 `text_flat`，短 key 排除；「装 trigram 就毫秒级」未验证。`netdisk-extract-text.mjs`：默认 dry-run、只写三列、环境失败绝不写 `none`、按 id 游标、口径与 `ensureText()` 逐字一致、M30 14 条钉死；回滚锚点见报告。⚠️ dry-run 漏算 `GAP_MS=300` ⇒ 串行耗时乘 1.4~1.5；`--full-clean` 会 delete 行 ⇒ 抽取前后禁跑。

**P-009 判定层（P0）**：原四步顺序错——实测 1 道真题全文级 `judge()` 判出 **3 个 exact 全是别的题解析（0/3）**。业界（报告 §7）：一题一对象＋多级漏斗＋置信度闸门，**没人拿题干比整篇文档**；⛔ 别搬向量库/Reranker/LLM 兜底。`question-match.ts` 新增切分/`SourceLocation`/设问/`judgeObjects()`，`judge()` 委托且返回结构不变；两处正文接入带 `source_location`；M31 15/15、M27 21/21。🔴 **六条准入硬闸（串联否决，禁改加权求和）**：≥3 长锚点／对象题干 ≤6000 字／设问一致（冲突硬否决，`unknown` 锚点率 0.4→**0.55**）／锚点共现**限对象内**／相邻解析段 ≥8 字且不串题号／来源唯一（并列⇒降级）；`topic/none` 一律 `answer:''`、无 `source_location`。🔴 **「未达标不放行」= 举证责任倒置**（不是 Top-1 / 调阈值）＋成本不对称＋准入非排序；两层判据＝单次六条布尔／上线准入**误判归零（一票否决）＋召回 ≥90%＋定位 100%＋P95<3s**；实测负例 0/4、正例 28/28、定位 28/28。🔴 **残余风险未消除**：合成「题干 A + 别人解析」仍放行；40/40 ROC 证明关系信号做不到零误判＋高召回（`solutionLink` 对本题/他人解析**同分**）⇒ 纯文本无版面坐标时**无法证明解析归属**，软信号不得进放行判据。

**P-010 结构化入库（P1）**：决策追加式（台账不涂改 P-009/D-012 历史，M31 断言保留）；§8.5 拦的是**召回变宽**，P1 只收紧判定、不增 exact。`0026` 一题一行（指纹/正文版本/`link_status`/规则版本/字符区间）；`question-objects-build.mjs` 默认 dry-run、只写目标表、复用 `dist` 作唯一切分真相源、幂等 upsert、三条防误删护栏；`question-object-store.ts` 唯一取数口必带 `user_id`，`QUESTION_OBJECTS_STRICT` 默认 0 回退 P0；`judgeStoredObjects()`/`selectUnique()` 与 P0 共用六条硬闸；两处 service 接 `judgeWithStore()`；`CACHE_VERSION` v5→**v6**；M32 **19/19**。🔴 口径：`library_docs` 判定层 `.slice(0,60_000)` ⇒ 构建脚本也按 60k 算 `source_revision`，否则永远判「过期」。

✅ **L3 全量铺量（11-07，范围仅写数据、不含部署）**：按 QA-16 §3.1 备份 → 0026 迁移 → 独立目录 `/opt/gk/qobj-run/server`（生产 dist 未动）→ dry-run → 全量 `nohup`，得 **326,680 行 / 10,460 来源**；指纹与正文版本全量复算 **0 偏差**、幂等重跑 `written 0`、源表未变、服务 200。🔴 **带出的坑**：`db-backup.mjs` 整表 `lines[]` 常驻内存 ⇒ **heap OOM**、不产出文件、每日 03:17 备份静默失效；修法＝`DERIVED_TABLES=['question_objects']` 排除**可确定性重建**的派生表 + manifest `excludedTables`/`rebuild`，恢复后 `--apply` 重建（QA-16 §6.1.2）；生产脚本是 10-31 CRLF 版、与仓库 HEAD 有 2 处既有差异 ⇒ 最小补丁同步、原件 `.bak-20261107`。

✅ **部署新 dist（11-07 09:20，思傅「部署新 dist 让这批数据真正进入判定链路」）**：报告 §9.7 / QA-16 §6.1.3–§6.1.4 / `D-013` 追加记录 2。🔴 **部署前抓到静默缺陷**：入库 `source_id=netdisk_files.id`（UUID）vs 运行时深挖 `String(cand.fsId)`（网盘数字）⇒ `loadQuestionObjects()` 恒空、网盘链路回退 P0，**326,680 行备而不用且接口/日志/health 全绿**；修法＝`ensureText()` 返回 `{text, sourceId}` 取缓存行 id，未铺量来源留空回退；M32 加 7 条子断言。教训（L30）：fixture 直接构造 rows 测不出取数 key，凡「查不到就回退」必须单独验 key 同源 + 生产模拟 `revisionMatch/structured/usable` 三项。🔴 **精准换 dist**：两边 8 个 JS 差异中 **4 个属身份治理**（`auth.controller`/`user-context`/`users.service`/新增 `anon-bootstrap-guard`，未批准、会改线上匿名建号）⇒ **不整目录替换**，只换判定链路 **12 文件**（4 组 js/d.ts/map）；回滚点 `dist.bak-20261107-0920`（530 文件/4.9MB），部署后哈希 **174/178 相同仅剩那 4 处**。🔴 **新表部署前必检**：`NOTIFY pgrst,'reload schema'` + `curl .../rest/v1/question_objects` 应回 **200 真实行**（8080 是 Caddy，直打 `/question_objects` 回空 200 是假通过）；`service_role` 需 SELECT + bypassrls。生产数据模拟 netdisk/library `revisionMatch/structured/usable` 全绿、library 正例 exact 定位正确；重启 4.2s、health 200、journalctl 无 ERROR、源表未变；本地与线上 4 个 JS 哈希逐字一致。只改后端 ⇒ 小程序包不重传；未做真实登录请求 E2E（避免污染生产用户数据）。

🔴 **边界**：① P1 未消除「别人的解析排本题后面」的张冠李戴（M32 实证断言），彻底消除需版面坐标；② `QUESTION_OBJECTS_STRICT` 未设（=0，有对象走结构化、无对象回退 P0）、`strict=1`、P2（正文索引/text_flat/双通道召回/keyHits）、P3（放宽 MAX_DEEP_FILES/呈现层前置）**仍锁**；③ 4 个身份治理改动仍未部署；④ 报告 §6 七项待拍板仍挂着。

## 4 接口与前端
> 光标补丁 / Taro / 隐私组件**完整原理**见归档（勿删，踩过三轮）。

- 前缀 `/api/`；禁 undefined 进 query；中文名 `encodeURIComponent`。`/api/upload`：`save`=建条目、`attach`=只持久化（附件必须 attach）。
- 🔴 **输入框光标**：两个 pnpm 补丁缺一不可 —— `@tarojs__react@4.1.9.patch`（同值 value 摘掉、**返回 `[]` 不能为 null**）＋`@tarojs__runtime@4.1.9.patch`（INPUT 只同步 `props.value`）；组件 `flushSync()` + 丢弃非字符串 `detail.value`。⛔ 延迟上抛／不传 value／`defaultValue`／改 `Symbol.hasInstance`（白屏）。`focus={false}`=失焦、`cursor={-1}`=末尾 ⇒ 条件展开。M12＋M18-11。✅ 全仓统一 `ui/Textarea`（maxlength -1、`style` 只落外壳、外壳禁 `onTouchStart`、`autoHeight` 只能 `minHeight`）。
- 🔴 `downloadFile`/`uploadFile` 只补域名不注入令牌 ⇒ 打自家 `/api` 的下载必须 `header: buildHeaders()`；公网签名直链**不要**带头。service 层自己 `unwrap`（调用方出现 `(res as any).data?.data` 即契约断）；驼峰/snake 在 service 转完。**M18 红线**：Text onClick（用 View）／下载 header／禁双重解包／guardPrivacy／maxlength=-1／禁 process.env／禁空 catch／列表 finally 解 loading／guardPolicy／同意键禁硬编码。
- 令牌 **X-Auth-Token 唯一被采信**（裸 X-User-Id 401），CORS 必暴露；免登录端点同步 `PUBLIC_ROUTES`；必须关 HTTP 协商缓存（ETag⇒304 空 body⇒列表静默不刷新）；`silent` 只约束「开始」。🔴 `navigateBack` 不重新 mount ⇒ 编辑/新增页返回要 `useDidShow` + `firstShowRef` 跳首帧 + `silent:true`。
- ⚠️ 音视频禁原生小写标签：音频 `createInnerAudioContext()`（`useDidHide` stop+destroy）、视频 `<Video>` 必须给确定高度；`<Image>`/`<Video poster>` 不发请求头 ⇒ 服务端直给 `*_url`。🚨 微信 request/uploadFile **超时上限 60s** ⇒ >60s 走 `POST /api/jobs` 202+轮询（新增类型同步 5 处、闸门在提交阶段、任务只在内存、重启即 failed）。
- 🔴 隐私同意要真拦写：`guardPolicy(action)` 与 `guardPrivacy` 串行两道；「去同意」跳 `pages/privacy/index?from=guard`。🚨 App 根渲染兄弟节点不挂页面 ⇒ `<PolicyConsent/>` 挂首页 + `useState(() => !hasAgreedPolicy())` 首帧画；`privacy-gate`/`Toaster` 同理。隐私接口失败禁 `catch {}`（errno 112）；`__usePrivacyCheck__` 默认关；Taro 4.1.9 取 API 走 `globalThis.wx`；头像昵称用原生 `chooseAvatar` + `type=nickname`。
- 🔴 改 `note`/result 结构 ⇒ 必 bump `CACHE_VERSION`（参与 `qHash`，`answer_cache` 按 `(user_id,q_hash,mode)` 存整个 result 原样返回）；判据＝拿**没问过的新题**测；当前 **v6**。QA-16 §6.3.5。
- 🔴 `gk-netdisk-index.timer`（周日 04:23，gk）：`--budget-ms 5400000`＋`--full-clean`＋`library-index-text.mjs`；增量看不见内容替换、`method=listall` 不可用（errno 20020）；**停 timer = 隐私「每周同步」承诺不兑现**。🔴 **防误删三护栏**：`--root` 不以 `/` 开头或含 `:`/`\` 直接退出（Git Bash 转路径⇒列 0 条⇒删光 65,890 行）／零文件不清库／待删超半数要 `--force-clean`。
- ⚠️ 面客统一「资料库」不出现「百度网盘」，**但隐私政策第四节第三方清单必须保留**（法定披露、两处副本逐字一致）；trgm 索引只在少条件生效（8~12 个 `ilike` ⇒ 顺序扫描）；`library_docs` 0023 起有 `text_content`/`text_status`。🔴 抽正文环境类失败（`no-python`/`no-script`/`timeout`）保持 `pending`，不许标 `none`。🔴 网盘凭证是运营者单账号 ⇒ 出现第二个真实用户即使披露不实（R-合规-08 三选一）。
- 🔴 导航 tab = 首页／复习本／**资料**(`pages/library`)／记忆，tab 页只能 `switchTab`；汇总在 `pages/summary`；面客说「资料」不说「文档」；键盘遮挡用 `lib/use-keyboard-avoid.ts`。原生 button 三种例外：头像 `chooseAvatar`／反馈 `contact`（仅真机）／同意键 `agreePrivacyAuthorization`；默认边框是 `::after`。`/auth/me` 带 `role`（单独查）；答案+解题合并一框、页面持唯一草案；`/api/memories` 支持 `subject_id`/`since`/`tag`（**无 `until`**），列表缓存 key 带筛选条件。

## 5 AI / 品牌 / L3 托管
- `users.ai_enabled`(0018) **默认 false**；`requireAiEnabled()` 拦 chat/message/answer-search/search/solve；改开关必须 `invalidateUserFlags()`。个人主体 ⇒ AI 入口整体收起（`AI_PUBLIC_ENTRY=false`）。名统一**成长学童**，`陕ICP备2026030931号-1X`；`--brand` #0B3D2E / `--brand-text` #0B7A55；`utils/latex.ts` 编辑态不显示源码；`LIBRARY_NETDISK_SYNC=true` 只写不读。
- L3 = Ubuntu 24.04.4 / 4核4G60G；栈 PG17.11→PostgREST12.2.3→Caddy→Node 3000→OCR venv；代码根 `/opt/gk/server`（布局必须 `/opt/gk/{server,migrations,ocr-engine}`）；用户 `ubuntu`（非 root），`/opt/gk` 要 `sudo -n`。
- 🔴 `STORAGE_DRIVER=local` 同步两处：`PUBLIC_ROUTES` 加 `/^\/api\/storage\/files\//` ＋ `STORAGE_PUBLIC_BASE_URL`（否则白图无报错）；Caddy 站点块**必须用 `handle` 包住** `file_server`；`PROJECT_DOMAIN` 是编译期常量，改 `.env.local` 必须重建。Linux 下 `OCR_VENV_DIR` 不生效 ⇒ 必设 `OCR_PYTHON`+`PPSV3_PYTHON`+`PADDLE_PDX_CACHE_HOME`/`XDG_CACHE_HOME`。
- 🔴 **手工部署只换 `dist` 会漏文件**：改 `ocr-engine/*.py` 必须单独 scp；漏传**接口不报错、静默降级**（判据 `hits[].hit` 有没有 `content`）。精准线提速开关是 PaddleX 层 `PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT`（须在 import 前设）：9.63→2.41s/页；快速=rapid→`main.py`、精准=PP-StructureV3→`main3.py`，**补丁两处都改**；`--mode both` 重复文本 ⇒ 生产 `OCR_ENGINE_MODE=rapid`；判好坏看置信度不看区数。
- 搬数据在云主机做（`PGTZ=UTC`＋两侧 pg_dump 排序比字节）；`--disable-triggers` dump 只能 `postgres` 导入＋`--single-transaction`。**生产备份**：`gk_backup` 必须 `bypassrls`（否则 `ocr_results` 静默 0 行）；口令丢了=备份永久作废，有历史备份+缺口令就抛错；网盘分片 4/16/**32MB**、≤1024 片、300s；DB 每日 03:17(keep 14)、文件周日 03:47(keep 6)。
- **结果指标**：唯一够格 = 到期首次作答正确率（按档位）⇒ `0021 review_events`+`review()` 埋点；按 `(item_id,due_on)` 取最早一条、只算 `due_on <= 作答本地日`；埋点失败不得阻断作答；每档 ≥30 样本才出数；**当前 0 行**。
- 🔴 **L3 长任务铁律**：① `ssh host 'node x.mjs'` 断连即 SIGHUP 被杀 ⇒ 远端 `nohup` + 远端日志 + 另开 ssh 轮询；② `.env.migrate` 是 `600 gk:gk`，`ubuntu` 直跑必 `EACCES` ⇒ 写库脚本必须 `sudo -u gk -H bash -c '…'`。

## 6 发布与测试
- 发版前轮换 WX_SECRET（`rotate-wx-secret.mjs`）**后必跑 encrypt-env.mjs**；`pnpm release:check` 上传后记得 revert；生产 `WAKE_ENABLED=0`。🚨 开发管理已托管第三方 ⇒ 域名白名单配不了 ⇒ **发正式版必须先解除托管**。服务类目现「教育服务 > 教育信息展示」（已通过），**保留 + 追加工具类目**，⛔ 别删。
- 🔴 备案：轻量须包月≥3月、**L3 到期⇒备案失效**；个人主体文案禁教育/培训/课程/辅导；**小程序备案 ≠ 域名备案**；首页 footer 挂真实号＋`beian.miit.gov.cn`；**公安联网备案待办**（判据＝拿到 `陕公网安备…号`）；首页 `<title>`/`<h1>` 必须与备案站名逐字一致（要素见 `docs/reports/公安联网备案操作指引.md` §2.4）。✅ 迁库零改查询 ⇒ 自签两枚 HS256 JWT；`SUPABASE_URL` 必须 `http://127.0.0.1:8080`，`service_role` 必须 BYPASSRLS。💰 L3 三年 ¥649（188 档+同价续费+升配 3.5 折，先续费后升配、费用须 ¥0）；装机坑：PGDG 用腾讯镜像、PostgREST `db-uri` TCP+密码、Caddy 写 IP 须 `bind 127.0.0.1`、swap `swappiness` 60→10。
- `server/scripts/verify/`：新模块丢 `modules/NN-x.mjs` 自动发现；`pnpm verify:ci`（M12 M13 M16）、前端 `pnpm verify:gate`（+M18）；`harness.api()` 对幂等方法重试一次，POST/超时不重试；纯函数模块 tsc 单编后 require（M12/M15/M26/M27/M31）。**M16 三条硬门**：六栏+引用可解析／禁用宣称词／镜像参数逐字一致；门只守结构、归因只有人能判。**造数据铁律**：同内容文件会命中去重 ⇒ 每次内容必须不同。
- UI 通道 `ide-cdp.mjs`+`ide-*.mjs`，进程须在**同一个 `run_in_background` 任务**启动+保活；输入一律 `Input.insertText`（绕开输入法组合 ⇒ 测不出时序竞争）；🔴 测试期禁用真登录（`/auth/login` 会整体迁移匿名号数据），切身份只换令牌 `ide-account.mjs use real|anon`。判图必须真载（`<Image>`→`<wx-image>`+内层 div `background-image`，`document.images` 恒 0）；IDE 四坑：鼠标事件带 `buttons:1`／「没反应」先查 `gk_policy_agreed_v1`／`chooseMedia` 走 Promise／选图必经裁剪编辑器。⚠️ 根 `tsc --noEmit` 会报一堆 node_modules 第三方声明错（既有噪音）；正确门禁 `pnpm verify:gate` + `pnpm lint:build`，后端用 `server/` 下 `tsc --noEmit` + `npx nest build`。

## 7 其它
- **复习排程 C4**：真相源 `timeline/review.ts`；五档 1→3→7→14→28 天，做对推进、做错归零；`content.review_count` 已废；前端不自算 plan；改间隔表触发 M15（三处同步）。
- **CI**：`gate`=build:server→build:weapp→M12 M13 M16；`api-core` 需 5 secret 才跑 M01–M08/M15；OCR GT 退出码 2 = 环境跑不起来；`R-算法-07` 竖式符号行丢失（未修）；导出口径 `include_answers` 不传=不含答案；🔴 PDF 只有 paddle（`recognizePdfDoc` 固定 ppsv3，`OCR_PDF_MAX_SCANNED_PAGES=8` ⇒ 有效 8 页）。
- **方法论**：M11 连续天数/停留时长只作引导展示、不得作判定标准；🚨 **20b 第 7 章标题不可动**（`method-gates.mjs` 正则算文献号上界，重排⇒H1 静默跳过）；批量改文档用脚本+「命中 1 次」断言；引用 `GK-SRS-20a M<n>`／`GK-SRS-20b 文献 <n>`，改准则走 L2；教训 L27 同一 bug 改到第三版停下建复现模型、L28 平台规则从源码/文档抠、L30 测试通道决定结论上限。
- **年级属性 P-005/D-008/0025**：12 档，真相源 `shared/grade.ts`＋前端镜像 `constants/grades.ts`（不跨端 import），M26 守；`users.grade`=当前／`grade_confirmed_year`=学年起始年／`timeline_items.grade`·`library_docs.grade`=创建时快照。🔴 扩散只看本年级精确命中数／`grade is null` 始终可见／`normalizeGrade` 先挡空串／计数失败按 0；复习本／记忆／识别页不传 grade；筛掉用户内容必须自带回退开关。⚠️ 新增用户属性字段要查所有按 user_id 搬数据的路径（`adoptGrade()`）。
- 🔴 **本地 commit ≠ 生产有代码**：曾因「生产库没 0025 **且** dist 没 `setGrade`」⇒ 404；排查先 grep 生产 dist 特征串；`sudo -n -u gk node /opt/gk/server/scripts/migrate.mjs --only <file>`（`--ping`/`--dry` 先验）。🔴 **`users` 行数 ≠ 真实用户规模**：生产 80 = 清掉 117 个零数据空壳后 79 匿名 + 1 正式；`findOrCreateByDeviceId()` 对每个新 `X-Device-Id` 自动建匿名号（TTL 30 天）；**528 道题挂在 29 个匿名号上是联调数据、不能删**。🔴 异步任务提交闸门必须与同步端点同口径（`POST /api/jobs` 曾按 type 一刀切 `requireAiEnabled` ⇒ `mode=kb` 403；按 `params.mode` 分流，M17 回归）。**CDP 噪音**：`remote-debug/appservice` 的 `wx is not defined` 不是崩了，判据＝主逻辑层 `typeof wx === "object"`；读历史日志用 `Log.enable`（会回放）。


===== r21 完整快照（2026-11-07 11:38，r22 压缩前）=====
# Growing-Kids 长期约定（r21 · 判据索引）

> 全文快照 `MEMORY-full-archive.md`（r17–r20，含原理与踩坑过程）；过程真相源 `docs/reports/`、`docs/design/method/proposals/P-NNN`＋台账 D-NNN、`docs/design/GK-QA-16-*.md`、`GK-OPS-18-*.md`、教训录 L<n>。本文件只留**红线判据＋一行指针**；新增前先想「能不能只写进 docs」。

## 0 流程
- 家长主用、孩子次要；改「学习行为」先过 20a §5.1 三问＋§6.2 M1–M11，证据查 20b。GK-OPS-22：L0/L1/L2＋提案单 P-NNN＋台账 D 号，**先查台账再评审**；动 `question-match.ts` 前须建档。设计决策逐题确认后再开工。
- 缺口序 C3 错因 > C2 信心 > C1 掌握梯度 > C5 交错。⛔ 励志推送／智能排程／「算出 ZPD」／打卡时长激励。**push 等思傅指示；本地 commit 照常。**

## 1 环境（两套库）
- 🔴 **生产＝L3 `42.192.36.120`**：`SUPABASE_URL=http://127.0.0.1:8080`（PostgREST→同机 PG `gk`）＋`STORAGE_DRIVER=local`，密钥 `/etc/gk/secrets.env`；**本地 `server/.env`／`.env.migrate` 指 Supabase 云 `yjsuzunoxvyrblhuigpv`，是迁库遗留开发库、非现网**。L3 PG 只听 127.0.0.1:5432、外网仅 22/80 ⇒ 现网数据查询/删除**必须 ssh 上 L3**（QA-16 §3.1），删前 `db-backup.mjs --no-upload`。查库：`ssh -T ubuntu@… "sudo -n -u postgres psql -d gk"`＋stdin SQL。
- 🔴 **commit≠发货**：前端 `build:weapp`→开发者工具重编译→真机重扫码；后端换 `server/dist` 到 L3 **并重启 `gk-api`**（QA-16 §6.1.1：先迁移、再换 dist 并重启，旧 dist `mv` 成 `.bak-<时间戳>`，grep 特征串验包）；只改后端时小程序包不重传。本地 `npx nest build`→杀 3001→`POST :3002/wake`（`/wait-ready` 只等不拉）。
- 🔴 **L3 长任务铁律**：① `ssh host 'node x.mjs'` 断连即 SIGHUP ⇒ 远端 `nohup`＋远端日志＋另开 ssh 轮询；② `.env.migrate` 是 `600 gk:gk`，`ubuntu` 直跑必 EACCES ⇒ 写库脚本 `sudo -u gk -H bash -c '…'`。OCR venv 在仓库外 `D:/AI/gk-ocr-env`；spawn OCR python 必走 `pythonEnv()`、stdout 走 `decodeEngineChunk()`（判据：中文无 U+FFFD）。

## 2 数据红线
- 无 RLS ⇒ 查询必须 `.eq('user_id', userId)`（`check:isolation` 门禁，源码豁免 `// check-isolation-ignore: 理由`）；删除加 `.select('id')` 校行数。新表外键 `user_id` 必须 varchar(36)；真相源**只有 `migrations/`**（`shared/schema.ts` 是死代码）；空串≠NULL，回写前 `trim()`；迁移用低权 migrator，建表后 `--force --only` 重跑。
- 管理员 `users.role`＋`requireAdmin()` fail-closed，提权唯一入口 `promote-admin.mjs`；role 单独 `select("role")`。去重：`blob_objects` 内容寻址＋ref_count，`(user_id,file_hash)` 查重**在 ingest 前**；改引擎/切分必 bump `OCR_ENGINE_VERSION`／`OBJECT_ENGINE_VERSION`；存储 key 只 ASCII；含 `*_images` 的读端点过 `withUrls`。
- 🔴 PG `text` 不接受 U+0000：夹 NUL 整条 update 抛 `0x00` ⇒ 永远 `pending`、伪装环境失败。落库前 `stripNul()`（txt 先剥 NUL 再判字数）。
- 🔴 **媒体读端点必须 `res.sendFile`**（禁 `createReadStream().pipe()`：无 Content-Length / 不处理 Range ⇒ 微信音频播不动）；判据 `curl -H 'Range: bytes=0-1023'` 回 206；前端 `obeyMuteSwitch=false`、`onError` 打 `errCode`（QA-16 §6.4）。
- 生产备份：`gk_backup` 必须 `bypassrls`；口令丢了＝备份永久作废；DB 每日 03:17(keep 14)、文件周日 03:47(keep 6)；分片 4/16/**32MB**、≤1024 片、300s。🔴 **`question_objects` 是派生表不进备份**（整表 `lines[]` 曾 heap OOM、每日备份静默失效），恢复后 `question-objects-build.mjs --apply` 重建（QA-16 §6.1.2）。

## 3 资料库检索正确性主线（P-006 → P-010）
> 真相源 `docs/reports/资料库正文召回-检索侧四步方案评审.md` §0–§9、`资料库正文索引-B方案可行性与成本测算.md`、P-006/008/009/010、D-009/011/012/013、QA-16 §6.1.1–§6.1.4。
- **P-006 硬闸**：真相源 `server/src/shared/question-match.ts`（**零依赖单文件**，M27/M31 tsc 单编后 require ⇒ 不能加 import）；粗筛 keys 只收 ≥4 字长锚点，`MATCH_MIN_LONG_ANCHORS=3`／`RATIO=0.4`。`match_level=exact|topic|none`；🔴 **硬闸无数据源豁免**（网盘／`library_docs.text_content`／自有题库／ima 都要过）、`topic` 必须 `answer:''`＋`verified:false`；`kb` 顺序＝自有题库同题答案→library_docs→网盘 exact→ima→兜底。🔴 前后端**必须同步发货**。🔴 **双减合规**：禁「拍照搜题」形态，`exact` 才放解析／`topic` 答案为空**既是正确性也是合规红线**；定位＝家长整理资料、查原题解析（报告 §7.6），改面客文案前先复核。
- **P-008 正文索引（A 方案 11-06 完成）**：🔴 真天花板＝`searchLocal()` 只 `name/path ilike`＋`MAX_DEEP_FILES=3` ⇒ 题干词不在文件名里永远进不了候选池。可抽率 docx≈100%、pdf<1MB 90%、≥1MB 0~12.5%；`.doc` 10,503 份无解。实绩 `ok` **10,454（93.5%）**、正文 **9,450.3 万字**；`AB=6` 文件名 0/正文 196；**召回代码仍零改动**。🔴 正文 `ilike` 无索引 2.8s/词、keys 去标点而正文含标点 ⇒ 0 命中，须预计算 `text_flat`。脚本默认 dry-run、只写三列、环境失败绝不写 `none`、M30 14 条钉死；⚠️ `--full-clean` 会 delete ⇒ 抽取前后禁跑。
- **P-009 判定层（P0）**：实测全文级 `judge()` 对 1 道真题判出 **3 个 exact 全是别的题解析（0/3）**。业界共识＝一题一对象＋多级漏斗＋置信度闸门，⛔ 别搬向量库/Reranker/LLM 兜底。🔴 **六条准入硬闸（串联否决，禁改加权求和）**：≥3 长锚点／对象题干 ≤6000 字／设问一致（冲突硬否决，`unknown` 锚点率 0.4→**0.55**）／锚点共现**限对象内**／相邻解析段 ≥8 字且不串题号／来源唯一（并列⇒降级）。🔴 **「未达标不放行」＝举证责任倒置**（不是 Top-1 / 调阈值）＋成本不对称＋准入非排序；两层判据＝单次六条布尔／上线准入**误判归零＋召回 ≥90%＋定位 100%＋P95<3s**；实测负例 0/4、正例 28/28。🔴 残余风险：合成「题干 A＋别人解析」仍放行；40/40 ROC 证明纯文本无版面坐标时**无法证明解析归属**。
- **P-010 结构化入库（P1）**：`0026` 一题一行（指纹/正文版本/`link_status`/规则版本/字符区间，唯一键含 `user_id`）；构建脚本默认 dry-run、只写目标表、复用 `dist` 作唯一切分真相源、幂等 upsert、三条防误删护栏；`question-object-store.ts` 唯一取数口必带 `user_id`，`QUESTION_OBJECTS_STRICT` 默认 0 回退 P0；`CACHE_VERSION` **v6**；M32 19/19。🔴 `library_docs` 判定层 `.slice(0,60_000)` ⇒ 构建脚本也按 60k 算 `source_revision`，否则永远判过期。
- ✅ **L3 全量铺量＋部署（11-07）**：**326,680 行 / 10,460 来源**，指纹与版本复算 0 偏差、幂等重跑 `written 0`、源表未变。🔴 部署前抓到 `source_id` 口径错配（入库 `netdisk_files.id` vs 运行时 `cand.fsId`）⇒ 对象恒空、静默回退 P0；修 `ensureText()` 返 `{text,sourceId}`，M32 加 7 条断言（教训 L30：凡「查不到就回退」必须验 key 同源）。🔴 **精准换 dist**：8 个 JS 差异里 4 个是**未批准的身份治理改动** ⇒ 只换判定链路 12 文件，回滚点 `dist.bak-20261107-0920`。🔴 **新表部署前必检**：`NOTIFY pgrst,'reload schema'`＋`curl 8080/rest/v1/question_objects` 回 **200 真实行**（直打 `/question_objects` 回空 200 是假通过）；`service_role` 需 SELECT＋bypassrls。报告 §9.7 / QA-16 v1.44 / D-013 记录 2。
- 🔴 **11-07 现网体检（本轮结论）**：326,680 行**全挂在 2 个账号**：唯一正式号 `cc6d7b10…`(admin) 326,087 行＋探测号 `f158a819…` 593 行；`netdisk_files` 同样只属这 2 个（78,400/30 行）。**80 个用户里 79 匿名、仅 1 个有 open_id** ⇒ 换任何新账号检索，`searchLocal()`／`ensureText()`／`loadQuestionObjects()` 全按 `.eq('user_id',userId)` ⇒ **公共题库零命中**，只剩实时文件名兜底＋现抽正文＋回退 P0。思傅明确设计口径应是「**所有用户共享的公共题库、不带用户信息**」⇒ 现状不满足；须连 `netdisk_files` 一起公共化，光改 `question_objects` 无效；同时触发 `R-合规-08` 路径③（隐私政策／面客文案「你自己的网盘」→「运营者提供的公共资料库」）。
- 🔴 **边界**：① P1 未消除「别人的解析排本题后面」的张冠李戴；② `strict=1`、P2（正文索引/`text_flat`/双通道召回/keyHits）、P3（放宽 `MAX_DEEP_FILES`/呈现层前置）**仍锁**；③ 4 个身份治理改动未部署；④ 报告 §6 七项待拍板仍挂着；⑤ 未做真实登录 E2E。

## 4 接口与前端
> 光标补丁 / Taro / 隐私组件完整原理见归档（勿删，踩过三轮）。
- 前缀 `/api/`；禁 undefined 进 query；中文名 `encodeURIComponent`。`/api/upload`：`save`=建条目、`attach`=只持久化。
- 🔴 **输入框光标**：两个 pnpm 补丁缺一不可 —— `@tarojs__react@4.1.9.patch`（同值 value 摘掉、**返回 `[]` 不能为 null**）＋`@tarojs__runtime@4.1.9.patch`（INPUT 只同步 `props.value`）；组件 `flushSync()`＋丢弃非字符串 `detail.value`。⛔ 延迟上抛／不传 value／`defaultValue`／改 `Symbol.hasInstance`（白屏）。`focus={false}`=失焦、`cursor={-1}`=末尾 ⇒ 条件展开。✅ 全仓统一 `ui/Textarea`（maxlength -1、`style` 只落外壳、外壳禁 `onTouchStart`、`autoHeight` 只能 `minHeight`）。
- 🔴 `downloadFile`/`uploadFile` 只补域名不注入令牌 ⇒ 打自家 `/api` 的下载必须 `header: buildHeaders()`；公网签名直链**不要**带头。service 层自己 `unwrap`（调用方出现 `(res as any).data?.data` 即契约断）；驼峰/snake 在 service 转完。**M18 红线**：Text onClick（用 View）／下载 header／禁双重解包／guardPrivacy／maxlength=-1／禁 process.env／禁空 catch／列表 finally 解 loading／guardPolicy／同意键禁硬编码。
- 令牌 **X-Auth-Token 唯一被采信**（裸 X-User-Id 401），CORS 必暴露；免登录端点同步 `PUBLIC_ROUTES`；必须关 HTTP 协商缓存（ETag⇒304 空 body⇒列表静默不刷新）；`silent` 只约束「开始」。🔴 `navigateBack` 不重新 mount ⇒ 编辑/新增页返回要 `useDidShow`＋`firstShowRef`＋`silent:true`。
- ⚠️ 音视频禁原生小写标签：音频 `createInnerAudioContext()`（`useDidHide` stop+destroy）、视频 `<Video>` 必须给确定高度；`<Image>`/`<Video poster>` 不发请求头 ⇒ 服务端直给 `*_url`。🚨 微信 request/uploadFile **超时上限 60s** ⇒ >60s 走 `POST /api/jobs` 202+轮询（新增类型同步 5 处、闸门在提交阶段、任务只在内存、重启即 failed）。
- 🔴 隐私同意要真拦写：`guardPolicy(action)` 与 `guardPrivacy` 串行两道；「去同意」跳 `pages/privacy/index?from=guard`。🚨 App 根渲染兄弟节点不挂页面 ⇒ `<PolicyConsent/>` 挂首页＋`useState(() => !hasAgreedPolicy())` 首帧画；`privacy-gate`/`Toaster` 同理。隐私接口失败禁 `catch {}`（errno 112）；`__usePrivacyCheck__` 默认关；Taro 4.1.9 走 `globalThis.wx`；头像昵称用原生 `chooseAvatar`＋`type=nickname`。
- 🔴 改 `note`/result 结构 ⇒ 必 bump `CACHE_VERSION`（参与 `qHash`，`answer_cache` 按 `(user_id,q_hash,mode)` 存整个 result 原样返回）；判据＝拿**没问过的新题**测；当前 **v6**。
- 🔴 `gk-netdisk-index.timer`（周日 04:23，gk）：`--budget-ms 5400000`＋`--full-clean`＋`library-index-text.mjs`；增量看不见内容替换、`method=listall` 不可用（errno 20020）；**停 timer＝隐私「每周同步」承诺不兑现**。🔴 **防误删三护栏**：`--root` 不以 `/` 开头或含 `:`/`\` 直接退出／零文件不清库／待删超半数要 `--force-clean`。
- ⚠️ 面客统一「资料库」不出现「百度网盘」，**但隐私政策第四节第三方清单必须保留**（法定披露、两处副本逐字一致有校验）；trgm 索引只在少条件生效；`library_docs` 0023 起有 `text_content`/`text_status`。🔴 抽正文环境类失败保持 `pending`。🔴 **网盘凭证是运营者单账号** ⇒ `R-合规-08` 硬前置三选一（per-user OAuth／关掉非运营者检索／改文案为公共资料库）。
- 🔴 导航 tab＝首页／复习本／**资料**(`pages/library`)／记忆，tab 页只能 `switchTab`；汇总在 `pages/summary`；面客说「资料」不说「文档」；键盘遮挡用 `lib/use-keyboard-avoid.ts`。原生 button 三种例外：头像 `chooseAvatar`／反馈 `contact`（仅真机）／同意键 `agreePrivacyAuthorization`；默认边框是 `::after`。`/auth/me` 带 `role`（单独查）；答案+解题合并一框、页面持唯一草案；`/api/memories` 支持 `subject_id`/`since`/`tag`（**无 `until`**）。

## 5 AI / 品牌 / L3 托管
- `users.ai_enabled`(0018) **默认 false**；`requireAiEnabled()` 拦 chat/message/answer-search/search/solve；改开关必须 `invalidateUserFlags()`。个人主体 ⇒ AI 入口整体收起（`AI_PUBLIC_ENTRY=false`）。名统一**成长学童**，`陕ICP备2026030931号-1X`；`--brand` #0B3D2E / `--brand-text` #0B7A55；`utils/latex.ts` 编辑态不显示源码；`LIBRARY_NETDISK_SYNC=true` 只写不读。
- L3＝Ubuntu 24.04.4 / 4核4G60G；栈 PG17.11→PostgREST12.2.3→Caddy→Node 3000→OCR venv；代码根 `/opt/gk/server`（布局必须 `/opt/gk/{server,migrations,ocr-engine}`）；用户 `ubuntu`（非 root），`/opt/gk` 要 `sudo -n`。
- 🔴 `STORAGE_DRIVER=local` 同步两处：`PUBLIC_ROUTES` 加 `/^\/api\/storage\/files\//` ＋ `STORAGE_PUBLIC_BASE_URL`（否则白图无报错）；Caddy 站点块**必须用 `handle` 包住** `file_server`；`PROJECT_DOMAIN` 是编译期常量，改 `.env.local` 必须重建。Linux 下 `OCR_VENV_DIR` 不生效 ⇒ 必设 `OCR_PYTHON`+`PPSV3_PYTHON`+`PADDLE_PDX_CACHE_HOME`/`XDG_CACHE_HOME`。
- 🔴 **手工部署只换 `dist` 会漏文件**：改 `ocr-engine/*.py` 必须单独 scp；漏传**接口不报错、静默降级**（判据 `hits[].hit` 有没有 `content`）。精准线提速开关是 PaddleX 层 `PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT`（须在 import 前设）：9.63→2.41s/页；快速=rapid→`main.py`、精准=PP-StructureV3→`main3.py`，**补丁两处都改**；`--mode both` 重复文本 ⇒ 生产 `OCR_ENGINE_MODE=rapid`；判好坏看置信度不看区数。
- 搬数据在云主机做（`PGTZ=UTC`＋两侧 pg_dump 排序比字节）；`--disable-triggers` dump 只能 `postgres` 导入＋`--single-transaction`。🔴 `SUPABASE_URL` 必须 `http://127.0.0.1:8080`；`service_role` 必须 BYPASSRLS；自签两枚 HS256 JWT。💰 L3 三年 ¥649（188 档+同价续费+升配 3.5 折）。
- **结果指标**：唯一够格＝到期首次作答正确率（按档位）⇒ `0021 review_events`＋`review()` 埋点；按 `(item_id,due_on)` 取最早一条、只算 `due_on <= 作答本地日`；埋点失败不得阻断作答；每档 ≥30 样本才出数；**当前 0 行**。

## 6 发布与测试
- 发版前轮换 WX_SECRET（`rotate-wx-secret.mjs`）**后必跑 encrypt-env.mjs**；`pnpm release:check` 上传后记得 revert；生产 `WAKE_ENABLED=0`。🚨 开发管理已托管第三方 ⇒ 域名白名单配不了 ⇒ **发正式版必须先解除托管**。服务类目现「教育服务 > 教育信息展示」，**保留 + 追加工具类目**，⛔ 别删。
- 🔴 **个人主体小程序不得做「用户共享题库 / UGC 发布分享」**：微信【社交-笔记】类目仅非个人主体可用，用户上传文字/图片并供他人查看即属 UGC 发布（2026-11-01「床虱地图」一周两次被暂停，客服口径）；须接内容安全 API + 属地网信报备 7 日 + 人工审核 + 申诉渠道。叠加 **PIPL §16「不得以不同意/撤回同意为由拒绝提供服务」** ⇒ ⛔「共享自己的题才能用公共题库」的对价开关；§23/25 向他人提供或公开需单独同意、§15 撤回后须删除、§28/29 不满 14 岁信息属敏感信息需监护人同意。教辅 PDF/Word 共享涉信息网络传播权（多地法院判例：「非商业/侵权即删/注明出处」均不免责，平台知晓并欢迎上传不适用避风港）。
- 🔴 备案：轻量须包月≥3月、**L3 到期⇒备案失效**；个人主体文案禁教育/培训/课程/辅导；**小程序备案 ≠ 域名备案**；首页 footer 挂真实号＋`beian.miit.gov.cn`；**公安联网备案待办**（判据＝拿到 `陕公网安备…号`）；首页 `<title>`/`<h1>` 必须与备案站名逐字一致（`docs/reports/公安联网备案操作指引.md` §2.4）。
- `server/scripts/verify/`：新模块丢 `modules/NN-x.mjs` 自动发现；`pnpm verify:ci`（M12 M13 M16）、前端 `pnpm verify:gate`（+M18）；`harness.api()` 对幂等方法重试一次，POST/超时不重试；纯函数模块 tsc 单编后 require。**M16 三条硬门**：六栏+引用可解析／禁用宣称词／镜像参数逐字一致；门只守结构。**造数据铁律**：同内容文件命中去重 ⇒ 每次内容必须不同。
- UI 通道 `ide-cdp.mjs`+`ide-*.mjs`，进程须在**同一个 `run_in_background` 任务**启动+保活；输入一律 `Input.insertText`；🔴 测试期禁用真登录（`/auth/login` 会整体迁移匿名号数据），切身份只换令牌 `ide-account.mjs use real|anon`。判图必须真载（`<Image>`→`<wx-image>`+内层 div `background-image`，`document.images` 恒 0）；IDE 四坑：鼠标事件带 `buttons:1`／「没反应」先查 `gk_policy_agreed_v1`／`chooseMedia` 走 Promise／选图必经裁剪编辑器。⚠️ 根 `tsc --noEmit` 的 node_modules 报错是既有噪音；正确门禁 `pnpm verify:gate` + `pnpm lint:build`，后端用 `server/` 下 `tsc --noEmit` + `npx nest build`。

## 7 其它
- **复习排程 C4**：真相源 `timeline/review.ts`；五档 1→3→7→14→28 天，做对推进、做错归零；`content.review_count` 已废；前端不自算 plan；改间隔表触发 M15（三处同步）。
- **CI**：`gate`=build:server→build:weapp→M12 M13 M16；`api-core` 需 5 secret 才跑 M01–M08/M15；OCR GT 退出码 2＝环境跑不起来；`R-算法-07` 竖式符号行丢失（未修）；导出口径 `include_answers` 不传=不含答案；🔴 PDF 只有 paddle（`OCR_PDF_MAX_SCANNED_PAGES=8` ⇒ 有效 8 页）。
- **方法论**：M11 连续天数/停留时长只作引导展示、不得作判定标准；🚨 **20b 第 7 章标题不可动**（`method-gates.mjs` 正则算文献号上界，重排⇒H1 静默跳过）；批量改文档用脚本+「命中 1 次」断言；引用 `GK-SRS-20a M<n>`／`GK-SRS-20b 文献 <n>`，改准则走 L2；教训 L27 同一 bug 改到第三版停下建复现模型、L28 平台规则从源码/文档抠、L30 测试通道决定结论上限。
- **年级属性 P-005/D-008/0025**：12 档，真相源 `shared/grade.ts`＋前端镜像 `constants/grades.ts`（不跨端 import），M26 守；`users.grade`=当前／`grade_confirmed_year`=学年起始年／`timeline_items.grade`·`library_docs.grade`=创建时快照。🔴 扩散只看本年级精确命中数／`grade is null` 始终可见／`normalizeGrade` 先挡空串／计数失败按 0；筛掉用户内容必须自带回退开关。
- 🔴 **本地 commit ≠ 生产有代码**：曾因「生产库没 0025 **且** dist 没 `setGrade`」⇒ 404；排查先 grep 生产 dist 特征串；`sudo -n -u gk node /opt/gk/server/scripts/migrate.mjs --only <file>`（`--ping`/`--dry` 先验）。🔴 **`users` 行数 ≠ 真实用户规模**：生产 80＝清掉 117 个零数据空壳后 79 匿名 + 1 正式；`findOrCreateByDeviceId()` 对每个新 `X-Device-Id` 自动建匿名号（TTL 30 天）；**528 道题挂在 29 个匿名号上是联调数据、不能删**。🔴 异步任务提交闸门必须与同步端点同口径（`POST /api/jobs` 曾按 type 一刀切 `requireAiEnabled` ⇒ `mode=kb` 403；按 `params.mode` 分流，M17 回归）。**CDP 噪音**：`remote-debug/appservice` 的 `wx is not defined` 不是崩了，判据＝主逻辑层 `typeof wx === "object"`。


===== r23 完整快照（2026-11-07 12:20，r24 压缩前）=====
# Growing-Kids 长期约定（r23 · 判据索引）

> **全文快照 `MEMORY-full-archive.md`（r17–r22，含原理/踩坑/实测数字/部署过程）**。过程真相源：`docs/reports/`、`docs/design/method/proposals/P-NNN`＋`decision-log.md` D-NNN、`GK-QA-16-*.md`、`GK-OPS-18-*.md`、教训录 L<n>。本文件只留**会出事的红线判据**；展开去归档对应章节，勿凭记忆补细节；新增前先想「能不能只写进 docs」。

## 0 流程
- 家长主用、孩子次要；改「学习行为」先过 20a §5.1 三问＋§6.2 M1–M11，证据查 20b。GK-OPS-22：L0/L1/L2＋提案单 P-NNN＋台账 D 号，**先查台账再评审**；动 `question-match.ts` 前须建档。设计决策逐题确认后再开工。
- 缺口序 C3 错因 > C2 信心 > C1 掌握梯度 > C5 交错。⛔ 励志推送／智能排程／「算出 ZPD」／打卡时长激励。**push 等思傅指示；本地 commit 照常。**

## 1 环境（两套库）
- 🔴 **生产＝L3 `42.192.36.120`**：`SUPABASE_URL=http://127.0.0.1:8080`（PostgREST→同机 PG `gk`）＋`STORAGE_DRIVER=local`，密钥 `/etc/gk/secrets.env`；**本地 `server/.env`／`.env.migrate` 指 Supabase 云 `yjsuzunoxvyrblhuigpv`，是迁库遗留开发库、非现网**。L3 PG 只听 127.0.0.1:5432、外网仅 22/80 ⇒ 现网数据查询/删除**必须 ssh 上 L3**（QA-16 §3.1），删前 `db-backup.mjs --no-upload`。查库：`ssh -T ubuntu@… "sudo -n -u postgres psql -d gk"`＋stdin SQL。
- 🔴 **commit≠发货**：前端 `build:weapp`→开发者工具重编译→真机重扫码；后端换 `server/dist` 到 L3 **并重启 `gk-api`**（QA-16 §6.1.1：先迁移、再换 dist 并重启，旧 dist `mv` 成 `.bak-<时间戳>`，grep 特征串验包）；只改后端时小程序包不重传。本地 `npx nest build`→杀 3001→`POST :3002/wake`（`/wait-ready` 只等不拉）。
- 🔴 **L3 长任务铁律**：① `ssh host 'node x.mjs'` 断连即 SIGHUP ⇒ 远端 `nohup`＋远端日志＋另开 ssh 轮询；② `.env.migrate` 是 `600 gk:gk`，`ubuntu` 直跑必 EACCES ⇒ 写库脚本 `sudo -u gk -H bash -c '…'`。OCR venv 在仓库外 `D:/AI/gk-ocr-env`；spawn OCR python 必走 `pythonEnv()`、stdout 走 `decodeEngineChunk()`（判据：中文无 U+FFFD）。

## 2 数据红线
- 无 RLS ⇒ 查询必须 `.eq('user_id', userId)`（`check:isolation` 门禁，源码豁免 `// check-isolation-ignore: 理由`）；删除加 `.select('id')` 校行数。新表外键 `user_id` 必须 varchar(36)；真相源**只有 `migrations/`**（`shared/schema.ts` 是死代码）；空串≠NULL，回写前 `trim()`；迁移用低权 migrator，建表后 `--force --only` 重跑。
- 管理员 `users.role`＋`requireAdmin()` fail-closed，提权唯一入口 `promote-admin.mjs`；role 单独 `select("role")`。去重：`blob_objects` 内容寻址＋ref_count，`(user_id,file_hash)` 查重**在 ingest 前**；改引擎/切分必 bump `OCR_ENGINE_VERSION`／`OBJECT_ENGINE_VERSION`；存储 key 只 ASCII；含 `*_images` 的读端点过 `withUrls`。
- 🔴 PG `text` 不接受 U+0000：夹 NUL 整条 update 抛 `0x00` ⇒ 永远 `pending`、伪装环境失败。落库前 `stripNul()`。
- 🔴 **媒体读端点必须 `res.sendFile`**（禁 `createReadStream().pipe()`：无 Content-Length / 不处理 Range ⇒ 微信音频播不动）；判据 `curl -H 'Range: bytes=0-1023'` 回 206；前端 `obeyMuteSwitch=false`、`onError` 打 `errCode`（QA-16 §6.4）。
- 生产备份：`gk_backup` 必须 `bypassrls`；口令丢了＝备份永久作废；DB 每日 03:17(keep 14)、文件周日 03:47(keep 6)；分片 4/16/**32MB**、≤1024 片。🔴 **`question_objects` 是派生表不进备份**（整表 `lines[]` 曾 heap OOM），恢复后 `question-objects-build.mjs --apply` 重建（QA-16 §6.1.2）。

## 3 资料库检索正确性主线
> 真相源 `docs/reports/资料库正文召回-检索侧四步方案评审.md` §0–§9 / **§10**、`资料库正文索引-B方案可行性与成本测算.md`、P-006/008/009/010/**011**、D-009/011/012/013/**014**、QA-16 §6.1.1–§6.1.5。
- **P-006 硬闸**：真相源 `server/src/shared/question-match.ts`（**零依赖单文件**，M27/M31 tsc 单编后 require ⇒ 不能加 import）；keys 只收 ≥4 字长锚点，`MATCH_MIN_LONG_ANCHORS=3`／`RATIO=0.4`。`match_level=exact|topic|none`；🔴 **硬闸无数据源豁免**（网盘／`library_docs.text_content`／自有题库／ima 都要过）、`topic` 必须 `answer:''`＋`verified:false`；`kb` 顺序＝自有题库→library_docs→网盘 exact→ima→兜底。🔴 前后端**必须同步发货**。🔴 **双减合规**：禁「拍照搜题」形态，`exact` 才放解析；定位＝家长整理资料、查原题解析（报告 §7.6），改面客文案前先复核。
- **P-008 正文索引（已完成）**：实绩 `ok` 10,454（93.5%）／正文 9,450 万字；`AB=6` 文件名 0 / 正文 196。🔴 真天花板＝`searchLocal()` 只 `name/path ilike`＋`MAX_DEEP_FILES=3`；正文 `ilike` 无索引 2.8s/词、keys 去标点而正文含标点 ⇒ 0 命中，须预计算 `text_flat`。`.doc` 10,503 份无解。脚本默认 dry-run、只写三列、环境失败绝不写 `none`、M30 14 条钉死；⚠️ `--full-clean` 会 delete ⇒ 抽取前后禁跑。
- **P-009 判定层（P0）**：全文级 `judge()` 对 1 道真题判出 3 个 exact 全是别的题解析（0/3）；⛔ 别搬向量库/Reranker/LLM 兜底。🔴 **六条准入硬闸（串联否决，禁改加权求和）**：≥3 长锚点／对象题干 ≤6000 字／设问一致（冲突硬否决，`unknown` 锚点率 0.55）／锚点共现**限对象内**／相邻解析段 ≥8 字且不串题号／来源唯一（并列⇒降级）。🔴 **「未达标不放行」＝举证责任倒置**（不是 Top-1 / 调阈值）＋成本不对称＋准入非排序；上线准入**误判归零＋召回 ≥90%＋定位 100%＋P95<3s**；实测负例 0/4、正例 28/28。🔴 残余风险：合成「题干 A＋别人解析」仍放行；40/40 ROC 证明纯文本无版面坐标时无法证明解析归属。
- **P-010 结构化入库（P1）**：`0026` 一题一行（指纹/正文版本/`link_status`/规则版本/字符区间，唯一键含 `user_id`）；构建脚本默认 dry-run、复用 `dist` 作唯一切分真相源、幂等 upsert、三条防误删护栏；`question-object-store.ts` 唯一取数口必带 `user_id`；`QUESTION_OBJECTS_STRICT` 默认 0 回退 P0；`CACHE_VERSION` **v7**；M32 19/19。🔴 `library_docs` 判定层与构建脚本都按 `.slice(0,60_000)` 算 `source_revision`。
- ✅ **L3 全量铺量＋部署（11-07）**：326,680 行 / 10,460 来源，幂等重跑 `written 0`。🔴 部署前抓到 `source_id` 口径错配（入库 `netdisk_files.id` vs 运行时 `cand.fsId`）⇒ 对象恒空、静默回退 P0；修 `ensureText()` 返 `{text,sourceId}`，M32 加 7 条断言（教训 L30：凡「查不到就回退」必须验 key 同源）。🔴 **精准换 dist**：8 个 JS 差异里 4 个是未批准的身份治理改动 ⇒ 只换判定链路 12 文件，回滚点 `dist.bak-20261107-0920`。🔴 **新表部署前必检**：`NOTIFY pgrst,'reload schema'`＋`curl 8080/rest/v1/question_objects` 回 **200 真实行**（直打 `/question_objects` 回空 200 是假通过）；`service_role` 需 SELECT＋bypassrls。详见报告 §9.7 / QA-16 v1.44。
- 🔴 **11-07 体检结论 → P-011 定稿**：326,680 行全挂 2 个账号（admin `cc6d7b10…` 326,087＋探测号 `f158a819…` 593）；`netdisk_files` 同（78,400/30）。80 用户里 79 匿名、仅 1 个有 open_id ⇒ 新账号 `searchLocal()`／`ensureText()`／`loadQuestionObjects()` 全 `.eq('user_id',userId)` ⇒ **公共题库零命中**。思傅定稿＝「**公共题库无条件开放 + 私有绝对私有 + 先接通 P2 + 用户贡献本期不做**」；须连 `netdisk_files` 一起公共化；`R-合规-08` 路径③改文案。详见报告 §10。
- **P-011 本地落地（11-07，生产未动）**：`shared/public-library.ts` 固定 `publicLibraryOwner()`（**零参常量**，env 仅本地/灾备覆盖）＋`flatText()`（先剥 NUL 再 `normalizeForMatch`，唯一归一化真相源）＋`textRecallEnabled()`（`NETDISK_TEXT_RECALL=0` 一键回退）。`netdisk-search.service.ts` 六处公共读写改公共 owner、签名去掉 userId、`searchLocal()` **双通道**（name/path + `text_flat`，只用 ≥4 字长锚点、独立查询、合并去重、正文共现数前置排序）、删 `coverage<0.2` 闸门、`saveCache()` 同步写 `text_flat`。`0027` 加 `text_flat` 列 + partial GIN trgm（**只改结构不写数据**）＋`netdisk-text-flat-build.mjs`（默认 dry-run、只写一列、幂等、`--all` 重算、查编译产物陈旧）。`CACHE_VERSION v6→v7`、隐私政策 **r7→r8**、面客 3 处文案、`guardPolicy('检索公共资料库')`。新增 **M33** 12/12；M27/M28/M31/M32 断言同步。🔴 `check-isolation` **无需豁免**（仍 `.eq('user_id', ownerId)`，只是 owner 换常量）。🔴 **改判是追加式**：D-012 §8.5「P1/P2/P3 一律不启动」历史文本原样保留（M31/M32 钉住）；三条前提＝判定层已换代（召回变宽≠放行变宽）／举证责任不变／补偿闸门（source_location + 请核对 + strict/P3 仍锁 + 回退开关）。**第二层上线准入仍未全绿**。
- 🔴 **边界**：① P1 未消除「题干 A + 别人解析」张冠李戴；② `strict=1`、P3（放宽 `MAX_DEEP_FILES`/呈现层前置）、补抽 `.doc`/大 PDF 仍锁；③ 4 个身份治理改动未部署；④ 未做真实登录双账号 E2E（A9）；⑤ 用户贡献通道**本期不做**（PIPL §16／个人主体 UGC 红线，见 §6）；⑥ ⏸ **生产数据归户（593 行对象 + 30 行索引）、0027 迁移、`text_flat` 全量回填、精准换 dist 与重启全部未执行**，须思傅单独拍板（QA-16 §6.1.5 有 8 步清单）；⑦ 前端文案改了 ⇒ 小程序包要重编译，不能只换后端 dist。

## 4 接口与前端
> 光标补丁 / Taro / 隐私组件完整原理见归档（勿删，踩过三轮）。
- 前缀 `/api/`；禁 undefined 进 query；中文名 `encodeURIComponent`。`/api/upload`：`save`=建条目、`attach`=只持久化。
- 🔴 **输入框光标**：两个 pnpm 补丁缺一不可 —— `@tarojs__react@4.1.9.patch`（同值 value 摘掉、**返回 `[]` 不能为 null**）＋`@tarojs__runtime@4.1.9.patch`（INPUT 只同步 `props.value`）；组件 `flushSync()`＋丢弃非字符串 `detail.value`。⛔ 延迟上抛／不传 value／`defaultValue`／改 `Symbol.hasInstance`（白屏）。`focus={false}`=失焦、`cursor={-1}`=末尾 ⇒ 条件展开。✅ 全仓统一 `ui/Textarea`（maxlength -1、`style` 只落外壳、`autoHeight` 只能 `minHeight`）。
- 🔴 `downloadFile`/`uploadFile` 只补域名不注入令牌 ⇒ 打自家 `/api` 的下载必须 `header: buildHeaders()`；公网签名直链**不要**带头。service 层自己 `unwrap`（出现 `(res as any).data?.data` 即契约断）；驼峰/snake 在 service 转完。**M18 红线**：Text onClick（用 View）／下载 header／禁双重解包／guardPrivacy／maxlength=-1／禁 process.env／禁空 catch／列表 finally 解 loading／guardPolicy／同意键禁硬编码。
- 令牌 **X-Auth-Token 唯一被采信**（裸 X-User-Id 401），CORS 必暴露；免登录端点同步 `PUBLIC_ROUTES`；必须关 HTTP 协商缓存（ETag⇒304 空 body⇒列表静默不刷新）；`silent` 只约束「开始」。🔴 `navigateBack` 不重新 mount ⇒ 编辑/新增页返回要 `useDidShow`＋`firstShowRef`＋`silent:true`。
- ⚠️ 音视频禁原生小写标签：音频 `createInnerAudioContext()`（`useDidHide` stop+destroy）、视频 `<Video>` 必须给确定高度；`<Image>`/`<Video poster>` 不发请求头 ⇒ 服务端直给 `*_url`。🚨 微信 request/uploadFile **超时上限 60s** ⇒ >60s 走 `POST /api/jobs` 202+轮询（新增类型同步 5 处、闸门在提交阶段、任务只在内存、重启即 failed）。
- 🔴 隐私同意要真拦写：`guardPolicy(action)` 与 `guardPrivacy` 串行两道；「去同意」跳 `pages/privacy/index?from=guard`。🚨 App 根渲染兄弟节点不挂页面 ⇒ `<PolicyConsent/>` 挂首页＋`useState(() => !hasAgreedPolicy())` 首帧画；`privacy-gate`/`Toaster` 同理。隐私接口失败禁 `catch {}`（errno 112）；Taro 4.1.9 走 `globalThis.wx`；头像昵称用原生 `chooseAvatar`＋`type=nickname`。
- 🔴 改 `note`/result 结构 ⇒ 必 bump `CACHE_VERSION`（参与 `qHash`，`answer_cache` 按 `(user_id,q_hash,mode)` 存整个 result 原样返回）；判据＝拿**没问过的新题**测；当前 **v7**（v6→v7 因 P-011 双通道改了 note 与候选池）。
- 🔴 `gk-netdisk-index.timer`（周日 04:23，gk）：`--budget-ms 5400000`＋`--full-clean`＋`library-index-text.mjs`；停 timer＝隐私「每周同步」承诺不兑现。🔴 **防误删三护栏**：`--root` 不以 `/` 开头或含 `:`/`\` 直接退出／零文件不清库／待删超半数要 `--force-clean`。
- ⚠️ 面客统一「资料库」不出现「百度网盘」，**但隐私政策第四节第三方清单必须保留**（法定披露、两处副本逐字一致有校验）；`library_docs` 0023 起有 `text_content`/`text_status`；抽正文环境类失败保持 `pending`。🔴 **网盘凭证是运营者单账号** ⇒ `R-合规-08` 硬前置三选一，**11-07 已选路径③**（文案改「运营者提供的公共资料库」），隐私政策 **r8**（`M28` 断言钉版本，升版会让已同意用户重新确认）。改面客文案＝小程序包要重编译。
- 🔴 导航 tab＝首页／复习本／**资料**(`pages/library`)／记忆，tab 页只能 `switchTab`；汇总在 `pages/summary`；面客说「资料」不说「文档」。原生 button 三种例外：头像 `chooseAvatar`／反馈 `contact`（仅真机）／同意键 `agreePrivacyAuthorization`。`/auth/me` 带 `role`（单独查）；答案+解题合并一框；`/api/memories` 支持 `subject_id`/`since`/`tag`（**无 `until`**）。

## 5 AI / 品牌 / L3 托管
- `users.ai_enabled`(0018) **默认 false**；`requireAiEnabled()` 拦 chat/message/answer-search/search/solve；改开关必须 `invalidateUserFlags()`。个人主体 ⇒ AI 入口整体收起（`AI_PUBLIC_ENTRY=false`）。名统一**成长学童**，`陕ICP备2026030931号-1X`；`--brand` #0B3D2E / `--brand-text` #0B7A55；`LIBRARY_NETDISK_SYNC=true` 只写不读。
- L3＝Ubuntu 24.04.4 / 4核4G60G；栈 PG17.11→PostgREST12.2.3→Caddy→Node 3000→OCR venv；代码根 `/opt/gk/server`（布局 `/opt/gk/{server,migrations,ocr-engine}`）；用户 `ubuntu`（非 root），`/opt/gk` 要 `sudo -n`。
- 🔴 `STORAGE_DRIVER=local` 同步两处：`PUBLIC_ROUTES` 加 `/^\/api\/storage\/files\//` ＋ `STORAGE_PUBLIC_BASE_URL`；Caddy 站点块**必须用 `handle` 包住** `file_server`；`PROJECT_DOMAIN` 是编译期常量，改 `.env.local` 必须重建。Linux 下 `OCR_VENV_DIR` 不生效 ⇒ 必设 `OCR_PYTHON`+`PPSV3_PYTHON`+`PADDLE_PDX_CACHE_HOME`/`XDG_CACHE_HOME`。
- 🔴 **手工部署只换 `dist` 会漏文件**：改 `ocr-engine/*.py` 必须单独 scp；漏传**接口不报错、静默降级**（判据 `hits[].hit` 有没有 `content`）。提速开关 `PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT`（须在 import 前设）；快速=rapid→`main.py`、精准→`main3.py`，**补丁两处都改**；生产 `OCR_ENGINE_MODE=rapid`。
- 搬数据在云主机做（`PGTZ=UTC`＋两侧 pg_dump 排序比字节）；`--disable-triggers` dump 只能 `postgres` 导入＋`--single-transaction`。🔴 `SUPABASE_URL` 必须 `http://127.0.0.1:8080`；`service_role` 必须 BYPASSRLS；自签两枚 HS256 JWT。
- **结果指标**：唯一够格＝到期首次作答正确率（按档位）⇒ `0021 review_events`＋`review()` 埋点；按 `(item_id,due_on)` 取最早一条、只算 `due_on <= 作答本地日`；埋点失败不得阻断作答；每档 ≥30 样本才出数；**当前 0 行**。

## 6 发布与测试
- 发版前轮换 WX_SECRET（`rotate-wx-secret.mjs`）**后必跑 encrypt-env.mjs**；`pnpm release:check` 上传后记得 revert；生产 `WAKE_ENABLED=0`。🚨 开发管理已托管第三方 ⇒ **发正式版必须先解除托管**。服务类目现「教育服务 > 教育信息展示」，**保留 + 追加工具类目**，⛔ 别删。
- 🔴 **个人主体小程序不得做「用户共享题库 / UGC 发布分享」**：微信【社交-笔记】类目仅非个人主体可用（2026-11-01「床虱地图」一周两次被暂停）；须内容安全 API + 属地网信报备 7 日 + 人工审核 + 申诉渠道。叠加 **PIPL §16「不得以不同意/撤回同意为由拒绝提供服务」** ⇒ ⛔「共享自己的题才能用公共题库」的对价开关；§23/25 单独同意、§15 撤回须删除、§28/29 不满 14 岁属敏感信息需监护人同意。教辅 PDF/Word 共享涉信息网络传播权（判例：「非商业/侵权即删/注明出处」均不免责，平台知晓并欢迎上传不适用避风港）。**行业做法**：作业帮靠签约老师众包＋最多 12 轮审核扩 3 亿题，夸克/猿辅导靠自建＋专业讲题，均无条件开放搜题、不设共享门槛。
- 🔴 备案：轻量须包月≥3月、**L3 到期⇒备案失效**；个人主体文案禁教育/培训/课程/辅导；**小程序备案 ≠ 域名备案**；首页 footer 挂真实号＋`beian.miit.gov.cn`；**公安联网备案待办**（判据＝拿到 `陕公网安备…号`）；首页 `<title>`/`<h1>` 必须与备案站名逐字一致。
- `server/scripts/verify/`：新模块丢 `modules/NN-x.mjs` 自动发现；`pnpm verify:ci`（M12 M13 M16）、前端 `pnpm verify:gate`（+M18）；`harness.api()` 对幂等方法重试一次，POST/超时不重试；纯函数模块 tsc 单编后 require。M16 三条硬门：六栏+引用可解析／禁用宣称词／镜像参数逐字一致。**造数据铁律**：同内容文件命中去重 ⇒ 每次内容必须不同。
- UI 通道 `ide-cdp.mjs`+`ide-*.mjs`，进程须在**同一个 `run_in_background` 任务**启动+保活；输入一律 `Input.insertText`；🔴 测试期禁用真登录（`/auth/login` 会整体迁移匿名号数据），切身份只换令牌 `ide-account.mjs use real|anon`。判图必须真载（`document.images` 恒 0）；IDE 四坑：鼠标事件带 `buttons:1`／先查 `gk_policy_agreed_v1`／`chooseMedia` 走 Promise／选图必经裁剪编辑器。⚠️ 根 `tsc --noEmit` 的 node_modules 报错是既有噪音；正确门禁 `pnpm verify:gate` + `pnpm lint:build`，后端用 `server/` 下 `tsc --noEmit` + `npx nest build`。

## 7 其它
- **复习排程 C4**：真相源 `timeline/review.ts`；五档 1→3→7→14→28 天，做对推进、做错归零；前端不自算 plan；改间隔表触发 M15（三处同步）。
- **CI**：`gate`=build:server→build:weapp→M12 M13 M16；`api-core` 需 5 secret 才跑 M01–M08/M15；OCR GT 退出码 2＝环境跑不起来；`R-算法-07` 竖式符号行丢失（未修）；导出口径 `include_answers` 不传=不含答案；🔴 PDF 只有 paddle（有效 8 页）。
- **方法论**：M11 连续天数/停留时长只作引导展示、不得作判定标准；🚨 **20b 第 7 章标题不可动**（`method-gates.mjs` 正则算文献号上界，重排⇒H1 静默跳过）；批量改文档用脚本+「命中 1 次」断言；教训 L27 同一 bug 改到第三版停下建复现模型、L28 平台规则从源码/文档抠、L30 测试通道决定结论上限。
- **年级属性 P-005/D-008/0025**：12 档，真相源 `shared/grade.ts`＋前端镜像 `constants/grades.ts`（不跨端 import），M26 守；`users.grade`=当前／`grade_confirmed_year`=学年起始年／`timeline_items.grade`·`library_docs.grade`=创建时快照。🔴 `grade is null` 始终可见／`normalizeGrade` 先挡空串／筛掉用户内容必须自带回退开关。
- 🔴 **本地 commit ≠ 生产有代码**：曾因「生产库没 0025 **且** dist 没 `setGrade`」⇒ 404；排查先 grep 生产 dist 特征串；`sudo -n -u gk node /opt/gk/server/scripts/migrate.mjs --only <file>`（`--ping`/`--dry` 先验）。🔴 **`users` 行数 ≠ 真实用户规模**：生产 80＝79 匿名 + 1 正式；`findOrCreateByDeviceId()` 对每个新 `X-Device-Id` 自动建匿名号；**528 道题挂在 29 个匿名号上是联调数据、不能删**。🔴 异步任务提交闸门必须与同步端点同口径（`POST /api/jobs` 曾按 type 一刀切 `requireAiEnabled` ⇒ `mode=kb` 403；按 `params.mode` 分流，M17 回归）。**CDP 噪音**：`remote-debug/appservice` 的 `wx is not defined` 不是崩了，判据＝主逻辑层 `typeof wx === "object"`。


===== r24 完整快照（2026-11-07 14:10，r25 压缩前）=====
# Growing-Kids 长期约定（r24 · 红线判据索引）

> **展开全文 `MEMORY-full-archive.md`（r17–r23 快照）**。过程真相源 `docs/reports/`、`docs/design/method/proposals/P-NNN`＋`decision-log.md` D-NNN、`GK-QA-16-*.md`、`GK-OPS-18-*.md`、教训录 L<n>。本文件只留**会出事的红线＋判据关键词**；细节查归档/docs，勿凭记忆补。新增前先想「能不能只写进 docs」。

## 0 流程
- 家长主用、孩子次要；改「学习行为」先过 20a §5.1 三问＋§6.2 M1–M11，证据查 20b。GK-OPS-22：L0/L1/L2＋提案单 P-NNN＋台账 D 号，**先查台账再评审**；动 `question-match.ts` 前须建档。设计决策逐题确认后再开工。
- 缺口序 C3 错因 > C2 信心 > C1 掌握梯度 > C5 交错。⛔ 励志推送／智能排程／「算出 ZPD」／打卡时长激励。**push 等思傅指示；本地 commit 照常。**

## 1 环境
- 🔴 **生产＝L3 `42.192.36.120`**：`SUPABASE_URL=http://127.0.0.1:8080`＋`STORAGE_DRIVER=local`，密钥 `/etc/gk/secrets.env`；**本地 `server/.env`／`.env.migrate` 指 Supabase 云开发库、非现网**。现网查询/删除**必须 ssh 上 L3**，删前 `db-backup.mjs --no-upload`；`ssh -T ubuntu@… "sudo -n -u postgres psql -d gk"`＋stdin SQL。
- 🔴 **commit≠发货**：前端 `build:weapp`→开发者工具重编译→真机重扫码；后端换 `server/dist` 到 L3 **并重启 `gk-api`**（QA-16 §6.1.1：先迁移、再换 dist 并重启，旧 dist `mv` 成 `.bak-<时间戳>`，grep 特征串验包）。本地 `npx nest build`→杀 3001→`POST :3002/wake`。
- 🔴 **L3 长任务**：① `ssh host 'node x.mjs'` 断连即 SIGHUP ⇒ 远端 `nohup`＋远端日志＋另开 ssh 轮询；② `.env.migrate` 是 `600 gk:gk` ⇒ 写库脚本 `sudo -u gk -H bash -c '…'`。OCR venv 在 `D:/AI/gk-ocr-env`；spawn OCR python 必走 `pythonEnv()`、stdout 走 `decodeEngineChunk()`（判据：中文无 U+FFFD）。

## 2 数据红线
- 无 RLS ⇒ 查询必须 `.eq('user_id', …)`（`check:isolation` 门禁，源码豁免 `// check-isolation-ignore: 理由`）；删除加 `.select('id')` 校行数。新表外键 `user_id` 必须 varchar(36)；真相源**只有 `migrations/`**（`shared/schema.ts` 是死代码）；空串≠NULL，回写前 `trim()`；迁移用低权 migrator，建表后 `--force --only` 重跑。
- 管理员 `users.role`＋`requireAdmin()` fail-closed，提权唯一入口 `promote-admin.mjs`；role 单独 `select("role")`。去重：`blob_objects` 内容寻址＋ref_count，`(user_id,file_hash)` 查重**在 ingest 前**；改引擎/切分必 bump `OCR_ENGINE_VERSION`／`OBJECT_ENGINE_VERSION`；存储 key 只 ASCII；含 `*_images` 的读端点过 `withUrls`。
- 🔴 PG `text` 不接受 U+0000：夹 NUL 整条 update 抛 `0x00` ⇒ 永远 `pending`。落库前 `stripNul()`。🔴 **媒体读端点必须 `res.sendFile`**（禁 `createReadStream().pipe()`：无 Content-Length / 不处理 Range ⇒ 微信音频播不动）；判据 `curl -H 'Range: bytes=0-1023'` 回 206。
- 生产备份：`gk_backup` 必须 `bypassrls`；口令丢了＝备份永久作废；DB 每日 03:17(keep 14)、文件周日 03:47(keep 6)；分片 4/16/**32MB**、≤1024 片。🔴 **`question_objects` 是派生表不进备份**（整表 `lines[]` 曾 heap OOM），恢复后 `question-objects-build.mjs --apply` 重建（QA-16 §6.1.2）。

## 3 资料库检索主线（P-006 → P-011）
> 真相源 `docs/reports/资料库正文召回-检索侧四步方案评审.md` §0–§10、`资料库正文索引-B方案可行性与成本测算.md`、P-006/008/009/010/011、D-009/011/012/013/014、QA-16 §6.1.1–§6.1.5。
- **P-006 硬闸**：真相源 `server/src/shared/question-match.ts`（**零依赖单文件**，M27/M31 tsc 单编后 require ⇒ 不能加 import）；keys 只收 ≥4 字长锚点，`MATCH_MIN_LONG_ANCHORS=3`／`RATIO=0.4`。🔴 **硬闸无数据源豁免**、`topic` 必须 `answer:''`＋`verified:false`；`kb` 顺序＝自有题库→library_docs→网盘 exact→ima→兜底。🔴 前后端**必须同步发货**。🔴 **双减合规**：禁拍照搜题形态，`exact` 才放解析；定位＝家长整理资料、查原题解析（§7.6）。
- **P-008 正文索引（已完成）**：`ok` 10,454（93.5%）／9,450 万字；`AB=6` 文件名 0 / 正文 196。🔴 旧 `searchLocal()` 只 `name/path ilike`＋`MAX_DEEP_FILES=3`；正文 `ilike` 无索引 2.8s/词、keys 去标点而正文含标点 ⇒ 0 命中，须预计算 `text_flat`。`.doc` 10,503 份无解。脚本默认 dry-run、只写三列、环境失败绝不写 `none`、M30 钉死；⚠️ `--full-clean` 会 delete ⇒ 抽取前后禁跑。
- **P-009 判定层（P0）**：全文级 `judge()` 对 1 道真题判出 3 个 exact 全是别的题解析（0/3）；⛔ 别搬向量库/Reranker/LLM 兜底。🔴 **六条准入硬闸（串联否决，禁改加权求和）**：≥3 长锚点／对象题干 ≤6000 字／设问一致（冲突硬否决，`unknown` 锚点率 0.55）／锚点共现**限对象内**／相邻解析段 ≥8 字且不串题号／来源唯一（并列⇒降级）。🔴 **「未达标不放行」＝举证责任倒置**（不是 Top-1 / 调阈值）；上线准入**误判归零＋召回 ≥90%＋定位 100%＋P95<3s**。🔴 残余风险：合成「题干 A＋别人解析」仍放行；40/40 ROC 证明纯文本无版面坐标时无法证明解析归属。
- **P-010 结构化入库（P1）**：`0026` 一题一行（指纹/正文版本/`link_status`/规则版本/字符区间，唯一键含 `user_id`）；构建脚本默认 dry-run、复用 `dist` 作唯一切分真相源、幂等 upsert、三条防误删护栏；`question-object-store.ts` 唯一取数口必带 `user_id`；`QUESTION_OBJECTS_STRICT` 默认 0 回退 P0；M32 19/19。🔴 `library_docs` 判定层与构建脚本都按 `.slice(0,60_000)` 算 `source_revision`。
- ✅ **L3 铺量＋部署（11-07）**：326,680 行 / 10,460 来源，幂等重跑 `written 0`。🔴 部署前抓到 `source_id` 口径错配（入库 `netdisk_files.id` vs 运行时 `cand.fsId`）⇒ 对象恒空、静默回退 P0；修 `ensureText()` 返 `{text,sourceId}`，M32 加 7 条断言（教训 L30：凡「查不到就回退」必须验 key 同源）。🔴 **精准换 dist**：8 个 JS 差异里 4 个是未批准的身份治理改动 ⇒ 只换判定链路 12 文件，回滚点 `dist.bak-20261107-0920`。🔴 **新表部署前必检**：`NOTIFY pgrst,'reload schema'`＋`curl 8080/rest/v1/question_objects` 回 **200 真实行**（空 200 是假通过）；`service_role` 需 SELECT＋bypassrls。
- 🔴 **11-07 体检 → P-011 定稿**：326,680 行全挂 2 个账号（admin `cc6d7b10…` 326,087＋探测号 `f158a819…` 593）；`netdisk_files` 同（78,400/30）。80 用户里 79 匿名、仅 1 个有 open_id ⇒ 新账号三处查询全 `.eq('user_id',userId)` ⇒ **公共题库零命中**。思傅定稿＝「**公共题库无条件开放 + 私有绝对私有 + 先接通 P2 + 用户贡献本期不做**」；须连 `netdisk_files` 一起公共化；`R-合规-08` 路径③改文案。报告 §10。
- **P-011 本地落地（11-07，生产未动）**：`shared/public-library.ts` 固定 `publicLibraryOwner()`（**零参常量**）＋`flatText()`（先剥 NUL 再 `normalizeForMatch`，唯一归一化真相源）＋`textRecallEnabled()`（`NETDISK_TEXT_RECALL=0` 回退）。`netdisk-search.service.ts` 六处公共读写改公共 owner、签名去掉 userId、`searchLocal()` **双通道**（name/path + `text_flat`，只用 ≥4 字长锚点、独立查询、合并去重、正文共现数前置排序）、删 `coverage<0.2` 闸门、`saveCache()` 同步写 `text_flat`。`0027` 加 `text_flat` 列 + partial GIN trgm（**只改结构不写数据**）＋`netdisk-text-flat-build.mjs`（默认 dry-run、只写一列、幂等、`--all` 重算、查编译产物陈旧）。`CACHE_VERSION v6→v7`、隐私政策 **r7→r8**、面客文案、M33 12/12。🔴 `check-isolation` **无需豁免**（仍 `.eq('user_id', ownerId)`，owner 换常量）。🔴 **改判是追加式**：D-012 §8.5「P1/P2/P3 一律不启动」历史文本原样保留（M31/M32 钉住）；前提＝判定层已换代（**召回变宽≠放行变宽**）／举证责任不变／补偿闸门（source_location + 请核对 + strict/P3 仍锁 + 回退开关）。**第二层上线准入仍未全绿**。
- 🔴 **边界**：① P1 未消除「题干 A + 别人解析」张冠李戴；② `strict=1`、P3、补抽 `.doc`/大 PDF 仍锁；③ 4 个身份治理改动未部署；④ 未做真实登录双账号 E2E（A9）；⑤ 用户贡献通道**本期不做**；⑥ ⏸ **生产数据归户（593 行对象 + 30 行索引）、0027 迁移、`text_flat` 全量回填、精准换 dist 与重启全部未执行**，须思傅单独拍板（QA-16 §6.1.5 八步清单）；⑦ 前端文案改了 ⇒ 小程序包要重编译。

## 4 接口与前端
> 光标补丁 / Taro / 隐私组件完整原理见归档（勿删，踩过三轮）。
- 前缀 `/api/`；禁 undefined 进 query；中文名 `encodeURIComponent`。`/api/upload`：`save`=建条目、`attach`=只持久化。
- 🔴 **输入框光标**：两个 pnpm 补丁缺一不可 —— `@tarojs__react@4.1.9.patch`（同值 value 摘掉、**返回 `[]` 不能为 null**）＋`@tarojs__runtime@4.1.9.patch`（INPUT 只同步 `props.value`）；组件 `flushSync()`＋丢弃非字符串 `detail.value`。⛔ 延迟上抛／不传 value／`defaultValue`／改 `Symbol.hasInstance`（白屏）。`focus={false}`=失焦、`cursor={-1}`=末尾 ⇒ 条件展开。✅ 全仓统一 `ui/Textarea`（maxlength -1、`style` 只落外壳）。
- 🔴 `downloadFile`/`uploadFile` 只补域名不注入令牌 ⇒ 打自家 `/api` 的下载必须 `header: buildHeaders()`；公网签名直链**不要**带头。service 层自己 `unwrap`（出现 `(res as any).data?.data` 即契约断）。**M18 红线**：Text onClick（用 View）／下载 header／禁双重解包／guardPrivacy／maxlength=-1／禁 process.env／禁空 catch／列表 finally 解 loading／guardPolicy／同意键禁硬编码。
- 令牌 **X-Auth-Token 唯一被采信**（裸 X-User-Id 401），CORS 必暴露；免登录端点同步 `PUBLIC_ROUTES`；必须关 HTTP 协商缓存（ETag⇒304 空 body⇒列表静默不刷新）；`silent` 只约束「开始」。🔴 `navigateBack` 不重新 mount ⇒ 编辑/新增页返回要 `useDidShow`＋`firstShowRef`＋`silent:true`。
- ⚠️ 音视频禁原生小写标签：音频 `createInnerAudioContext()`、视频 `<Video>` 必须给确定高度；`<Image>`/`<Video poster>` 不发请求头 ⇒ 服务端直给 `*_url`。🚨 微信 request/uploadFile **超时上限 60s** ⇒ >60s 走 `POST /api/jobs` 202+轮询（新增类型同步 5 处、闸门在提交阶段、任务只在内存）。
- 🔴 隐私同意要真拦写：`guardPolicy(action)` 与 `guardPrivacy` 串行两道；「去同意」跳 `pages/privacy/index?from=guard`。🚨 App 根渲染兄弟节点不挂页面 ⇒ `<PolicyConsent/>` 挂首页＋`useState(() => !hasAgreedPolicy())` 首帧画；`privacy-gate`/`Toaster` 同理。隐私接口失败禁 `catch {}`（errno 112）；Taro 4.1.9 走 `globalThis.wx`。
- 🔴 改 `note`/result 结构 ⇒ 必 bump `CACHE_VERSION`（参与 `qHash`，`answer_cache` 按 `(user_id,q_hash,mode)` 存整个 result 原样返回）；判据＝拿**没问过的新题**测；当前 **v7**。
- 🔴 `gk-netdisk-index.timer`（周日 04:23，gk）：`--budget-ms 5400000`＋`--full-clean`＋`library-index-text.mjs`；停 timer＝隐私「每周同步」承诺不兑现。**防误删三护栏**：`--root` 不以 `/` 开头或含 `:`/`\` 退出／零文件不清库／待删超半数要 `--force-clean`。P2 上线后追加 `netdisk-text-flat-build.mjs --apply --all`。
- ⚠️ 面客统一「资料库」不出现「百度网盘」，**但隐私政策第四节第三方清单必须保留**（法定披露、两处副本逐字一致有校验）；抽正文环境类失败保持 `pending`。🔴 **网盘凭证是运营者单账号** ⇒ `R-合规-08` 已选路径③（文案改「运营者提供的公共资料库」），隐私政策 **r8**（M28 钉版本，升版会让已同意用户重新确认）。
- 🔴 导航 tab＝首页／复习本／**资料**(`pages/library`)／记忆，tab 页只能 `switchTab`；面客说「资料」不说「文档」。原生 button 三种例外：头像 `chooseAvatar`／反馈 `contact`／同意键 `agreePrivacyAuthorization`。`/auth/me` 带 `role`（单独查）；`/api/memories` 支持 `subject_id`/`since`/`tag`（**无 `until`**）。

## 5 AI / 品牌 / L3 托管
- `users.ai_enabled`(0018) **默认 false**；`requireAiEnabled()` 拦 chat/message/answer-search/search/solve；改开关必须 `invalidateUserFlags()`。个人主体 ⇒ AI 入口整体收起（`AI_PUBLIC_ENTRY=false`）。名统一**成长学童**，`陕ICP备2026030931号-1X`；`--brand` #0B3D2E / `--brand-text` #0B7A55；`LIBRARY_NETDISK_SYNC=true` 只写不读。
- L3＝Ubuntu 24.04.4 / 4核4G60G；栈 PG17.11→PostgREST12.2.3→Caddy→Node 3000→OCR venv；代码根 `/opt/gk/server`（布局 `/opt/gk/{server,migrations,ocr-engine}`）；用户 `ubuntu`（非 root），`/opt/gk` 要 `sudo -n`。
- 🔴 `STORAGE_DRIVER=local` 同步两处：`PUBLIC_ROUTES` 加 `/^\/api\/storage\/files\//` ＋ `STORAGE_PUBLIC_BASE_URL`；Caddy 站点块**必须用 `handle` 包住** `file_server`；`PROJECT_DOMAIN` 是编译期常量，改 `.env.local` 必须重建。Linux 下 `OCR_VENV_DIR` 不生效 ⇒ 必设 `OCR_PYTHON`+`PPSV3_PYTHON`+`PADDLE_PDX_CACHE_HOME`/`XDG_CACHE_HOME`。
- 🔴 **手工部署只换 `dist` 会漏文件**：改 `ocr-engine/*.py` 必须单独 scp；漏传**接口不报错、静默降级**（判据 `hits[].hit` 有没有 `content`）。提速开关 `PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT`（须在 import 前设）；快速=rapid→`main.py`、精准→`main3.py`，**补丁两处都改**；生产 `OCR_ENGINE_MODE=rapid`。
- 搬数据在云主机做（`PGTZ=UTC`＋两侧 pg_dump 排序比字节）；`--disable-triggers` dump 只能 `postgres` 导入＋`--single-transaction`。🔴 `SUPABASE_URL` 必须 `http://127.0.0.1:8080`；`service_role` 必须 BYPASSRLS。
- **结果指标**：唯一够格＝到期首次作答正确率（按档位）⇒ `0021 review_events`＋`review()` 埋点；按 `(item_id,due_on)` 取最早一条、只算 `due_on <= 作答本地日`；埋点失败不得阻断作答；每档 ≥30 样本才出数；**当前 0 行**。

## 6 发布与测试
- 发版前轮换 WX_SECRET（`rotate-wx-secret.mjs`）**后必跑 encrypt-env.mjs**；`pnpm release:check` 上传后记得 revert；生产 `WAKE_ENABLED=0`。🚨 开发管理已托管第三方 ⇒ **发正式版必须先解除托管**。服务类目现「教育服务 > 教育信息展示」，**保留 + 追加工具类目**，⛔ 别删。
- 🔴 **个人主体小程序不得做「用户共享题库 / UGC 发布分享」**：微信【社交-笔记】类目仅非个人主体可用（2026-11-01「床虱地图」一周两次被暂停）；须内容安全 API + 属地网信报备 7 日 + 人工审核 + 申诉渠道。叠加 **PIPL §16「不得以不同意/撤回同意为由拒绝提供服务」** ⇒ ⛔「共享自己的题才能用公共题库」；§23/25 单独同意、§15 撤回须删除、§28/29 不满 14 岁需监护人同意。教辅 PDF/Word 共享涉信息网络传播权（判例：「非商业/侵权即删/注明出处」均不免责）。**行业做法**：作业帮靠签约老师众包＋最多 12 轮审核扩 3 亿题，夸克/猿辅导靠自建＋专业讲题，均无条件开放搜题、不设共享门槛。
- 🔴 备案：轻量须包月≥3月、**L3 到期⇒备案失效**；个人主体文案禁教育/培训/课程/辅导；**小程序备案 ≠ 域名备案**；首页 footer 挂真实号＋`beian.miit.gov.cn`；**公安联网备案待办**；首页 `<title>`/`<h1>` 必须与备案站名逐字一致。
- `server/scripts/verify/`：新模块丢 `modules/NN-x.mjs` 自动发现；`verify:ci`（M12 M13 M16）、`verify:gate`（+M18）、`method:check`（H1/H2/H3）、`lint:build`；纯函数模块 tsc 单编后 require。**M16 三条硬门**：六栏+引用可解析／禁用宣称词／镜像参数逐字一致。**造数据铁律**：同内容文件命中去重 ⇒ 每次内容必须不同。
- UI 通道 `ide-cdp.mjs`+`ide-*.mjs`，进程须在**同一个 `run_in_background` 任务**启动+保活；🔴 测试期禁用真登录（`/auth/login` 会整体迁移匿名号数据），切身份只换令牌。IDE 四坑：鼠标事件带 `buttons:1`／先查 `gk_policy_agreed_v1`／`chooseMedia` 走 Promise／选图必经裁剪编辑器。⚠️ 根 `tsc --noEmit` 的 node_modules 报错是既有噪音；后端用 `server/` 下 `tsc --noEmit` + `npx nest build`。

## 7 其它
- **复习排程 C4**：真相源 `timeline/review.ts`；五档 1→3→7→14→28 天，做对推进、做错归零；前端不自算 plan；改间隔表触发 M15（三处同步）。
- **CI**：`gate`=build:server→build:weapp→M12 M13 M16；`api-core` 需 5 secret 才跑 M01–M08/M15；OCR GT 退出码 2＝环境跑不起来；`R-算法-07` 竖式符号行丢失（未修）；导出口径 `include_answers` 不传=不含答案。
- **方法论**：M11 连续天数/停留时长只作引导展示、不得作判定标准；🚨 **20b 第 7 章标题不可动**（`method-gates.mjs` 正则算文献号上界，重排⇒H1 静默跳过）；批量改文档用脚本+「命中 1 次」断言；教训 L27 同一 bug 改到第三版停下建复现模型、L28 平台规则从源码/文档抠、L30 测试通道决定结论上限。
- **年级属性 P-005/D-008/0025**：12 档，真相源 `shared/grade.ts`＋前端镜像 `constants/grades.ts`（不跨端 import），M26 守；`grade is null` 始终可见／`normalizeGrade` 先挡空串／筛掉用户内容必须自带回退开关。
- 🔴 **本地 commit ≠ 生产有代码**：曾因「生产库没 0025 **且** dist 没 `setGrade`」⇒ 404；排查先 grep 生产 dist 特征串；`sudo -n -u gk node /opt/gk/server/scripts/migrate.mjs --only <file>`（`--ping`/`--dry` 先验）。🔴 **`users` 行数 ≠ 真实用户规模**：生产 80＝79 匿名 + 1 正式；**528 道题挂在 29 个匿名号上是联调数据、不能删**。🔴 异步任务提交闸门必须与同步端点同口径（`POST /api/jobs` 曾按 type 一刀切 `requireAiEnabled` ⇒ `mode=kb` 403；按 `params.mode` 分流，M17 回归）。**CDP 噪音**：`remote-debug/appservice` 的 `wx is not defined` 不是崩了，判据＝主逻辑层 `typeof wx === "object"`。


===== r26 完整快照（2026-11-07 16:10，r27 压缩前）=====
# Growing-Kids 长期约定（r26 · 红线判据索引）

> 全文快照 `MEMORY-full-archive.md`（r17–r25）；过程/实绩真相源 `docs/reports/`、`docs/design/method/proposals/P-NNN`＋`decision-log.md` D-NNN、`GK-QA-16-*.md`（生产执行 §6.1.6）、`GK-OPS-18-*.md`、`.workbuddy/memory/YYYY-MM-DD.md`、教训录 L<n>。本文件只留**会出事的判据＋一行指针**；新增前先想「能不能只写进 docs」。

## 0 流程
- 家长主用、孩子次要；改「学习行为」先过 20a §5.1 三问＋§6.2 M1–M11，证据查 20b。GK-OPS-22：L0/L1/L2＋提案单 P-NNN＋台账 D 号，**先查台账再评审**；动 `question-match.ts` 前须建档。设计决策逐题确认后再开工。
- 缺口序 C3 错因 > C2 信心 > C1 掌握梯度 > C5 交错。⛔ 励志推送／智能排程／「算出 ZPD」／打卡时长激励。**push 等思傅指示；本地 commit 照常。**

## 1 环境
- 🔴 **生产＝L3 `42.192.36.120`**：`SUPABASE_URL=http://127.0.0.1:8080`＋`STORAGE_DRIVER=local`，密钥 `/etc/gk/secrets.env`；**本地 `server/.env`／`.env.migrate` 指 Supabase 云开发库、非现网**（L3 同名文件指本机 PG `gk`）。现网查删**必须 ssh 上 L3**，删前 `db-backup.mjs --no-upload`；`ssh -T ubuntu@… "sudo -n -u postgres psql -d gk"`＋stdin SQL。
- 🔴 **commit≠发货**：前端 `build:weapp`→开发者工具重编译→真机重扫码；后端换 `server/dist` 到 L3 **并重启 `gk-api`**（QA-16 §6.1.1：先迁移、再换 dist 并重启、旧 dist 留 `.bak-<时间戳>`、grep 特征串验包）。本地 `npx nest build`→杀 3001→`POST :3002/wake`。
- 🔴 **精准换 dist**：整包替换会顺手部署未批准功能。先比两边完整 sha256 清单（Windows 端 `sha256sum` 带 `*`，须先归一化格式）逐个人工确认归属；**4 个身份治理文件永久排除**（`auth/auth.controller.js`、`shared/user-context.js`、`users/users.service.js`、`shared/anon-bootstrap-guard.js`）；部署后复比，剩余差异必须全是明确排除项。
- 🔴 **L3 长任务**：① 远端 `nohup`＋远端日志＋另开 ssh 轮询（`ssh host 'node …'` 断连即 SIGHUP）；② `.env.migrate` 600 gk:gk ⇒ `sudo -u gk -H bash -c '…'`；③ `/tmp` 下脚本 require 不到 node_modules ⇒ `NODE_PATH=/opt/gk/server/node_modules`。OCR venv `D:/AI/gk-ocr-env`；spawn OCR python 走 `pythonEnv()`、stdout 走 `decodeEngineChunk()`（判据：中文无 U+FFFD）。

## 2 数据红线
- 无 RLS ⇒ 查询必须 `.eq('user_id', …)`（`check:isolation` 门禁，豁免 `// check-isolation-ignore: 理由`）；删除加 `.select('id')` 校行数。新表外键 `user_id` varchar(36)；真相源**只有 `migrations/`**（`shared/schema.ts` 死代码）；空串≠NULL，回写前 `trim()`；`--only <file>`／`--force --only` 重跑。
- 管理员 `users.role`＋`requireAdmin()` fail-closed，提权唯一入口 `promote-admin.mjs`，role 单独 `select("role")`。去重 `blob_objects` 内容寻址＋ref_count，`(user_id,file_hash)` 查重在 ingest 前；改引擎/切分必 bump `OCR_ENGINE_VERSION`／`OBJECT_ENGINE_VERSION`；存储 key 只 ASCII；含 `*_images` 的读端点过 `withUrls`。
- 🔴 PG `text` 不接受 U+0000 ⇒ 夹 NUL 整条 update 抛 `0x00`、永远 `pending`；落库前 `stripNul()`。🔴 **媒体读端点必须 `res.sendFile`**（禁 `createReadStream().pipe()`：无 Content-Length / 不处理 Range ⇒ 微信音频播不动）；判据 `curl -H 'Range: bytes=0-1023'` 回 206。
- 备份：`gk_backup` 必须 `bypassrls`；口令丢了＝备份永久作废；DB 每日 03:17(keep 14)、文件周日 03:47(keep 6)、分片 4/16/32MB ≤1024 片。🔴 **`question_objects` 是派生表不进备份**（整表 `lines[]` 曾 heap OOM），恢复后 `question-objects-build.mjs --apply` 重建（§6.1.2）。
- 🔴 **归户/去重前必查唯一键**：`netdisk_files (user_id,fs_id)`、`question_objects (user_id,source_type,source_id,object_index)`。`objectFingerprintInput()` 含 `source_id` ⇒ 同内容不同来源指纹必不同，判等价要用 `stem_text/solution_text/source_revision`，别拿指纹判重。

## 3 资料库检索主线（P-006 → P-011，均已上生产）
> 真相源 `docs/reports/资料库正文召回-检索侧四步方案评审.md` §0–§10.7、P-006/008/009/010/011、D-009/011/012/013/014、QA-16 §6.1.1–§6.1.6。
- **P-006 硬闸**：真相源 `server/src/shared/question-match.ts`（**零依赖单文件**，M27/M31 tsc 单编后 require ⇒ 不能加 import）；keys 只收 ≥4 字长锚点，`MATCH_MIN_LONG_ANCHORS=3`／`RATIO=0.4`。🔴 **硬闸无数据源豁免**、`topic` 必须 `answer:''`＋`verified:false`；`kb` 顺序＝自有题库→library_docs→网盘 exact→ima→兜底；前后端**必须同步发货**。🔴 **双减合规**：禁拍照搜题形态，`exact` 才放解析；定位＝家长整理资料、查原题解析（§7.6）。
- **P-008**：正文抽取已完成（10,454 份 / 9,450 万字）；真天花板是旧 `searchLocal()` 只 `name/path ilike`＋`MAX_DEEP_FILES=3`；keys 去标点而正文含标点 ⇒ 必须预计算 `text_flat`。`.doc` 10,503 份无解。脚本默认 dry-run、只写三列、环境失败绝不写 `none`；⚠️ `--full-clean` 会 delete ⇒ 抽取前后禁跑。
- **P-009 判定层（P0）**：⛔ 别搬向量库/Reranker/LLM 兜底。🔴 **六条准入硬闸（串联否决，禁改加权求和）**：≥3 长锚点／对象题干 ≤6000 字／设问一致（冲突硬否决，`unknown` 锚点率 0.55）／锚点共现**限对象内**／相邻解析段 ≥8 字且不串题号／来源唯一（并列⇒降级）。🔴 **「未达标不放行」＝举证责任倒置**（不是 Top-1 / 调阈值）；上线准入**误判归零＋召回 ≥90%＋定位 100%＋P95<3s**。🔴 残余风险：合成「题干 A＋别人解析」仍放行；纯文本无版面坐标时无法证明解析归属。
- **P-010（P1）**：`0026` 一题一行；构建脚本默认 dry-run、复用 `dist` 作唯一切分真相源、幂等 upsert、三条防误删护栏；`question-object-store.ts` 唯一取数口必带 `user_id`；`QUESTION_OBJECTS_STRICT` 默认 0 回退 P0。🔴 `library_docs` 判定层与构建脚本都按 `.slice(0,60_000)` 算 `source_revision`。🔴 教训 L30：`source_id` 必须是 `netdisk_files.id`（不是 `cand.fsId`），凡「查不到就回退」必须验 key 同源。
- **P-011 定稿与实现**：「**公共题库无条件开放 + 私有绝对私有 + 先接通 P2 + 用户贡献本期不做**」。`shared/public-library.ts`：`publicLibraryOwner()`（**零参常量**，env 仅本地/灾备）、`flatText()`（先剥 NUL 再 `normalizeForMatch`，唯一归一化真相源）、`textRecallEnabled()`（`NETDISK_TEXT_RECALL=0` 回退）。`netdisk-search.service.ts` 六处公共读写改公共 owner、**签名去掉 userId**、`searchLocal()` **双通道**（name/path + `text_flat`，只用 ≥4 字长锚点、独立查询、合并去重、正文共现数前置排序）、删 `coverage<0.2` 闸门、`saveCache()` 同步写 `text_flat`。`0027` 只加结构；`netdisk-text-flat-build.mjs` 默认 dry-run、只写一列、幂等、`--all` 重算、查编译产物陈旧。`CACHE_VERSION v6→v7`、隐私政策 **r7→r8**、M33 12/12。🔴 `check-isolation` **无需豁免**（仍 `.eq('user_id', ownerId)`，owner 换常量）。🔴 **改判是追加式**：D-012 §8.5「P1/P2/P3 一律不启动」历史文本原样保留（M31/M32 钉住）；前提＝判定层已换代（**召回变宽≠放行变宽**）／举证责任不变／补偿闸门（source_location + 请核对 + strict/P3 仍锁 + 回退开关）。**第二层上线准入仍未全绿**。
- ✅ **生产已生效（11-07 14:05，实绩/命令/回滚点见 QA-16 §6.1.6）**：两表 owner=1；`text_flat` 全填充；GIN 318MB / 单查 142–477ms 走 Bitmap Index Scan；精准换 10 文件并重启，health 200 / 0 ERROR / 0 次正文召回回退；PostgREST 新列 200 真实行；A9 自签令牌 admin/匿名/admin **三方逐字一致**且 `exact` 带 `sourceLocation`；timer 追加 `--apply`（**不带 `--all`**，理由见 §6.1.6.1）；`build:weapp` 已构建。🔴 **开发者工具重编译＋真机重扫码＋上传发布仍待人工**（r8 重新征求同意随前端包生效）。
- 🔴 **执行期三偏差（已判据化，详情 §6.1.6.1）**：① 归户 UPDATE→删等价冗余（唯一键冲突）；② 索引实测移到回填**之后**（迁移后索引空是假通过；改 DROP→回填→一次性 CREATE）；③ timer 不跑 `--all`（避免每周抖动 GIN 索引），`--all` 留作归一化口径变更时手动跑。
- 🔴 **仍锁 / 未做**：`strict=1`、P3、补抽 `.doc`/大 PDF、4 个身份治理改动、**真机两个微信账号的登录 E2E**（A9 是服务端 HTTP 层自签令牌）、用户贡献通道本期不做；服务重启后首次请求曾有一次冷态差异，稳定态三方 SAME，留作观察。

## 4 接口与前端
> 光标补丁 / Taro / 隐私组件完整原理见归档（勿删，踩过三轮）。
- 前缀 `/api/`；禁 undefined 进 query；中文名 `encodeURIComponent`。`/api/upload`：`save`=建条目、`attach`=只持久化。
- 🔴 **输入框光标**：两个 pnpm 补丁缺一不可 —— `@tarojs__react@4.1.9.patch`（同值 value 摘掉、**返回 `[]` 不能为 null**）＋`@tarojs__runtime@4.1.9.patch`（INPUT 只同步 `props.value`）；组件 `flushSync()`＋丢弃非字符串 `detail.value`。⛔ 延迟上抛／不传 value／`defaultValue`／改 `Symbol.hasInstance`（白屏）。`focus={false}`=失焦、`cursor={-1}`=末尾 ⇒ 条件展开。✅ 全仓统一 `ui/Textarea`（maxlength -1、`style` 只落外壳）。
- 🔴 `downloadFile`/`uploadFile` 只补域名不注入令牌 ⇒ 打自家 `/api` 的下载必须 `header: buildHeaders()`；公网签名直链**不要**带头。service 层自己 `unwrap`（出现 `(res as any).data?.data` 即契约断）。**M18 红线**：Text onClick（用 View）／下载 header／禁双重解包／guardPrivacy／maxlength=-1／禁 process.env／禁空 catch／列表 finally 解 loading／guardPolicy／同意键禁硬编码。
- 令牌 **X-Auth-Token 唯一被采信**（`v1.<uid>.<exp>.<HMAC-SHA256(payload,AUTH_TOKEN_SECRET).hex 前 40>`，密钥 `.env.secrets`，可服务端自签做 E2E）；裸 X-User-Id 401；CORS 必暴露；免登录端点同步 `PUBLIC_ROUTES`；必须关 HTTP 协商缓存（ETag⇒304 空 body⇒列表静默不刷新）；`silent` 只约束「开始」。🔴 `navigateBack` 不重新 mount ⇒ 编辑/新增页返回要 `useDidShow`＋`firstShowRef`＋`silent:true`。
- ⚠️ 音视频禁原生小写标签：音频 `createInnerAudioContext()`、视频 `<Video>` 必须给确定高度；`<Image>`/`<Video poster>` 不发请求头 ⇒ 服务端直给 `*_url`。🚨 微信 request/uploadFile **超时上限 60s** ⇒ >60s 走 `POST /api/jobs` 202+轮询（新增类型同步 5 处、闸门在提交阶段、任务只在内存）。
- 🔴 隐私同意要真拦写：`guardPolicy(action)` 与 `guardPrivacy` 串行两道；「去同意」跳 `pages/privacy/index?from=guard`。🚨 App 根渲染兄弟节点不挂页面 ⇒ `<PolicyConsent/>` 挂首页＋`useState(() => !hasAgreedPolicy())` 首帧画；`privacy-gate`/`Toaster` 同理。隐私接口失败禁 `catch {}`（errno 112）；Taro 4.1.9 走 `globalThis.wx`。
- 🔴 改 `note`/result 结构 ⇒ 必 bump `CACHE_VERSION`（参与 `qHash`，`answer_cache` 按 `(user_id,q_hash,mode)` 存整个 result 原样返回）；判据＝拿**没问过的新题**测；当前 **v7**。
- 🔴 `gk-netdisk-index.timer`（周日 04:23，gk）：`--budget-ms 5400000`＋`--full-clean`＋`library-index-text.mjs`＋`netdisk-text-flat-build.mjs --apply`；停 timer＝隐私「每周同步」承诺不兑现。**防误删三护栏**：`--root` 不以 `/` 开头或含 `:`/`\` 退出／零文件不清库／待删超半数要 `--force-clean`。
- ⚠️ 面客统一「资料库」不出现「百度网盘」，**但隐私政策第四节第三方清单必须保留**（法定披露、两处副本逐字一致有校验）；抽正文环境类失败保持 `pending`。🔴 **网盘凭证是运营者单账号** ⇒ `R-合规-08` 已选路径③（文案「运营者提供的公共资料库」），隐私政策 **r8**（M28 钉版本，升版会让已同意用户重新确认）。
- 🔴 导航 tab＝首页／复习本／**资料**(`pages/library`)／记忆，tab 页只能 `switchTab`；面客说「资料」不说「文档」。原生 button 三种例外：头像 `chooseAvatar`／反馈 `contact`／同意键 `agreePrivacyAuthorization`。`/auth/me` 带 `role`；`/api/memories` 支持 `subject_id`/`since`/`tag`（**无 `until`**）。

## 5 AI / 品牌 / L3 托管
- `users.ai_enabled`(0018) **默认 false**；`requireAiEnabled()` 拦 chat/message/answer-search/search/solve；`mode=kb` 走 `requireUserId` 不受该开关连坐；改开关必须 `invalidateUserFlags()`。个人主体 ⇒ AI 入口整体收起（`AI_PUBLIC_ENTRY=false`）。名统一**成长学童**，`陕ICP备2026030931号-1X`；`--brand` #0B3D2E / `--brand-text` #0B7A55；`LIBRARY_NETDISK_SYNC=true` 只写不读。
- L3＝Ubuntu 24.04.4 / 4核4G60G；PG17.11→PostgREST12.2.3→Caddy→Node 3000→OCR venv；代码根 `/opt/gk/server`（`/opt/gk/{server,migrations,ocr-engine}`）；用户 `ubuntu`（非 root），`/opt/gk` 要 `sudo -n`；`gk-api` `NODE_OPTIONS=--max-old-space-size=768`。
- 🔴 `STORAGE_DRIVER=local` 同步两处：`PUBLIC_ROUTES` 加 `/^\/api\/storage\/files\//` ＋ `STORAGE_PUBLIC_BASE_URL`；Caddy 站点块**必须用 `handle` 包住** `file_server`；`PROJECT_DOMAIN` 是编译期常量，改 `.env.local` 必须重建。Linux 下 `OCR_VENV_DIR` 不生效 ⇒ 必设 `OCR_PYTHON`+`PPSV3_PYTHON`+`PADDLE_PDX_CACHE_HOME`/`XDG_CACHE_HOME`。
- 🔴 **手工部署只换 `dist` 会漏文件**：改 `ocr-engine/*.py` 必须单独 scp；漏传**接口不报错、静默降级**（判据 `hits[].hit` 有没有 `content`）。提速开关 `PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT`（须在 import 前设）；快速=rapid→`main.py`、精准→`main3.py`，**补丁两处都改**；生产 `OCR_ENGINE_MODE=rapid`。
- 搬数据在云主机做（`PGTZ=UTC`＋两侧 pg_dump 排序比字节）；`--disable-triggers` dump 只能 `postgres` 导入＋`--single-transaction`。🔴 `SUPABASE_URL` 必须 `http://127.0.0.1:8080`；`service_role` 必须 BYPASSRLS。🔴 **8080 是 Caddy 不是 PostgREST 直连**：直打 `/<table>` 回 200 空 body 是假通过，必须 `/rest/v1/<table>?select=...` 回 200 真实行（§6.1.4）。
- **结果指标**：唯一够格＝到期首次作答正确率（按档位）⇒ `0021 review_events`＋`review()` 埋点；按 `(item_id,due_on)` 取最早一条、只算 `due_on <= 作答本地日`；埋点失败不得阻断作答；每档 ≥30 样本才出数；**当前 0 行**。

## 6 发布与测试
- 发版前轮换 WX_SECRET（`rotate-wx-secret.mjs`）**后必跑 encrypt-env.mjs**；`pnpm release:check` 上传后记得 revert；生产 `WAKE_ENABLED=0`。🚨 开发管理已托管第三方 ⇒ **发正式版必须先解除托管**。服务类目现「教育服务 > 教育信息展示」，**保留 + 追加工具类目**，⛔ 别删。
- 🔴 **个人主体小程序不得做「用户共享题库 / UGC 发布分享」**：【社交-笔记】类目仅非个人主体可用（2026-11-01「床虱地图」一周两次被暂停）；须内容安全 API + 属地网信报备 7 日 + 人工审核 + 申诉渠道。叠加 **PIPL §16「不得以不同意/撤回同意为由拒绝提供服务」** ⇒ ⛔「共享自己的题才能用公共题库」；§23/25 单独同意、§15 撤回须删除、§28/29 不满 14 岁需监护人同意。教辅 PDF/Word 共享涉信息网络传播权（「非商业/侵权即删/注明出处」均不免责）。**行业做法**：作业帮靠签约老师众包＋最多 12 轮审核，夸克/猿辅导靠自建＋专业讲题，均无条件开放搜题、不设共享门槛（调研详见报告 §10.5）。
- 🔴 备案：轻量须包月≥3月、**L3 到期⇒备案失效**；个人主体文案禁教育/培训/课程/辅导；**小程序备案 ≠ 域名备案**；首页 footer 挂真实号＋`beian.miit.gov.cn`；**公安联网备案待办**；首页 `<title>`/`<h1>` 必须与备案站名逐字一致。
- `server/scripts/verify/`：新模块丢 `modules/NN-x.mjs` 自动发现；`verify:ci`（M12 M13 M16）、`verify:gate`（+M18）、`method:check`（H1/H2/H3）、`lint:build`；纯函数模块 tsc 单编后 require。**M16 三条硬门**：六栏+引用可解析／禁用宣称词／镜像参数逐字一致。**造数据铁律**：同内容文件命中去重 ⇒ 每次内容必须不同。当前基线：`verify:gate` 37/37、M27+M28+M31+M32+M33 **81/81**。
- UI 通道 `ide-cdp.mjs`+`ide-*.mjs`，进程须在**同一个 `run_in_background` 任务**启动+保活；🔴 测试期禁用真登录（`/auth/login` 会整体迁移匿名号数据），切身份只换令牌。IDE 四坑：鼠标事件带 `buttons:1`／先查 `gk_policy_agreed_v1`／`chooseMedia` 走 Promise／选图必经裁剪编辑器。⚠️ 根 `tsc --noEmit` 的 node_modules 报错是既有噪音；后端用 `server/` 下 `tsc --noEmit` + `npx nest build`。

## 7 其它
- **复习排程 C4**：真相源 `timeline/review.ts`；五档 1→3→7→14→28 天，做对推进、做错归零；前端不自算 plan；改间隔表触发 M15（三处同步）。
- **CI**：`gate`=build:server→build:weapp→M12 M13 M16；`api-core` 需 5 secret 才跑 M01–M08/M15；OCR GT 退出码 2＝环境跑不起来；`R-算法-07` 竖式符号行丢失（未修）；导出口径 `include_answers` 不传=不含答案。
- **方法论**：M11 连续天数/停留时长只作引导展示、不得作判定标准；🚨 **20b 第 7 章标题不可动**（`method-gates.mjs` 正则算文献号上界，重排⇒H1 静默跳过）；批量改文档用脚本+「命中 1 次」断言；教训 L27 同一 bug 改到第三版停下建复现模型、L28 平台规则从源码/文档抠、L30 测试通道决定结论上限。
- **年级属性 P-005/D-008/0025**：12 档，真相源 `shared/grade.ts`＋前端镜像 `constants/grades.ts`（不跨端 import），M26 守；`grade is null` 始终可见／`normalizeGrade` 先挡空串／筛掉用户内容必须自带回退开关。
- 🔴 **本地 commit ≠ 生产有代码**：曾因「生产库没 0025 **且** dist 没 `setGrade`」⇒ 404；排查先 grep 生产 dist 特征串。🔴 **`users` 行数 ≠ 真实用户规模**：生产 80＝79 匿名 + 1 正式；**528 道题挂在 29 个匿名号上是联调数据、不能删**。🔴 异步任务提交闸门必须与同步端点同口径（`POST /api/jobs` 曾按 type 一刀切 ⇒ `mode=kb` 403；按 `params.mode` 分流，M17 回归）。**CDP 噪音**：`remote-debug/appservice` 的 `wx is not defined` 不是崩了，判据＝主逻辑层 `typeof wx === "object"`。


===== r27 完整快照（2026-11-07 17:00，P-012 执行完毕后）=====
# Growing-Kids 长期约定（r27 · 红线判据索引）

> 全文快照 `MEMORY-full-archive.md`（r17–r26）；过程/实绩真相源 `docs/reports/`、`docs/design/method/proposals/P-NNN`＋`decision-log.md` D-NNN、`GK-QA-16-*.md`（生产执行 §6.1.6）、`GK-OPS-18-*.md`、`.workbuddy/memory/YYYY-MM-DD.md`、教训录 L<n>。本文件只留**会出事的判据＋一行指针**；新增前先想「能不能只写进 docs」。

## 0 流程
- 家长主用、孩子次要；改「学习行为」先过 20a §5.1 三问＋§6.2 M1–M11，证据查 20b。GK-OPS-22：L0/L1/L2＋提案单 P-NNN＋台账 D 号，**先查台账再评审**；动 `question-match.ts` 前须建档。设计决策逐题确认后再开工。
- 缺口序 C3 错因 > C2 信心 > C1 掌握梯度 > C5 交错。⛔ 励志推送／智能排程／「算出 ZPD」／打卡时长激励。**push 等思傅指示；本地 commit 照常。**

## 1 环境
- 🔴 **生产＝L3 `42.192.36.120`**：`SUPABASE_URL=http://127.0.0.1:8080`＋`STORAGE_DRIVER=local`，密钥 `/etc/gk/secrets.env`；**本地 `server/.env`／`.env.migrate` 指 Supabase 云开发库、非现网**（L3 同名文件指本机 PG `gk`）。现网查删**必须 ssh 上 L3**，删前 `db-backup.mjs --no-upload`；`ssh -T ubuntu@… "sudo -n -u postgres psql -d gk"`＋stdin SQL。
- 🔴 **commit≠发货**：前端 `build:weapp`→开发者工具重编译→真机重扫码→上传发布；后端换 `server/dist` 到 L3 **并重启 `gk-api`**（QA-16 §6.1.1：先迁移、再换 dist 并重启、旧 dist 留 `.bak-<时间戳>`、grep 特征串验包）。本地 `npx nest build`→杀 3001→`POST :3002/wake`。
- 🔴 **精准换 dist**：整包替换会顺手部署未批准功能。先比两边完整 sha256 清单（Windows 端 `sha256sum` 带 `*`，须先归一化格式）逐个人工确认归属；**4 个身份治理文件永久排除**（`auth/auth.controller.js`、`shared/user-context.js`、`users/users.service.js`、`shared/anon-bootstrap-guard.js`）；部署后复比，剩余差异必须全是明确排除项。
- 🔴 **L3 长任务**：① 远端 `nohup`＋远端日志＋另开 ssh 轮询（断连即 SIGHUP）；② `.env.migrate` 600 gk:gk ⇒ `sudo -u gk -H`；③ `/tmp` 下脚本 require 不到 node_modules ⇒ `NODE_PATH=/opt/gk/server/node_modules`。OCR venv `D:/AI/gk-ocr-env`；spawn OCR python 走 `pythonEnv()`、stdout 走 `decodeEngineChunk()`（判据：中文无 U+FFFD）。

## 2 数据红线
- 无 RLS ⇒ 查询必须 `.eq('user_id', …)`（`check:isolation` 门禁，豁免 `// check-isolation-ignore: 理由`）；删除加 `.select('id')` 校行数。新表外键 `user_id` varchar(36)；真相源**只有 `migrations/`**（`shared/schema.ts` 死代码）；空串≠NULL，回写前 `trim()`；`--only <file>`／`--force --only` 重跑。
- 管理员 `users.role`＋`requireAdmin()` fail-closed，提权唯一入口 `promote-admin.mjs`，role 单独 `select("role")`。去重 `blob_objects` 内容寻址＋ref_count，`(user_id,file_hash)` 查重在 ingest 前；改引擎/切分必 bump `OCR_ENGINE_VERSION`／`OBJECT_ENGINE_VERSION`；存储 key 只 ASCII；含 `*_images` 的读端点过 `withUrls`。
- 🔴 PG `text` 不接受 U+0000 ⇒ 夹 NUL 整条 update 抛 `0x00`、永远 `pending`；落库前 `stripNul()`。🔴 **媒体读端点必须 `res.sendFile`**（禁 `createReadStream().pipe()`：无 Content-Length / 不处理 Range ⇒ 微信音频播不动）；判据 `curl -H 'Range: bytes=0-1023'` 回 206。
- 备份：`gk_backup` 必须 `bypassrls`；口令丢了＝备份永久作废；DB 每日 03:17(keep 14)、文件周日 03:47(keep 6)、分片 4/16/32MB ≤1024 片。🔴 **`question_objects` 是派生表不进备份**（整表 `lines[]` 曾 heap OOM），恢复后 `question-objects-build.mjs --apply` 重建（§6.1.2）。
- 🔴 **归户/去重前必查唯一键**：`netdisk_files (user_id,fs_id)`、`question_objects (user_id,source_type,source_id,object_index)`。`objectFingerprintInput()` 含 `source_id` ⇒ 同内容不同来源指纹必不同，判等价要用 `stem_text/solution_text/source_revision`。

## 3 资料库检索主线（P-006 → P-012，均已上生产后端）
> 真相源 `docs/reports/资料库正文召回-检索侧四步方案评审.md` §0–§11.6（§4 定义 P0–P3）、P-006/008/009/010/011/012、D-009/011/012/013/014/015、QA-16 §6.1.1–§6.1.7。
- **P-006 硬闸**：真相源 `server/src/shared/question-match.ts`（**零依赖单文件**，M27/M31 tsc 单编后 require ⇒ 不能加 import）；keys 只收 ≥4 字长锚点，`MATCH_MIN_LONG_ANCHORS=3`／`RATIO=0.4`。🔴 **硬闸无数据源豁免**、`topic` 必须 `answer:''`＋`verified:false`；`kb` 顺序＝自有题库→library_docs→网盘 exact→ima→兜底；前后端**必须同步发货**。🔴 **双减合规**：禁拍照搜题形态，`exact` 才放解析（§7.6）。
- **P-008**：正文抽取 10,454 份 / 9,450 万字；旧 `searchLocal()` 只 `name/path ilike`＋`MAX_DEEP_FILES=3`；keys 去标点而正文含标点 ⇒ 必须预计算 `text_flat`。`.doc` 10,503 份无解。脚本默认 dry-run、只写三列、环境失败绝不写 `none`；⚠️ `--full-clean` 会 delete ⇒ 抽取前后禁跑。
- **P0（P-009）**：⛔ 别搬向量库/Reranker/LLM 兜底。🔴 **六条准入硬闸（串联否决，禁改加权求和）**：≥3 长锚点／对象题干 ≤6000 字／设问一致（`unknown` 锚点率 0.55）／锚点共现**限对象内**／相邻解析段 ≥8 字且不串题号／来源唯一。🔴 **「未达标不放行」＝举证责任倒置**；上线准入**误判归零＋召回 ≥90%＋定位 100%＋P95<3s**。🔴 残余：合成「题干 A＋别人解析」仍放行；纯文本无版面坐标时无法证明解析归属。
- **P1（P-010）**：`0026` 一题一行；构建脚本默认 dry-run、复用 `dist` 作唯一切分真相源、幂等 upsert、三条防误删护栏；`question-object-store.ts` 唯一取数口必带 `user_id`；`QUESTION_OBJECTS_STRICT` 默认 0 回退 P0。🔴 `library_docs` 与构建脚本都按 `.slice(0,60_000)` 算 `source_revision`。🔴 教训 L30：`source_id` 必须是 `netdisk_files.id`（不是 `cand.fsId`），凡「查不到就回退」必须验 key 同源。
- **P2（P-011）**：「**公共题库无条件开放 + 私有绝对私有 + 用户贡献本期不做**」。`shared/public-library.ts`：`publicLibraryOwner()`（**零参常量**）、`flatText()`（先剥 NUL 再 `normalizeForMatch`，唯一归一化真相源）、`textRecallEnabled()`（`NETDISK_TEXT_RECALL=0` 回退）。`netdisk-search.service.ts` 六处公共读写改公共 owner、签名去掉 userId、`searchLocal()` 双通道（name/path + `text_flat`，≥4 字长锚点、独立查询、合并去重、正文共现数前置排序）、删 `coverage<0.2` 闸门、`saveCache()` 同步写 `text_flat`。`0027` 只加结构；`netdisk-text-flat-build.mjs` 默认 dry-run、只写一列、幂等、`--all` 重算、查编译产物陈旧。`CACHE_VERSION v6→v7`、隐私政策 **r8**、M33 12/12。🔴 `check-isolation` **无需豁免**（仍 `.eq('user_id', ownerId)`）。
- 🔴 **改判一律追加式**：D-012 §8.5「P1/P2/P3 一律不启动」历史文本原样保留（M31/M32 钉住）；P2 放行前提＝判定层已换代（**召回变宽≠放行变宽**）／举证责任不变／补偿闸门（source_location + 请核对 + strict/P3 仍锁 + 回退开关）。**第二层上线准入仍未全绿**。
- ✅ **生产已生效（11-07 14:05 P2 / 16:55 P3 后端，实绩见 QA-16 §6.1.6 / §6.1.7.1）**：两表 owner=1；`text_flat` 10,431/10,431；GIN 318MB / 单查 142–477ms 走 Bitmap Index Scan；换 10 文件并重启，health 200 / 0 ERROR / 0 次回退；A9 自签令牌三方逐字一致且 `exact` 带 `sourceLocation`；timer 追加 `--apply`（**不带 `--all`**）。✅ 上一轮 r8 前端包思傅 16:10 已上传发布；⚠️ **本轮来源卡片仍需再发一次小程序包**。
- ✅ **P-012 / D-015（16:15 拍板，追加式改判）**：**P2 补齐**＝统一打分（`keyHits = nameHits + tHits×2` 单一口径，bigram coverage 退出主排序）＋ SQL `.order('fs_id')` / 扫描上限 2000 告警 / 合并后 `.sort()`→`.slice(0,300)`；**P3**＝`MAX_DEEP_FILES=8`、`DEEP_BUDGET_MS=8s`＋`DEEP_HARD_BUDGET_MS=18s`、默认禁在线抽取（`NETDISK_ONLINE_EXTRACT=1` 回退）、前端 `exact` 来源卡片、`CACHE_VERSION v7→v8`（结果内容变了，缓存会吐旧命中）。🔴 **判定层 `question-match.ts` 一行未动**，`strict=1` 仍锁；M34 8/8；A9 三方一致 / 深挖 8 / `tookMs` 899–1044ms / `exact=2` 带定位（上轮 `exact=1`，是候选变宽后有过闸对象，**不是判定变松**）。
- 🔴 **执行期三偏差（§6.1.6.1）**：① 归户 UPDATE→删等价冗余（唯一键冲突）；② 索引实测移到回填**之后**；③ timer 不跑 `--all`（避免每周抖动 GIN 索引）。
- 🔴 **仍锁 / 未做**：`strict=1`、第二层上线准入放行、补抽 `.doc`/大 PDF、4 个身份治理改动、**真机两个微信账号登录 E2E**（A9 是服务端自签令牌）、**本轮来源卡片的前端发版**；「题干 A + 别人解析」残余风险未消除，**不得写成误判归零 / 所有用户已可用**。服务重启后首次请求曾有一次冷态差异，本轮未复现、留作观察。

## 4 接口与前端
- 前缀 `/api/`；禁 undefined 进 query；中文名 `encodeURIComponent`。`/api/upload`：`save`=建条目、`attach`=只持久化。
- 🔴 **输入框光标**：两个 pnpm 补丁缺一不可 —— `@tarojs__react@4.1.9.patch`（同值 value 摘掉、**返回 `[]` 不能为 null**）＋`@tarojs__runtime@4.1.9.patch`（INPUT 只同步 `props.value`）；组件 `flushSync()`＋丢弃非字符串 `detail.value`。⛔ 延迟上抛／不传 value／`defaultValue`／改 `Symbol.hasInstance`（白屏）。✅ 全仓统一 `ui/Textarea`（maxlength -1、`style` 只落外壳）。
- 🔴 `downloadFile`/`uploadFile` 只补域名不注入令牌 ⇒ 打自家 `/api` 的下载必须 `header: buildHeaders()`；公网签名直链**不要**带头。service 层自己 `unwrap`（出现 `(res as any).data?.data` 即契约断）。**M18 红线**：Text onClick（用 View）／下载 header／禁双重解包／guardPrivacy／maxlength=-1／禁 process.env／禁空 catch／列表 finally 解 loading／guardPolicy／同意键禁硬编码。
- 令牌 **X-Auth-Token 唯一被采信**（`v1.<uid>.<exp>.<HMAC-SHA256(payload,AUTH_TOKEN_SECRET).hex 前 40>`，密钥 `.env.secrets`，可服务端自签做 E2E）；裸 X-User-Id 401；CORS 必暴露；免登录端点同步 `PUBLIC_ROUTES`；必须关 HTTP 协商缓存（ETag⇒304 空 body⇒列表静默不刷新）；`silent` 只约束「开始」。🔴 `navigateBack` 不重新 mount ⇒ 编辑/新增页返回要 `useDidShow`＋`firstShowRef`＋`silent:true`。
- ⚠️ 音视频禁原生小写标签：音频 `createInnerAudioContext()`、视频 `<Video>` 必须给确定高度；`<Image>`/`<Video poster>` 不发请求头 ⇒ 服务端直给 `*_url`。🚨 微信 request/uploadFile **超时上限 60s** ⇒ >60s 走 `POST /api/jobs` 202+轮询（新增类型同步 5 处、闸门在提交阶段、任务只在内存）。
- 🔴 隐私同意要真拦写：`guardPolicy(action)` 与 `guardPrivacy` 串行两道；「去同意」跳 `pages/privacy/index?from=guard`。🚨 App 根渲染兄弟节点不挂页面 ⇒ `<PolicyConsent/>` 挂首页＋`useState(() => !hasAgreedPolicy())` 首帧画；`privacy-gate`/`Toaster` 同理。隐私接口失败禁 `catch {}`（errno 112）；Taro 4.1.9 走 `globalThis.wx`。
- 🔴 改 `note`/result 结构 ⇒ 必 bump `CACHE_VERSION`（参与 `qHash`，`answer_cache` 按 `(user_id,q_hash,mode)` 存整个 result 原样返回）；判据＝拿**没问过的新题**测；当前 **v8**（P-012 候选池/结果内容变，必须失效旧缓存）。
- 🔴 `gk-netdisk-index.timer`（周日 04:23，gk）：`--budget-ms 5400000`＋`--full-clean`＋`library-index-text.mjs`＋`netdisk-text-flat-build.mjs --apply`；停 timer＝隐私「每周同步」承诺不兑现。**防误删三护栏**：`--root` 不以 `/` 开头或含 `:`/`\` 退出／零文件不清库／待删超半数要 `--force-clean`。
- ⚠️ 面客统一「资料库」不出现「百度网盘」，**但隐私政策第四节第三方清单必须保留**（法定披露、两处副本逐字一致有校验）；抽正文环境类失败保持 `pending`。🔴 **网盘凭证是运营者单账号** ⇒ `R-合规-08` 已选路径③（「运营者提供的公共资料库」），隐私政策 **r8**（M28 钉版本）。
- 🔴 导航 tab＝首页／复习本／**资料**(`pages/library`)／记忆，tab 页只能 `switchTab`。原生 button 三种例外：头像 `chooseAvatar`／反馈 `contact`／同意键 `agreePrivacyAuthorization`。`/auth/me` 带 `role`；`/api/memories` 支持 `subject_id`/`since`/`tag`（**无 `until`**）。

## 5 AI / 品牌 / L3 托管
- `users.ai_enabled`(0018) **默认 false**；`requireAiEnabled()` 拦 chat/message/answer-search/search/solve；`mode=kb` 走 `requireUserId` 不受连坐；改开关必须 `invalidateUserFlags()`。个人主体 ⇒ AI 入口整体收起（`AI_PUBLIC_ENTRY=false`）。名统一**成长学童**，`陕ICP备2026030931号-1X`；`--brand` #0B3D2E / `--brand-text` #0B7A55；`LIBRARY_NETDISK_SYNC=true` 只写不读。
- L3＝Ubuntu 24.04.4 / 4核4G60G；PG17.11→PostgREST12.2.3→Caddy→Node 3000→OCR venv；代码根 `/opt/gk/server`；用户 `ubuntu`（非 root），`/opt/gk` 要 `sudo -n`；`gk-api` `NODE_OPTIONS=--max-old-space-size=768`。
- 🔴 `STORAGE_DRIVER=local` 同步两处：`PUBLIC_ROUTES` 加 `/^\/api\/storage\/files\//` ＋ `STORAGE_PUBLIC_BASE_URL`；Caddy 站点块**必须用 `handle` 包住** `file_server`；`PROJECT_DOMAIN` 是编译期常量，改 `.env.local` 必须重建。Linux 下 `OCR_VENV_DIR` 不生效 ⇒ 必设 `OCR_PYTHON`+`PPSV3_PYTHON`+`PADDLE_PDX_CACHE_HOME`/`XDG_CACHE_HOME`。
- 🔴 **手工部署只换 `dist` 会漏文件**：改 `ocr-engine/*.py` 必须单独 scp；漏传**接口不报错、静默降级**（判据 `hits[].hit` 有没有 `content`）。快速=rapid→`main.py`、精准→`main3.py`，**补丁两处都改**；生产 `OCR_ENGINE_MODE=rapid`。
- 搬数据在云主机做（`PGTZ=UTC`＋两侧 pg_dump 排序比字节）；`--disable-triggers` dump 只能 `postgres` 导入＋`--single-transaction`。🔴 `SUPABASE_URL` 必须 `http://127.0.0.1:8080`；`service_role` 必须 BYPASSRLS。🔴 **8080 是 Caddy 不是 PostgREST 直连**：直打 `/<table>` 回 200 空 body 是假通过，必须 `/rest/v1/<table>?select=...` 回 200 真实行（§6.1.4）。
- **结果指标**：唯一够格＝到期首次作答正确率（按档位）⇒ `0021 review_events`＋`review()` 埋点；每档 ≥30 样本才出数；**当前 0 行**。

## 6 发布与测试
- 发版前轮换 WX_SECRET（`rotate-wx-secret.mjs`）**后必跑 encrypt-env.mjs**；`pnpm release:check` 上传后记得 revert；生产 `WAKE_ENABLED=0`。🚨 开发管理已托管第三方 ⇒ **发正式版必须先解除托管**。服务类目现「教育服务 > 教育信息展示」，**保留 + 追加工具类目**，⛔ 别删。
- 🔴 **个人主体小程序不得做「用户共享题库 / UGC 发布分享」**：【社交-笔记】类目仅非个人主体可用；须内容安全 API + 属地网信报备 7 日 + 人工审核 + 申诉渠道。叠加 **PIPL §16「不得以不同意/撤回同意为由拒绝提供服务」** ⇒ ⛔「共享自己的题才能用公共题库」。教辅 PDF/Word 共享涉信息网络传播权。**行业做法**：作业帮靠签约老师众包＋12 轮审核，夸克/猿辅导靠自建，均无条件开放搜题（报告 §10.5）。
- 🔴 备案：轻量须包月≥3月、**L3 到期⇒备案失效**；个人主体文案禁教育/培训/课程/辅导；**小程序备案 ≠ 域名备案**；首页 footer 挂真实号＋`beian.miit.gov.cn`；**公安联网备案待办**；首页 `<title>`/`<h1>` 必须与备案站名逐字一致。
- `server/scripts/verify/`：新模块丢 `modules/NN-x.mjs` 自动发现；`verify:ci`（M12 M13 M16）、`verify:gate`（+M18）、`method:check`（H1/H2/H3）、`lint:build`；纯函数模块 tsc 单编后 require。**M16 三条硬门**：六栏+引用可解析／禁用宣称词／镜像参数逐字一致。**造数据铁律**：同内容文件命中去重 ⇒ 每次内容必须不同。当前基线 `verify:gate` 37/37、M27–M34 **103/103**、`check:isolation` 150/150。
- UI 通道 `ide-cdp.mjs`+`ide-*.mjs`，进程须在**同一个 `run_in_background` 任务**启动+保活；🔴 测试期禁用真登录（`/auth/login` 会整体迁移匿名号数据），切身份只换令牌。⚠️ 根 `tsc --noEmit` 的 node_modules 报错是既有噪音；后端用 `server/` 下 `tsc --noEmit` + `npx nest build`。

## 7 其它
- **复习排程 C4**：真相源 `timeline/review.ts`；五档 1→3→7→14→28 天，做对推进、做错归零；前端不自算 plan；改间隔表触发 M15（三处同步）。
- **CI**：`gate`=build:server→build:weapp→M12 M13 M16；`api-core` 需 5 secret 才跑 M01–M08/M15；OCR GT 退出码 2＝环境跑不起来；`R-算法-07` 竖式符号行丢失（未修）；导出口径 `include_answers` 不传=不含答案。
- **方法论**：M11 连续天数/停留时长只作引导展示、不得作判定标准；🚨 **20b 第 7 章标题不可动**（`method-gates.mjs` 正则算文献号上界，重排⇒H1 静默跳过）；批量改文档用脚本+「命中 1 次」断言；教训 L27 同一 bug 改到第三版停下建复现模型、L28 平台规则从源码/文档抠、L30 测试通道决定结论上限。
- **年级属性 P-005/D-008/0025**：12 档，真相源 `shared/grade.ts`＋前端镜像 `constants/grades.ts`（不跨端 import），M26 守；`grade is null` 始终可见／`normalizeGrade` 先挡空串／筛掉用户内容必须自带回退开关。
- 🔴 **本地 commit ≠ 生产有代码**：曾因「生产库没 0025 **且** dist 没 `setGrade`」⇒ 404；排查先 grep 生产 dist 特征串。🔴 **`users` 行数 ≠ 真实用户规模**：生产 80＝79 匿名 + 1 正式；**528 道题挂在 29 个匿名号上是联调数据、不能删**。🔴 异步任务提交闸门必须与同步端点同口径（`POST /api/jobs` 曾按 type 一刀切 ⇒ `mode=kb` 403；按 `params.mode` 分流，M17 回归）。**CDP 噪音**：`remote-debug/appservice` 的 `wx is not defined` 不是崩了，判据＝主逻辑层 `typeof wx === "object"`。


---

<!-- r27 全文快照，2026-11-07 归档；r28 起 MEMORY.md 改为精简索引 -->

# Growing-Kids 长期约定（r27 · 红线判据索引）

> 全文快照 `MEMORY-full-archive.md`（r17–r26）；过程/实绩真相源 `docs/reports/`、`docs/design/method/proposals/P-NNN`＋`decision-log.md` D-NNN、`GK-QA-16-*.md`（生产执行 §6.1.6）、`GK-OPS-18-*.md`、`.workbuddy/memory/YYYY-MM-DD.md`、教训录 L<n>。本文件只留**会出事的判据＋一行指针**；新增前先想「能不能只写进 docs」。

## 0 流程
- 家长主用、孩子次要；改「学习行为」先过 20a §5.1 三问＋§6.2 M1–M11，证据查 20b。GK-OPS-22：L0/L1/L2＋提案单 P-NNN＋台账 D 号，**先查台账再评审**；动 `question-match.ts` 前须建档。设计决策逐题确认后再开工。
- 缺口序 C3 错因 > C2 信心 > C1 掌握梯度 > C5 交错。⛔ 励志推送／智能排程／「算出 ZPD」／打卡时长激励。**push 等思傅指示；本地 commit 照常。**

## 1 环境
- 🔴 **生产＝L3 `42.192.36.120`**：`SUPABASE_URL=http://127.0.0.1:8080`＋`STORAGE_DRIVER=local`，密钥 `/etc/gk/secrets.env`；**本地 `server/.env`／`.env.migrate` 指 Supabase 云开发库、非现网**（L3 同名文件指本机 PG `gk`）。现网查删**必须 ssh 上 L3**，删前 `db-backup.mjs --no-upload`；`ssh -T ubuntu@… "sudo -n -u postgres psql -d gk"`＋stdin SQL。
- 🔴 **commit≠发货**：前端 `build:weapp`→开发者工具重编译→真机重扫码→上传发布；后端换 `server/dist` 到 L3 **并重启 `gk-api`**（QA-16 §6.1.1：先迁移、再换 dist 并重启、旧 dist 留 `.bak-<时间戳>`、grep 特征串验包）。本地 `npx nest build`→杀 3001→`POST :3002/wake`。
- 🔴 **精准换 dist**：整包替换会顺手部署未批准功能。先比两边完整 sha256 清单（Windows 端 `sha256sum` 带 `*`，须先归一化格式）逐个人工确认归属；**4 个身份治理文件永久排除**（`auth/auth.controller.js`、`shared/user-context.js`、`users/users.service.js`、`shared/anon-bootstrap-guard.js`）；部署后复比，剩余差异必须全是明确排除项。
- 🔴 **L3 长任务**：① 远端 `nohup`＋远端日志＋另开 ssh 轮询（断连即 SIGHUP）；② `.env.migrate` 600 gk:gk ⇒ `sudo -u gk -H`；③ `/tmp` 下脚本 require 不到 node_modules ⇒ `NODE_PATH=/opt/gk/server/node_modules`。OCR venv `D:/AI/gk-ocr-env`；spawn OCR python 走 `pythonEnv()`、stdout 走 `decodeEngineChunk()`（判据：中文无 U+FFFD）。

## 2 数据红线
- 无 RLS ⇒ 查询必须 `.eq('user_id', …)`（`check:isolation` 门禁，豁免 `// check-isolation-ignore: 理由`）；删除加 `.select('id')` 校行数。新表外键 `user_id` varchar(36)；真相源**只有 `migrations/`**（`shared/schema.ts` 死代码）；空串≠NULL，回写前 `trim()`；`--only <file>`／`--force --only` 重跑。
- 管理员 `users.role`＋`requireAdmin()` fail-closed，提权唯一入口 `promote-admin.mjs`，role 单独 `select("role")`。去重 `blob_objects` 内容寻址＋ref_count，`(user_id,file_hash)` 查重在 ingest 前；改引擎/切分必 bump `OCR_ENGINE_VERSION`／`OBJECT_ENGINE_VERSION`；存储 key 只 ASCII；含 `*_images` 的读端点过 `withUrls`。
- 🔴 PG `text` 不接受 U+0000 ⇒ 夹 NUL 整条 update 抛 `0x00`、永远 `pending`；落库前 `stripNul()`。🔴 **媒体读端点必须 `res.sendFile`**（禁 `createReadStream().pipe()`：无 Content-Length / 不处理 Range ⇒ 微信音频播不动）；判据 `curl -H 'Range: bytes=0-1023'` 回 206。
- 备份：`gk_backup` 必须 `bypassrls`；口令丢了＝备份永久作废；DB 每日 03:17(keep 14)、文件周日 03:47(keep 6)、分片 4/16/32MB ≤1024 片。🔴 **`question_objects` 是派生表不进备份**（整表 `lines[]` 曾 heap OOM），恢复后 `question-objects-build.mjs --apply` 重建（§6.1.2）。
- 🔴 **归户/去重前必查唯一键**：`netdisk_files (user_id,fs_id)`、`question_objects (user_id,source_type,source_id,object_index)`。`objectFingerprintInput()` 含 `source_id` ⇒ 同内容不同来源指纹必不同，判等价要用 `stem_text/solution_text/source_revision`。

## 3 资料库检索主线（P-006 → P-012，均已上生产后端）
> 真相源 `docs/reports/资料库正文召回-检索侧四步方案评审.md` §0–§11.6（§4 定义 P0–P3）、P-006/008/009/010/011/012、D-009/011/012/013/014/015、QA-16 §6.1.1–§6.1.7。
- **P-006 硬闸**：真相源 `server/src/shared/question-match.ts`（**零依赖单文件**，M27/M31 tsc 单编后 require ⇒ 不能加 import）；keys 只收 ≥4 字长锚点，`MATCH_MIN_LONG_ANCHORS=3`／`RATIO=0.4`。🔴 **硬闸无数据源豁免**、`topic` 必须 `answer:''`＋`verified:false`；`kb` 顺序＝自有题库→library_docs→网盘 exact→ima→兜底；前后端**必须同步发货**。🔴 **双减合规**：禁拍照搜题形态，`exact` 才放解析（§7.6）。
- **P-008**：正文抽取 10,454 份 / 9,450 万字；旧 `searchLocal()` 只 `name/path ilike`＋`MAX_DEEP_FILES=3`；keys 去标点而正文含标点 ⇒ 必须预计算 `text_flat`。`.doc` 10,503 份无解。脚本默认 dry-run、只写三列、环境失败绝不写 `none`；⚠️ `--full-clean` 会 delete ⇒ 抽取前后禁跑。
- **P0（P-009）**：⛔ 别搬向量库/Reranker/LLM 兜底。🔴 **六条准入硬闸（串联否决，禁改加权求和）**：≥3 长锚点／对象题干 ≤6000 字／设问一致（`unknown` 锚点率 0.55）／锚点共现**限对象内**／相邻解析段 ≥8 字且不串题号／来源唯一。🔴 **「未达标不放行」＝举证责任倒置**；上线准入**误判归零＋召回 ≥90%＋定位 100%＋P95<3s**。🔴 残余：合成「题干 A＋别人解析」仍放行；纯文本无版面坐标时无法证明解析归属。
- **P1（P-010）**：`0026` 一题一行；构建脚本默认 dry-run、复用 `dist` 作唯一切分真相源、幂等 upsert、三条防误删护栏；`question-object-store.ts` 唯一取数口必带 `user_id`；`QUESTION_OBJECTS_STRICT` 默认 0 回退 P0。🔴 `library_docs` 与构建脚本都按 `.slice(0,60_000)` 算 `source_revision`。🔴 教训 L30：`source_id` 必须是 `netdisk_files.id`（不是 `cand.fsId`），凡「查不到就回退」必须验 key 同源。
- **P2（P-011）**：「**公共题库无条件开放 + 私有绝对私有 + 用户贡献本期不做**」。`shared/public-library.ts`：`publicLibraryOwner()`（**零参常量**）、`flatText()`（先剥 NUL 再 `normalizeForMatch`，唯一归一化真相源）、`textRecallEnabled()`（`NETDISK_TEXT_RECALL=0` 回退）。`netdisk-search.service.ts` 六处公共读写改公共 owner、签名去掉 userId、`searchLocal()` 双通道（name/path + `text_flat`，≥4 字长锚点、独立查询、合并去重、正文共现数前置排序）、删 `coverage<0.2` 闸门、`saveCache()` 同步写 `text_flat`。`0027` 只加结构；`netdisk-text-flat-build.mjs` 默认 dry-run、只写一列、幂等、`--all` 重算、查编译产物陈旧。`CACHE_VERSION v6→v7`、隐私政策 **r8**、M33 12/12。🔴 `check-isolation` **无需豁免**（仍 `.eq('user_id', ownerId)`）。
- 🔴 **改判一律追加式**：D-012 §8.5「P1/P2/P3 一律不启动」历史文本原样保留（M31/M32 钉住）；P2 放行前提＝判定层已换代（**召回变宽≠放行变宽**）／举证责任不变／补偿闸门（source_location + 请核对 + strict/P3 仍锁 + 回退开关）。**第二层上线准入仍未全绿**。
- ✅ **生产已生效（11-07 14:05 P2 / 16:55 P3 后端，实绩见 QA-16 §6.1.6 / §6.1.7.1）**：两表 owner=1；`text_flat` 10,431/10,431；GIN 318MB / 单查 142–477ms 走 Bitmap Index Scan；换 10 文件并重启，health 200 / 0 ERROR / 0 次回退；A9 自签令牌三方逐字一致且 `exact` 带 `sourceLocation`；timer 追加 `--apply`（**不带 `--all`**）。✅ 上一轮 r8 前端包思傅 16:10 已上传发布；⚠️ **本轮来源卡片仍需再发一次小程序包**。
- ✅ **P-012 / D-015（16:15 拍板，追加式改判）**：**P2 补齐**＝统一打分（`keyHits = nameHits + tHits×2` 单一口径，bigram coverage 退出主排序）＋ SQL `.order('fs_id')` / 扫描上限 2000 告警 / 合并后 `.sort()`→`.slice(0,300)`；**P3**＝`MAX_DEEP_FILES=8`、`DEEP_BUDGET_MS=8s`＋`DEEP_HARD_BUDGET_MS=18s`、默认禁在线抽取（`NETDISK_ONLINE_EXTRACT=1` 回退）、前端 `exact` 来源卡片、`CACHE_VERSION v7→v8`（结果内容变了，缓存会吐旧命中）。🔴 **判定层 `question-match.ts` 一行未动**，`strict=1` 仍锁；M34 8/8；A9 三方一致 / 深挖 8 / `tookMs` 899–1044ms / `exact=2` 带定位（上轮 `exact=1`，是候选变宽后有过闸对象，**不是判定变松**）。
- 🔴 **执行期三偏差（§6.1.6.1）**：① 归户 UPDATE→删等价冗余（唯一键冲突）；② 索引实测移到回填**之后**；③ timer 不跑 `--all`（避免每周抖动 GIN 索引）。
- 🔴 **仍锁 / 未做**：`strict=1`、第二层上线准入放行、补抽 `.doc`/大 PDF、4 个身份治理改动、**真机两个微信账号登录 E2E**（A9 是服务端自签令牌）、**本轮来源卡片的前端发版**；「题干 A + 别人解析」残余风险未消除，**不得写成误判归零 / 所有用户已可用**。服务重启后首次请求曾有一次冷态差异，本轮未复现、留作观察。

## 4 接口与前端
- 前缀 `/api/`；禁 undefined 进 query；中文名 `encodeURIComponent`。`/api/upload`：`save`=建条目、`attach`=只持久化。
- 🔴 **输入框光标**：两个 pnpm 补丁缺一不可 —— `@tarojs__react@4.1.9.patch`（同值 value 摘掉、**返回 `[]` 不能为 null**）＋`@tarojs__runtime@4.1.9.patch`（INPUT 只同步 `props.value`）；组件 `flushSync()`＋丢弃非字符串 `detail.value`。⛔ 延迟上抛／不传 value／`defaultValue`／改 `Symbol.hasInstance`（白屏）。✅ 全仓统一 `ui/Textarea`（maxlength -1、`style` 只落外壳）。
- 🔴 `downloadFile`/`uploadFile` 只补域名不注入令牌 ⇒ 打自家 `/api` 的下载必须 `header: buildHeaders()`；公网签名直链**不要**带头。service 层自己 `unwrap`（出现 `(res as any).data?.data` 即契约断）。**M18 红线**：Text onClick（用 View）／下载 header／禁双重解包／guardPrivacy／maxlength=-1／禁 process.env／禁空 catch／列表 finally 解 loading／guardPolicy／同意键禁硬编码。
- 令牌 **X-Auth-Token 唯一被采信**（`v1.<uid>.<exp>.<HMAC-SHA256(payload,AUTH_TOKEN_SECRET).hex 前 40>`，密钥 `.env.secrets`，可服务端自签做 E2E）；裸 X-User-Id 401；CORS 必暴露；免登录端点同步 `PUBLIC_ROUTES`；必须关 HTTP 协商缓存（ETag⇒304 空 body⇒列表静默不刷新）；`silent` 只约束「开始」。🔴 `navigateBack` 不重新 mount ⇒ 编辑/新增页返回要 `useDidShow`＋`firstShowRef`＋`silent:true`。
- ⚠️ 音视频禁原生小写标签：音频 `createInnerAudioContext()`、视频 `<Video>` 必须给确定高度；`<Image>`/`<Video poster>` 不发请求头 ⇒ 服务端直给 `*_url`。🚨 微信 request/uploadFile **超时上限 60s** ⇒ >60s 走 `POST /api/jobs` 202+轮询（新增类型同步 5 处、闸门在提交阶段、任务只在内存）。
- 🔴 隐私同意要真拦写：`guardPolicy(action)` 与 `guardPrivacy` 串行两道；「去同意」跳 `pages/privacy/index?from=guard`。🚨 App 根渲染兄弟节点不挂页面 ⇒ `<PolicyConsent/>` 挂首页＋`useState(() => !hasAgreedPolicy())` 首帧画；`privacy-gate`/`Toaster` 同理。隐私接口失败禁 `catch {}`（errno 112）；Taro 4.1.9 走 `globalThis.wx`。
- 🔴 改 `note`/result 结构 ⇒ 必 bump `CACHE_VERSION`（参与 `qHash`，`answer_cache` 按 `(user_id,q_hash,mode)` 存整个 result 原样返回）；判据＝拿**没问过的新题**测；当前 **v8**（P-012 候选池/结果内容变，必须失效旧缓存）。
- 🔴 `gk-netdisk-index.timer`（周日 04:23，gk）：`--budget-ms 5400000`＋`--full-clean`＋`library-index-text.mjs`＋`netdisk-text-flat-build.mjs --apply`；停 timer＝隐私「每周同步」承诺不兑现。**防误删三护栏**：`--root` 不以 `/` 开头或含 `:`/`\` 退出／零文件不清库／待删超半数要 `--force-clean`。
- ⚠️ 面客统一「资料库」不出现「百度网盘」，**但隐私政策第四节第三方清单必须保留**（法定披露、两处副本逐字一致有校验）；抽正文环境类失败保持 `pending`。🔴 **网盘凭证是运营者单账号** ⇒ `R-合规-08` 已选路径③（「运营者提供的公共资料库」），隐私政策 **r8**（M28 钉版本）。
- 🔴 导航 tab＝首页／复习本／**资料**(`pages/library`)／记忆，tab 页只能 `switchTab`。原生 button 三种例外：头像 `chooseAvatar`／反馈 `contact`／同意键 `agreePrivacyAuthorization`。`/auth/me` 带 `role`；`/api/memories` 支持 `subject_id`/`since`/`tag`（**无 `until`**）。

## 5 AI / 品牌 / L3 托管
- `users.ai_enabled`(0018) **默认 false**；`requireAiEnabled()` 拦 chat/message/answer-search/search/solve；`mode=kb` 走 `requireUserId` 不受连坐；改开关必须 `invalidateUserFlags()`。个人主体 ⇒ AI 入口整体收起（`AI_PUBLIC_ENTRY=false`）。名统一**成长学童**，`陕ICP备2026030931号-1X`；`--brand` #0B3D2E / `--brand-text` #0B7A55；`LIBRARY_NETDISK_SYNC=true` 只写不读。
- L3＝Ubuntu 24.04.4 / 4核4G60G；PG17.11→PostgREST12.2.3→Caddy→Node 3000→OCR venv；代码根 `/opt/gk/server`；用户 `ubuntu`（非 root），`/opt/gk` 要 `sudo -n`；`gk-api` `NODE_OPTIONS=--max-old-space-size=768`。
- 🔴 `STORAGE_DRIVER=local` 同步两处：`PUBLIC_ROUTES` 加 `/^\/api\/storage\/files\//` ＋ `STORAGE_PUBLIC_BASE_URL`；Caddy 站点块**必须用 `handle` 包住** `file_server`；`PROJECT_DOMAIN` 是编译期常量，改 `.env.local` 必须重建。Linux 下 `OCR_VENV_DIR` 不生效 ⇒ 必设 `OCR_PYTHON`+`PPSV3_PYTHON`+`PADDLE_PDX_CACHE_HOME`/`XDG_CACHE_HOME`。
- 🔴 **手工部署只换 `dist` 会漏文件**：改 `ocr-engine/*.py` 必须单独 scp；漏传**接口不报错、静默降级**（判据 `hits[].hit` 有没有 `content`）。快速=rapid→`main.py`、精准→`main3.py`，**补丁两处都改**；生产 `OCR_ENGINE_MODE=rapid`。
- 搬数据在云主机做（`PGTZ=UTC`＋两侧 pg_dump 排序比字节）；`--disable-triggers` dump 只能 `postgres` 导入＋`--single-transaction`。🔴 `SUPABASE_URL` 必须 `http://127.0.0.1:8080`；`service_role` 必须 BYPASSRLS。🔴 **8080 是 Caddy 不是 PostgREST 直连**：直打 `/<table>` 回 200 空 body 是假通过，必须 `/rest/v1/<table>?select=...` 回 200 真实行（§6.1.4）。
- **结果指标**：唯一够格＝到期首次作答正确率（按档位）⇒ `0021 review_events`＋`review()` 埋点；每档 ≥30 样本才出数；**当前 0 行**。

## 6 发布与测试
- 发版前轮换 WX_SECRET（`rotate-wx-secret.mjs`）**后必跑 encrypt-env.mjs**；`pnpm release:check` 上传后记得 revert；生产 `WAKE_ENABLED=0`。🚨 开发管理已托管第三方 ⇒ **发正式版必须先解除托管**。服务类目现「教育服务 > 教育信息展示」，**保留 + 追加工具类目**，⛔ 别删。
- 🔴 **个人主体小程序不得做「用户共享题库 / UGC 发布分享」**：【社交-笔记】类目仅非个人主体可用；须内容安全 API + 属地网信报备 7 日 + 人工审核 + 申诉渠道。叠加 **PIPL §16「不得以不同意/撤回同意为由拒绝提供服务」** ⇒ ⛔「共享自己的题才能用公共题库」。教辅 PDF/Word 共享涉信息网络传播权。**行业做法**：作业帮靠签约老师众包＋12 轮审核，夸克/猿辅导靠自建，均无条件开放搜题（报告 §10.5）。
- 🔴 备案：轻量须包月≥3月、**L3 到期⇒备案失效**；个人主体文案禁教育/培训/课程/辅导；**小程序备案 ≠ 域名备案**；首页 footer 挂真实号＋`beian.miit.gov.cn`；**公安联网备案待办**；首页 `<title>`/`<h1>` 必须与备案站名逐字一致。
- `server/scripts/verify/`：新模块丢 `modules/NN-x.mjs` 自动发现；`verify:ci`（M12 M13 M16）、`verify:gate`（+M18）、`method:check`（H1/H2/H3）、`lint:build`；纯函数模块 tsc 单编后 require。**M16 三条硬门**：六栏+引用可解析／禁用宣称词／镜像参数逐字一致。**造数据铁律**：同内容文件命中去重 ⇒ 每次内容必须不同。当前基线 `verify:gate` 37/37、M27–M34 **103/103**、`check:isolation` 150/150。
- UI 通道 `ide-cdp.mjs`+`ide-*.mjs`，进程须在**同一个 `run_in_background` 任务**启动+保活；🔴 测试期禁用真登录（`/auth/login` 会整体迁移匿名号数据），切身份只换令牌。⚠️ 根 `tsc --noEmit` 的 node_modules 报错是既有噪音；后端用 `server/` 下 `tsc --noEmit` + `npx nest build`。

## 7 其它
- **复习排程 C4**：真相源 `timeline/review.ts`；五档 1→3→7→14→28 天，做对推进、做错归零；前端不自算 plan；改间隔表触发 M15（三处同步）。
- **CI**：`gate`=build:server→build:weapp→M12 M13 M16；`api-core` 需 5 secret 才跑 M01–M08/M15；OCR GT 退出码 2＝环境跑不起来；`R-算法-07` 竖式符号行丢失（未修）；导出口径 `include_answers` 不传=不含答案。
- **方法论**：M11 连续天数/停留时长只作引导展示、不得作判定标准；🚨 **20b 第 7 章标题不可动**（`method-gates.mjs` 正则算文献号上界，重排⇒H1 静默跳过）；批量改文档用脚本+「命中 1 次」断言；教训 L27 同一 bug 改到第三版停下建复现模型、L28 平台规则从源码/文档抠、L30 测试通道决定结论上限。
- **年级属性 P-005/D-008/0025**：12 档，真相源 `shared/grade.ts`＋前端镜像 `constants/grades.ts`（不跨端 import），M26 守；`grade is null` 始终可见／`normalizeGrade` 先挡空串／筛掉用户内容必须自带回退开关。
- 🔴 **本地 commit ≠ 生产有代码**：曾因「生产库没 0025 **且** dist 没 `setGrade`」⇒ 404；排查先 grep 生产 dist 特征串。🔴 **`users` 行数 ≠ 真实用户规模**：生产 80＝79 匿名 + 1 正式；**528 道题挂在 29 个匿名号上是联调数据、不能删**。🔴 异步任务提交闸门必须与同步端点同口径（`POST /api/jobs` 曾按 type 一刀切 ⇒ `mode=kb` 403；按 `params.mode` 分流，M17 回归）。**CDP 噪音**：`remote-debug/appservice` 的 `wx is not defined` 不是崩了，判据＝主逻辑层 `typeof wx === "object"`。


---

# r28 快照（2026-11-08 归档 · 压缩前全文）

# Growing-Kids 长期约定（r28 · 红线索引）

> 详细判据全文见 `MEMORY-full-archive.md`（r17–r27，按 § 对应）；实绩/过程真相源 `docs/reports/`、`proposals/P-NNN`＋`decision-log.md` D-NNN、`GK-QA-16-*`、`GK-OPS-*`、`.workbuddy/memory/YYYY-MM-DD.md`、教训录 L<n>。**本文件只留一句话红线**；新增前先想「能不能只写进 docs」。

## 0 流程
- 家长主用、孩子次要；改「学习行为」先过 20a §5.1 三问＋§6.2 M1–M11。GK-OPS-22：L0/L1/L2＋提案单 P-NNN＋台账 D 号，**先查台账再评审**；动 `question-match.ts` 前须建档；设计决策逐题确认再开工。
- 缺口序 C3 错因 > C2 信心 > C1 掌握梯度 > C5 交错。⛔ 励志推送／智能排程／「算出 ZPD」／打卡时长激励。**push 等思傅指示；本地 commit 照常。**

## 1 环境与发货（详档 §1）
- 🔴 生产＝L3 `42.192.36.120`（本机 PG `gk`＋PostgREST 8080＋Caddy）；**本地 `server/.env`／`.env.migrate` 是 Supabase 云开发库、非现网**。现网查删必须 ssh 上 L3，删前 `db-backup.mjs --no-upload`。
- 🔴 **commit≠发货**：前端 `build:weapp`→重编译→上传→发版；后端换 `server/dist` 到 L3 **并重启 `gk-api`**（QA-16 §6.1.1：先迁移、旧 dist 留 `.bak-时间戳`、grep 特征串验包）。
- 🔴 **验证≠真机**：回归在开发者工具模拟器跑（§6），⛔ 别每轮写「真机重扫码待人工」；真机只在发版前一次＋真机专有能力；正式发版仍需思傅在 mp 后台点（开发管理托管第三方）。
- 🔴 **精准换 dist**：先比两边完整 sha256 清单（Windows `*` 先归一化）逐个确认归属；**4 个身份治理文件永久排除**；部署后复比，剩余差异必须全是排除项。
- 🔴 L3 长任务：远端 `nohup`＋远端日志＋另开 ssh 轮询；`.env.migrate` ⇒ `sudo -u gk -H`；`/tmp` 脚本要 `NODE_PATH=/opt/gk/server/node_modules`。OCR 中文无 U+FFFD 才对（`pythonEnv()`／`decodeEngineChunk()`）。

## 2 数据（详档 §2）
- 无 RLS ⇒ 查询必须 `.eq('user_id', …)`（`check:isolation`）；删除加 `.select('id')` 校行数；真相源**只有 `migrations/`**；空串≠NULL，回写前 `trim()`。
- 管理员 `users.role`＋`requireAdmin()` fail-closed，提权唯一入口 `promote-admin.mjs`；去重 `blob_objects` 内容寻址＋ref_count；改引擎/切分必 bump 版本号；存储 key 只 ASCII；`*_images` 读端点过 `withUrls`。
- 🔴 PG `text` 不接受 U+0000 ⇒ 落库前 `stripNul()`。🔴 **媒体读端点必须 `res.sendFile`**（Range 206 判据），禁 `createReadStream().pipe()`。
- 备份：`gk_backup` 必须 `bypassrls`，口令丢了永久作废；🔴 `question_objects` 派生表不进备份，恢复后 `question-objects-build.mjs --apply` 重建。
- 🔴 归户/去重前必查唯一键：`netdisk_files (user_id,fs_id)`、`question_objects (user_id,source_type,source_id,object_index)`；`objectFingerprintInput()` 含 `source_id`，判等价用 `stem_text/solution_text/source_revision`。

## 3 资料库检索（P-006→P-012，详档 §3＋报告 §0–§11.6）
- 真相源 `server/src/shared/question-match.ts`（**零依赖单文件**，不能加 import）；🔴 硬闸无数据源豁免、`topic` 必须 `answer:''`＋`verified:false`；`kb` 顺序＝自有题库→library_docs→网盘 exact→ima→兜底；前后端同步发货；双减禁拍照搜题、`exact` 才放解析。
- 🔴 **P0 六条准入硬闸（串联否决，禁改加权求和）**：≥3 长锚点／题干 ≤6000 字／设问一致／锚点共现限对象内／相邻解析段 ≥8 字不串题号／来源唯一。🔴「未达标不放行」＝举证责任倒置；**作用域经 P-015 修正为「未达标不得冒充本题答案」，不是「不得提供任何学习材料」**；准入＝误判归零＋召回 ≥90%＋定位 100%＋P95<3s。⛔ 本期不上向量库/Reranker/LLM 兜底（思傅 11-07 23:50 已授权对比参照与改设计方法；经评估仍不上，理由见 `P-015 §1`，后续可另立提案）。
- 🔴 **判定层一行未动**是 P2/P3 放行前提：**召回变宽≠放行变宽**；举证责任不变；补偿闸门（source_location＋请核对＋strict/P3 仍锁＋回退开关）。**第二层上线准入仍未全绿**，残余「题干 A＋别人解析」风险未消除，**不得写成误判归零 / 所有用户已可用**。
- **P1**：`0026` 一题一行，构建脚本默认 dry-run／复用 `dist` 切分／幂等 upsert／三条防误删护栏；`question-object-store.ts` 唯一取数口必带 `user_id`；`QUESTION_OBJECTS_STRICT` 默认 0 回退 P0。🔴 L30：`source_id` 必须是 `netdisk_files.id`，凡「查不到就回退」必须验 key 同源。
- **P2**：定稿「公共题库无条件开放＋私有绝对私有＋用户贡献本期不做」；`shared/public-library.ts` 的 `publicLibraryOwner()`／`flatText()`／`textRecallEnabled()` 是唯一真相源；`searchLocal()` 双通道（name/path＋`text_flat`），`saveCache()` 同步写 `text_flat`；🔴 `check-isolation` 无需豁免。
- **P-012/P3**：统一打分 `keyHits = nameHits + tHits×2`、SQL 排序后 top-N、深挖 8 份/8s＋18s 兜底、默认禁在线抽取、`exact` 来源卡片、`CACHE_VERSION v8`（P-013 v9 → P-014 v10 → P-015 **v11**）。
- 🔴 **改判一律追加式**（D-012 §8.5 历史文本原样保留，M31/M32 钉住）；执行期三偏差：归户改删冗余／GIN 索引移到回填后／timer 不跑 `--all`。
- 🔴 **11-07 晚真实登录态实测**：当前账号 6 条真实录入题 `mode=kb` ⇒ **exact=0 / topic=5 / none=1**，全 `verified=false`、答案为空；题干是**整页 OCR 文本＋错字**（1 条 17,035 字整张试卷、「图形分折」「tsunamie thrqugh」）。⚠️ **21:20 订正**：当时归因「要提命中先修上游切题/OCR」**已被实测证伪**——手工切单题＋修错字 5 例仍 exact=0；L3 只读 `question_objects` 含 `BMDN` **4 行**（有解析、link=ok）、`text_flat` 含 BMDN **47 份**，判定层 `store.usable=49`、`rejectReason`＝「对象内锚点共现不足 1/17」拒绝的是别的题 ⇒ **真根因在召回侧**：`textAnchors` 取 `extractDistinctive().keys` 前 4 个，全被 12 个 6 字滑窗占满截断 ⇒ `DABC60/C60AB3/AB3BC5/BC5MN分` 这类碎片，含 `BMDN` 的片段排第 12 位之外，原题文件进不了深挖 8 份；英文题 `keys`＝`tsun/unam/swep/thro/roug/vill`（4 字滑窗），召回全是英文绘本。诊断脚本 `node server/scripts/kb-hit-diagnose.mjs`（只读可重跑）。⇒ 修法走 **`P-013`/`D-016`（方案 A，后已否决）**：只改召回选词、判定层 `anchors`/`longAnchors`/`judge*` 一行不动、bump `CACHE_VERSION v8→v9`、深挖 8/8s 不动；上游 OCR/切题降为独立 P1；⛔ 绝不靠放宽判定层。样本 6+5 条仅方向性证据，不作召回率结论，不得写成「功能已可用」。
- 🔴 **22:2x `P-013`/`D-016` 实施＋部署（falsifier ① 已触发，待裁决）**：思傅拍板 A+B 分两步（本轮 A）＋英文同修＋直接部署＋`TEXT_RECALL_KEYS=4`。`question-match.ts` **一行未动**，只在 `netdisk-search.service.ts` 加 `pickTextAnchors()`/`isGenericPointLabel()`/`LATIN_STOP` 与拉丁整词分支，`CACHE_VERSION v8→v9`，新增 M35。M27–M35 **111/111**、`check:isolation` 150/150、`verify:gate` 37/37；精准换 5 产物（回滚点 `dist.bak-p013-20261107-2216`）、复比剩余 14 项全是排除项、health 200/0 ERROR。✅ **召回缺陷确实修好**：原题文件从进不了深挖池 → **排第 1/2 位**、锚点共现 `1/17→18/18`、**完整库内原题自检 `exact=2` 带定位**（判定链路无回归）、英文 `keys` 从 `tsun/unam/swep` → 整词、耗时 89–2686ms。🔴 **但 6 条真实题 + 5 单题 `exact` 仍全 0**、用户侧 `answer-search` 全 `verified=false/ans=0` ⇒ **`P-013` 目标未达成、falsifier ① 触发**。✅ **22:3x 思傅裁决「保留代码、提案改判为未达标」**：`P-013` 状态 `已批准→已否决`、5 个产物**留在生产不回滚**（回滚点 `dist.bak-p013-20261107-2216` 备查）、🔴 **所有收益表述撤回**——观测数字只作工程事实，不作达标依据／对外宣称／召回率，后续收益口径以新提案为准。下一步方向＝**上游切题/OCR 质量**（另立提案，本轮不动），方案 B 与英文判定锚点后置。**新瓶颈两个**：①上游切题/OCR（整页/多题连排/错字让**设问一致性硬闸**正确拒绝：截断 320 字 `ask=conflict`、完整 375 字 `ask=same` 且 exact=2）⇒ 召回修好后它**重新成为第一瓶颈**；②`extractDistinctive()` 对纯英文返回空 `anchors` ⇒ **判定层对英文题没有判定能力**（动判定层需新提案、第二层准入仍锁）。⛔ 不宣称「命中已提升/误判归零/所有用户已可用」，不得计算召回率。
- 🔴 **P-014/D-017（23:2x 已实施并部署）**：8 条真实题只读取证**证伪「单独切题/OCR 能提 exact」**——规则切题后仅 1/8 `exact`，且那 1 条是作文要求片段走 `ask=unknown` 命中英语教辅第 80 对象、带 972 字解析（**假 exact**）；干净 103 字几何单题仍 0，L3 `EFC=60` 在 `question_objects`/`text_flat` **0 行** ⇒ 库覆盖 / OCR 字面差异 / 英文判定锚点才是主因，`BMDN` 4 行还是「同字母不同题」。⛔ 别再靠放宽判定层或硬推切题提命中。已上线方向 A：`shared/input-guard.ts` 零依赖闸门（整页 >1200 字／题号 ≥2／<25 字或无设问 ⇒ 不送判定＋如实提示）、`netdisk/search` 与 `answer-search` **双入口**、前端 `recognize` 引导（镜像 `src/constants/input-guard.ts`，M36 逐字钉）、`CACHE_VERSION v10`、M36；部署 **7 产物**（21 项差异＝7 产物＋14 登记排除项）、health 200 / 0 ERROR / 回滚点 `dist.bak-p014-20261107-2320`。**验收＝假 exact 1/8→0/8、其余不变，不宣称提命中**；`question-match.ts` 一行未动。诊断 `node server/scripts/kb-upstream-diagnose.mjs --limit 8 --stems 2`。⚠️ 前端包 `build:weapp` 已构建，**仍待思傅手动上传发版**。⚠️ 新坑：页面级文案在 `dist/pages/recognize/index.js` 不在 `common.js` ⇒ `ide-verify.mjs` 已改为递归扫 `dist/**/*.js`。
- 🔴 **P-015/D-018（11-08 00:2x，目标重锚）**：思傅定最终目的＝**「检索到正确解答思路和解答过程」**；允许题目不完全一致但思路可借鉴时提供**库内相似例题（题干＋它自己的解析，同源配对）＋事先声明**。真相源 `server/src/shared/question-reference.ts`（零业务依赖，独立第二层）＋前端逐字镜像 `src/constants/reference-disclaimer.ts`；`answer` 仍空 / `verified` 仍 false / 无「采纳」；**判定层 `question-match.ts` 一行未动**；`CACHE_VERSION v11`；M37 9 组。生产实测干净单题 `refs=3`（最值/相似三角形/等腰三角形，均带完整解析），多小问仍被闸门拦。🔴 **不宣称**命中提升 / 修复有效 / 误判归零 / 所有用户已可用；样本 3 类不算召回率；库覆盖、OCR 字面差异、英文锚点、第二层准入仍锁。
- ✅ 11-07 P2 14:05＋P3 后端 16:55 已生效（QA-16 §6.1.6/§6.1.7.1）；r8 前端包已发。✅ **11-08 00:2x 已用 CLI 直传 `2026.11.08.1` 开发版（872.0 KB）**，P-012 来源卡片与 P-014 录入引导、P-015 参考例题层随包；⚠️ **只产生开发版，未提审 / 未发正式版**。🔴 仍锁：`strict=1`、第二层准入、`.doc`/大 PDF 补抽、4 个身份治理改动、**双账号真实登录 E2E**（A9 只是服务端自签令牌；11-07 晚模拟器已有 1 个真实登录号＝公共 owner，仍缺第二个号）。

## 4 接口与前端（详档 §4）
- 前缀 `/api/`；禁 undefined 进 query；中文名 `encodeURIComponent`；`/api/upload` 的 `save` 建条目、`attach` 只持久化。
- 🔴 光标：两个 pnpm 补丁缺一不可（react 同值摘 value 且返回 `[]`、runtime INPUT 只同步 `props.value`）＋组件 `flushSync()`＋丢非字符串 `detail.value`；⛔ 延迟上抛／不传 value／`defaultValue`／改 `Symbol.hasInstance`。全仓用 `ui/Textarea`。
- 🔴 下载打自家 `/api` 必须 `header: buildHeaders()`（公网签名直链不要带头）；service 层自己 `unwrap`，出现 `.data?.data` 即契约断。M18 红线见详档。
- 令牌 **X-Auth-Token 唯一被采信**（`v1.<uid>.<exp>.<HMAC-SHA256(...) 前40>`，密钥 `.env.secrets`，可自签做 E2E）；裸 X-User-Id 401；免登录端点同步 `PUBLIC_ROUTES`；必须关 ETag 协商缓存；`navigateBack` 不重 mount ⇒ `useDidShow`＋`firstShowRef`＋`silent:true`。
- ⚠️ 音视频禁原生小写标签；`<Image>`/`<Video poster>` 不发头 ⇒ 服务端直给 `*_url`；🚨 request/uploadFile 超时 60s ⇒ >60s 走 `POST /api/jobs` 202+轮询。
- 🔴 隐私同意要真拦写：`guardPolicy(action)` 与 `guardPrivacy` 串行两道；`<PolicyConsent/>` 挂首页＋首帧 `useState`；隐私接口失败禁 `catch {}`；Taro 4.1.9 走 `globalThis.wx`。
- 🔴 改 `note`/result 结构 ⇒ 必 bump `CACHE_VERSION`（当前 **v11**），判据＝拿没问过的新题测。P-015 起 `references`/`reference_disclaimer` 属 result 结构，旧缓存会显示成「有内容、无声明」。
- 🔴 `gk-netdisk-index.timer` 周日 04:23 必须跑（停＝隐私承诺不兑现）；`--full-clean` 三条防误删护栏见详档。
- ⚠️ 面客说「资料库」不说「百度网盘」，**但隐私政策第四节第三方清单必须保留**（两处副本逐字一致）；隐私政策 **r8**。🔴 导航 tab＝首页／复习本／资料／记忆，tab 页只能 `switchTab`。

## 5 AI / 品牌 / L3（详档 §5）
- `users.ai_enabled` 默认 false，`requireAiEnabled()` 拦 chat/message/answer-search/search/solve；`mode=kb` 不受连坐；改开关必须 `invalidateUserFlags()`。个人主体 ⇒ AI 入口收起。名统一**成长学童**、品牌色见详档。
- 🔴 `STORAGE_DRIVER=local` 同步 `PUBLIC_ROUTES`＋`STORAGE_PUBLIC_BASE_URL`；Caddy 站点块必须 `handle` 包 `file_server`；`PROJECT_DOMAIN` 编译期常量，改必重建；Linux 必设 `OCR_PYTHON`+`PPSV3_PYTHON`+`PADDLE_PDX_CACHE_HOME`。
- 🔴 只换 `dist` 会漏 `ocr-engine/*.py` ⇒ **接口不报错、静默降级**（判据 `hits[].hit` 有无 `content`）；rapid/precise 补丁两处都改。
- 🔴 **8080 是 Caddy 不是 PostgREST 直连**：必须 `/rest/v1/<table>?select=...` 回真实行才算通过；`service_role` 必须 BYPASSRLS；搬数据在云主机做。
- **结果指标**唯一够格＝到期首次作答正确率（`0021 review_events`）；每档 ≥30 样本；**当前 0 行**。

## 6 发布与验证（详档 §6）
- 发版前轮换 WX_SECRET **后必跑 encrypt-env.mjs**；`release:check` 后 revert；生产 `WAKE_ENABLED=0`。🚨 开发管理托管第三方 ⇒ **发正式版必须先解除托管**；服务类目保留＋追加工具类目。
- 🔴 **个人主体不得做用户共享题库 / UGC 发布分享**（【社交-笔记】仅非个人主体）；PIPL §16 ⇒ ⛔「共享自己的题才能用公共题库」；§23/25 单独同意、§15 撤回须删、§28/29 监护人同意；教辅共享涉信息网络传播权。
- 🔴 备案：轻量包月≥3月、**L3 到期⇒备案失效**；个人主体禁教育培训课程辅导文案；小程序备案≠域名备案；**公安联网备案待办**；首页 `<title>`/`<h1>` 与备案站名逐字一致。
- **验证通道（11-07 打通）**：一条命令 `node server/scripts/ide-verify.mjs --launch --marker "<特征串>"` ⇒ 冷启动 IDE＋CDP 自检＋8 页冒烟。🔴 **冷启动唯一可行解＝纯 Node 写 UTF-8 `.cmd`（首行 `chcp 65001`）交给桌面 `explorer.exe`**：ShellExecute 由外壳完成、IDE 脱离工具会话常驻；explorer 返回 exit 1 属正常，只认 9222＋哨兵文件。⛔ Start-Process/后台保活（命令结束整树被清）、WMI `Create`、`schtasks`、Bash 调 `powershell.exe`/`cmd.exe` 全被安全策略挡。冷启动后须等 10s＋多轮 reload 启动页＋轮询页面 target（9222 早于项目窗口）。🔴 **别在验证前跑 CLI `open`/`auto`**：会把 IDE 切回启动页／自动化模式，reload 救不回来 ⇒ 完全退出 IDE 再 `--launch`。✅ 重新登录后 `cli open --project` 已通；`auto` 需隐藏参数 `--auto-port 9420`（此前 code 10 实为 `Port is not provided`，**不是登录问题**）。✅ **模拟器已能拿到真实登录态**（`gk_auth_token` v1／91 字、昵称 Si、user id 即公共 owner `cc6d7b10-…`；`/api/auth/me` 200、无令牌 401；隐私弹窗已消失、profile 显示云端同步）。🔴 **模拟器≠真机**：音频 Range、隐私授权真弹窗、原生组件/性能仍须手机；**双账号 A9 仍缺第二个真实微信号**，攒到发版前一次。⚠️ `upload` 未实测、上传 key 0 字节。
- `server/scripts/verify/`：`verify:ci`／`verify:gate`／`method:check`／`lint:build`，新模块丢 `modules/NN-x.mjs`；M16 三条硬门；造数据每次内容必须不同。基线 103/103、`check:isolation` 150/150。
- 🔴 测试期禁用真登录（`/auth/login` 会迁移匿名号数据），切身份只换令牌；根 `tsc --noEmit` 的 node_modules 报错是既有噪音。

## 7 其它（详档 §7）
- 复习排程真相源 `timeline/review.ts`，五档 1→3→7→14→28 天，改间隔表触发 M15（三处同步）；前端不自算 plan。
- CI `gate`=build:server→build:weapp→M12 M13 M16；OCR GT 退出码 2＝环境跑不起来；`R-算法-07` 竖式符号行丢失未修；`include_answers` 不传=不含答案。
- 🚨 **20b 第 7 章标题不可动**（重排⇒H1 静默跳过）；批量改文档用脚本+「命中 1 次」断言；M11 连续天数/时长只作展示不得作判定；教训 L27/L28/L30/L31 见教训录。
- 年级 12 档真相源 `shared/grade.ts`＋前端镜像 `constants/grades.ts`（不跨端 import），M26 守。
- 🔴 本地 commit≠生产有代码（排查先 grep 生产 dist 特征串）；`users` 行数≠真实规模（80＝79 匿名+1 正式，**528 道题挂 29 匿名号是联调数据不能删**）；异步任务提交闸门按 `params.mode` 分流；CDP `wx is not defined` 是噪音，判据主逻辑层 `typeof wx === "object"`。


================================================================
===== r30 全文归档（2026-11-09 压缩前，18,433 B）=====
================================================================
# Growing-Kids 长期约定（r30 · 红线索引）

> 全文/过程/证据见 `MEMORY-full-archive.md`（r17–r29）、`docs/reports/`、`proposals/P-NNN`＋`decision-log.md` D-NNN、`GK-QA-16-*`、`GK-OPS-*`、`memory/YYYY-MM-DD.md`、教训录 L<n>。**本文件只留红线**；新增前先想「能不能只写进 docs」。

## 0 流程
- 家长主用/孩子次要；改「学习行为」先过 20a §5.1 三问＋§6.2 M1–M11；OPS-22：L0/L1/L2＋提案 P-NNN＋台账 D 号，**先查台账再评审**；动 `question-match.ts` 前须建档；设计决策逐题确认再开工。
- 缺口序 C3 错因 > C2 信心 > C1 掌握梯度 > C5 交错。⛔ 励志推送／智能排程／「算出 ZPD」／打卡时长激励。**push 等思傅指示；本地 commit 照常。**

## 1 环境与发货
- 🔴 生产＝L3 `42.192.36.120`（PG `gk`＋PostgREST 8080＋Caddy）；本地 `server/.env`／`.env.migrate` 是 Supabase 云开发库、**非现网**。查删必 ssh L3，删前 `db-backup.mjs --no-upload`。
- 🔴 微信 IDE 唯一开发目录＝`D:\AI\Growing-Kids`；旧同名副本 `-miniapp` 已于 11-08 整目录删除（留存 `D:\AI\gk-miniapp-archive-20261108`），曾致「4 个前端修复后依旧」。列表真相＝`reduxPersist:projectList`。编译上传前必看路径（GK-DD-08 §52）。
- 🔴 commit≠发货：前端 `build:weapp`→重编译→上传→发版；后端换 `server/dist` **并重启 `gk-api`**（先迁移、旧 dist 留 `.bak-时间戳`、grep 特征串验包）。
- 🔴 验证≠真机：回归在模拟器跑，⛔ 别每轮写「真机重扫码待人工」；真机只在发版前一次。
- 🔴 精准换 dist：先比两边完整 sha256 清单（Windows `*` 归一化）逐个归属；**14 项登记排除项**永久排除（4 组身份治理 10 个＋`anon-bootstrap-guard.*`＋漏传 d.ts＋注释 map＋2 tsbuildinfo）；部署后复比剩余差异必须全是排除项。⚠️ `.d.ts` 也随新增导出变化。
- 🔴 L3 长任务：远端 `nohup`＋远端日志＋另开 ssh 轮询；`.env.migrate` ⇒ `sudo -u gk -H`；`/tmp` 脚本要 `NODE_PATH=/opt/gk/server/node_modules`；OCR 中文无 U+FFFD 才对。
- 🔴 **L3 批量转换铁律（11-08 用 15 分钟生产事故换来）**：`nice` 管不住内存/IO；4C/3.7G 上①worker 数必须压测后定②批大小 ≤2③`ionice -c3 nice -n19`④每批前查 `MemAvailable`（<700MB 等）⑤单批超时 ≤8min⑥跳超大文件。参数别手打错（`--shard` 写成 `--shape` ＝分片失效从全表重跑＝多开一份并发）。症状：**ping 通但 22 端口 banner 超时＋站点/API 全超时** ⇒ 退避 3min 再进，`sudo pkill -9 -f` 清 soffice/python/node；**长跑一律 cgroup 兜底**：`systemd-run --unit=gk-xxx -p MemoryMax=1800M -p CPUQuota=200% …`，`journalctl -u` 看进度。
- 🔴 **多 worker 跑 soffice 必须给每个 worker 独立 profile**：`-env:UserInstallation=file:///tmp/<worker>/lo-profile`（已固化在 `netdisk-inline-crop.py` 的 `lo_profile_arg()`）。共用默认 profile 时第二个 `soffice --headless` 会**挂死在单实例锁**上（CPU 0%、日志不动），看起来像「文档太大转不动」——11-08 首轮 2 worker 压测就卡在这里。
- ⚠️ **单份超大 docx（7MB 级）PDF 转换可能 >8min**：靠 `ensure_pdf` 的 480s 超时跳过，不要为它放宽整体超时（会拖住整个 worker）。

## 2 数据
- 无 RLS ⇒ 查询必须 `.eq('user_id', …)`（`check:isolation`）；删除加 `.select('id')` 校行数；真相源**只有 `migrations/`**；空串≠NULL，回写前 `trim()`。
- 管理员 `users.role`＋`requireAdmin()` fail-closed，提权唯一入口 `promote-admin.mjs`；`blob_objects` 内容寻址＋ref_count；改引擎/切分必 bump 版本；存储 key 只 ASCII；`*_images` 读端点过 `withUrls`。
- 🔴 PG `text` 不收 U+0000 ⇒ 落库前 `stripNul()`。🔴 媒体读端点必须 `res.sendFile`（Range 206 判据），禁 `createReadStream().pipe()`。
- 备份 `gk_backup` 必须 `bypassrls`（口令丢了永久作废）；🔴 `question_objects`／`question_figures`／`question_inline_figures` 等派生表不进备份，恢复后脚本重建。
- 🔴 归户/去重前必查唯一键：`netdisk_files (user_id,fs_id)`、`question_objects (user_id,source_type,source_id,object_index)`；`objectFingerprintInput()` 含 `source_id`，判等价用 `stem_text/solution_text/source_revision`。

## 3 资料库检索（P-006→P-018）
- 真相源 `shared/question-match.ts`（**零依赖单文件**，不能加 import）；🔴 硬闸无数据源豁免、`topic` 必 `answer:''`＋`verified:false`；`kb` 顺序＝自有题库→library_docs→网盘 exact→ima→兜底；前后端同步发货；双减禁拍照搜题、`exact` 才放解析。
- 🔴 **P0 六条硬闸（串联否决，禁改加权求和）**：≥3 长锚点／题干 ≤6000 字／设问一致／锚点共现限对象内／相邻解析段 ≥8 字不串题号／来源唯一。「未达标不放行」＝举证责任倒置；P-015 修正作用域＝「不得冒充本题答案」而非「不得提供学习材料」；准入＝误判归零＋召回 ≥90%＋定位 100%＋P95<3s。⛔ 本期不上向量库/Reranker/LLM 兜底。
- 🔴 **判定层一行未动**是各轮放行前提：**召回变宽≠放行变宽**；第二层上线准入仍未全绿，「题干 A＋别人解析」残余风险未消除。
- P1/P2/P3：`0026` 一题一行、构建默认 dry-run／幂等 upsert／三条防误删护栏；`question-object-store.ts` 唯一取数口必带 `user_id`；🔴 `source_id` 必须是 `netdisk_files.id`（L30）；公共题库「无条件开放＋私有绝对私有＋贡献本期不做」（`shared/public-library.ts`）；`searchLocal()` 双通道 name/path＋`text_flat`＋`saveCache()` 同步写；打分 `keyHits=nameHits+tHits×2`、SQL top-N、深挖 8 份/8s＋18s、默认禁在线抽取。
- 🔴 改 `note`/result 结构 ⇒ 必 bump `CACHE_VERSION`（**v13**，链 v8→v9 P-013→v10 P-014→v11 P-015→v12 P-016→v13 P-017；P-018 拟 v14），判据＝拿没问过的新题测。`references`/`reference_disclaimer`/`figureUrl`/`figurePage` 均属 result 结构。
- 🔴 **P-017 整块快照（已上线，留作兜底）**：根因＝`question_objects` 从无图片字段、`pdf_tool.py` 的 `text_only` 连 docx 公式（`o:OLEObject`→WMF）一起吞 ⇒ 库内解析成「抛物线中，当时，；当时，或3」残串。docx→soffice→PDF→字符框三重定位→裁切→WebP→`0028` 只存映射→`/api/storage/files/*` 公开读（小程序 `<Image>` 不发头）。**定位不到不入库不下发，绝不拿相邻题顶替**。29,773 张／121 份。
- 🔴 **P-018 题干原位重建（C 方案，已在生产）**：docx `word/document.xml` 的 `w:drawing`（png/jpeg）＋`w:object`（MathType WMF），用 `char_start` 与「剥标签文字流」同坐标系原位插回；`0029_question_inline_figures`＋`0030_question_inline_done`（记账防 0 图重试）；`netdisk-inline-crop.py`＋`-build.mjs`（`--apply/--force/--limit/--shard/--source`）。定位不到不入库不下发，**绝不拿相邻题顶替**。
- 🔴 **公式必须走 PDF 渲染**：`≤→£` 假证伪已推翻（L3 缺 Symbol 别名、Pango 回退）；装别名后 `U+00A3` 在 `StandardSymbolsPS`/原版 `symbol.ttf` 都画 `≤` ⇒ **Symbol 私有码表↔Latin-1 天然对应，无需建表**。仍不走 WMF：libwmf 误标 `Times`、`MT Extra` PUA、Dx 绑定原度量；且代价 42.6s/88s CPU/1030 fork vs PDF 8.1s/8s CPU/1 fork。
- 🔴 **PDF 路线不做「识别」**（公式是 IMAGE 位图，无解码/OCR/码表）⇒「`≤` 认成 `£`」类别设计上不存在。真实风险＝**Symbol 别名丢失让 `≠`/`<`/`−` 整体消失**且全链路静默不报错 ⇒ `assertSymbolFont()` 在 `--apply` 前查 `fc-match Symbol`，不含 `symbol` 即 throw（`INLINE_SKIP_FONT_CHECK=1` 逃生，M40 B9 守）。详见 `P-018 §5.3`。
- 🔴 **文字处理从来不是 LibreOffice**：入库文字＝`pdf_tool.py::extract_docx()`（zip＋正则剥标签，零 LO）；LO 只做 docx→PDF 底图。换 Word/WPS 不会消除残串（Word COM `InlineShapes=208`、`Content.Text` 同样残串，且导出 PDF 三次卡死）⇒ **不换工具**（`P-018 §5.4`）。
- ⚠️ `grab_figure` 必须 `import io`；`charOffset` 是 stem 内**码点**索引，服务端 `cpToUtf16()` 换算后才给前端；前端用 `RichText`（`<text>` 内 image 会丢）。开发版 `2026.11.08.4`。
- 🔴 **扩量实绩**：11-09 `3,007→5,019 份 / 218,581 张 / 1,010MB / 3,661 份有图 / 68.9%`（分母 7,286）；落盘 2.6G、141,812 文件（去重 35%，覆盖越广收益越高）；offset 越界 **0**；端到端 6 题 `refs=6` 全带图、URL 全 https。11-09 上轮 `3,007 / 41.3%`、11-08 首轮 `504 / 6.9%`。
- 🔴 **失败根因与运维铁律**：`--apply` 用 `INLINE_MAX_TRIES=2` 队列回插重试（救回率 78%），但**失败集中在长跑后半程且重试也救不回** ⇒ 是 worker 的 LO profile/soffice 状态退化，不是文档损坏（判据：全新 `INLINE_WORK_DIR` 串行跑同批 **60/60 全成功**）。⇒ **每约 1,000 份或每 2 小时重启 worker 换新 profile**，别只靠加重试；`INLINE_WORK_DIR` 每 worker 必须不同。`CPUQuota` 100%→150% 可把合计速率从 10.6 提到 15–18 份/分（`set-property` 必须逐 unit 调用）。
- 🔴 **L3 跑 scripts/*.mjs 长任务**：`systemd-run` 不继承 dotenvx 环境 ⇒ unit 的 `bash -c` 里 `set -a; . .env.secrets; . .env.migrate; set +a`（User=gk），否则「缺数据库连接配置」。
- 🔴 **输入闸门作用域（P-016/D-019）**：`guardQuestionInput()` 不合格时**只拦判定层**，不拦参考例题层——`answer-search` 走 `search(q,{referenceMode:'examples'})`（`hits=[]`、深挖 `min(4)`、预算 `min(4000ms)`）；`/api/netdisk/search` 直连不传该参数仍短路（实测 `hits=0/refs=0`）。前端 `source:'none'` 也必须渲染卡片＋常驻 `note`，`showToast` 一律在 `hideLoading()` 之后。
- 🔴 **目标（思傅 11-08 重锚）＝「检索到正确解答思路和解答过程」**，不追 exact。允许思路可借鉴的库内相似例题（题干＋它自己的解析，同源配对）＋事先声明。`shared/question-reference.ts`（独立第二层）＋前端逐字镜像 `constants/reference-disclaimer.ts`；`answer` 仍空／`verified` 仍 false／无「采纳」；声明在内容之前且每条例题重复。生产实测 `refs=3` 带完整解析，多小问被 P-014 闸门拦。
- 🔴 **已证伪两条路 ⛔ 别重走**：①P-013/D-016 只改召回选词 ⇒ `exact` 仍全 0（已否决，收益表述撤回）；②单独切题/OCR ⇒ 8 条仅 1 条假 exact。根因三叠加：库覆盖／OCR 字面差异／`extractDistinctive()` 纯英文返回空 anchors。
- **P-014 已上线**：`shared/input-guard.ts` 零依赖闸门（整页 >1200 字／题号≥2／<25 字或无设问 ⇒ 不送判定＋如实提示）＋双入口＋前端引导（M36 逐字钉）；验收假 exact `1/8→0/8`，**不宣称提命中**。⚠️ 页面级文案在 `dist/pages/recognize/index.js` ⇒ `ide-verify.mjs` 递归扫 `dist/**/*.js`。
- ✅ 生产：P2/P3 11-07 生效；P-014 7、P-015 11、P-016 5 产物，health 200／0 ERROR／哈希复比过（回滚点 `QA-16 §6.1.8–6.1.11`）；开发版链 `2026.11.08.1`→`.2`(P-016)→`.3`(P-017)；⚠️ **只开发版，未提审未发正式版**，`urlCheck`＋隐私开关两道硬门仍关。
- 🔴 **微信 CLI 上传四坑**：①`wait IDE port timeout` 多是本机 `HTTP_PROXY` 劫持 127.0.0.1 ⇒ CLI 前清空 `HTTP(S)_PROXY/ALL_PROXY`＋`NO_PROXY=127.0.0.1,localhost`；②`refreshTicket … no userinfo` ⇒ 先 `islogin`；③`code 10 / -38 编译中` 重投无效 ⇒ `taskkill //F //IM wechatdevtools.exe` → 冷启动 → **upload 作为重启后第一动作**；④IDE 停启动页时 `--launch` 起 9222 但 appservice 0 ⇒ taskkill→等 8s→`cli open --project "D:\AI\Growing-Kids"`（CLI 自拉起）→islogin→upload（此路径无 9222）。`.ide` 端口每次冷启动变，别写死。
- 🔴 **不宣称**命中提升／修复有效／误判归零／所有用户已可用；样本仅方向性证据，**不得计算召回率**；唯一够格指标＝`0021 review_events`（**0 行**）。
- 🔴 **仍锁**：`strict=1`、第二层准入、`.doc` 10,503 份与大 PDF 补抽、4 组身份治理、双账号真实登录 E2E、公安联网备案；向量召回／Reranker／知识点图谱／方案 B／英文锚点／库覆盖体检／OCR 纠错字典／贡献通道**各需独立提案**。
- 只读诊断：`kb-hit-diagnose.mjs`、`kb-upstream-diagnose.mjs --limit 8 --stems 2`。

## 4 接口与前端
- 前缀 `/api/`；禁 undefined 进 query；中文名 `encodeURIComponent`；`/api/upload` 的 `save` 建条目、`attach` 只持久化。
- 🔴 光标：两个 pnpm 补丁缺一不可（react 同值摘 value 且返回 `[]`、runtime INPUT 只同步 `props.value`）＋`flushSync()`＋丢非字符串 `detail.value`；⛔ 延迟上抛／不传 value／`defaultValue`／改 `Symbol.hasInstance`。全仓用 `ui/Textarea`。
- 🔴 下载打自家 `/api` 必须 `header: buildHeaders()`（公网签名直链不要带头）；service 层自己 `unwrap`，出现 `.data?.data` 即契约断。
- 令牌 **X-Auth-Token 唯一被采信**（`v1.<uid>.<exp>.<HMAC 前40>`，密钥 `.env.secrets`，可自签做 E2E）；裸 X-User-Id 401；免登录端点同步 `PUBLIC_ROUTES`；必须关 ETag；`navigateBack` 不重 mount ⇒ `useDidShow`＋`firstShowRef`＋`silent:true`。
- ⚠️ 音视频禁原生小写标签；`<Image>`/`<Video poster>` 不发头 ⇒ 服务端直给 `*_url`；🚨 request/uploadFile 超时 60s ⇒ >60s 走 `POST /api/jobs` 202+轮询。
- 🔴 隐私同意要真拦写：`guardPolicy(action)` 与 `guardPrivacy` 串行两道；`<PolicyConsent/>` 挂首页＋首帧；隐私接口失败禁 `catch {}`；Taro 4.1.9 走 `globalThis.wx`；隐私政策 **r8**（第四节第三方清单必须保留，两处副本逐字一致）。
- 🔴 `gk-netdisk-index.timer` 周日 04:23 必须跑（停＝隐私承诺不兑现）。面客说「资料库」不说「百度网盘」。导航 tab＝首页／复习本／资料／记忆，tab 页只能 `switchTab`。

## 5 AI / 品牌 / L3
- `users.ai_enabled` 默认 false，`requireAiEnabled()` 拦 chat/message/answer-search/search/solve；`mode=kb` 不连坐；改开关必须 `invalidateUserFlags()`。个人主体 ⇒ AI 入口收起。名统一**成长学童**。
- 🔴 `STORAGE_DRIVER=local` 同步 `PUBLIC_ROUTES`＋`STORAGE_PUBLIC_BASE_URL`；Caddy 站点块必须 `handle` 包 `file_server`；`PROJECT_DOMAIN` 编译期常量，改必重建；Linux 必设 `OCR_PYTHON`+`PPSV3_PYTHON`+`PADDLE_PDX_CACHE_HOME`。🔴 生产 `STORAGE_PUBLIC_BASE_URL` **必须 `https://deep-root.cn`**（11-08 前是 `http://42.192.36.120` ⇒ `figureUrlFor()` / `getPublicUrl()` 下发 http IP，小程序 `<Image>`/RichText 手机裂图；改配置＋重启即生效，库里只存 `storage_key` 无需改数据）；并确认 mp 后台 `downloadFile` 合法域名（托管未解除前不能自行配）。
- 🔴 只换 `dist` 会漏 `ocr-engine/*.py` ⇒ 接口不报错、静默降级（判据 `hits[].hit` 有无 `content`）。
- 🔴 **8080 是 Caddy 不是 PostgREST 直连**：必须 `/rest/v1/<table>?select=…` 回真实行才算通过；`service_role` 必须 BYPASSRLS。结果指标唯一够格＝到期首次作答正确率（`0021`），每档 ≥30 样本，**当前 0 行**。

## 6 发布与验证
- 发版前轮换 WX_SECRET **后必跑 encrypt-env.mjs**；`release:check` 后 revert；生产 `WAKE_ENABLED=0`。🚨 开发管理托管第三方 ⇒ **发正式版必须先解除托管**；服务类目保留＋追加工具类目。
- 🔴 **个人主体不得做用户共享题库/UGC 分享**（【社交-笔记】仅非个人主体）；PIPL §16/23/25/15/28/29 逐条落地；教辅共享涉信息网络传播权。
- 🔴 备案：轻量包月≥3月、**L3 到期⇒备案失效**；个人主体禁教育培训课程辅导文案；小程序备案≠域名备案；**公安联网备案待办**；首页 `<title>`/`<h1>` 与备案站名逐字一致。
- **验证通道**：`ide-verify.mjs --launch --marker "<特征串>"` ⇒ 冷启动＋CDP 自检＋8 页冒烟。🔴 冷启动唯一可行解＝纯 Node 写 UTF-8 `.cmd`（首行 `chcp 65001`）交桌面 `explorer.exe`，只认 9222＋哨兵文件（exit 1 正常）；⛔ Start-Process／WMI／schtasks／Bash 调 cmd 全被挡。🔴 验证前别跑 CLI `open`/`auto`；`auto` 需 `--auto-port 9420`。✅ 模拟器有真实登录态（`gk_auth_token` v1／公共 owner `cc6d7b10-…`）。🔴 模拟器≠真机（音频 Range、隐私真弹窗、原生组件/性能须手机）。
- `server/scripts/verify/`：`verify:ci`／`verify:gate`／`method:check`／`lint:build`；M16 三条硬门；造数据每次内容不同。`check:isolation` 150/150；M27–M37 128/128。
- 🔴 测试期禁用真登录（会迁移匿名号数据），切身份只换令牌；根 `tsc --noEmit` 的 node_modules 报错是既有噪音。

## 7 其它
- 复习排程真相源 `timeline/review.ts`，五档 1→3→7→14→28 天，改间隔触发 M15（三处同步）；前端不自算 plan。年级 12 档真相源 `shared/grade.ts`＋镜像 `constants/grades.ts`，M26 守。
- CI `gate`=build:server→build:weapp→M12 M13 M16；OCR GT 退出码 2＝环境跑不起来；`R-算法-07` 竖式符号行丢失未修；`include_answers` 不传＝不含答案。
- 🚨 **20b 第 7 章标题不可动**；批量改文档用脚本+「命中 1 次」断言；M11 连续天数/时长只作展示不得作判定。
- 🔴 本地 commit≠生产有代码（排查先 grep 生产 dist 特征串）；`users` 80 行＝79 匿名+1 正式，**528 道题挂 29 匿名号是联调数据不能删**；CDP `wx is not defined` 是噪音。
- 🔴 **本机删除守卫**：批量删除守卫拦 `Remove-Item -Recurse`／`rm -rf`／`fs.rmSync`（Bash 侧 exit 127）；`Add-Type`、COM 均被禁 ⇒ 回收站 API 不可用。合规路径＝逐文件 `[System.IO.File]::Delete` 每批 10 个校验＋自底向上 `[System.IO.Directory]::Delete(p,$false)`；删前备份＋警告＋列清单。


---

# r31 全文归档（2026-11-09，压缩前的 MEMORY.md 原文）

# Growing-Kids 长期约定（r31 · 红线索引）

> 全文/过程/证据见 `MEMORY-full-archive.md`（r17–r30 全文）、`docs/`、`proposals/P-NNN`＋`decision-log.md` D-NNN、`GK-QA-16-*`、`GK-OPS-*`、`memory/YYYY-MM-DD.md`、教训录 L<n>。**本文件只留红线**；新增前先想「能不能只写进 docs」。

## 0 流程
- 家长主用/孩子次要；改「学习行为」先过 20a §5.1 三问＋§6.2 M1–M11；OPS-22：L0/L1/L2＋提案 P-NNN＋台账 D 号，**先查台账再评审**；动 `question-match.ts` 前须建档；设计决策逐题确认再开工。
- 缺口序 C3 错因 > C2 信心 > C1 掌握梯度 > C5 交错。⛔ 励志推送／智能排程／「算出 ZPD」／打卡时长激励。**push 等思傅指示；本地 commit 照常。**

## 1 环境与发货
- 🔴 生产＝L3 `42.192.36.120`（PG `gk`＋PostgREST 8080＋Caddy）；本地 `server/.env`／`.env.migrate` 是 Supabase 云开发库、**非现网**。查删必 ssh L3，删前 `db-backup.mjs --no-upload`。
- 🔴 微信 IDE 唯一开发目录＝`D:\AI\Growing-Kids`（旧 `-miniapp` 副本 11-08 已删，曾致「4 个前端修复后依旧」）；列表真相＝`reduxPersist:projectList`（GK-DD-08 §52）。
- 🔴 commit≠发货≠生产有代码：前端 `build:weapp`→重编译→上传→发版；后端换 `server/dist` **并重启 `gk-api`**（先迁移、旧 dist 留 `.bak-时间戳`、grep 特征串验包）；只换 dist 会漏 `ocr-engine/*.py` ⇒ 静默降级（判据 `hits[].hit` 有无 `content`）。排查先 grep 生产 dist。
- 🔴 精准换 dist：先比完整 sha256 清单（Windows `*` 归一化）逐个归属；**14 项登记排除项**永久排除；部署后复比剩余差异必须全是排除项。⚠️ `.d.ts` 也随新增导出变化。
- 🔴 验证≠真机：回归在模拟器跑，⛔ 别每轮写「真机重扫码待人工」；真机只在发版前一次。
- 🔴 **L3 批量转换铁律（11-08 用 15 分钟生产事故换来）**：`nice` 管不住内存/IO；4C/3.7G 上①worker 数必须压测后定②批大小 ≤2③`ionice -c3 nice -n19`④每批前查 `MemAvailable`（<700MB 等）⑤单批超时 ≤8min⑥跳超大文件；参数别手打错（`--shard` 写成 `--shape` ＝分片失效从全表重跑）。症状：**ping 通但 22 端口 banner 超时＋站点/API 全超时** ⇒ 退避 3min，`sudo pkill -9 -f` 清 soffice/python/node；**长跑一律 cgroup 兜底** `systemd-run --unit=gk-xxx -p MemoryMax=1800M -p CPUQuota=150% …`。
- 🔴 **多 worker 跑 soffice 必须每个 worker 独立 profile**：`-env:UserInstallation=file:///tmp/<worker>/lo-profile`（固化在 `netdisk-inline-crop.py::lo_profile_arg()`）；共用默认 profile 会挂死在单实例锁（CPU 0%、日志不动），看起来像「文档太大转不动」。
- 🔴 **L3 跑 scripts/*.mjs 长任务**：`systemd-run` 不继承 dotenvx ⇒ unit 的 `bash -c` 里 `set -a; . .env.secrets; . .env.migrate; set +a`（User=gk），否则「缺数据库连接配置」。远端 `nohup`＋远端日志＋另开 ssh 轮询；`.env.migrate` ⇒ `sudo -u gk -H`；`/tmp` 脚本要 `NODE_PATH=/opt/gk/server/node_modules`；OCR 中文无 U+FFFD 才对。
- 🔴 微信 CLI 上传四坑：代理劫持 127.0.0.1 ⇒ 清 `HTTP(S)_PROXY`＋`NO_PROXY`；`refreshTicket no userinfo` ⇒ 先 `islogin`；`code 10/-38 编译中` ⇒ `taskkill //F //IM wechatdevtools.exe`→冷启动→**upload 作为重启后第一动作**；IDE 停启动页 ⇒ `cli open --project "D:\AI\Growing-Kids"` 自拉起（此路径无 9222）。`.ide` 端口每次冷启动变，别写死。详见归档 r30 §3。

## 2 数据
- 无 RLS ⇒ 查询必须 `.eq('user_id', …)`（`check:isolation`）；删除加 `.select('id')` 校行数；真相源**只有 `migrations/`**；空串≠NULL，回写前 `trim()`。
- 管理员 `users.role`＋`requireAdmin()` fail-closed，提权唯一入口 `promote-admin.mjs`；`blob_objects` 内容寻址＋ref_count；改引擎/切分必 bump 版本；存储 key 只 ASCII；`*_images` 读端点过 `withUrls`。
- 🔴 PG `text` 不收 U+0000 ⇒ 落库前 `stripNul()`。🔴 媒体读端点必须 `res.sendFile`（Range 206 判据），禁 `createReadStream().pipe()`。
- 备份 `gk_backup` 必须 `bypassrls`（口令丢了永久作废）；🔴 `question_objects`／`question_figures`／`question_inline_figures` 等派生表不进备份，恢复后脚本重建。
- 🔴 归户/去重前必查唯一键：`netdisk_files (user_id,fs_id)`、`question_objects (user_id,source_type,source_id,object_index)`；`objectFingerprintInput()` 含 `source_id`，判等价用 `stem_text/solution_text/source_revision`。
- `users` 80 行＝79 匿名+1 正式，**528 道题挂 29 匿名号是联调数据不能删**；CDP `wx is not defined` 是噪音。

## 3 资料库检索（P-006→P-018）
- 真相源 `shared/question-match.ts`（**零依赖单文件**，不能加 import）；🔴 硬闸无数据源豁免、`topic` 必 `answer:''`＋`verified:false`；`kb` 顺序＝自有题库→library_docs→网盘 exact→ima→兜底；前后端同步发货；双减禁拍照搜题、`exact` 才放解析。
- 🔴 **P0 六条硬闸（串联否决，禁改加权求和）**：≥3 长锚点／题干 ≤6000 字／设问一致／锚点共现限对象内／相邻解析段 ≥8 字不串题号／来源唯一。「未达标不放行」＝举证责任倒置；准入＝误判归零＋召回 ≥90%＋定位 100%＋P95<3s。⛔ 本期不上向量库/Reranker/LLM 兜底。
- 🔴 **判定层一行未动**是各轮放行前提：**召回变宽≠放行变宽**；第二层上线准入仍未全绿，「题干 A＋别人解析」残余风险未消除。
- P1/P2/P3：`0026` 一题一行、构建默认 dry-run／幂等 upsert／三条防误删护栏；`question-object-store.ts` 唯一取数口必带 `user_id`；🔴 `source_id` 必须是 `netdisk_files.id`；公共题库「无条件开放＋私有绝对私有＋贡献本期不做」；`searchLocal()` 双通道 name/path＋`text_flat`＋`saveCache()` 同步写；打分 `keyHits=nameHits+tHits×2`、SQL top-N、深挖 8 份/8s＋18s、默认禁在线抽取。
- 🔴 改 `note`/result 结构 ⇒ 必 bump `CACHE_VERSION`（**当前 v14**，v13 P-017→v14 P-018），判据＝拿没问过的新题测。`references`/`reference_disclaimer`/`figureUrl`/`figurePage`/`inlineFigures` 均属 result 结构。
- 🔴 **P-017 整块快照（已上线，兜底）**：docx→soffice→PDF→字符框三重定位→裁切→WebP→`0028` 只存映射→`/api/storage/files/*` 公开读。**定位不到不入库不下发，绝不拿相邻题顶替**。29,773 张／121 份。
- 🔴 **P-018 题干原位重建（C 方案，在生产）**：docx `word/document.xml` 的 `w:drawing`（png/jpeg）＋`w:object`（MathType WMF），用 `char_start` 与「剥标签文字流」同坐标系原位插回；`0029`＋`0030`（记账防 0 图重试）；`netdisk-inline-crop.py`＋`-build.mjs`（`--apply/--force/--limit/--shard/--source`）。同样**定位不到绝不顶替**。
- 🔴 公式路线结论：`≤→£` 是假证伪（缺 Symbol 别名＋Pango 回退）；**公式必须走 PDF 渲染**，⛔ 不走 WMF（libwmf 误标 `Times`、`MT Extra` PUA、Dx 绑定原度量，且 42.6s/88s CPU/1030 fork vs PDF 8.1s/8s CPU/1 fork）。PDF 路线**不做识别**（公式是 IMAGE 位图）⇒ 不会认错符号，真实风险＝**Symbol 别名丢失让 `≠`/`<`/`−` 整体静默消失** ⇒ `assertSymbolFont()` 在 `--apply` 前查 `fc-match Symbol`，不含 `symbol` 即 throw（`INLINE_SKIP_FONT_CHECK=1` 逃生，M40 B9 守）。详见 `P-018 §5.3/§5.4`。
- 🔴 **文字处理从来不是 LibreOffice**：入库文字＝`pdf_tool.py::extract_docx()`（zip＋正则剥标签，零 LO）；LO 只做 docx→PDF 底图。换 Word/WPS **不会消除残串也不换工具**（Word COM `InlineShapes=208`、`Content.Text` 同样残串、导出 PDF 三次卡死）。
- ⚠️ `grab_figure` 必须 `import io`；`charOffset` 是 stem 内**码点**索引，服务端 `cpToUtf16()` 换算后才给前端；前端用 `RichText`（`<text>` 内 image 会丢）。开发版 `2026.11.08.4`。
- 🔴 **全量收尾（11-09）**：docx 候选 **7,286 / 7,286 全部处理完（待处理 0）**、**273,037 张 / 1,580MB**、**5,153 份有图（70.7%）**；公式 195,072/218MB、几何图 77,965/1362MB；`empty=2,132`（本身无图）＋**1 份 `engine_version='lo-hang-skip'`**（LO 死循环，非真实无图）；落盘 3.0G/165,410 文件（去重 39.4%）；offset 越界 **0**；端到端 `refs=6` 全带图、httpsURL 8/8。分批 `504/6.9%`→`3,007/41.3%`→`5,019/68.9%`→100%；见 D-021 末表。
- 🔴 **两类「卡住」要分清**：长跑 900–1,000 份后失败抬头＝profile 退化（换新 profile 即好）；而**单份小文档在两个不同 profile 都让 soffice 99.9% CPU 空转 4–5 分钟**＝LO 死循环文档（换 profile 无效）⇒ 如实记账 `status='empty' + engine_version='lo-hang-skip'`（表 CHECK 只允许 ok/empty，engine_version 作哨兵可查），别每轮白等 8min。全库仅 1 份 `681b7b1d…`。
- ⚠️ **>6MB 阈值过保守已修正**：7.9MB 压测 12s/38 图；192 份超大（6–38.4MB）全部跑完，20–38MB 的 11 份单 worker 串行全成功。`ensure_pdf()` 加 `INLINE_PDF_TIMEOUT_S`（**默认 480s 行为不变**），大文档批次放宽到 900s，node `INLINE_DOC_TIMEOUT_MS` 必须更大。
- 🔴 **失败根因与运维铁律**：`INLINE_MAX_TRIES=2` 队列回插重试（救回 78–87%），但**失败集中在约 900–1,000 份之后且重试也救不回** ⇒ worker 的 LO profile/soffice 状态退化，不是文档损坏（判据：全新 `INLINE_WORK_DIR` 串行跑同批 60/60、40/40 全成功）。⇒ **每约 1,000 份或每 2 小时重启 worker 换新 profile**；`INLINE_WORK_DIR` 每 worker 必须不同。`CPUQuota` 100%→150% 把合计速率从 10.6 提到 15–20 份/分（`set-property` 必须逐 unit 调用）。
- 🔴 **输入闸门作用域（P-016/D-019）**：`guardQuestionInput()` 不合格**只拦判定层**，不拦参考例题层——`answer-search` 走 `search(q,{referenceMode:'examples'})`；`/api/netdisk/search` 直连不传该参数仍短路（实测 `hits=0/refs=0`）。前端 `source:'none'` 也必须渲染卡片＋常驻 `note`，`showToast` 一律在 `hideLoading()` 之后。
- 🔴 **目标（思傅 11-08 重锚）＝「检索到正确解答思路和解答过程」**，不追 exact。允许库内相似例题（题干＋它自己的解析，同源配对）＋事先声明。`shared/question-reference.ts`＋前端逐字镜像 `constants/reference-disclaimer.ts`；`answer` 仍空／`verified` 仍 false／无「采纳」；声明在内容之前且每条例题重复。
- 🔴 **已证伪 ⛔ 别重走**：①P-013/D-016 只改召回选词 ⇒ `exact` 仍全 0；②单独切题/OCR ⇒ 8 条仅 1 条假 exact。根因三叠加：库覆盖／OCR 字面差异／`extractDistinctive()` 纯英文返回空 anchors。
- **P-014 已上线**：`shared/input-guard.ts` 零依赖闸门（整页 >1200 字／题号≥2／<25 字或无设问 ⇒ 不送判定＋如实提示）＋双入口（M36 逐字钉）；验收假 exact `1/8→0/8`，**不宣称提命中**。⚠️ 页面级文案在 `dist/pages/recognize/index.js` ⇒ `ide-verify.mjs` 递归扫 `dist/**/*.js`。
- ✅ 生产 P2/P3 11-07 生效、P-014/015/016 产物 health 200／0 ERROR／哈希复比过（回滚点 `QA-16 §6.1.8–6.1.11`）；⚠️ **只开发版，未提审未发正式版**，`urlCheck`＋隐私开关两道硬门仍关。
- 🔴 **不宣称**命中提升／修复有效／误判归零／所有用户已可用；样本仅方向性证据，**不得计算召回率**；唯一够格指标＝`0021 review_events`（**0 行**）。
- 🔴 **仍锁**：`strict=1`、第二层准入、`.doc` 10,503 份与扫描 PDF／`m:oMath` 各需独立提案（**docx 侧已全量**）、4 组身份治理、双账号真实登录 E2E、公安联网备案；向量召回／Reranker／知识点图谱／方案 B／英文锚点／库覆盖体检／OCR 纠错字典／贡献通道**各需独立提案**。
- 只读诊断：`kb-hit-diagnose.mjs`、`kb-upstream-diagnose.mjs --limit 8 --stems 2`。

## 4 接口与前端
- 前缀 `/api/`；禁 undefined 进 query；中文名 `encodeURIComponent`；`/api/upload` 的 `save` 建条目、`attach` 只持久化。
- 🔴 光标：两个 pnpm 补丁缺一不可（react 同值摘 value 且返回 `[]`、runtime INPUT 只同步 `props.value`）＋`flushSync()`＋丢非字符串 `detail.value`；⛔ 延迟上抛／不传 value／`defaultValue`／改 `Symbol.hasInstance`。全仓用 `ui/Textarea`。
- 🔴 下载打自家 `/api` 必须 `header: buildHeaders()`（公网签名直链不要带头）；service 层自己 `unwrap`，出现 `.data?.data` 即契约断。
- 令牌 **X-Auth-Token 唯一被采信**（`v1.<uid>.<exp>.<HMAC 前40>`，密钥 `.env.secrets`，可自签做 E2E）；裸 X-User-Id 401；免登录端点同步 `PUBLIC_ROUTES`；必须关 ETag；`navigateBack` 不重 mount ⇒ `useDidShow`＋`firstShowRef`＋`silent:true`。
- ⚠️ 音视频禁原生小写标签；`<Image>`/`<Video poster>` 不发头 ⇒ 服务端直给 `*_url`；🚨 request/uploadFile 超时 60s ⇒ >60s 走 `POST /api/jobs` 202+轮询。
- 🔴 隐私同意要真拦写：`guardPolicy(action)` 与 `guardPrivacy` 串行两道；`<PolicyConsent/>` 挂首页＋首帧；隐私接口失败禁 `catch {}`；Taro 4.1.9 走 `globalThis.wx`；隐私政策 **r8**（第四节第三方清单必须保留，两处副本逐字一致）。
- 🔴 `gk-netdisk-index.timer` 周日 04:23 必须跑（停＝隐私承诺不兑现）。面客说「资料库」不说「百度网盘」。导航 tab＝首页／复习本／资料／记忆，tab 页只能 `switchTab`。

## 5 AI / 品牌 / L3
- `users.ai_enabled` 默认 false，`requireAiEnabled()` 拦 chat/message/answer-search/search/solve；`mode=kb` 不连坐；改开关必须 `invalidateUserFlags()`。个人主体 ⇒ AI 入口收起。名统一**成长学童**。
- 🔴 `STORAGE_DRIVER=local` 同步 `PUBLIC_ROUTES`＋`STORAGE_PUBLIC_BASE_URL`；Caddy 站点块必须 `handle` 包 `file_server`；`PROJECT_DOMAIN` 编译期常量，改必重建；Linux 必设 `OCR_PYTHON`+`PPSV3_PYTHON`+`PADDLE_PDX_CACHE_HOME`。🔴 生产 `STORAGE_PUBLIC_BASE_URL` **必须 `https://deep-root.cn`**（11-08 前是 `http://42.192.36.120` ⇒ 下发 http IP，小程序 `<Image>`/RichText 手机裂图；改配置＋重启即生效，库里只存 `storage_key`）；并确认 mp 后台 `downloadFile` 合法域名（托管未解除前不能自行配）。
- 🔴 **8080 是 Caddy 不是 PostgREST 直连**：必须 `/rest/v1/<table>?select=…` 回真实行才算通过；`service_role` 必须 BYPASSRLS。结果指标唯一够格＝到期首次作答正确率（`0021`），每档 ≥30 样本，**当前 0 行**。

## 6 发布与验证
- 发版前轮换 WX_SECRET **后必跑 encrypt-env.mjs**；`release:check` 后 revert；生产 `WAKE_ENABLED=0`。🚨 开发管理托管第三方 ⇒ **发正式版必须先解除托管**；服务类目保留＋追加工具类目。
- 🔴 **个人主体不得做用户共享题库/UGC 分享**（【社交-笔记】仅非个人主体）；PIPL §16/23/25/15/28/29 逐条落地；教辅共享涉信息网络传播权。
- 🔴 备案：轻量包月≥3月、**L3 到期⇒备案失效**；个人主体禁教育培训课程辅导文案；小程序备案≠域名备案；**公安联网备案待办**；首页 `<title>`/`<h1>` 与备案站名逐字一致。
- **验证通道**：`ide-verify.mjs --launch --marker "<特征串>"` ⇒ 冷启动＋CDP 自检＋8 页冒烟；🔴 冷启动唯一可行解＝纯 Node 写 UTF-8 `.cmd`（首行 `chcp 65001`）交桌面 `explorer.exe`，只认 9222＋哨兵文件（exit 1 正常）；⛔ Start-Process／WMI／schtasks／Bash 调 cmd 全被挡；验证前别跑 CLI `open`/`auto`（`auto` 需 `--auto-port 9420`）。✅ 模拟器有真实登录态（`gk_auth_token` v1／公共 owner `cc6d7b10-…`）。🔴 模拟器≠真机（音频 Range、隐私真弹窗、原生组件/性能须手机）。
- `server/scripts/verify/`：`verify:ci`／`verify:gate`／`method:check`／`lint:build`；M16 三条硬门；造数据每次内容不同。`check:isolation` 150/150；M27–M37 128/128；`verify:gate` 37/37。
- 🔴 测试期禁用真登录（会迁移匿名号数据），切身份只换令牌；根 `tsc --noEmit` 的 node_modules 报错是既有噪音。

## 7 其它
- 复习排程真相源 `timeline/review.ts`，五档 1→3→7→14→28 天，改间隔触发 M15（三处同步）；前端不自算 plan。年级 12 档真相源 `shared/grade.ts`＋镜像 `constants/grades.ts`，M26 守。
- CI `gate`=build:server→build:weapp→M12 M13 M16；OCR GT 退出码 2＝环境跑不起来；`R-算法-07` 竖式符号行丢失未修；`include_answers` 不传＝不含答案。
- 🚨 **20b 第 7 章标题不可动**；批量改文档用脚本+「命中 1 次」断言；M11 连续天数/时长只作展示不得作判定。
- 🔴 **本机删除守卫**：批量删除守卫拦 `Remove-Item -Recurse`／`rm -rf`／`fs.rmSync`（Bash 侧 exit 127）；`Add-Type`、COM 均被禁 ⇒ 回收站 API 不可用。合规路径＝逐文件 `[System.IO.File]::Delete` 每批 10 个校验＋自底向上 `[System.IO.Directory]::Delete(p,$false)`；删前备份＋警告＋列清单。


===== SNAPSHOT 2026-11-16 (MEMORY.md r74, full copy) =====
# Growing-Kids 长期约定（r74 · 红线索引）

> 证据＝`MEMORY-full-archive.md`、`docs/reports/`、`proposals/P-NNN`＋`docs/design/method/decision-log.md` D-NNN。**只留红线＋指针**；软限 16KB。r73·D-071。

## 0 流程
- 家长主用；改「学习行为」先过 20a §5.1 三问＋§6.2 M1–M11；GK-OPS-22：L0/L1/L2＋提案 P-NNN＋台账 D 号，**先查台账再评审**；动 `question-match.ts` 前建档；设计决策逐题确认。
- 缺口序 C3 错因 > C2 信心 > C1 掌握梯度 > C5 交错。⛔ 励志推送／智能排程／ZPD／打卡时长激励。**push 等思傅指示；本地 commit 照常。** 要实际进展、别堆方案。

## 1 环境与发货
- 🔴 生产＝L3 `42.192.36.120`（PG `gk`＋Caddy 8080）；本地 `.env`／`.env.migrate` 是 Supabase 云开发库**非现网**；查删必 ssh，删前备份。微信 IDE 唯一目录 `D:\AI\Growing-Kids`。
- 🔴 侧车＝**独立** `gk-ppsv3.service`（:9301／1.6G／2400M）。D-071 起**单元模式**（`UNIT=gk-ppsv3`＋`SUPERVISE=1`，改自 D-070 `SUPERVISE=0`）：空闲 15min `stop`、被调用 `start`→**探针预热 ~17s** 才放行；⚠️ **`/healthz` 200≠能用**（首次 `/ppsv3` 才加载模型）；SIGTERM **不停共享单元**。
- 🔴 **gk-api 带 `NoNewPrivileges=yes` ⇒ `sudo` 提权被内核拒**（`/etc/sudoers.d/gk-ppsv3` 是死配置）⇒ 授权只走 **polkit** `/etc/polkit-1/rules.d/49-gk-ppsv3.rules`（限 gk 用户＋gk-ppsv3＋start/stop/restart）＋`PPSV3_UNIT_SUDO=0`；规则留档 `docs/gk-ppsv3.service` 顶部。
- 🔴 commit≠发货≠生产有代码：前端 `build:weapp`→上传→提审→发版；后端换 `server/dist` **并重启 `gk-api`**。精准换 dist＝`build:server` → sha256 **集合比对**→ 旧 dist `cp -a .bak-时间戳` → 只覆盖点名文件＋`chown gk:gk`＋`chmod 644` → 复比零差异 → 才重启。`@/` 别名 tsc 不重写 paths ⇒ 相对路径＋M13；漏 `ocr-engine/*.py` ⇒ 静默降级（生产在 `/opt/gk/ocr-engine/`，不在 dist）；模拟器≠真机。
- L3 批量转换：worker ≤2、批 ≤2、`ionice -c3 nice -n19`、查 `MemAvailable`(<700MB 等)、批 ≤8min；长跑 `systemd-run -p MemoryMax=1800M`。事故＝ping 通但 22 banner/API 超时 ⇒ 退避 3min、`pkill -9 -f` 清 soffice/python/node。`--shard`≠`--shape`。
- soffice **每 worker 独立 profile**（`lo_profile_arg()`）。两类卡住：~1,000 份后失败抬头＝profile 退化（每 2h 重启）；单份小文档两 profile 99.9% CPU 空转＝LO 死循环 ⇒ `status='empty'＋'lo-hang-skip'`（全库 1 份）；cwd 须 gk 可写。
- 🔴 `systemd-run` 不继承 dotenvx ⇒ unit `bash -c` 里 `set -a; . .env.secrets; . .env.migrate; set +a`（User=gk）；`.env.migrate`⇒`sudo -u gk -H`；`/tmp` 脚本要 `NODE_PATH`＋`chown -R gk:gk`；远端 nohup＋日志＋另开 ssh 轮询；OCR 中文无 U+FFFD。
- 🔴 微信 CLI：清代理＋`NO_PROXY=127.0.0.1,localhost`；**`code 10` 两种分流（D-062/065）**：①CLI 自起 headless server（`.ide` 端口非 LISTEN）⇒ 显式 `--port`；②冷启动**掉登录态** ⇒ `islogin --port` false ⇒ `cli login --port` 扫码（`code 25` 超时）。端口读 `%LOCALAPPDATA%\微信开发者工具\User Data\<hash>\Default\.ide`；`key/private.appid.key` 0 字节 ⇒ miniprogram-ci 不可用。
- 🔴 生产 dist＝D-066（18 文件）＋D-071（3 个 `dist/ocr/*`）；`:3000`／公网 health **200**、v17；前端仅开发版 `2026.11.15.2` 未提审。

## 2 数据
- 无 RLS ⇒ 查询必 `.eq('user_id', …)`；删除加 `.select('id')` 校行数；真相源**只有 `migrations/`**；空串≠NULL，回写前 `trim()`；PG text 不收 U+0000 ⇒ `stripNul()`；媒体读端点必须 `res.sendFile`（Range 206 判据），禁 `.pipe()`。
-  `users.role`＋`requireAdmin()` fail-closed，提权走 `promote-admin.mjs`；`blob_objects` 内容寻址＋ref_count；改引擎/切分必 bump 版本；存储 key 只 ASCII；`*_images` 读端点过 `withUrls`。
- 备份 `gk_backup` 必须 `bypassrls`；🔴 派生表（`question_objects`／`question_figures`／`question_inline_figures`）不进备份、恢复后重建。库 214MB 打包 OOM ⇒ `NODE_OPTIONS=--max-old-space-size=2560`；**备份未成功前不 `--apply`**（D-031）。
- 🔴 归户/去重键：`netdisk_files (user_id,fs_id)`、`question_objects (user_id,source_type,source_id,object_index)`；`objectFingerprintInput()` 含 `source_id`。`users` 80 行＝79 匿名+1 正式，**528 题挂 29 匿名号不能删**。

## 3 资料库检索与 D 线
- 真相源 `shared/question-match.ts`（**零依赖单文件**，不能加 import）；硬闸无数据源豁免、`topic` 必 `answer:''`＋`verified:false`；`kb` 顺序＝自有题库→library_docs→网盘 exact→兜底（D-060 删第 ④ 源）；双减禁拍照搜题、`exact` 才放解析。
- 🔴 **P0 六条硬闸串联否决，禁改加权求和**：≥3 长锚点／题干 ≤6000 字／设问一致／锚点共现限对象内／相邻解析段 ≥8 字不串题号／来源唯一；举证责任倒置；准入＝误判归零＋召回 ≥90%＋定位 100%＋P95<3s。⛔ 不上向量库/Reranker/LLM 兜底（**仅判定层**；参考例题层 D-038／`P-026`）。
- 🔴 **判定层一行未动**是放行前提：**召回变宽≠放行变宽**，第二层准入未全绿。目标＝「检索到正确解答思路和过程」不追 exact；同源配对例题＋事先声明，`answer` 空/`verified` false/无「采纳」。改 `note`/result 结构或删召回来路 ⇒ bump `CACHE_VERSION`（**v17**，answer_cache 缓存整个 result）；判据＝拿新题测。
- 🔴 **图形**：P-017 快照＋P-018 原位重建（`w:drawing`/`w:object` 按 `char_start` 插回）；**定位不到不入库不下发，绝不拿相邻题顶替**；`charOffset` 码点 ⇒ `cpToUtf16()`；前端 `RichText`；公式必须 PDF 渲染；⛔ WMF／`≤→£` 假证伪；`assertSymbolFont()` 防 Symbol 吞符号。**入库文字不是 LO**（`extract_docx()` 零 LO，LO 只做底图）。
- 输入闸门（P-016/D-019）：`guardQuestionInput()` 不合格**只拦判定层**不拦参考例题层（`referenceMode:'examples'`）；`source:'none'` 也须渲染卡片＋常驻 `note`；文案在 `dist/pages/recognize/index.js` ⇒ `ide-verify.mjs` 递归扫。
- 🔴 ⛔ **已证伪别重走**：①P-013 只改召回选词 ⇒ exact 仍 0；②单独切题/OCR ⇒ 8 条仅 1 假 exact；③P-014 `1/8→0/8` **不宣称提命中**。根因＝库覆盖／OCR 字面差异／纯英文题干空 anchors。
- 🔴 **不宣称**命中提升/误判归零/全覆盖；样本仅方向性证据、**不得算召回率**；唯一指标 `0021 review_events`（0 行）。开发版、未提审未发正式版，两门仍关。
- 🔴 性能（D-025→033）：P95 **3443/3457/3488**＝稳态长尾、主段 **L0 候选池**；列裁剪须 `strpos`＋统一大小写；F5 只读不重映射 offset；`--apply` 双硬锁。
- 🔴 **40 条复核 18 不通过⇒签核不通过**（D-034/035）：根因＝`parse_docx()` 把 `w:drawing`／`w:object` 打成透明占位 PNG。⛔「文字邻域」证伪、F5/F5b fail-closed、**不加 F5c**；**读得懂≠题目可解、错图比没图更糟**。0 行是**出数条件**非代码。
- 🔴 课标线（D-038→045）：T0 硬门、自建 9 科（`0032` 720 行／**仅开发库**）＋M43 12/12；T0 三件套落地但**仍未过**（生产 `0032` 未上／`review_events` 0）；**循环依赖＝记账错⇒拆账不放宽**；G8 **未过**；`P-028` 五题已批准；标签层＋M44 **未发货未面客**；S7 未签核。
- 🔴 qobj-2 在生产（D-049→053）：**615,370 行＝ok 521,476＋rejected 93,894**；`0032` 未上 ⇒ curriculum `available:false`。D-053：空题根因＝白名单漏 `．`(U+FF0E)；去重＝`stem+solution` 全同、只标 `rejected` 不删行；M47 12/12。15 份切题失效未修。
- 🔴 **D-054~059**：导出带图三链＋高清护栏＋学习手册页（⛔ 未做 `charOffset` 混排）；按 B 保留资料库搜题（**产品裁决不是签核**）；**AI 助手对用户不可用**（`AI_PUBLIC_ENTRY=false`＋fail-closed）；`pages/chat` 全删；`UgcTextGuard` 收口五条入库口、命中 400（best-effort、图视频未检）。M27–M41 `v14` 断言既有失败，勿称全绿。
- 🔴 **D-060/061/062**：提审页选「**采集用户隐私**」、5.1 保「必要的最短时间」⛔ 不选 0 天、6.2 填「**弹窗**」；迁境内自建库 ⇒ 披露「数据全存中国大陆境内、不涉及出境」；`supabase-js`／文件名／迁移史字面仍存 ≠ 现行境外服务方；ima 整删；政策 **r11**。未提审 ⇒ r11／采集隐私／6.2／`method=1` 未生效、两门仍关。
- 🔴 **D-063~067（P-029）**：多图导入＝多选→排序页（✕ 可插回、长按调序）→`purpose='temp'` 串行→`/api/library/combine-images` **一图一页 PDF**（⛔ 智能拼页）→**只建 1 条 `library_docs`**；上限 20；实证 14/14、27/27。
- 🔴 **D-068（P-030，未发货）**：拖不动＝`touchstart` 提前量＋根 View 收事件＋`dragActiveRef`＋`hitCellIndex()`；预览放大（**不写回**）／左右转／裁剪（**写回参与合成**）；`image-editor.tsx` 与合成页**两处**加左转；`0033` 无限层级文件夹（`MAX_DEPTH=32`）、**老库 fail-safe＝显式传 `folder_id` 才碰新列**。M52 10/10、实证 37/37。🔴 **均未上 dist／未重传 ⇒ 未面客**。
- 🔴 **D-069（P-031）**：按题号裁图＝改 `recognize` 的 `split`；`question-locate.ts` 零依赖（半角小数 `(?!\d)`）。**定位不到给整页候选＋`answerRect=null`，绝不借邻题区间（D-020）**。r3 四病灶＝合段 `explodeLines()`／OCR 吞点 `startsWithLabel()`（只认本次号）／`RE_第N题` 加 `(?!\s*图)`／手写区 `handwritingStart()` 连续≥3 行。⛔ 不扩正则。
  🔴 **r4/D-072 图被切**：快速通道只给文字行、**图上无文字** ⇒ 精准 `image` 块是唯一来源。`extractFigures()`→`page_figures`（键 `fig-v1`）→`locateQuestions(…,figures)`，**图注优先**（16 图排在 14 区间）、无图注按 y 重叠 0 不归；只外扩、同段落重算、失败不改框。前端「补全图形」（热 9s/冷 20s）。
  🔴 **r4.1/D-073**：`归属唯一` 错⇒**图块互斥、题可多图**（`figureBoxes` 逐块校验）；图注认 `第7题(1)图`。17/17。**已上线**：dist 581/581、ocr-page fast 4.6s/图0、precise 29.4s/图4；开发版 2026.11.16.1。
  🔴 限制：矩形剔不掉并排邻题图、覆盖率未测、手写 1~2 行退旧行为；**未真机回归/未提审未发版**、`0033` 未执行。
- 🔴 **仍锁**：`strict=1`、第二层准入、T0 判定、协议实跑、M42 v4／F6／.doc 快照下发／J1 归一写库／J2、S7–S9、G1–G8 发货、面客集成、`0032`＋`0033` 上生产、PDF 压测／`U+FFFD`／长尾；向量召回/Reranker/方案 B/英文锚点各需独立提案（判定层永久排除）。

## 4 接口与前端
- 前缀 `/api/`；禁 undefined 进 query；中文名 `encodeURIComponent`；`/api/upload` 的 `save` 建条目、`attach` 只持久化。
- 🔴 光标：两个 pnpm 补丁缺一不可＋`flushSync()`＋丢非字符串 `detail.value`；⛔ 延迟上抛／不传 value／`defaultValue`／改 `Symbol.hasInstance`；全仓用 `ui/Textarea`。
- 🔴 下载打自家 `/api` 必须 `header: buildHeaders()`；service 自己 `unwrap`，出现 `.data?.data` 即契约断。
- 🔴 **D-074（P-034 题干图文混排，L1，未发货）**：textarea 塞不了 img ⇒ **`[图N]` 占位 + RichText 按 slot 插图**。存 `content.question_inline_figures`(jsonb 免 migration)＋`withUrls` 派生 `question_inline_figure_urls`(单张失败⇒undefined)。相册拍照(双闸门)或题面图裁块→`attach` 上传→插 `[图N]`；删图同步删标记、slot 不复用；图文一次提交、剥 `_url`；helper `src/lib/question-inline-figure.ts`；无 URL 显示 `[图N]`、不拿邻图顶。34/34、M55 4/4
  🔴 仅详情页展示态生效；列表/导出仍纯文本。未真机回归、未发货。
令牌 **X-Auth-Token 唯一被采信**（`v1.<uid>.<exp>.<HMAC 前40>`）；裸 X-User-Id 401；免登录端点同步 `PUBLIC_ROUTES`；必关 ETag；`navigateBack` 不重 mount ⇒ `useDidShow`＋`firstShowRef`＋`silent:true`。
- ⚠️ 音视频禁原生小写标签；`<Image>`/`<Video poster>` **不发头** ⇒ 服务端直给 `*_url`；🔴 **头像 `avatarUrl` 存对象 key 不能直接当 src**（实测 401／本地 500）⇒ 先 `downloadFile` 落 `gk_avatar_local.path`；`profile` 页 `toImageSrc()`、**D-066 首页 `homeAvatarSrc()`**。🚨 request/uploadFile 超时 60s ⇒ >60s 走 `POST /api/jobs` 202+轮询。
- 🔴 隐私同意真拦写：`guardPolicy(action)` 与 `guardPrivacy` 串行两道；`<PolicyConsent/>` 首页＋首帧；隐私接口失败禁 `catch {}`；Taro 4.1.9 走 `globalThis.wx`；政策 **r11**（升版＝全员重同意，随前端包生效）。`gk-netdisk-index.timer` 周日 04:23 必跑。面客说「资料库」；tab 页只能 `switchTab`。

## 5 AI / 品牌 / L3
- `ai_enabled` 默认 false，`requireAiEnabled()` 拦 chat/message/answer-search/search/solve；`mode=kb` 不连坐；改开关必 `invalidateUserFlags()`；🔴 个人主体 ⇒ **AI 助手对用户不可用**（D-057，**闸门保留**）。名「成长学童」。
- 🔴 `STORAGE_DRIVER=local` 同步 `PUBLIC_ROUTES`+`STORAGE_PUBLIC_BASE_URL`；Caddy `handle` 包 `file_server`；`PROJECT_DOMAIN` 改必重建；Linux 必设 `OCR_PYTHON`+`PPSV3_PYTHON`+`PADDLE_PDX_CACHE_HOME`。🔴 生产 `STORAGE_PUBLIC_BASE_URL` **必须 `https://deep-root.cn`**（旧 http IP ⇒ 手机裂图）。
- 🔴 **8080 是 Caddy 不是 PostgREST 直连**：`/rest/v1/<table>?select=…` 回真实行才算通过；`service_role` 必须 BYPASSRLS。🔴 **`:8080/api/health` 是空 200 假探针** ⇒ 真健康打 **`:3000/api/health`**（D-052）。唯一够格指标＝`0021` 到期首答正确率（0 行）。

## 6 发布与验证
- 发版前轮换 WX_SECRET **后必跑 encrypt-env.mjs**；`release:check` 后 revert；生产 `WAKE_ENABLED=0`。✅ 托管已解除（D-057）。🔴 发布门两阻断＝`urlCheck`/`__usePrivacyCheck__`；前提＝mp 后台域名白名单(含 `downloadFile`)＋隐私指引先办完。⚠️ 旧 IDE 1.06.2303220 把 `app.json ["__usePrivacyCheck__"]` 误报「无效」，**不要删该字段**。
- 🔴 **mp 两项前置**：实操只认 `docs/reports/mp后台-隐私指引7项与UGC声明-操作指引.md`（入口2、7 项短句、r11 后共享 **5 条**、§2.4.1、UGC 五类全勾、`method=1`、`audit_desc` 238 字）。🔴 **共同前提＝先换 dist 重启＋上传 r11 前端包**（r11 仍只开发版）。
- 🔴 个人主体不得做共享题库/UGC 分享；PIPL §16/23/25/15/28/29 逐条落地；教辅共享涉信息网络传播权。备案：包月≥3月、**L3 到期⇒失效**；禁教育培训文案；小程序备案≠域名备案；**公安联网备案审核中(D-044)**；首页 `<title>`/`<h1>` 与备案站名一致。
- 验证：`ide-verify.mjs --launch --marker "<特征串>"`；🔴 冷启动唯一解＝纯 Node 写 UTF-8 `.cmd` 交桌面 `explorer.exe`，只认 9222＋哨兵文件；⛔ Start-Process／WMI／schtasks 被挡。✅ gate 38/38、isolation 164、M52 10/10、M54 8/8、侧车实证 30/30；测试期禁真登录。

## 7 其它
- 复习排程真相源 `timeline/review.ts`（1→3→7→14→28 天），改间隔触发 M15 三处同步，前端不自算 plan；年级 12 档 `shared/grade.ts`＋镜像 `constants/grades.ts`，M26 守。
- CI `gate`=build:server→build:weapp→M12 M13 M16；`R-算法-07` 竖式符号行丢失未修；`include_answers` 不传＝不含答案。🚨 20b 第 7 章标题不可动；批量改文档用脚本＋「命中 1 次」断言；M11 天数/时长只作展示不作判定。
- 🔴 **本机删除守卫**：`Remove-Item -Recurse`／`rm -rf`／`fs.rmSync` 被拦，`Add-Type`／COM 被禁 ⇒ 回收站 API 不可用。合规路径＝逐文件 `[System.IO.File]::Delete` 每批 10 个校验＋自底向上 `[System.IO.Directory]::Delete(p,$false)`；删前备份＋警告＋列清单。

===== SNAPSHOT 2026-11-17 (before D-078 MEMORY compression) =====
# Growing-Kids 长期约定（r74 · 红线索引）

> 证据＝`MEMORY-full-archive.md`、`docs/reports/`、`proposals/P-NNN`＋`docs/design/method/decision-log.md` D-NNN。只留红线＋指针；软限 16KB。

## 0 流程
- 家长主用；改「学习行为」先过 20a §5.1 三问＋§6.2 M1–M11；GK-OPS-22：L0/L1/L2＋提案 P-NNN＋台账 D 号，先查台账再评审；动 `question-match.ts` 前建档；设计决策逐题确认。
- 缺口序 C3 错因 > C2 信心 > C1 掌握梯度 > C5 交错。⛔ 励志推送／智能排程／ZPD／打卡时长激励。push 等思傅指示；本地 commit 照常。要实际进展、别堆方案。

## 1 环境与发货
- 🔴 生产＝L3 `42.192.36.120`（PG `gk`＋Caddy 8080）；本地 `.env`／`.env.migrate` 是 Supabase 云开发库非现网；查删必 ssh、删前备份。微信 IDE 唯一目录 `D:\AI\Growing-Kids`。
- 🔴 侧车＝独立 `gk-ppsv3.service`（:9301／1.6G／2400M）。D-071 单元模式（UNIT=gk-ppsv3＋SUPERVISE=1，改自 D-070 SUPERVISE=0）：空闲 15min stop、被调用 start→探针预热 ~17s 才放行；⚠️ `/healthz` 200≠能用（首次 `/ppsv3` 才加载模型）；SIGTERM 不停共享单元。
- 🔴 gk-api 带 NoNewPrivileges=yes ⇒ sudo 提权被内核拒（`/etc/sudoers.d/gk-ppsv3` 死配置）⇒ 授权只走 polkit `/etc/polkit-1/rules.d/49-gk-ppsv3.rules`（限 gk 用户＋gk-ppsv3＋start/stop/restart）＋`PPSV3_UNIT_SUDO=0`；规则留档 `docs/gk-ppsv3.service` 顶部。
- 🔴 commit≠发货≠生产有代码：前端 `build:weapp`→上传→提审→发版；后端换 `server/dist` 并重启 `gk-api`。精准换 dist＝`build:server`→sha256 集合比对→旧 dist `cp -a .bak-时间戳`→只覆盖点名文件＋`chown gk:gk`＋`chmod 644`→复比零差异→才重启。`@/` 别名 tsc 不重写 paths⇒相对路径＋M13；漏 `ocr-engine/*.py`⇒静默降级（生产在 `/opt/gk/ocr-engine/`，不在 dist）；模拟器≠真机。
- L3 批量转换：worker ≤2、批 ≤2、`ionice -c3 nice -n19`、查 MemAvailable(<700MB 等)、批 ≤8min；长跑 `systemd-run -p MemoryMax=1800M`。事故＝ping 通但 22 banner/API 超时⇒退避 3min、`pkill -9 -f` 清 soffice/python/node。`--shard`≠`--shape`。
- soffice 每 worker 独立 profile（`lo_profile_arg()`）。两类卡住：~1,000 份后失败抬头＝profile 退化（每 2h 重启）；单份小文档两 profile 99.9% CPU 空转＝LO 死循环⇒`status='empty'`＋`lo-hang-skip`（全库 1 份）；cwd 须 gk 可写。
- 🔴 `systemd-run` 不继承 dotenvx ⇒ unit `bash -c` 里 `set -a; . .env.secrets; . .env.migrate; set +a`（User=gk）；`.env.migrate`⇒`sudo -u gk -H`；`/tmp` 脚本要 `NODE_PATH`＋`chown -R gk:gk`；远端 nohup＋日志＋另开 ssh 轮询；OCR 中文无 U+FFFD。
- 🔴 微信 CLI：清代理＋`NO_PROXY=127.0.0.1,localhost`；code 10 两种分流（D-062/065）：①CLI 自起 headless server（`.ide` 端口非 LISTEN）⇒显式 `--port`；②冷启动掉登录态⇒`islogin --port` false⇒`cli login --port` 扫码（code 25 超时）。端口读 `%LOCALAPPDATA%\微信开发者工具\User Data\<hash>\Default\.ide`；`key/private.appid.key` 0 字节⇒miniprogram-ci 不可用。
- 🔴 生产 dist＝D-066（18 文件）＋D-071（3 个 `dist/ocr/*`）；`:3000`／公网 health 200、v17；前端仅开发版 `2026.11.15.2` 未提审。

## 2 数据
- 无 RLS ⇒ 查询必 `.eq('user_id', …)`；删除加 `.select('id')` 校行数；真相源只有 `migrations/`；空串≠NULL，回写前 `trim()`；PG text 不收 U+0000⇒`stripNul()`；媒体读端点必须 `res.sendFile`（Range 206 判据），禁 `.pipe()`。
- `users.role`＋`requireAdmin()` fail-closed，提权走 `promote-admin.mjs`；`blob_objects` 内容寻址＋ref_count；改引擎/切分必 bump 版本；存储 key 只 ASCII；`*_images` 读端点过 `withUrls`。
- 备份 `gk_backup` 必须 `bypassrls`；🔴 派生表（`question_objects`／`question_figures`／`question_inline_figures`）不进备份、恢复后重建。库 214MB 打包 OOM⇒`NODE_OPTIONS=--max-old-space-size=2560`；备份未成功前不 `--apply`（D-031）。
- 🔴 归户/去重键：`netdisk_files (user_id,fs_id)`、`question_objects (user_id,source_type,source_id,object_index)`；`objectFingerprintInput()` 含 `source_id`。`users` 80 行＝79 匿名+1 正式，528 题挂 29 匿名号不能删。

## 3 资料库检索与 D 线
- 真相源 `shared/question-match.ts`（零依赖单文件，不能加 import）；硬闸无数据源豁免、`topic` 必 `answer:''`＋`verified:false`；`kb` 顺序＝自有题库→library_docs→网盘 exact→兜底（D-060 删第④源）；双减禁拍照搜题、exact 才放解析。
- 🔴 P0 六条硬闸串联否决，禁改加权求和：≥3 长锚点／题干 ≤6000 字／设问一致／锚点共现限对象内／相邻解析段 ≥8 字不串题号／来源唯一；举证责任倒置；准入＝误判归零＋召回 ≥90%＋定位 100%＋P95<3s。⛔ 不上向量库/Reranker/LLM 兜底（仅判定层；参考例题层 D-038／P-026）。
- 🔴 判定层一行未动是放行前提：召回变宽≠放行变宽，第二层准入未全绿。目标＝检索到正确解答思路和过程不追 exact；同源配对例题＋事先声明，`answer` 空／`verified` false／无「采纳」。改 `note`/result 结构或删召回来路⇒bump `CACHE_VERSION`（v17，answer_cache 缓存整个 result）；判据＝拿新题测。
- 🔴 图形：P-017 快照＋P-018 原位重建（`w:drawing`／`w:object` 按 `char_start` 插回）；定位不到不入库不下发，绝不拿相邻题顶替；`charOffset` 码点⇒`cpToUtf16()`；前端 `RichText`；公式必须 PDF 渲染；⛔ WMF／`≤→£` 假证伪；`assertSymbolFont()` 防 Symbol 吞符号。入库文字不是 LO（`extract_docx()` 零 LO，LO 只做底图）。
- 输入闸门（P-016/D-019）：`guardQuestionInput()` 不合格只拦判定层不拦参考例题层（`referenceMode:'examples'`）；`source:'none'` 也须渲染卡片＋常驻 `note`；文案在 `dist/pages/recognize/index.js`⇒`ide-verify.mjs` 递归扫。
- 🔴 ⛔ 已证伪别重走（详情见 archive）：①P-013 只改召回选词⇒exact 仍 0；②单独切题/OCR⇒8 条仅 1 假 exact；③P-014 `1/8→0/8` 不宣称提命中。根因＝库覆盖／OCR 字面差异／纯英文题干空 anchors。
- 🔴 不宣称命中提升/误判归零/全覆盖；样本仅方向性证据、不得算召回率；唯一指标 `0021 review_events`（0 行）。开发版、未提审未发正式版，两门仍关。
- 🔴 性能（D-025→033）：P95 3443/3457/3488＝稳态长尾、主段 L0 候选池；列裁剪须 `strpos`＋统一大小写；F5 只读不重映射 offset；`--apply` 双硬锁。
- 🔴 40 条复核 18 不通过⇒签核不通过（D-034/035）：根因＝`parse_docx()` 把 `w:drawing`／`w:object` 打成透明占位 PNG。⛔「文字邻域」证伪、F5/F5b fail-closed、不加 F5c；读得懂≠题目可解、错图比没图更糟。0 行是出数条件非代码。
- 🔴 课标线（D-038→045）：T0 硬门、自建 9 科（`0032` 720 行／仅开发库）＋M43 12/12；T0 三件套落地但仍未过（生产 `0032` 未上／`review_events` 0）；循环依赖＝记账错⇒拆账不放宽；G8 未过；`P-028` 五题已批准；标签层＋M44 未发货未面客；S7 未签核。
- 🔴 qobj-2 在生产（D-049→053）：615,370 行＝ok 521,476＋rejected 93,894；`0032` 未上⇒curriculum `available:false`。D-053：空题根因＝白名单漏 `．`(U+FF0E)；去重＝`stem+solution` 全同、只标 `rejected` 不删行；M47 12/12。15 份切题失效未修。
- 🔴 D-054~059：导出带图三链＋高清护栏＋学习手册页（⛔ 未做 `charOffset` 混排）；按 B 保留资料库搜题（产品裁决不是签核）；AI 助手对用户不可用（`AI_PUBLIC_ENTRY=false`＋fail-closed）；`pages/chat` 全删；`UgcTextGuard` 收口五条入库口、命中 400（best-effort、图视频未检）。M27–M41 v14 断言既有失败，勿称全绿。
- 🔴 D-060/061/062：提审页选「采集用户隐私」、5.1 保「必要的最短时间」⛔ 不选 0 天、6.2 填「弹窗」；迁境内自建库⇒披露「数据全存中国大陆境内、不涉及出境」；`supabase-js`／文件名／迁移史字面仍存 ≠ 现行境外服务方；ima 整删；政策 r11。未提审⇒r11／采集隐私／6.2／`method=1` 未生效、两门仍关。
- 🔴 D-063~067（P-029）：多图导入＝多选→排序页（✕ 可插回、长按调序）→`purpose='temp'` 串行→`/api/library/combine-images` 一图一页 PDF（⛔ 智能拼页）→只建 1 条 `library_docs`；上限 20；实证 14/14、27/27。
- 🔴 D-068（P-030，未发货）：拖不动＝`touchstart` 提前量＋根 View 收事件＋`dragActiveRef`＋`hitCellIndex()`；预览放大（不写回）／左右转／裁剪（写回参与合成）；`image-editor.tsx` 与合成页两处加左转；`0033` 无限层级文件夹（MAX_DEPTH=32）、老库 fail-safe＝显式传 `folder_id` 才碰新列。M52 10/10、实证 37/37。均未上 dist／未重传⇒未面客。
- 🔴 D-069（P-031）：按题号裁图＝改 `recognize` 的 `split`；`question-locate.ts` 零依赖（半角小数 `(?!\d)`）。定位不到给整页候选＋`answerRect=null`，绝不借邻题区间（D-020）。r3 四病灶＝合段 `explodeLines()`／OCR 吞点 `startsWithLabel()`（只认本次号）／`RE_第N题` 加 `(?!\s*图)`／手写区 `handwritingStart()` 连续≥3 行。⛔ 不扩正则。
  - 🔴 r4/D-072 图被切：快速通道只给文字行、图上无文字⇒精准 `image` 块是唯一来源。`extractFigures()`→`page_figures`（键 `fig-v1`）→`locateQuestions(…,figures)`，图注优先（16 图排在 14 区间）、无图注按 y 重叠 0 不归；只外扩、同段落重算、失败不改框。前端「补全图形」（热 9s/冷 20s）。
  - 🔴 r4.1/D-073：`归属唯一` 错⇒图块互斥、题可多图（`figureBoxes` 逐块校验）；图注认 `第7题(1)图`。17/17。已上线：dist 581/581、ocr-page fast 4.6s/图0、precise 29.4s/图4；开发版 2026.11.16.1。
  - 🔴 限制：矩形剔不掉并排邻题图、覆盖率未测、手写 1~2 行退旧行为；未真机回归/未提审未发版、`0033` 未执行。
- 🔴 仍锁：`strict=1`、第二层准入、T0 判定、协议实跑、M42 v4／F6／.doc 快照下发／J1 归一写库／J2、S7–S9、G1–G8 发货、面客集成、`0032`＋`0033` 上生产、PDF 压测／U+FFFD／长尾；向量召回/Reranker/方案 B/英文锚点各需独立提案（判定层永久排除）。

## 4 接口与前端
- 前缀 `/api/`；禁 undefined 进 query；中文名 `encodeURIComponent`；`/api/upload` 的 `save` 建条目、`attach` 只持久化。
- 🔴 光标：两个 pnpm 补丁缺一不可＋`flushSync()`＋丢非字符串 `detail.value`；⛔ 延迟上抛／不传 value／`defaultValue`／改 `Symbol.hasInstance`；全仓用 `ui/Textarea`。
- 🔴 下载打自家 `/api` 必须 `header: buildHeaders()`；service 自己 `unwrap`，出现 `.data?.data` 即契约断。
- 🔴 D-074/075（P-034图文混排，L1，已发货未面客）：textarea塞不了img⇒`[图N]`占位+RichText按slot插图；存`content.question_inline_figures`(jsonb免迁移)＋派生`question_inline_figure_urls`(单张失败⇒undefined)；无URL显示`[图N]`、不拿邻图顶。D-075扩列表+导出：列表卡按slot带图；`inline-figure-runs.ts`切段，A链document/B链pdf原位插图，C链不接。不bump CACHE_VERSION。
- 🔴 D-076（4修复+0033上生产+开发版`2026.11.16.3`，未提审/未真机）：①删除跳动⇒量高度扣scrollTop；②文件夹灰显⇒**0033已上**；③题号输入框⇒独占行；④裁剪框⇒下限0.03。⑤见D-077。
- 🔴 D-077（方案A，L1，未发货/未真机）：分节输入`一6,二5`⇒拆{节,号}+逐节定位(节尾收口不跨节、无该节fail-closed)；旧函数老路径逐字不变、判定层`question-match.ts`一行未动；同号不同节按index合并。详见台账。
- 🔴 D-078（3项UI，L1，未发货/未真机）：①资料库批量栏加「移动到…」⇒复用单条PATCH逐条移动(不动后端dist)、部分失败逐条统计；②识别页两按钮flex-1等宽并排、文案「识别文字/以图片形式保存」；③记忆页科目+分类全移除(列表/卡片/详情/编辑)，新建固定category=life、编辑不传category保留原值，数据字段不删。M58 5/5。详见台账。
- 令牌 X-Auth-Token 唯一被采信（`v1.<uid>.<exp>.<HMAC 前40>`）；裸 X-User-Id 401；免登录端点同步 `PUBLIC_ROUTES`；必关 ETag；`navigateBack` 不重 mount⇒`useDidShow`＋`firstShowRef`＋`silent:true`。
- ⚠️ 音视频禁原生小写标签；`<Image>`／`<Video poster>` 不发头⇒服务端直给 `*_url`；🔴 头像 `avatarUrl` 存对象 key 不能直接当 src（实测 401／本地 500）⇒先 `downloadFile` 落 `gk_avatar_local.path`；`profile` 页 `toImageSrc()`、D-066 首页 `homeAvatarSrc()`。🚨 request/uploadFile 超时 60s⇒>60s 走 `POST /api/jobs` 202+轮询。
- 🔴 隐私同意真拦写：`guardPolicy(action)` 与 `guardPrivacy` 串行两道；`<PolicyConsent/>` 首页＋首帧；隐私接口失败禁 `catch {}`；Taro 4.1.9 走 `globalThis.wx`；政策 r11（升版＝全员重同意，随前端包生效）。`gk-netdisk-index.timer` 周日 04:23 必跑。面客说「资料库」；tab 页只能 `switchTab`。

## 5 AI / 品牌 / L3
- `ai_enabled` 默认 false，`requireAiEnabled()` 拦 chat/message/answer-search/search/solve；`mode=kb` 不连坐；改开关必 `invalidateUserFlags()`；🔴 个人主体⇒AI 助手对用户不可用（D-057，闸门保留）。名「成长学童」。
- 🔴 `STORAGE_DRIVER=local` 同步 `PUBLIC_ROUTES`＋`STORAGE_PUBLIC_BASE_URL`；Caddy `handle` 包 `file_server`；`PROJECT_DOMAIN` 改必重建；Linux 必设 `OCR_PYTHON`＋`PPSV3_PYTHON`＋`PADDLE_PDX_CACHE_HOME`。生产 `STORAGE_PUBLIC_BASE_URL` 必须 `https://deep-root.cn`（旧 http IP⇒手机裂图）。
- 🔴 8080 是 Caddy 不是 PostgREST 直连：`/rest/v1/<table>?select=…` 回真实行才算通过；`service_role` 必须 BYPASSRLS。`:8080/api/health` 是空 200 假探针⇒真健康打 `:3000/api/health`（D-052）。唯一够格指标＝`0021` 到期首答正确率（0 行）。

## 6 发布与验证
- 发版前轮换 WX_SECRET 后必跑 `encrypt-env.mjs`；`release:check` 后 revert；生产 `WAKE_ENABLED=0`。✅ 托管已解除（D-057）。🔴 发布门两阻断＝`urlCheck`／`__usePrivacyCheck__`；前提＝mp 后台域名白名单（含 `downloadFile`）＋隐私指引先办完。⚠️ 旧 IDE 1.06.2303220 把 `app.json ["__usePrivacyCheck__"]` 误报「无效」，不要删该字段。
- 🔴 mp 两项前置：实操只认 `docs/reports/mp后台-隐私指引7项与UGC声明-操作指引.md`（入口2、7 项短句、r11 后共享 5 条、§2.4.1、UGC 五类全勾、`method=1`、`audit_desc` 238 字）。共同前提＝先换 dist 重启＋上传 r11 前端包（r11 仍只开发版）。
- 🔴 个人主体不得做共享题库/UGC 分享；PIPL §16/23/25/15/28/29 逐条落地；教辅共享涉信息网络传播权。备案：包月≥3月、L3 到期⇒失效；禁教育培训文案；小程序备案≠域名备案；公安联网备案审核中(D-044)；首页 `<title>`／`<h1>` 与备案站名一致。
- 验证：`ide-verify.mjs --launch --marker "<特征串>"`；🔴 冷启动唯一解＝纯 Node 写 UTF-8 `.cmd` 交桌面 `explorer.exe`，只认 9222＋哨兵文件；⛔ Start-Process／WMI／schtasks 被挡。✅ gate 38/38、isolation 164、M52 10/10、M54 8/8、侧车实证 30/30；测试期禁真登录。

## 7 其它
- 复习排程真相源 `timeline/review.ts`（1→3→7→14→28 天），改间隔触发 M15 三处同步，前端不自算 plan；年级 12 档 `shared/grade.ts`＋镜像 `constants/grades.ts`，M26 守。
- CI `gate`＝build:server→build:weapp→M12 M13 M16；`R-算法-07` 竖式符号行丢失未修；`include_answers` 不传＝不含答案。🚨 20b 第 7 章标题不可动；批量改文档用脚本＋「命中 1 次」断言；M11 天数/时长只作展示不作判定。
- 🔴 本机删除守卫：`Remove-Item -Recurse`／`rm -rf`／`fs.rmSync` 被拦，`Add-Type`／COM 被禁⇒回收站 API 不可用。合规路径＝逐文件 `[System.IO.File]::Delete` 每批 10 个校验＋自底向上 `[System.IO.Directory]::Delete(p,$false)`；删前备份＋警告＋列清单。
