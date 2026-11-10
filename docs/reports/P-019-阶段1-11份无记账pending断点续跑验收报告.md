# P-019 阶段 1 · 11 份无记账 pending 断点续跑验收报告

> 日期：2026-11-10 ｜ 关联提案：`P-019` ｜ 关联决策：`D-029`（思傅「11 份无记账 pending 断点续跑」）｜ 前置：`D-028`（全量幂等切题后 `pending=192`）
> 批准范围：**仅** 11 份无记账 pending 的 `.doc` 正文补抽；不含增量切题、不含 181 份 failed 重跑、不含抠图、不含判定层/部署/发版。

---

## 1. 结论

| 环节 | 结果 |
|---|---|
| 只读探测 | `--doc --probe 11 --only-ids`：处理 11 份 ⇒ **ok=3 / 环境失败=8 / failed=0 / 下载失败=0**，**一行未写**。8 份为稳定转换超时，**非 LO 死循环**（worker 持续推进、无孤儿 soffice、转换进程正常超时退出） |
| 写前备份 | `gk-db-20261110-115812.gkbk`（209,571.3 KB / 25 表 / 403,153 行），`--no-upload`、读回自检 sha256 一致 |
| 正式写入 | `--doc --apply --limit 11 --only-ids` ⇒ **ok=3 / 环境失败=8 保持 pending / failed=0 / 下载失败=0 / 零删除**，与探测逐项一致 |
| 数据变化 | `doc_ok` 10,144 → **10,147**；`ledger_ok` → 10,147；无记账 pending **11 → 8**；`doc_pending` 192 → **189** |
| 数据门 | `all_sha_match=10147/10147`、3 份新正文均非空且 sha_ok、`qo_total=656650` 不变、`answer_cache=0`、`question_inline_figures` 273,037 且 `.doc` 来源 **0 行** |
| 服务 | `/api/health=200`、`gk-api active`、孤儿 soffice **0**、`MemAvailable` 全程 ≥2.5 GB、两个 unit 均 `Result=success` |

🔴 **仍未进索引**：本次只补了 3 份正文，**没有跑增量幂等切题**（`question_objects` 保持 656,650 行）。按举证责任倒置，增量切题是独立写入动作，未并进本次授权，列为待点头项。

---

## 2. 为什么需要 `--only-ids`

阶段 1 全量结束后 `pending=192`，构成为 **181 份 failed**（`not_ole` 151 + `extract:nonzero-exit` 30）+ **11 份无记账**（8 份环境失败 + 3 份下载失败）。这 11 份全部属于同一个匿名号 `cc6d7b10-…`，而该号共有 192 份 pending ⇒ 原有 `--user` / `--limit` 都**无法精确限定**到 11 份，直接跑会连带重跑 181 份已判定 failed 的文档。

因此给 `server/scripts/netdisk-extract-text.mjs` 增加 `--only-ids <file>` 白名单：

- 文件逐行一个 id，启动时校验非空与 UUID 格式；
- 候选 SQL 追加 `and id::text = any($N::text[])`（🔴 `netdisk_files.id` 是 `varchar` 不是 `uuid`，用 `::uuid[]` 会报 `operator does not exist: character varying = uuid`）；
- **不带 `--only-ids` 时 `idFilter` 为空串，历史候选口径逐字不变**；`applyRun`（非 `.doc` 路径）一行未动；
- 生产投的是新一次性脚本 `/opt/gk/server/scripts/_p019-resume11.mjs`，**不覆盖** `_p019-stage1.mjs`（阶段 1 全量原件）与主脚本（11-06 旧版）；
- M41 **10/10**、`verify:gate`、`method:check` 三门全过。

---

## 3. 探测：8 份「环境失败」是不是 LO 死循环

按 L3 铁律先做零写入探测，判据不是"有没有超时"，而是"**worker 会不会推进 / 会不会留孤儿进程 / 换 profile 有没有用**"：

| 观察 | 实测 | 判定 |
|---|---|---|
| worker 推进 | 2 个独立 LO profile 持续换文件（记录到 4 个不同 `fs_id`） | ✅ 在推进，不是单份卡死 |
| CPU 形态 | 两个 soffice 各 ~50%（cgroup `CPUQuota=100%` 限到 1 核），**不是**单进程 99.9% 空转 | ✅ 非死循环特征 |
| 超时行为 | 每份在 `DOC_CONVERT_TIMEOUT_BASE_MS=120s` × `DOC_MAX_TRIES=2` 后正常退出，脚本 `killpg(SIGKILL)` 清理 | ✅ 有界 |
| 收尾 | 探测结束 `soffice=0`、`MemAvailable` 回到 2.86 GB、`health=200`、无残留 `.doc` 临时文件 | ✅ 干净 |

⇒ 与全库唯一那份 `681b7b1d…`（`lo-hang-skip`，换 profile 无效）**不是同一类问题**。这 8 份是「转换超时的长尾文档」，重试仍失败，按脚本设计**保持 pending**、绝不写 `none`（写 none 等于把好文档永久判死）。

**8 份失败构成与阶段 1 日志吻合**：阶段 1 尾部记录「环境失败=8 下载失败=3 保持 pending」；本次探测「环境失败=8 下载失败=0」，说明 3 份是当时下载失败的临时故障、现已恢复，8 份是稳定的转换长尾。

---

## 4. 写入明细（3 份新 `ok` 正文）

| 文档 | 正文字数 | `sha_ok` | `U+FFFD` | 图标记数 |
|---|---|---|---|---|
| 12不定方程1981-2019年历年数学联赛50套真题WORD版分类汇编含详细答案.doc | 1,853 | ✅ | 无 | 274 |
| 初三化学上册+第六单元+《碳和碳的氧化物.doc | 17,069 | ✅ | 无 | 54 |
| 初中九年级化学下册全册试讲教案(人教版).doc | 50,444 | ✅ | **有** | 27 |

- `sha_ok` = `sha256(text_content)` 与 `doc_convert_done.text_sha256` 一致，同源钉子成立。
- 第 3 份含 `U+FFFD`，与全库 **142 份**同类写入瑕疵一致 ⇒ **P-020 的 F0 拦不住**（F0 只校「重转流 vs 记账哈希」，两者同样是写入流的哈希）。这是已知质量边界，本轮不修、另案登记。
- 3 份图标记合计 355 个，但 **`.doc` 来源 `question_inline_figures` 仍 0 行**——抠图未放行，未产图、未下图。

---

## 5. 写后数据门

| 项 | 写前 | 写后 |
|---|---|---|
| `doc_ok` / `doc_review` / `doc_none` | 10,144 / 66 / 97 | **10,147** / 66 / 97 |
| `doc_pending` | 192 | **189**（181 failed + 8 无记账） |
| 无记账 pending | 11 | **8** |
| `doc_convert_done` 总行 / `status='ok'` | 10,488 / 10,144 | **10,491** / **10,147** |
| `all_sha_match`（全库 ok 正文哈希一致） | 10,144 | **10,147 / 10,147** |
| `question_objects` | 656,650 | 656,650（**未切题**） |
| `answer_cache` | 0 | 0 |
| `question_inline_figures` / `.doc` 来源 | 273,037 / 0 | 273,037 / **0** |

零删除、零 `none` 误判、零 `review` 泄漏、`engine_version` 未新增。

---

## 6. 踩坑与纪律

1. **类型**：`netdisk_files.id` 是 `varchar`，白名单参数必须用 `::text[]` + `id::text`，用 `::uuid[]` 直接 `operator does not exist`。
2. **`/tmp` 属主顺序**：先 `mkdir`（ubuntu 属主）→ `scp` → 再 `chown -R gk:gk`。反过来会让 `scp` 以 ubuntu 写入 `gk:gk` 目录被拒（阶段 1 踩过同类 EACCES）。
3. **systemd-run 不继承 dotenvx**：unit 的 `bash -c` 里必须 `set -a; . ./.env; . ./.env.secrets; . ./.env.migrate; set +a`，并显式 `export OCR_PYTHON=/opt/gk/.venv-py/bin/python`（probe）与 `DOC_EXTRACT_APPLY_APPROVED=1`（apply，双闸门）。
4. **不与其它 soffice 任务并行**：本轮写入完成后才启动 P-020 阶段 3 抽样，遵守 L3 ≤2 worker / cgroup / `nice19` / `ionice -c3` / 独立 profile 铁律。

---

## 7. 复现命令

```bash
# 生成 11 个 id 白名单
ssh ubuntu@42.192.36.120 'sudo -u gk -H bash -c '"'"'set -a; . /opt/gk/server/.env.secrets; \
  . /opt/gk/server/.env.migrate; set +a; psql "$DATABASE_URL" -At \
  -f /tmp/gk-pend11-ids.sql > /tmp/gk-p019-resume11.ids'"'"''

# 只读探测（零写库）
sudo systemd-run --unit=gk-p019-resume11-probe --uid=gk -p MemoryMax=900M \
  -p CPUQuota=100% -p RuntimeMaxSec=1800 -p WorkingDirectory=/opt/gk/server \
  bash -c 'set -a; . ./.env; . ./.env.secrets; . ./.env.migrate; set +a; \
    export OCR_PYTHON=/opt/gk/.venv-py/bin/python; nice -n19 ionice -c3 \
    node scripts/_p019-resume11.mjs --doc --probe 11 \
    --only-ids /tmp/gk-p019-resume11.ids > /tmp/...-probe.out 2>&1'

# 写入（先备份：node scripts/db-backup.mjs --no-upload）
sudo systemd-run --unit=gk-p019-resume11-apply --uid=gk -p MemoryMax=900M \
  -p CPUQuota=100% -p RuntimeMaxSec=2400 -p WorkingDirectory=/opt/gk/server \
  bash -c 'set -a; . ./.env; . ./.env.secrets; . ./.env.migrate; set +a; \
    export DOC_EXTRACT_APPLY_APPROVED=1; export OCR_PYTHON=/opt/gk/.venv-py/bin/python; \
    nice -n19 ionice -c3 node scripts/_p019-resume11.mjs --doc --apply --limit 11 \
    --only-ids /tmp/gk-p019-resume11.ids > /tmp/...-apply.out 2>&1'
```

---

## 8. 边界与待办

- **8 份稳定的转换长尾仍 pending**，未写 `none`、未重跑 181 份 failed；`not_ole` 151 份真实格式定性需独立提案。
- **3 份新正文尚未进索引**（`question_objects` 未变）。若要兑现，需单独点头跑一次幂等 `question-objects-build.mjs --apply`（dry-run 21.7s 量级、增量极小）。
- 🔴 **抠图仍不放行**：P-020 Q5 / F4 / 阶段 2 小批量状态不变，`w:object` 未定性。
- 不宣称命中提升／修复有效／误判归零／所有用户已可用；不计算召回率；`0021 review_events` 仍 **0 行**。
- 继续开发态：未部署、未发版、未 push；`CACHE_VERSION` 仍 **v14**、判定层一行未动、未换 dist、未重启 `gk-api`。
