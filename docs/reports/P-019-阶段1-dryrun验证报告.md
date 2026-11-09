# P-019 阶段 1 · dry-run 实现与只读验证报告

> 日期：2026-11-09 21:1x–21:3x ｜ 关联：`P-019` §3.2 / §4、`decision-log.md` D-024、M41 ｜ 状态：**阶段 1 的 dry-run / 只读探测已完成，待评审是否批准 `--apply`**
> 拍板：思傅 2026-11-09「1进入阶段1；2加；3为2worker；4列为阶段2硬门」。
> 🔴 边界：**本轮零写生产库**——未执行 0031 迁移、未写 `netdisk_files` 三列、未写记账表、未部署、未重启 `gk-api`、未 push。`--apply` 仍由双重闸门硬拦。

---

## 1. 批准范围与四项落实

| # | 拍板 | 落实 |
|---|---|---|
| ① | 进入阶段 1 | 仍只 dry-run / 只读 `--probe`；`--doc --apply` 在 `main()` 与 `applyDocRun()` 双重闸门拒绝（实测 rc=1） |
| ② | 加薄文本复核队列 | `50 ≤ 有效字 < 200` ⇒ `text_status='review'`，写正文供人工复核，但 `question-objects-build.mjs` 只取 `ok` ⇒ 不进题目索引 |
| ③ | 全量 2 worker | `--doc` 下 `CONCURRENCY=2`，仍压在 `Math.min(2,…)` 事故铁律内；每 worker 独立 LO profile |
| ④ | 双次转换哈希对比列为阶段 2 硬门 | 判据与验收写入 D-024 与提案 §3.2，M41 B7 静态钉住；本轮完成 12 份**预实验**（§4），不替代正式验收 |

---

## 2. 实现清单

| 文件 | 改动 |
|---|---|
| `migrations/0031_doc_convert_done.sql` | 新增记账表：`(user_id, source_id)` 主键、`status` 五态 CHECK `ok/none/review/failed/too_big`、`text_sha256` / `docx_sha256` / 对象计数 / `convert_ms` / `engine_version`。**本轮未在生产执行** |
| `server/scripts/netdisk-extract-text.mjs` | 加 `--doc` opt-in（不带时 `BASE_SCOPE_SQL` 逐字不变）、`--probe N` 只读探测、`--apply` 双闸门、字体闸门、单次转换 + 独立 profile + `killpg` 超时 + 长尾回插重试、同源哈希、薄文本三态、2 worker |
| `server/scripts/verify/modules/41-doc-extract.mjs` | 新增 M41（10 条静态门）：判定层不变 / 0031 枚举 / 零写库 / 闸门 / 白名单三列 / `review` 不进索引 / 同源钉子与阶段 2 硬门 / 2 worker 护栏 / 方案 A 零回归 / 缓存与不宣称 |
| `P-019` 提案、`decision-log.md` D-024 | §3.2 拍板与阶段 2 硬门判据、§4 落实补记、§5 边界、§7 变更记录（历史行不涂改） |

**写库白名单（即便日后批准 `--apply` 也只碰这些）**：`netdisk_files.text_content / text_status / text_updated_at` 三列 + `doc_convert_done` 幂等 upsert；`writeRow` 带 `where id=$3 and user_id=$4` 并校 `rowCount===1`。不碰 `name/path/size_bytes/mtime/synced_at`、`question_objects`、任何图表与 `blob_objects`。

---

## 3. 验证矩阵（全部在 L3 生产机，只读）

| # | 验证项 | 实测结果 |
|---|---|---|
| 1 | `.doc` dry-run 统计 | 候选 **10,499 份 / 7,211 MB（7.0 GB）**，`text_status` 全 `pending`；分档 <1MB 8,263／1–5MB 2,090／5–20MB 137／20–40MB 9；`doc_convert_done` **未建**；输出 2 worker、复核队列、同源钉子、阶段 2 硬门 |
| 2 | 量-本口径修正 | 旧 P-008 线性模型（下载 0.9s + size/10 + 抽取 0.12s）**不含 `.doc→docx` 转换**，曾输出误导性的「串行约 3.2 小时」⇒ 已改为阶段 0 实测外推 **9.5 h（2 worker）**、含余量 9.5–10.0 h，**不作承诺** |
| 3 | 零回归（不带 `--doc`） | 输出仍是「方案 A docx 全量 + pdf<1MB + txt」，`docx 7,384 / pdf 3,724 …`，历史两条主分支逐字不变 |
| 4 | `--apply` 闸门负向 | `--doc --apply` ⇒ `抽取失败：P-019 阶段 1 只批准 dry-run / --probe…`，**rc=1**，未进入写库路径 |
| 5 | `--doc --probe 20`（`systemd-run` + `MemoryMax=1800M` + `CPUQuota=150%`） | **处理 20 份：ok=19、review=1、none=0、failed=0、环境失败=0、下载失败=0**；下载 0.01 GB；字体闸门 `StandardSymbolsPS.otf` 通过；`health=200`、`MemAvailable 2.94 GB`、收尾 `soffice=0`。**薄文本复核队列被真实样本命中 1 份** |
| 6 | 零写库基线 | 探测前 `pending/nonpending/table = 10499/0/no_table`；探测后 `10499/0/0/no_table`（新增「有正文行数」仍 0）⇒ **`netdisk_files` 与记账表一行未动**。本地与 L3 脚本 sha256 一致 `b5fcb5082b5efa2e` |

**门禁**：`npm run verify -- M41` **10/10**；`method:check` H1/H2/H3 全过（检查 17/140/2 处）；`verify:gate` **37/37**（M12 13、M13 9、M16 4、M18 11）；`cd server && npm run check:isolation` 扫描 **152 处** `.from()` 调用点，未发现缺用户隔离的查询。

---

## 4. 🔴 阶段 2 硬门的预实验（双次独立转换）

12 份分层样本（`big` 2 / `normal` 4 / `object_like` 4 / `scan` 2），每份用**两个全新独立 LO profile 各转一次**，两次产物分别走 `extractDocContent({kind:'docx'})`，比较 `stripNul(text).slice(0,200000)` 的 sha256。

| 指标 | 结果 |
|---|---|
| 文字流 `text_sha256` | **same=12 / diff=0 / other=0（一致率 100%）** |
| docx 二进制 `docx_sha256` | **same=0 / diff=12（12/12 全不同）** |
| 74 s 长尾文档 | 两次 **69,335 ms / 69,490 ms**，哈希一致 ⇒ 长尾稳定复现，是对象数导致而非随机退化 |
| scan 层 | 一份 104 字符 / 有意义 84 字，另一份 16 字 ⇒ 在阶段 1 口径下分别进 `review` / `none` |

### 三个必须写进结论的判断

1. **同源钉子只能钉文字流，不能钉文件**。LO 每次转换产出的 docx 二进制都不同（时间戳/内部 ID），但剥标签文字流 100% 一致 ⇒ `text_sha256` 是**唯一合法的同源校对判据**；`docx_sha256` 降级为诊断追溯列，已写进 0031 的列注释。阶段 3 抠图必须**复用同一次转换的同一份 docx 产物**，不能「重转一次再对齐」。
2. 🔴 **两套文字流口径不同**：阶段 0 压测用 `zipfile + re.sub(document.xml)` 只取正文；阶段 1 用 `extract_docx()`（含 `header*/footer*`、`<w:p`/`<w:br` 换行预处理）。同一份「扫描版」压测判 **0 字**、阶段 1 判 **84 字**。⇒ ① 阶段 0 的 **94% 可抽率与阶段 1 的 status 分布不可直接对比**；② `netdisk-inline-crop.py` 只读 `word/document.xml`，与 `extract_docx` 的坐标系是否一致**尚未在 `.doc` 转换产物上验证** ⇒ 列为**阶段 3 二次评审的专项硬门**，不是阶段 2 的（阶段 2 只用 `text_content` 切题）。
3. **预实验不替代正式验收**：D-024 的阶段 2 硬门仍要求 ≥20 份、含 `w:object>0`／≥5MB／scan 各档，且须在 `question-objects-build.mjs --apply` **之前**重跑并把样本清单与结论写进台账。本轮 12 份只作基线证据。

---

## 5. 边界与不宣称

- 本阶段只做**索引工程的准备与只读验证**：`text_content` 一行未写、`question_objects` 一行未加、`0031` 表未在生产建立 ⇒ **目前检索行为完全没变**。
- 不写命中提升／修复有效／误判归零／所有用户已可用／图形全覆盖／看懂图形；**不计算召回率**；库覆盖扩大 ≠ P0 六条硬闸放行；`question-match.ts` 一行未动、`CACHE_VERSION` 仍 v14；唯一够格指标 `0021 review_events` 仍 **0 行**。
- 12/12 文字流一致是**这 12 份样本**的结论，不外推全库；9.5–10 h 仍是线性外推、不作承诺。
- `review` 状态是「暂不进索引、留待人工复核」，**不是**「判定有正文」；`<50` 仍判 `none` 且 `text_content` 写 `null`，不留空串。

---

## 6. 清理、复跑与复现命令

- L3 上阶段 1 脚本以**新文件名** `/opt/gk/server/scripts/_p019-stage1.mjs` 放置，**未覆盖生产 `netdisk-extract-text.mjs`、未改 `server/dist`、未重启 `gk-api`**；验证后清理。临时目录 `/tmp/gk-doc-stage1-w*`、`/tmp/gk-doc-twin*`、样本/日志/临时 SQL 均已清理；`gk-doc-bench` / `gk-doc-probe` unit 已 `reset-failed`。
- 前置备份 `/opt/gk/server/backups/gk-db-20261109-190357.gkbk`（150 MB，读回自检通过）**保留**。

```bash
# 只读统计（不写库）
cd /opt/gk/server && node scripts/_p019-stage1.mjs --doc
# 只读探测 20 份（仍零写库）
cd /opt/gk/server && node scripts/_p019-stage1.mjs --doc --probe 20
# 负向：应被闸门拒绝（rc=1）
cd /opt/gk/server && node scripts/_p019-stage1.mjs --doc --apply
# 本地门禁
npm run method:check && npm run verify:gate && npm run verify -- M41
```

---

## 7. 下一道门（待思傅逐题确认，未回复前不写实现代码、不写生产库）

| # | 待确认 | 说明 |
|---|---|---|
| ① | 是否批准阶段 1 的 `--apply` | 需先在 L3 执行 `0031` 迁移、单独批准、显式设 `DOC_EXTRACT_APPLY_APPROVED=1`；全量约 10,499 份 / 9.5–10 h，仍按 2 worker + cgroup + 独立 profile + 每 ~1,000 份换 profile 执行 |
| ② | 阶段 2 正式硬门何时重跑 | ≥20 份双次转换对比，结论入台账后才可申请 `question-objects-build.mjs --apply` |
| ③ | 阶段 3 是否立项「文字流坐标系专项验证」 | `extract_docx`（含页眉页脚）与 `netdisk-inline-crop.py`（仅 document.xml）在 `.doc` 转换产物上的对齐关系未验证；`w:object` 性质未定 |
| ④ | 是否继续只做开发态 | 与正式版发布 10 项前提、`0021` 出数死锁相关，按方向①另行决策 |
