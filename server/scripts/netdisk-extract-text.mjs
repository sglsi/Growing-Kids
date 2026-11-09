#!/usr/bin/env node
/**
 * 网盘学习资料「正文离线预抽」（P-008 / D-011 · 方案 A）
 *
 * 为什么要有这个脚本（思傅 2026-11-05 质疑）：
 *   现在搜题只拿「文件名 / 目录名」去 `ilike`，题干里的关键词（「平行四边形」「AB=6」）
 *   不出现在文件名里，这份资料就**永远进不了候选池** —— 明明网盘里有，却搜不到。
 *   正文只在「文件名已经命中」之后才被抽来**验证**，从不参与**召回**。
 *   本脚本把正文先抽出来落库，为后续「正文也参与召回」铺路。
 *
 * 🔴 本轮只批准到 dry-run（思傅 2026-11-05「先进行 A 并只跑 dry-run」）：
 *   · 不带 `--apply`：只统计、只出量-本预估，**一行都不写**；
 *   · 带 `--apply` 才会下载并写库。
 *
 * ✅ 2026-11-06 思傅批准试抽 1000 份并已执行（`--apply --limit 1000`）：
 *   28m59s / 下载 1.01 GB / 处理 1000 份 ⇒ ok 927 + none 73 / 环境失败 0 / 下载失败 0；
 *   `ok` 由 18 → 945，正文由 16.1 万字 → 866.6 万字。抽样 5 份内容与文件名严格对应，零串档。
 *   召回增量实测：「平行四边形」正文命中 109 份、文件名仅 9 份 ⇒ 100 份只能靠正文召回。
 *
 * ✅ 2026-11-06 思傅「继续抽取 4000 份」已执行（分两段，合计**处理 4,047 份 → 写入 4,043 行**）：
 *   第 1 段 2,297 份（`ssh` 前台一跑到尾，03:07 `Connection reset` 把远端 node 一起杀掉，日志截断在 1,550）；
 *   第 2 段 1,750 份（远端 `nohup` 托住，41 分钟跑完，下载 1.70 GB，未再中断）。
 *   ⇒ `ok` 3,802 + `none` 241，环境失败 2 + 下载失败 2（保持 `pending`）；库内 `ok` 945 → 4,747、正文 4,256.5 万字。
 *   docx 98.7%（均 11,299 字）/ pdf<1MB 84.7%；6 份抽验零串档；回滚锚点 `2026-11-05 16:15:09+00`。
 *
 * 🔴 在 L3 上跑的两条硬规矩（2026-11-06 踩过）：
 *   ① 长任务必须**远端 `nohup` + 远端日志**，再另开 ssh 轮询 —— `ssh host 'node …'` 一断连就 SIGHUP 杀进程；
 *   ② 必须 `sudo -u gk -H bash -c '…'` —— `/opt/gk/server/.env.migrate` 是 `600 gk:gk`，`ubuntu` 直跑必 `EACCES` 秒退。
 *
 * 覆盖范围（方案 A，实测划算的三类，见报告《资料库正文索引-B方案可行性与成本测算》§6）：
 *   docx 全量 + pdf < 1MB + txt   ≈ 11,190 份 / 10.8 GB
 *   明确不含：.doc（10,503 份，转换工具未装）、pdf ≥ 1MB（可抽率 0~12.5%）、
 *            扫描版 OCR（2.41s/页 + 1.6GB 驻留，1 万份量级不可行）。
 *
 * 用法（在 server/ 下，先 `npx nest build` 保证 dist 是最新的）：
 *   node scripts/netdisk-extract-text.mjs                       # 全库 dry-run（只读）
 *   node scripts/netdisk-extract-text.mjs --user <uuid>          # 只统计某个用户
 *   node scripts/netdisk-extract-text.mjs --apply --limit 200    # 小批量试抽 200 份
 *   node scripts/netdisk-extract-text.mjs --apply                # 全量（低峰窗口，并发 ≤2）
 *   node scripts/netdisk-extract-text.mjs --apply --force        # 连已抽过的重抽
 *
 * P-019 阶段 1（2026-11-09，思傅逐题确认「1进入阶段1；2加；3为2worker；4列为阶段2硬门」）：
 *   node scripts/netdisk-extract-text.mjs --doc                  # .doc dry-run（只读统计）
 *   node scripts/netdisk-extract-text.mjs --doc --probe 20       # 只读探测 20 份（下载+转换+抽取，零写库）
 *   node scripts/netdisk-extract-text.mjs --doc --apply          # 🔴 闸门硬拦：写生产库未授权
 *   全量默认 2 worker；薄文本 50~199 字标 review 不进索引；同源钉子 text_sha256 落 0031 记账表；
 *   阶段 2 硬门＝双次转换文字流哈希对比未通过不得切题入库（D-024）。
 *
 * 🔴 写库只碰三列：`text_content` / `text_status` / `text_updated_at`。
 *    绝不改 `name` / `path` / `size_bytes` / `mtime` / `synced_at`（P-008 §④⑤、报告 §10-5）。
 *
 * ⚠️ 抽取前后**禁止**跑 `netdisk-index.mjs --full-clean`：它会 DELETE 行，连带丢掉已抽正文。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import pg from 'pg'
import dotenv from 'dotenv'

// ============ 参数 ============
const APPLY = process.argv.includes('--apply')
const FORCE = process.argv.includes('--force')
const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(name)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const USER_ID = arg('--user')
const LIMIT = Number(arg('--limit', '0')) || 0

// ============ P-019 阶段 1：老式 .doc（思傅 2026-11-09 逐题确认「1进入阶段1；2加；3为2worker；4列为阶段2硬门」）============
// 🔴 本轮只批准 dry-run 与只读 --probe；`--apply` **未授权**，由 main() 的闸门硬拦，
//    须思傅单独批准并显式设置 DOC_EXTRACT_APPLY_APPROVED=1 才可写库。
// `--doc` 是 opt-in：不带它时 SCOPE_SQL 与历史行为逐字一致（docx/pdf<1MB/txt 零回归）。
const DOC_MODE = process.argv.includes('--doc')
const PROBE = Number(arg('--probe', '0')) || 0
const DOC_APPLY_APPROVED = process.env.DOC_EXTRACT_APPLY_APPROVED === '1'

// 全量并发配置按思傅拍板 = 2 worker；非 .doc 路径历史默认仍是 1。
const CONCURRENCY = Math.min(2, Math.max(1, Number(arg('--concurrency', DOC_MODE ? '2' : '1')) || 1))
const GAP_MS = Math.max(300, Number(arg('--gap', '300')) || 300)
const BATCH = 50

// ============ 口径常量（必须与服务端 ensureText() 逐字一致）============
// 改这里等于改抽取口径，必须同步 server/src/netdisk/netdisk-search.service.ts
const MAX_PAGES = 200 // 整本书不必全抽，前 200 页足够覆盖题目所在章节
const MAX_TEXT_CHARS = Number(process.env.NETDISK_TEXT_MAX_CHARS ?? 200_000)
const MIN_MEANINGFUL_CHARS = 50 // 去掉空白后 < 50 字 ⇒ 判为扫描版（与 ensureText 一致）
const MAX_TEXT_BYTES = 40 * 1024 * 1024 // 超 40MB 不下载，直接标 too_big
const PDF_MAX_BYTES = 1 * 1024 * 1024 // 方案 A 边界：pdf 只抽 < 1MB

// ---- P-019 阶段 1 口径（D-024；改这里等于改判定口径，必须同步 M41 与提案）----
const DOC_ENGINE_VERSION = 'doc-convert-v1'
const REVIEW_MIN_CHARS = MIN_MEANINGFUL_CHARS // 50：< 50 判 none（与 ensureText 一致）
const REVIEW_MAX_CHARS = 200 // 50~199 字进「薄文本复核队列」⇒ text_status='review'
const DOC_MAX_TRIES = 2 // 长尾隔离：转换超时/失败换 profile 回插重试一次（P-018 INLINE_MAX_TRIES 经验）
const DOC_CONVERT_TIMEOUT_BASE_MS = 120_000
const DOC_CONVERT_TIMEOUT_BIG_MS = 300_000
const DOC_BIG_BYTES = 20 * 1024 * 1024

// 环境类失败：**绝不能**记 none（none 的语义是「确认这份文档没有文字层」，记错就永久判死）
const ENV_FAIL_REASONS = new Set(['no-python', 'no-script', 'timeout'])
const ENV_FAIL_ABORT = 5 // 连续这么多份都是环境失败 ⇒ 环境不可用，立即中止（不白跑）

// 预计可抽率：来自 50 份真实样本分层抽样（报告 §4）
const YIELD_RATE = { docx: 0.95, pdf: 0.9, txt: 1.0 }
// 下载耗时模型：实测 0.9s 固定开销 + 约 10MB/s（报告 §5）
// 抽取耗时：实测 p50 69ms / p90 149ms，取 0.12s 保守
const EXTRACT_SECONDS = 0.12

// ============ 工具 ============
const nf = new Intl.NumberFormat('en-US')
const fmt = (n) => nf.format(Math.round(n))
const mb = (bytes) => bytes / 1024 / 1024
const gb = (bytes) => bytes / 1024 / 1024 / 1024
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const p = path.resolve(process.cwd(), '.env.migrate')
  if (!fs.existsSync(p)) throw new Error(`找不到 ${p}`)
  const line = fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith('DATABASE_URL='))
  if (!line) throw new Error('.env.migrate 里没有 DATABASE_URL')
  return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
}

/** 方案 A 的候选条件（历史口径；不带 --doc 时逐字不变，保证零回归） */
const BASE_SCOPE_SQL = `is_dir = false
  and coalesce(size_bytes, 0) > 0
  and coalesce(size_bytes, 0) <= ${MAX_TEXT_BYTES}
  and (ext = 'docx' or ext = 'txt' or (ext = 'pdf' and coalesce(size_bytes, 0) < ${PDF_MAX_BYTES}))`

/** P-019 阶段 1：只取 ext='doc'，单独成批，不混入既有 docx/pdf/txt 全量流程 */
const DOC_SCOPE_SQL = `is_dir = false
  and ext = 'doc'
  and coalesce(size_bytes, 0) > 0
  and coalesce(size_bytes, 0) <= ${MAX_TEXT_BYTES}`

const SCOPE_SQL = DOC_MODE ? DOC_SCOPE_SQL : BASE_SCOPE_SQL

const userClause = (params) => {
  if (!USER_ID) return ''
  params.push(USER_ID)
  return ` and user_id = $${params.length}`
}

// ============ dry-run：只统计、只出预估 ============
async function dryRun(client) {
  const params = []
  const uq = userClause(params)

  console.log(`================ ${DOC_MODE ? 'P-019 阶段 1 · .doc' : '方案 A'} dry-run（只读，不写库）================`)
  console.log(
    `【范围】${DOC_MODE ? '仅 ext=doc（soffice→docx 后复用 extract_docx 口径）' : 'docx 全量 + pdf < 1MB + txt（P-008 §④②）'}`,
  )
  console.log(`【用户】${USER_ID || '全部用户'}`)
  console.log('')

  // ① 候选池按扩展名
  const { rows: byExt } = await client.query(
    `select ext, count(*)::int as files,
            coalesce(sum(size_bytes), 0)::bigint as bytes,
            coalesce(round(avg(size_bytes)), 0)::bigint as avg_bytes
       from netdisk_files
      where ${SCOPE_SQL}${uq}
      group by ext order by files desc`,
    params,
  )
  const totalFiles = byExt.reduce((a, r) => a + r.files, 0)
  const totalBytes = byExt.reduce((a, r) => a + Number(r.bytes), 0)

  console.log('--- 候选池（按类型）---')
  for (const r of byExt) {
    console.log(
      `  ${String(r.ext).padEnd(5)} ${fmt(r.files).padStart(8)} 份  ` +
        `${fmt(mb(Number(r.bytes))).padStart(8)} MB  平均 ${(mb(Number(r.avg_bytes))).toFixed(2)} MB`,
    )
  }
  console.log(
    `  ${'合计'.padEnd(5)} ${fmt(totalFiles).padStart(8)} 份  ` +
      `${fmt(mb(totalBytes)).padStart(8)} MB (${gb(totalBytes).toFixed(1)} GB)`,
  )

  // ② 状态分布（决定「真正要处理多少」）
  const p2 = []
  const uq2 = userClause(p2)
  const { rows: byStatus } = await client.query(
    `select coalesce(text_status, '(null)') as st, count(*)::int as files,
            coalesce(sum(size_bytes), 0)::bigint as bytes
       from netdisk_files
      where ${SCOPE_SQL}${uq2}
      group by 1 order by files desc`,
    p2,
  )
  const pending = byStatus
    .filter((r) => r.st === 'pending' || r.st === '(null)')
    .reduce((a, r) => a + r.files, 0)
  const pendingBytes = byStatus
    .filter((r) => r.st === 'pending' || r.st === '(null)')
    .reduce((a, r) => a + Number(r.bytes), 0)

  console.log('')
  console.log('--- 状态分布 ---')
  for (const r of byStatus) {
    const note = r.st === 'ok' ? '⇒ 已有正文，跳过（--force 可重抽）' : r.st === 'none' ? '⇒ 判过无文字层，跳过' : ''
    console.log(`  ${String(r.st).padEnd(10)} ${fmt(r.files).padStart(8)} 份  ${note}`)
  }

  // ③ 体积分档（便于与报告 §7.1 对照）
  const p3 = []
  const uq3 = userClause(p3)
  const { rows: bySize } = await client.query(
    `select ext,
            case when size_bytes < 1048576 then 'a <1MB'
                 when size_bytes < 5242880 then 'b 1-5MB'
                 when size_bytes < 20971520 then 'c 5-20MB'
                 when size_bytes < 41943040 then 'd 20-40MB'
                 else 'e >40MB' end as bucket,
            count(*)::int as files,
            coalesce(sum(size_bytes), 0)::bigint as bytes
       from netdisk_files
      where ${SCOPE_SQL}${uq3}
      group by 1, 2 order by 1, 2`,
    p3,
  )
  console.log('')
  console.log('--- 体积分档 ---')
  for (const r of bySize) {
    console.log(
      `  ${String(r.ext).padEnd(5)} ${r.bucket.padEnd(10)} ${fmt(r.files).padStart(7)} 份  ${fmt(mb(Number(r.bytes))).padStart(7)} MB`,
    )
  }

  // ④ 不在本轮范围（如实排除，对应 M10「宣称不得超出能力」）
  const p4 = []
  const uq4 = userClause(p4)
  const { rows: outScope } = await client.query(
    `select
       count(*) filter (where is_dir = false and ext = 'pdf' and size_bytes >= ${PDF_MAX_BYTES})::int as pdf_big,
       count(*) filter (where is_dir = false and ext = 'doc')::int as doc,
       count(*) filter (where is_dir = false and ext in ('mp4','mp3','jpg','png'))::int as media,
       count(*) filter (where is_dir = false and ext in ('docx','txt') and coalesce(size_bytes,0) > ${MAX_TEXT_BYTES})::int as too_big
     from netdisk_files where 1 = 1${uq4}`,
    p4,
  )
  const o = outScope[0] || {}
  console.log('')
  console.log('--- 不在本轮范围（如实排除）---')
  console.log(`  pdf ≥ 1MB      ${fmt(o.pdf_big || 0).padStart(7)} 份  （实测可抽率 0~12.5%，不划算）`)
  console.log(`  .doc           ${fmt(o.doc || 0).padStart(7)} 份  （${DOC_MODE ? '本轮范围，见下' : 'P-019 已立项，不并入方案 A'}）`)
  console.log(`  视频/音频/图片 ${fmt(o.media || 0).padStart(7)} 份  （无文字层）`)
  console.log(`  > 40MB         ${fmt(o.too_big || 0).padStart(7)} 份  （docx/txt 超抽取上限，标 too_big 不下载）`)

  // ④-2 P-019 阶段 1 专属：记账表状态、复核队列、硬门清单（全部只读）
  if (DOC_MODE) {
    const { rows: tbl } = await client.query(`select to_regclass('doc_convert_done') is not null as ok`)
    console.log('')
    console.log('--- P-019 阶段 1 约束（只读）---')
    console.log(`  0031 记账表 doc_convert_done : ${tbl[0]?.ok ? '已建' : '未建（本轮不执行迁移、不写库）'}`)
    console.log(`  薄文本复核队列              : ${REVIEW_MIN_CHARS} ≤ 有效字 < ${REVIEW_MAX_CHARS} ⇒ text_status='review'（不进 question_objects）`)
    console.log(`  并发配置                    : ${CONCURRENCY} worker（思傅拍板全量 2 worker）`)
    console.log('  同源钉子                    : text_sha256 = sha256(写入 text_content 的文本)，阶段 3 抠图前必须校对')
    console.log('  阶段 2 硬门                 : 双次转换文字流哈希对比未通过 ⇒ 不得启动切题入库（D-024）')
    console.log('  --probe N                   : 只读探测 N 份（下载+转换+抽取，绝不写库）')
    console.log('  --apply                     : 未授权，main() 闸门硬拦')
  }

  // ⑤ 用户分布（多用户后按用户串行跑）
  const p5 = []
  const uq5 = userClause(p5)
  const { rows: byUser } = await client.query(
    `select user_id, count(*)::int as files
       from netdisk_files where ${SCOPE_SQL}${uq5}
      group by 1 order by files desc limit 5`,
    p5,
  )
  console.log('')
  console.log('--- 用户分布（top 5）---')
  for (const r of byUser) console.log(`  ${r.user_id}  ${fmt(r.files).padStart(8)} 份`)

  // ⑥ 量-本预估
  const yieldOk = byExt.reduce((a, r) => a + r.files * (YIELD_RATE[r.ext] ?? 0.9), 0)
  // 总量线性模型：固定开销 × 份数 + 总量 / 10MB/s + 抽取 × 份数
  const hours = (0.9 * totalFiles + totalBytes / 1024 / 1024 / 10 + totalFiles * EXTRACT_SECONDS) / 3600
  const pendingHours =
    (0.9 * pending + pendingBytes / 1024 / 1024 / 10 + pending * EXTRACT_SECONDS) / 3600

  console.log('')
  if (DOC_MODE) {
    // 🔴 P-008 的「下载 0.9s + size/10 + 抽取 0.12s」不含 .doc→docx 的 soffice 转换，
    //    照搬会给出约 3.2h 的错误低估（阶段 0 实测外推 9.5–10h），故 .doc 分支不输出旧模型。
    console.log('--- 量-本参照（P-008 线性模型不含转换，不适用；改用阶段 0 实测）---')
    console.log(`  候选合计      ${fmt(totalFiles)} 份 / ${gb(totalBytes).toFixed(1)} GB（全部待处理）`)
    console.log(`  阶段 0 实测外推 10,499 份 × 3.27 s/份（2 worker）≈ ${(10_499 * 3.27 / 3600).toFixed(1)} h；` +
      '含长跑 profile 退化/重试余量约 9.5–10.0 h，**不作承诺**')
    console.log('  阶段 0 样本内可抽 94/100（scan 层超配约 10 倍，**不外推全库、不作承诺**）')
  } else {
    console.log('--- 量-本预估（实测模型：下载 0.9s + size_MB/10，抽取 0.12s/份）---')
    console.log(`  候选合计      ${fmt(totalFiles)} 份 / ${gb(totalBytes).toFixed(1)} GB  ⇒ 串行约 ${hours.toFixed(1)} 小时`)
    console.log(`  其中待处理    ${fmt(pending)} 份 / ${gb(pendingBytes).toFixed(1)} GB  ⇒ 串行约 ${pendingHours.toFixed(1)} 小时`)
    console.log(`  预计可抽      ≈ ${fmt(yieldOk)} 份（docx 95% / pdf<1MB 90% / txt 100%，按实测可抽率保守估）`)
    console.log(`  正文字节      ≈ ${fmt(mb(yieldOk * 9000))} MB 原始（按 9,000 字/份）`)
  }
  console.log('')
  console.log(`[dry-run] 未传 --apply，一行都没写。${DOC_MODE ? '（--probe N 只做只读探测，同样不写库）' : ''}`)
  console.log('===========================================================')
}

// ============ apply：真抽（本提案未批准执行）============
async function applyRun(client) {
  // 环境自检：没配 python 抽取会整批失败。**只提醒、不中断**——
  // 服务侧已改成「环境类失败保持 pending」，不会把好文档洗成 none。
  if (!process.env.OCR_PYTHON && !process.env.OCR_VENV_DIR) {
    console.warn(
      '⚠️ 未设置 OCR_PYTHON：抽取依赖 pdf_tool.py 找得到 python（pypdfium2）。\n' +
        '   若下面全是 no-python 失败，请用 OCR_PYTHON=/path/to/python 重跑。',
    )
  }

  const { pathToFileURL } = await import('node:url')
  const dist = (p) => pathToFileURL(path.resolve(process.cwd(), 'dist', p)).href
  const { BaiduNetdiskService } = await import(dist('storage/baidu-netdisk.service.js'))
  const { extractDocContent } = await import(dist('ocr/pdf-tool.js'))
  const nd = new BaiduNetdiskService()
  if (!nd.enabled()) throw new Error('网盘未启用（缺 BAIDU_APP_KEY / BAIDU_SECRET_KEY）')

  const stat = { ok: 0, none: 0, skipped: 0, tooBig: 0, envFail: 0, dlFail: 0, written: 0, bytes: 0 }
  let cursor = ''
  let processed = 0

  for (;;) {
    if (LIMIT > 0 && processed >= LIMIT) break

    const params = [cursor, BATCH]
    const uq = userClause(params)
    const statusFilter = FORCE ? '' : ` and coalesce(text_status, 'pending') = 'pending'`
    const { rows } = await client.query(
      `select id, user_id, fs_id, name, ext, size_bytes
         from netdisk_files
        where ${SCOPE_SQL}${statusFilter}
          and id > $1${uq}
        order by id limit $2`,
      params,
    )
    if (!rows.length) break

    // 游标推进：用「按 id 排序 + id > cursor」，环境失败的不会被反复取到
    cursor = rows[rows.length - 1].id

    const worker = async (row) => {
      if (LIMIT > 0 && processed >= LIMIT) return
      processed++
      const ext = String(row.ext || '').toLowerCase()
      const sizeOk = Number(row.size_bytes) || 0
      try {
        // 超上限：不下载，直接标 too_big（省流量）
        if (sizeOk > MAX_TEXT_BYTES) {
          stat.tooBig++
          await writeRow(client, row, null, 'too_big')
          return
        }
        // txt / md 不必进 python，直接读
        if (ext === 'txt') {
          const buf = await nd.downloadByFsId(row.fs_id)
          if (!buf || !buf.length) {
            stat.dlFail++
            return // 下载失败不写库：保持 pending，下次重试
          }
          stat.bytes += buf.length
          // 先剥 NUL 再判字数：NUL 不在 `\s` 里，会被算成「有效字符」，
          // 一份全是 NUL 的 txt 会被误判成 ok（2026-11-06 实测）。
          const text = stripNul(buf.toString('utf8'))
          const meaningful = text.replace(/\s+/g, '').length
          if (meaningful < MIN_MEANINGFUL_CHARS) {
            stat.none++
            await writeRow(client, row, null, 'none')
          } else {
            stat.ok++
            await writeRow(client, row, text.slice(0, MAX_TEXT_CHARS), 'ok')
          }
          return
        }
        if (ext !== 'pdf' && ext !== 'docx') {
          // 不在方案 A 范围：脚本已用 SCOPE_SQL 过滤，走到这里说明条件写错了
          stat.skipped++
          console.warn(`  ⚠️ 不在范围却进了批：${ext} ${row.name}`)
          return
        }

        const buf = await nd.downloadByFsId(row.fs_id)
        if (!buf || !buf.length) {
          stat.dlFail++
          return
        }
        stat.bytes += buf.length

        const out = await extractDocContent({
          kind: ext === 'pdf' ? 'pdf' : 'docx',
          content: buf,
          textOnly: true,
          maxPages: MAX_PAGES,
          timeoutMs: 60_000,
        })
        if (!out.ok || !out.data) {
          // 🔴 环境类失败：不写库，保持 pending（写 none 等于永久判死）
          if (ENV_FAIL_REASONS.has(out.reason)) {
            stat.envFail++
            console.warn(`  ⚠️ 环境不可用（${out.reason}）：${row.name}，保持 pending`)
            return
          }
          stat.none++
          await writeRow(client, row, null, 'none')
          return
        }
        const text = (out.data.pages || []).map((p) => p.text).filter(Boolean).join('\n')
        const meaningful = text.replace(/\s+/g, '').length
        if (meaningful < MIN_MEANINGFUL_CHARS) {
          stat.none++
          await writeRow(client, row, null, 'none')
        } else {
          stat.ok++
          await writeRow(client, row, text.slice(0, MAX_TEXT_CHARS), 'ok')
        }
      } catch (e) {
        // 异常同样不写 none：多半是环境/网络问题，保持 pending 可重试
        stat.envFail++
        console.warn(`  ⚠️ 抽取异常：${row.name} — ${e instanceof Error ? e.message : e}`)
      }
    }

    // 简单 worker pool（并发 ≤2）
    let idx = 0
    const runners = Array.from({ length: CONCURRENCY }, async () => {
      while (idx < rows.length) {
        if (LIMIT > 0 && processed >= LIMIT) return
        const row = rows[idx++]
        await worker(row)
        await sleep(GAP_MS)
      }
    })
    await Promise.all(runners)

    console.log(
      `  游标 ${cursor.slice(0, 8)}…｜本批 ${rows.length} 份｜累计 ${processed}：` +
        `ok=${stat.ok} none=${stat.none} too_big=${stat.tooBig} 环境失败=${stat.envFail} 下载失败=${stat.dlFail}`,
    )

    // 连续环境失败 ⇒ 环境不可用，立即中止，不白跑
    if (stat.envFail >= ENV_FAIL_ABORT && stat.ok === 0) {
      throw new Error(
        `连续 ${stat.envFail} 份都是环境类失败，抽取环境不可用，已中止。` +
          `请检查 OCR_PYTHON / PPSV3_PYTHON 后重跑（未写库的行仍为 pending）。`,
      )
    }
  }

  console.log('\n================ 抽取结果 ================')
  console.log(`处理 ${processed} 份：ok=${stat.ok} none=${stat.none} too_big=${stat.tooBig}`)
  console.log(`跳过的：环境失败=${stat.envFail}（保持 pending） 下载失败=${stat.dlFail}（保持 pending）`)
  console.log(`下载量 ${gb(stat.bytes).toFixed(2)} GB`)
  console.log('==========================================')
}

/**
 * 写库：**只碰三列**，且带 user_id 双重限定（数据隔离红线）。
 * 行数不符立即抛错 —— 静默漏写会让「为什么搜不到」永远查不出来。
 *
 * 🔴 PostgreSQL 的 `text` 类型**不接受 U+0000**（NUL）：文件里带一个 NUL，
 *    整条 update 就抛 `invalid byte sequence for encoding "UTF8": 0x00`，
 *    这份文档永远停在 `pending`（2026-11-06 实测 `string.txt` / `eula.txt`）。
 *    NUL 对检索零价值 ⇒ 落库前剔除。放在这里而不是各分支里，
 *    是为了让 txt / pdf / docx 三条路径都被覆盖（docx 的 XML 里也会夹 NUL）。
 */
function stripNul(text) {
  return typeof text === 'string' ? text.replace(/\u0000/g, '') : text
}

async function writeRow(client, row, text, status) {
  // 🔴 P-019 --probe 只读：走完整链路但绝不写库（M41 B3 静态钉住）
  if (PROBE > 0) return
  const { rowCount } = await client.query(
    `update netdisk_files
        set text_content = $1, text_status = $2, text_updated_at = now()
      where id = $3 and user_id = $4`,
    [stripNul(text), status, row.id, row.user_id],
  )
  if (rowCount !== 1) {
    throw new Error(`写库行数不符：id=${row.id} user=${row.user_id}，实际 ${rowCount} 行`)
  }
}

// ============================================================================
// P-019 阶段 1：老式 .doc 补抽（L1 · 本轮仅 dry-run / 只读 --probe 获批）
//
// 🔴 同源铁律：.doc 是转换产物。抽正文与后续抠图必须复用「同一次转换」的
//    同一份 docx 文字流；本轮把写入 text_content 的文本 sha256 钉进
//    doc_convert_done.text_sha256，阶段 3 抠图前必须先校对（D-024）。
// 🔴 单次转换：每份 .doc 只转一次，docx 用完即删，不入库、不进 blob_objects。
// 🔴 薄文本：50~199 字标 review，写正文但不进 question_objects（只认 ok）。
// ============================================================================

/** 只数对象；文字流口径以 extractDocContent(extract_docx) 为准，不另起一套 */
const DOC_PROBE_PY = `import zipfile,sys
z=zipfile.ZipFile(sys.argv[1])
x=z.read('word/document.xml').decode('utf8','ignore')
print('%d %d %d' % (x.count('<w:drawing'),x.count('<w:object'),x.count('<m:oMath')))
`

const emptyDocRec = (row) => ({
  status: 'failed',
  meaningful_chars: 0,
  text_sha256: null,
  docx_sha256: null,
  drawing_count: 0,
  object_count: 0,
  omath_count: 0,
  convert_ms: 0,
  bytes: Number(row.size_bytes) || 0,
  engine_version: DOC_ENGINE_VERSION,
  notes: null,
})

function docWorkDir(worker) {
  const dir = path.join(os.tmpdir(), `gk-doc-stage1-w${worker}`)
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'profile'), { recursive: true })
  return dir
}

/** 每个 worker 独立 LO profile；超时 killpg 防孤儿（P-018 事故护栏） */
function convertDocToDocx(src, outDir, profile, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'nice',
      ['-n', '19', 'ionice', '-c3', 'soffice',
        `-env:UserInstallation=file://${profile}`, '--headless', '--norestore',
        '--convert-to', 'docx', '--outdir', outDir, src],
      { detached: true, stdio: 'ignore' },
    )
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* 已退出 */ }
      reject(new Error('doc_convert_timeout'))
    }, timeoutMs)
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`doc_convert_exit_${code}`))
    })
  })
}

function probeDocxObjects(docxPath) {
  try {
    const out = execFileSync('python3', ['-c', DOC_PROBE_PY, docxPath], {
      encoding: 'utf8', timeout: 30_000,
    }).trim().split(' ')
    return {
      drawing: Number(out[0]) || 0,
      object: Number(out[1]) || 0,
      oMath: Number(out[2]) || 0,
    }
  } catch {
    return { drawing: 0, object: 0, oMath: 0 }
  }
}

/** 字体闸门：跑转换前必查 Symbol 别名，防公式静默缺符号（P-018 M40 B9） */
function assertDocFontGate() {
  if (process.platform !== 'linux' || process.env.DOC_SKIP_FONT_CHECK === '1') return
  const out = execFileSync('fc-match', ['Symbol'], { encoding: 'utf8' }).trim()
  if (!/symbol/i.test(out)) {
    throw new Error(`Symbol 字体别名缺失（fc-match Symbol => ${out}），拒绝执行`)
  }
  console.log(`字体闸门通过：${out}`)
}

async function writeDocDone(client, row, rec) {
  if (PROBE > 0) return // 🔴 --probe 只读，连记账表也不写
  await client.query(
    `insert into doc_convert_done
       (user_id, source_id, status, meaningful_chars, text_sha256, docx_sha256,
        drawing_count, object_count, omath_count, convert_ms, bytes, engine_version, notes)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (user_id, source_id) do update set
       status = excluded.status, meaningful_chars = excluded.meaningful_chars,
       text_sha256 = excluded.text_sha256, docx_sha256 = excluded.docx_sha256,
       drawing_count = excluded.drawing_count, object_count = excluded.object_count,
       omath_count = excluded.omath_count, convert_ms = excluded.convert_ms,
       bytes = excluded.bytes, engine_version = excluded.engine_version,
       notes = excluded.notes, scanned_at = now()`,
    [row.user_id, row.id, rec.status, rec.meaningful_chars, rec.text_sha256,
      rec.docx_sha256, rec.drawing_count, rec.object_count, rec.omath_count,
      rec.convert_ms, rec.bytes, rec.engine_version, rec.notes],
  )
}

async function processDocRow(client, row, deps, stat, worker) {
  const rec = emptyDocRec(row)
  const wdir = docWorkDir(worker)
  const safeId = String(row.fs_id).replace(/[^\w.-]/g, '_')
  const src = path.join(wdir, `${safeId}.doc`)
  const outDir = path.join(wdir, 'out')
  const profile = path.join(wdir, 'profile')
  const docx = path.join(outDir, `${safeId}.docx`)
  try {
    const buf = await deps.nd.downloadByFsId(row.fs_id)
    if (!buf || !buf.length) {
      stat.dlFail++
      return // 下载失败保持 pending，下次重试
    }
    rec.bytes = buf.length
    stat.bytes += buf.length
    if (buf.subarray(0, 8).toString('hex') !== 'd0cf11e0a1b11ae1') {
      rec.notes = 'not_ole'
      stat.failed++
      await writeDocDone(client, row, rec)
      return
    }
    fs.writeFileSync(src, buf)

    const timeoutMs = Number(row.size_bytes) >= DOC_BIG_BYTES
      ? DOC_CONVERT_TIMEOUT_BIG_MS : DOC_CONVERT_TIMEOUT_BASE_MS
    let converted = false
    for (let t = 0; t < DOC_MAX_TRIES && !converted; t++) {
      fs.rmSync(docx, { force: true })
      fs.rmSync(profile, { recursive: true, force: true })
      fs.mkdirSync(profile, { recursive: true }) // 换 profile 隔离长尾/退化
      const t0 = Date.now()
      try {
        await convertDocToDocx(src, outDir, profile, timeoutMs)
        rec.convert_ms = Date.now() - t0
        converted = true
      } catch (e) {
        rec.notes = `convert_try${t + 1}:${String(e.message || e).slice(0, 80)}`
        if (t + 1 >= DOC_MAX_TRIES) {
          stat.envFail++ // 环境/长尾类：不写库，保持 pending
          return
        }
      }
    }
    const docxBuf = fs.readFileSync(docx)
    rec.docx_sha256 = crypto.createHash('sha256').update(docxBuf).digest('hex')
    const objs = probeDocxObjects(docx)
    rec.drawing_count = objs.drawing
    rec.object_count = objs.object
    rec.omath_count = objs.oMath

    // 与 docx 侧完全同一个抽取口径（extract_docx），char_start 坐标系天然一致
    const out = await deps.extractDocContent({
      kind: 'docx', content: docxBuf, textOnly: true,
      maxPages: MAX_PAGES, timeoutMs: 60_000,
    })
    if (!out.ok || !out.data) {
      if (ENV_FAIL_REASONS.has(out.reason)) {
        stat.envFail++ // 环境类不写 none，避免永久判死
        return
      }
      rec.notes = `extract:${out.reason || 'unknown'}`
      stat.failed++
      await writeDocDone(client, row, rec)
      return
    }
    const text = (out.data.pages || []).map((p) => p.text).filter(Boolean).join('\n')
    const meaningful = text.replace(/\s+/g, '').length
    const written = stripNul(text).slice(0, MAX_TEXT_CHARS)
    rec.meaningful_chars = meaningful
    // 🔴 同源钉子：钉的是「真正写进 text_content 的那份文本」
    rec.text_sha256 = crypto.createHash('sha256').update(written, 'utf8').digest('hex')
    rec.status = meaningful < REVIEW_MIN_CHARS ? 'none'
      : meaningful < REVIEW_MAX_CHARS ? 'review' : 'ok'
    if (rec.status === 'none') stat.none++
    else if (rec.status === 'review') { stat.review++; rec.notes = 'thin_text_review' }
    else stat.ok++

    await writeRow(client, row, rec.status === 'none' ? null : written, rec.status)
    await writeDocDone(client, row, rec)
  } catch (e) {
    stat.envFail++
    console.warn(`  ⚠️ .doc 处理异常：${row.name} — ${e instanceof Error ? e.message : e}`)
  } finally {
    fs.rmSync(src, { force: true })
    fs.rmSync(docx, { force: true })
  }
}

async function applyDocRun(client) {
  // 闸门再拦一次：即使绕过 main 的分支也不允许未授权写库
  if (APPLY && !DOC_APPLY_APPROVED) {
    throw new Error(
      'P-019 阶段 1 只批准 dry-run / --probe；--apply 写生产库需思傅单独批准，' +
      '并显式设置 DOC_EXTRACT_APPLY_APPROVED=1（D-024）',
    )
  }
  assertDocFontGate()
  const { pathToFileURL } = await import('node:url')
  const dist = (p) => pathToFileURL(path.resolve(process.cwd(), 'dist', p)).href
  const { BaiduNetdiskService } = await import(dist('storage/baidu-netdisk.service.js'))
  const { extractDocContent } = await import(dist('ocr/pdf-tool.js'))
  const nd = new BaiduNetdiskService()
  if (!nd.enabled()) throw new Error('网盘未启用（缺 BAIDU_APP_KEY / BAIDU_SECRET_KEY）')

  if (APPLY) {
    const { rows } = await client.query(`select to_regclass('doc_convert_done') is not null as ok`)
    if (!rows[0]?.ok) throw new Error('0031_doc_convert_done 迁移未执行，拒绝 --apply')
  }

  const stat = { ok: 0, none: 0, review: 0, failed: 0, tooBig: 0, envFail: 0, dlFail: 0, bytes: 0 }
  const limit = PROBE > 0 ? PROBE : LIMIT
  let cursor = ''
  let processed = 0

  for (;;) {
    if (limit > 0 && processed >= limit) break
    const params = [cursor, BATCH]
    const uq = userClause(params)
    const statusFilter = FORCE ? '' : ` and coalesce(text_status, 'pending') = 'pending'`
    const { rows } = await client.query(
      `select id, user_id, fs_id, name, ext, size_bytes
         from netdisk_files
        where ${SCOPE_SQL}${statusFilter}
          and id > $1${uq}
        order by id limit $2`,
      params,
    )
    if (!rows.length) break
    cursor = rows[rows.length - 1].id

    let idx = 0
    const runners = Array.from({ length: CONCURRENCY }, async (_, w) => {
      while (idx < rows.length) {
        if (limit > 0 && processed >= limit) return
        const row = rows[idx++]
        processed++
        if (Number(row.size_bytes) > MAX_TEXT_BYTES) {
          stat.tooBig++
          const rec = emptyDocRec(row)
          rec.status = 'too_big'
          await writeRow(client, row, null, 'too_big')
          await writeDocDone(client, row, rec)
          continue
        }
        await processDocRow(client, row, { nd, extractDocContent }, stat, w)
        await sleep(GAP_MS)
      }
    })
    await Promise.all(runners)
    console.log(
      `  游标 ${cursor.slice(0, 8)}…｜本批候选 ${rows.length} 份｜累计实处理 ${processed}：` +
        `ok=${stat.ok} review=${stat.review} none=${stat.none} failed=${stat.failed} ` +
        `too_big=${stat.tooBig} 环境失败=${stat.envFail} 下载失败=${stat.dlFail}`,
    )
  }

  console.log('\n================ .doc 正文补抽结果 ================')
  console.log(`${PROBE > 0 ? '[只读探测 --probe]' : '[写库 --apply]'} 处理 ${processed} 份：` +
    `ok=${stat.ok} review=${stat.review} none=${stat.none} failed=${stat.failed} too_big=${stat.tooBig}`)
  console.log(`跳过：环境失败=${stat.envFail}（保持 pending） 下载失败=${stat.dlFail}（保持 pending）`)
  console.log(`下载量 ${gb(stat.bytes).toFixed(2)} GB`)
  console.log(PROBE > 0
    ? '🔴 --probe 只读：一行都没写（netdisk_files 三列与 0031 记账表均未动）'
    : '写入：netdisk_files.text_content / text_status / text_updated_at 三列 + doc_convert_done')
  console.log('===================================================')
}

async function main() {
  dotenv.config({ path: path.resolve(process.cwd(), '.env') })
  dotenv.config({ path: path.resolve(process.cwd(), '.env.secrets') })

  const client = new pg.Client({ connectionString: databaseUrl() })
  await client.connect()
  try {
    // 🔴 P-019 阶段 1 闸门：--apply 未获授权（思傅 2026-11-09 只批 dry-run / 只读探测）
    if (DOC_MODE && APPLY && !DOC_APPLY_APPROVED) {
      throw new Error(
        'P-019 阶段 1 只批准 dry-run / --probe；--apply 写生产库需思傅单独批准，' +
        '并显式设置 DOC_EXTRACT_APPLY_APPROVED=1（D-024）',
      )
    }
    if (DOC_MODE && (APPLY || PROBE > 0)) {
      await applyDocRun(client)
      return
    }
    if (!APPLY) {
      await dryRun(client)
      return
    }
    await applyRun(client)
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error('抽取失败：', e instanceof Error ? e.message : e)
  process.exit(1)
})
