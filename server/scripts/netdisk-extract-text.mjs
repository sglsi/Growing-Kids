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
 * 🔴 写库只碰三列：`text_content` / `text_status` / `text_updated_at`。
 *    绝不改 `name` / `path` / `size_bytes` / `mtime` / `synced_at`（P-008 §④⑤、报告 §10-5）。
 *
 * ⚠️ 抽取前后**禁止**跑 `netdisk-index.mjs --full-clean`：它会 DELETE 行，连带丢掉已抽正文。
 */
import fs from 'node:fs'
import path from 'node:path'
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

// 并发 ≤2（网盘个人号 QPS 上限实测约 9，留足余量）、每份之间 ≥300ms
const CONCURRENCY = Math.min(2, Math.max(1, Number(arg('--concurrency', '1')) || 1))
const GAP_MS = Math.max(300, Number(arg('--gap', '300')) || 300)
const BATCH = 50

// ============ 口径常量（必须与服务端 ensureText() 逐字一致）============
// 改这里等于改抽取口径，必须同步 server/src/netdisk/netdisk-search.service.ts
const MAX_PAGES = 200 // 整本书不必全抽，前 200 页足够覆盖题目所在章节
const MAX_TEXT_CHARS = Number(process.env.NETDISK_TEXT_MAX_CHARS ?? 200_000)
const MIN_MEANINGFUL_CHARS = 50 // 去掉空白后 < 50 字 ⇒ 判为扫描版（与 ensureText 一致）
const MAX_TEXT_BYTES = 40 * 1024 * 1024 // 超 40MB 不下载，直接标 too_big
const PDF_MAX_BYTES = 1 * 1024 * 1024 // 方案 A 边界：pdf 只抽 < 1MB

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

/** 方案 A 的候选条件：docx 全量 + pdf < 1MB + txt */
const SCOPE_SQL = `is_dir = false
  and coalesce(size_bytes, 0) > 0
  and coalesce(size_bytes, 0) <= ${MAX_TEXT_BYTES}
  and (ext = 'docx' or ext = 'txt' or (ext = 'pdf' and coalesce(size_bytes, 0) < ${PDF_MAX_BYTES}))`

const userClause = (params) => {
  if (!USER_ID) return ''
  params.push(USER_ID)
  return ` and user_id = $${params.length}`
}

// ============ dry-run：只统计、只出预估 ============
async function dryRun(client) {
  const params = []
  const uq = userClause(params)

  console.log('================ 方案 A dry-run（只读，不写库）================')
  console.log(`【范围】docx 全量 + pdf < 1MB + txt（P-008 §④②）`)
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
  console.log(`  .doc           ${fmt(o.doc || 0).padStart(7)} 份  （转换工具未装，需单独立项）`)
  console.log(`  视频/音频/图片 ${fmt(o.media || 0).padStart(7)} 份  （无文字层）`)
  console.log(`  > 40MB         ${fmt(o.too_big || 0).padStart(7)} 份  （docx/txt 超抽取上限，标 too_big 不下载）`)

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
  console.log('--- 量-本预估（实测模型：下载 0.9s + size_MB/10，抽取 0.12s/份）---')
  console.log(`  候选合计      ${fmt(totalFiles)} 份 / ${gb(totalBytes).toFixed(1)} GB  ⇒ 串行约 ${hours.toFixed(1)} 小时`)
  console.log(`  其中待处理    ${fmt(pending)} 份 / ${gb(pendingBytes).toFixed(1)} GB  ⇒ 串行约 ${pendingHours.toFixed(1)} 小时`)
  console.log(`  预计可抽      ≈ ${fmt(yieldOk)} 份（docx 95% / pdf<1MB 90% / txt 100%，按实测可抽率保守估）`)
  console.log(`  正文字节      ≈ ${fmt(mb(yieldOk * 9000))} MB 原始（按 9,000 字/份）`)
  console.log('')
  console.log('[dry-run] 未传 --apply，一行都没写。')
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
          const text = buf.toString('utf8')
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
 */
async function writeRow(client, row, text, status) {
  const { rowCount } = await client.query(
    `update netdisk_files
        set text_content = $1, text_status = $2, text_updated_at = now()
      where id = $3 and user_id = $4`,
    [text, status, row.id, row.user_id],
  )
  if (rowCount !== 1) {
    throw new Error(`写库行数不符：id=${row.id} user=${row.user_id}，实际 ${rowCount} 行`)
  }
}

async function main() {
  dotenv.config({ path: path.resolve(process.cwd(), '.env') })
  dotenv.config({ path: path.resolve(process.cwd(), '.env.secrets') })

  const client = new pg.Client({ connectionString: databaseUrl() })
  await client.connect()
  try {
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
