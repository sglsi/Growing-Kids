# Growing-Kids 长期约定（r75 · 红线索引）

> 证据＝`MEMORY-full-archive.md`、`docs/reports/`、`proposals/P-NNN`＋`docs/design/method/decision-log.md` D-NNN。只留红线＋指针；软限 16KB。

## 0 流程
- 家长主用；改「学习行为」先过 20a §5.1 三问＋§6.2 M1–M11；GK-OPS-22：L0/L1/L2＋提案 P-NNN＋台账 D 号，先查台账再评审；动 `question-match.ts` 前建档；设计决策逐题确认。
- 缺口序 C3 错因 > C2 信心 > C1 掌握梯度 > C5 交错。⛔ 励志推送／智能排程／ZPD／打卡时长激励。push 等思傅指示；本地 commit 照常。要实际进展、别堆方案。

## 1 环境与发货
- 🔴 生产＝L3 `42.192.36.120`（PG `gk`＋Caddy 8080）；本地 `.env`／`.env.migrate` 是 Supabase 云开发库非现网；查删必 ssh、删前备份。微信 IDE 唯一目录 `D:\AI\Growing-Kids`。
- 🔴 侧车＝独立 `gk-ppsv3.service`（:9301／1.6G／2400M）。D-071 单元模式（UNIT=gk-ppsv3＋SUPERVISE=1，改自 D-070 SUPERVISE=0）：空闲 15min stop、被调用 start→探针预热 ~17s 才放行；⚠️ `/healthz` 200≠能用（首次 `/ppsv3` 才加载模型）；SIGTERM 不停共享单元。
- 🔴 gk-api 带 NoNewPrivileges=yes ⇒ sudo 提权被内核拒（`/etc/sudoers.d/gk-ppsv3` 死配置）⇒ 授权只走 polkit `/etc/polkit-1/rules.d/49-gk-ppsv3.rules`（限 gk 用户＋gk-ppsv3＋start/stop/restart）＋`PPSV3_UNIT_SUDO=0`；规则留档 `docs/gk-ppsv3.service` 顶部。
- 🔴 commit≠发货≠生产有代码：前端`build:weapp`→上传→提审→发版；后端换`server/dist`重启`gk-api`。精准换dist＝`build:server`→sha256比对→旧dist备份→只覆盖点名文件+`chown gk:gk`+`chmod 644`→复比零差异→才重启。`@/`别名tsc不重写paths⇒相对路径＋M13；漏`ocr-engine/*.py`⇒静默降级(在`/opt/gk/ocr-engine/`)。
- L3 批量转换：worker ≤2、批 ≤2、`ionice -c3 nice -n19`、查 MemAvailable(<700MB 等)、批 ≤8min；长跑 `systemd-run -p MemoryMax=1800M`。事故＝ping 通但 22 banner/API 超时⇒退避 3min、`pkill -9 -f` 清 soffice/python/node。`--shard`≠`--shape`。
- soffice 每 worker 独立 profile（`lo_profile_arg()`）。两类卡住：~1,000 份后失败抬头＝profile 退化（每 2h 重启）；单份小文档两 profile 99.9% CPU 空转＝LO 死循环⇒`status='empty'`＋`lo-hang-skip`（全库 1 份）；cwd 须 gk 可写。
- 🔴 `systemd-run` 不继承 dotenvx ⇒ unit `bash -c` 里 `set -a; . .env.secrets; . .env.migrate; set +a`（User=gk）；`.env.migrate`⇒`sudo -u gk -H`；`/tmp` 脚本要 `NODE_PATH`＋`chown -R gk:gk`；远端 nohup＋日志＋另开 ssh 轮询；OCR 中文无 U+FFFD。
- 🔴 微信CLI：清代理+`NO_PROXY=127.0.0.1,localhost`；code10两分流(D-062/065)：①自起headless(`.ide`非LISTEN)⇒显式`--port`；②冷启掉登录态⇒`islogin --port`false⇒`cli login --port`扫码(25超时)。端口读`%LOCALAPPDATA%\微信开发者工具\User Data\<hash>\Default\.ide`；`key/private.appid.key`0字节⇒miniprogram-ci不可用。
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
- 🔴 D-054~059：导出带图三链＋高清护栏＋学习手册页（⛔ 未做 `charOffset` 混排）；按 B 保留资料库搜题（产品裁决不是签核）；AI 助手对用户不可用（`AI_PUBLIC_ENTRY=false`＋fail-closed）；`pages/chat` 全删；`UgcTextGuard` 收口五条入库口、命中 400（best-effort、图视频未检）。M27–M41 v14 断言既有失败。
- 🔴 D-060/061/062：提审页选「采集用户隐私」、5.1 保「必要的最短时间」⛔ 不选 0 天、6.2 填「弹窗」；迁境内自建库⇒披露「数据全存中国大陆境内、不涉及出境」；`supabase-js`／文件名／迁移史字面仍存 ≠ 现行境外服务方；ima 整删；政策 r11。未提审⇒r11／采集隐私／6.2／`method=1` 未生效、两门仍关。
- 🔴 D-063~067（P-029）：多图导入＝多选→排序页（✕ 可插回、长按调序）→`purpose='temp'` 串行→`/api/library/combine-images` 一图一页 PDF（⛔ 智能拼页）→只建 1 条 `library_docs`；上限 20；实证 14/14、27/27。
- 🔴 D-068（P-030）：拖不动＝`touchstart`提前量+根View收事件+`dragActiveRef`+`hitCellIndex()`；预览放大(不写回)/左右转/裁剪(写回参与合成)；`image-editor.tsx`与合成页两处加左转；`0033`无限层级文件夹(MAX_DEPTH=32)、老库fail-safe＝显式传`folder_id`才碰新列。M52 10/10、实证37/37。
- 🔴 D-069(P-031)：按题号裁图＝改`recognize`的`split`；`question-locate.ts`零依赖(半角小数`(?!\d)`)。定位不到给整页候选+`answerRect=null`，绝不借邻题区间(D-020)。r3四病灶＝合段`explodeLines()`/OCR吞点`startsWithLabel()`(只认本次号)/`RE_第N题`加`(?!\s*图)`/手写区`handwritingStart()`连续≥3行。⛔不扩正则。
  - 🔴 r4/D-072 图被切：快速通道只给文字行、图上无文字⇒精准 `image` 块是唯一来源。`extractFigures()`→`page_figures`（键 `fig-v1`）→`locateQuestions(…,figures)`，图注优先（16 图排在 14 区间）、无图注按 y 重叠 0 不归；只外扩、同段落重算、失败不改框。前端「补全图形」（热 9s/冷 20s）。
  - 🔴 r4.1/D-073：`归属唯一` 错⇒图块互斥、题可多图（`figureBoxes` 逐块校验）；图注认 `第7题(1)图`。17/17。已上线：dist 581/581、ocr-page fast 4.6s/图0、precise 29.4s/图4；开发版 2026.11.16.1。
  - 🔴 限制：矩形剔不掉并排邻题图、覆盖率未测、手写 1~2 行退旧行为；未真机回归/未提审未发版、`0033` 未执行。
- 🔴 仍锁：`strict=1`、第二层准入、T0 判定、协议实跑、M42 v4／F6／.doc 快照下发／J1 归一写库／J2、S7–S9、G1–G8 发货、面客集成、`0032`＋`0033` 上生产、PDF 压测／U+FFFD／长尾；向量召回/Reranker/方案 B/英文锚点各需独立提案（判定层永久排除）。

## 4 接口与前端
- 前缀 `/api/`；禁 undefined 进 query；中文名 `encodeURIComponent`；`/api/upload` 的 `save` 建条目、`attach` 只持久化。
- 🔴 光标：两个 pnpm 补丁缺一不可＋`flushSync()`＋丢非字符串 `detail.value`；⛔ 延迟上抛／不传 value／`defaultValue`／改 `Symbol.hasInstance`；全仓用 `ui/Textarea`。
- 🔴 下载打自家 `/api` 必须 `header: buildHeaders()`；service 自己 `unwrap`，出现 `.data?.data` 即契约断。
- 🔴 D-074/075（P-034图文混排，已发未面客）：textarea塞不了img⇒`[图N]`占位+RichText按slot插图；`question_inline_figures`(jsonb免迁移)+`question_inline_figure_urls`；无URL显`[图N]`不拿邻图顶；列表卡按slot带图，`inline-figure-runs.ts`切段A文档/B pdf原位插图、C不接。
- 🔴 D-076~086（查台账）：删除补偿/裁剪下限0.03/分节定位(判定层未动)/批量移动/页顶输入+题号回显/删题回退/资料夹/一次裁剪一题/换页先收编/裁答案；裁剪框量预览区高+最近手柄/附件带url+cropKey；答案页缩略图选页+连续裁+题号OCR预置框；页码后端0基⇒唯一+1(禁`index||i+1`)；选择器按`subjectId`默认本科目；`hideLoadingSafe()`45处。
- 🔴 D-087：图片答案认附件/图+saveAnswer翻status；页图start_page增量10页/批(生产已上)；批量全选/取消(赋值)；复习资料逐题版式(保序/题答同块不跨页/题号+解答标签/弃BSSF页数变多，生产已上)。开发版2026.11.18.5。
- 🔴 D-088：复习资料去页头/题号30→15/题型留白(应用96pt、填空选择24pt、纯图默认应用；`question-space.ts` v2)；后端已上生产/未真机未提审未push。
- 🔴 D-079：冷启16s算进识别⇒顶60s失败，`ocr-warmup`+`warmupQuiet()`；`start()`探活重建；跨栏`extra`入库；裁剪卡死⇒同步起手+节流+`handleForceExit`。
- 令牌 X-Auth-Token 唯一被采信(`v1.<uid>.<exp>.<HMAC前40>`)；裸X-User-Id 401；免登录端点同步`PUBLIC_ROUTES`；必关ETag；`navigateBack`不重mount⇒`useDidShow`+`firstShowRef`+`silent:true`
- ⚠️ 音视频禁原生小写标签；`<Image>`/`<Video poster>`不发头⇒服务端直给`*_url`；🔴头像`avatarUrl`存对象key不能直接当src(实测401/本地500)⇒先`downloadFile`落`gk_avatar_local.path`；`profile`页`toImageSrc()`、D-066首页`homeAvatarSrc()`。🚨>60s请求走`POST /api/jobs`+轮询。
- 🔴 隐私同意真拦写：`guardPolicy(action)` 与 `guardPrivacy` 串行两道；`<PolicyConsent/>` 首页＋首帧；隐私接口失败禁 `catch {}`；Taro 4.1.9 走 `globalThis.wx`；政策 r11（升版＝全员重同意，随前端包生效）。`gk-netdisk-index.timer` 周日 04:23 必跑。面客说「资料库」；tab 页只能 `switchTab`。

## 5 AI / 品牌 / L3
- `ai_enabled` 默认 false，`requireAiEnabled()` 拦 chat/message/answer-search/search/solve；`mode=kb` 不连坐；改开关必 `invalidateUserFlags()`；🔴 个人主体⇒AI 助手对用户不可用（D-057，闸门保留）。名「成长学童」。
- 🔴 \`STORAGE_DRIVER=local\`同步\`PUBLIC_ROUTES\`+\`STORAGE_PUBLIC_BASE_URL\`；Caddy\`handle\`包\`file_server\`；\`PROJECT_DOMAIN\`改必重建；Linux必设\`OCR_PYTHON\`+\`PPSV3_PYTHON\`+\`PADDLE_PDX_CACHE_HOME\`。生产\`STORAGE_PUBLIC_BASE_URL\`必须\`https://deep-root.cn\`(旧http IP⇒手机裂图)。
- 🔴 8080 是 Caddy 不是 PostgREST 直连：`/rest/v1/<table>?select=…` 回真实行才算通过；`service_role` 必须 BYPASSRLS。`:8080/api/health` 是空 200 假探针⇒真健康打 `:3000/api/health`（D-052）。唯一够格指标＝`0021` 到期首答正确率（0 行）。

## 6 发布与验证
- 发版前轮换 WX_SECRET 后必跑 `encrypt-env.mjs`；`release:check` 后 revert；生产 `WAKE_ENABLED=0`。🔴 发布门两阻断＝`urlCheck`／`__usePrivacyCheck__`；前提＝mp 后台域名白名单（含 `downloadFile`）＋隐私指引先办完。⚠️ 旧 IDE 1.06.2303220 把 `app.json ["__usePrivacyCheck__"]` 误报「无效」，不要删该字段。
- 🔴 mp 两项前置：实操只认 `docs/reports/mp后台-隐私指引7项与UGC声明-操作指引.md`（入口2、7 项短句、r11 后共享 5 条、§2.4.1、UGC 五类全勾、`method=1`、`audit_desc` 238 字）。共同前提＝先换 dist 重启＋上传 r11 前端包（r11 仍只开发版）。
- 🔴 个人主体不得做共享题库/UGC 分享；PIPL §16/23/25/15/28/29 逐条落地；教辅共享涉信息网络传播权。备案：包月≥3月、L3 到期⇒失效；禁教育培训文案；小程序备案≠域名备案；公安联网备案审核中(D-044)；首页 `<title>`／`<h1>` 与备案站名一致。
- 验证：`ide-verify.mjs --launch --marker "<特征串>"`；🔴 冷启动唯一解＝纯 Node 写 UTF-8 `.cmd` 交桌面 `explorer.exe`，只认 9222＋哨兵文件；⛔ Start-Process／WMI／schtasks 被挡。✅ gate 38/38、isolation 164、M52 10/10、M54 8/8、侧车实证 30/30；测试期禁真登录。

## 7 其它
- 复习排程真相源 `timeline/review.ts`（1→3→7→14→28 天），改间隔触发 M15 三处同步，前端不自算 plan；年级 12 档 `shared/grade.ts`＋镜像 `constants/grades.ts`，M26 守。
- CI `gate`＝build:server→build:weapp→M12 M13 M16；`R-算法-07` 竖式符号行丢失未修；`include_answers` 不传＝不含答案。🚨 20b 第 7 章标题不可动；批量改文档用脚本＋「命中 1 次」断言；M11 天数/时长只作展示不作判定。
- 🔴 本机删除守卫：`Remove-Item -Recurse`／`rm -rf`／`fs.rmSync` 被拦，`Add-Type`／COM 被禁⇒回收站 API 不可用。合规路径＝逐文件 `[System.IO.File]::Delete` 每批 10 个校验＋自底向上 `[System.IO.Directory]::Delete(p,$false)`；删前备份＋警告＋列清单。
