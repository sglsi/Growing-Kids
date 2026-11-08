#!/usr/bin/env node
/**
 * P-017 / D-020：参考例题「原题快照」离线生成（docx → PDF → 裁切 → WebP → 入库）
 *
 * 为什么要有这一步（思傅 2026-11-08）：
 *   「特别是数学，有很多图形的题目，当前题库中查寻到的相同类型题目只有文字的描述，没有图形」
 *   取证后还发现更严重的问题：docx 里公式是 OLE 对象（WMF 位图），`text_only` 抽取把它们
 *   一并吞了 —— 库内数学解析实际是「抛物线中，当时，；当时，或3」这种残缺串。
 *   所以这里生成的不是「补一张图」，而是**原题快照**：图形、公式、排版一起保住。
 *
 * 两段式（node 管下载/入库，python 管转 PDF/定位/裁切）：
 *   ① 本脚本按批取「带解析题目的 docx 来源」→ 下载原文件 → 写 manifest.json；
 *   ② 调 `netdisk-figure-crop.py`（soffice + pypdfium2）→ 产出 result.json；
 *   ③ 读结果 upsert `question_figures`，图本体落内容寻址存储 `figures/<2>/<sha>.webp`。
 *
 * 用法（在 server/ 下，先 `npx nest build` 保证 dist 是最新的）：
 *   node scripts/netdisk-figure-build.mjs                    # dry-run：只统计规模
 *   node scripts/netdisk-figure-build.mjs --apply --limit 30 # 小批量试跑
 *   node scripts/netdisk-figure-build.mjs --apply --shard 0/2 # 分片（可多 worker，但要看内存）
 *   node scripts/netdisk-figure-build.mjs --apply --force    # 连已生成过的重做
 *
 * 🔴 运行纪律（2026-11-08 用事故换来的，别当建议）：
 *   L3 只有 4 核 / 3.7G。soffice 转一份几百页带几千张图的 docx 能吃掉 1G+，
 *   两个 worker × `FIGURE_BATCH=8` 直接把机器压进 swap，连 sshd 都 fork 不出来
 *   —— 表现是「ping 通、22 端口 banner 超时、/api/health 也超时」，等于整机不可用。
 *   规矩：① `FIGURE_BATCH` 默认 2，别调大；② 同时最多 1 个 worker；
 *        ③ 必须带 `ionice -c3 nice -n19`（脚本已内置）；
 *        ④ 睡前/低峰跑，边跑边看 `free -m`，可用内存 < 700MB 脚本会自己等。
 *
 * 🔴 在 L3 上跑的规矩（与 netdisk-extract-text.mjs 一致）：
 *   长任务必须远端 `nohup` + 远端日志，用 `sudo -u gk -H bash -c '…'` 启动；
 *   `soffice` 已验证可在 gk 身份下运行（HOME=/opt/gk）。
 * 🔴 只写 `question_figures`，绝不改 `question_objects` / `netdisk_files`。
 */
import path from 'node:path'
import fs from 'node:fs'
import fss from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import dotenv from 'dotenv'
import pg from 'pg'

const exec = promisify(execFile)
const ROOT = process.cwd()
const WORK = process.env.FIGURE_WORK_DIR || '/tmp/gkfig-work'
const ENGINE = 'fig-v1'
// 🔴 批大小直接决定峰值内存：soffice 一次转 N 份，N 越大越容易把 4G 小机器打满。
//    2026-11-08 用 8 并发 2 个 worker 全量跑，把 L3 压到 sshd 都 fork 不出来（见 §运行纪律）。
//    安全默认改成 2；要提速先加内存，不要靠调大这个数。
const BATCH = Number(process.env.FIGURE_BATCH || 2)
// 内存红线：每批开始前检查，低于此值就等，别把机器拖进 swap（一旦进 swap 就再也退不出来）。
const MIN_FREE_MB = Number(process.env.FIGURE_MIN_FREE_MB || 700)
// 单批转换超时：soffice 遇到超大文件会卡到 30 分钟以上（2026-11-08 实测卡 38 分钟、RSS 1.9G），
// 必须设上限，超时就跳过这一批并记一笔，别让一个坏文件拖死整轮。
const BATCH_TIMEOUT_MS = Number(process.env.FIGURE_BATCH_TIMEOUT_MS || 8 * 60_000)
// 单份 docx 体积上限：超过就跳过（超大教辅留给专门的低峰批次，绝不混在全量里）
const MAX_MB = Number(process.env.FIGURE_MAX_MB || 20)

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const FORCE = argv.includes('--force')
const li = argv.indexOf('--limit')
const LIMIT = li >= 0 ? Number(argv[li + 1]) : 0
const si = argv.indexOf('--skip')
const SKIP = si >= 0 ? Number(argv[si + 1]) : 0
const shi = argv.indexOf('--shard')
const SHARD = shi >= 0 ? String(argv[shi + 1]) : ''   // 形如 "0/2"
const ui = argv.indexOf('--user')
const USER = ui >= 0 ? argv[ui + 1] : ''

/**
 * 稳定分片：按 source_id 的字符和取模。
 * 🔴 别用 `--skip/--limit` 切分并发：`pendingSources` 会排除「已有图」的来源，
 *    断点重启后列表变短、切片整体错位，会**留空洞**（漏掉一批永远不跑）。
 *    哈希分片只依赖 source_id，重启前后一致，天然幂等。
 */
function inShard(sourceId) {
  if (!SHARD) return true
  const [i, n] = SHARD.split('/').map(Number)
  if (!n) return true
  let h = 0
  for (let k = 0; k < sourceId.length; k++) h = (h * 31 + sourceId.charCodeAt(k)) % 100003
  return h % n === i
}

/**
 * 可用内存（MB）。读 `/proc/meminfo` 的 `MemAvailable`，含可回收缓存。
 * 非 Linux（本地只在 Windows 跑 dry-run）读不到就返回 Infinity，不拦。
 */
function freeMemMb() {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8')
    const av = /MemAvailable:\s+(\d+)\s*kB/.exec(m)
    return av ? Math.round(Number(av[1]) / 1024) : Infinity
  } catch {
    return Infinity
  }
}

/** 每批开工前等内存到位；长期不足就整体停下，绝不硬撑进 swap。 */
async function waitForMemory(where) {
  if (freeMemMb() >= MIN_FREE_MB) return
  console.warn(`[figure] ${where} 可用内存 ${freeMemMb()}MB < ${MIN_FREE_MB}MB，等待释放…`)
  let waited = 0
  while (freeMemMb() < MIN_FREE_MB) {
    await new Promise((r) => setTimeout(r, 15_000))
    waited += 15
    if (waited > 1800) {
      throw new Error(`可用内存长期不足（${freeMemMb()}MB），本轮停止；先查是不是别的进程在吃内存`)
    }
  }
  console.log(`[figure] ${where} 内存回到 ${freeMemMb()}MB，继续（等待 ${waited}s）`)
}

const HAS_IONICE = fs.existsSync('/usr/bin/ionice')
const PY_SCRIPT = path.join(ROOT, 'scripts/netdisk-figure-crop.py')

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const p = path.join(ROOT, '.env.migrate')
  const line = fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith('DATABASE_URL='))
  if (!line) throw new Error('.env.migrate 里没有 DATABASE_URL')
  return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
}

function storageDir() {
  return process.env.STORAGE_LOCAL_DIR || path.resolve(ROOT, '.local-storage')
}

/** 待处理来源：带解析题目的 docx，且（除非 --force）该来源还没有任何图 */
async function pendingSources(client) {
  const params = []
  let where = `q.has_solution and q.source_type = 'netdisk' and nf.ext = 'docx'`
  if (USER) {
    params.push(USER)
    where += ` and q.user_id = $${params.length}`
  }
  if (!FORCE) {
    where += ` and not exists (
      select 1 from question_figures f
       where f.user_id = q.user_id and f.source_type = q.source_type
         and f.source_id = q.source_id)`
  }
  const { rows } = await client.query(
    `select q.user_id, q.source_id, nf.fs_id, nf.name, nf.size_bytes,
            count(*) filter (where q.has_solution)::int as sols
       from question_objects q
       join netdisk_files nf on nf.id::text = q.source_id
      where ${where}
      group by 1,2,3,4,5
      order by sols desc`,
    params,
  )
  return rows
}

async function objectsOf(client, sourceId, userId) {
  const { rows } = await client.query(
    `select object_index, stem_text, source_revision, char_start
       from question_objects
      where user_id = $1 and source_type = 'netdisk' and source_id = $2
        and has_solution
      order by char_start asc`,
    [userId, sourceId],
  )
  return rows
}

/** 正文总长：用于把 char_start 折算成「预期页码」，公式缺失导致的字面不一致就不致命了 */
async function textLenOf(client, sourceId, userId) {
  const { rows } = await client.query(
    `select coalesce(length(text_content), 0)::int as len
       from netdisk_files where id::text = $1 and user_id = $2 limit 1`,
    [sourceId, userId],
  )
  return rows[0]?.len || 0
}

async function dryRun(client) {
  const rows = await pendingSources(client)
  const { rows: agg } = await client.query(
    `select count(*)::int as done_rows, coalesce(sum(size_bytes),0)::bigint as done_bytes
       from question_figures`,
  )
  const sols = rows.reduce((a, r) => a + r.sols, 0)
  console.log('=========== P-017 原题快照 dry-run（一行未写）===========')
  console.log(`待处理来源（docx，带解析）   ${rows.length} 份`)
  console.log(`覆盖题目对象                 ${sols} 个`)
  console.log(`已有快照行                   ${agg[0].done_rows} 行 / ${(Number(agg[0].done_bytes) / 1048576).toFixed(1)} MB`)
  console.log(`实测单价 43.7 KB/张 ⇒ 预估   ${((sols * 43.7) / 1048576).toFixed(1)} GB`)
  console.log(`实测 3s/份转换 + 62ms/张裁切 ⇒ 预估 ${((rows.length * 3 + sols * 0.062) / 3600).toFixed(1)} 小时`)
  console.log('===========================================================')
}

async function applyRun(client) {
  const { BaiduNetdiskService } = await import(
    pathToFileURL(path.resolve(ROOT, 'dist/storage/baidu-netdisk.service.js')).href
  )
  const nd = new BaiduNetdiskService()
  if (!nd.enabled()) throw new Error('网盘未启用（缺 BAIDU_APP_KEY / BAIDU_SECRET_KEY）')

  const sdir = storageDir()
  await fss.mkdir(sdir, { recursive: true })
  await fss.mkdir(WORK, { recursive: true })

  const sources = await pendingSources(client)
  const sharded = sources.filter((s) => inShard(String(s.source_id)))
  const sliced = SKIP > 0 ? sharded.slice(SKIP) : sharded
  const tooBig = sliced.filter((s) => Number(s.size_bytes || 0) > MAX_MB * 1048576)
  const sized = sliced.filter((s) => Number(s.size_bytes || 0) <= MAX_MB * 1048576)
  if (tooBig.length) {
    console.warn(
      `[figure] 跳过 ${tooBig.length} 份 >${MAX_MB}MB 的超大文件（留给专门的低峰批次，` +
        `别混在全量里：它们正是 2026-11-08 把机器卡住的那批）`,
    )
  }
  const target = LIMIT > 0 ? sized.slice(0, LIMIT) : sized
  console.log(
    `[figure] 待处理 ${target.length} 份（库内候选 ${sources.length} 份，` +
      `shard=${SHARD || '-'} skip=${SKIP} work=${WORK}）`,
  )

  const total = { files: 0, ok: 0, objs: 0, located: 0, cropped: 0, rows: 0, bytes: 0, dlMs: 0 }
  const t0 = Date.now()

  for (let i = 0; i < target.length; i += BATCH) {
    const batch = target.slice(i, i + BATCH)
    const dir = path.join(WORK, `b${String(i / BATCH).padStart(4, '0')}`)
    await waitForMemory(`批 ${i / BATCH}`)
    await fss.rm(dir, { recursive: true, force: true }).catch(() => {})
    await fss.mkdir(path.join(dir, 'src'), { recursive: true })

    const manifest = []
    for (const s of batch) {
      total.files++
      const td = Date.now()
      let buf = null
      try {
        buf = await nd.downloadByFsId(s.fs_id)
      } catch (e) {
        console.warn(`[figure] 下载失败 ${s.name}: ${e instanceof Error ? e.message : e}`)
      }
      total.dlMs += Date.now() - td
      if (!buf || !buf.length) continue
      const file = path.join(dir, 'src', `${s.fs_id}.docx`)
      await fss.writeFile(file, buf)
      const objs = await objectsOf(client, s.source_id, s.user_id)
      const totalLen = await textLenOf(client, s.source_id, s.user_id)
      manifest.push({
        fsId: s.fs_id,
        userId: s.user_id,
        sourceId: s.source_id,
        name: s.name,
        docx: file,
        totalLen,
        objects: objs.map((o) => ({
          index: o.object_index,
          stem: o.stem_text,
          rev: o.source_revision,
          start: o.char_start,
        })),
      })
    }
    if (!manifest.length) {
      await fss.rm(dir, { recursive: true, force: true }).catch(() => {})
      continue
    }
    await fss.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest))

    // ② python：转 PDF + 定位 + 裁切
    const py = process.env.OCR_PYTHON || 'python3'
    const pyArgs = [PY_SCRIPT, dir, sdir]
    // ionice -c3（idle 类）+ nice 19：只在机器空闲时吃 IO/CPU，绝不和生产 API 抢
    const [cmd, args] = HAS_IONICE
      ? ['ionice', ['-c', '3', 'nice', '-n', '19', py, ...pyArgs]]
      : ['nice', ['-n', '19', py, ...pyArgs]]
    try {
      const { stdout } = await exec(cmd, args, {
        maxBuffer: 8 << 20,
        timeout: BATCH_TIMEOUT_MS,
      })
      const st = JSON.parse(stdout.trim().split('\n').pop())
      total.ok += st.pdfOk || 0
      total.objs += st.objs || 0
      total.located += st.located || 0
    } catch (e) {
      console.warn(`[figure] python 阶段失败（batch ${i / BATCH}）：${e instanceof Error ? e.message : e}`)
      continue
    } finally {
      // soffice 有时不退出（超时被杀后更是留下孤儿子进程在空转），每批收尾清一次
      await exec('pkill', ['-f', 'soffice.bin']).catch(() => {})
    }

    // ③ 入库
    const resPath = path.join(dir, 'result.json')
    if (!fs.existsSync(resPath)) continue
    const res = JSON.parse(await fss.readFile(resPath, 'utf8'))
    const bySource = new Map(manifest.map((m) => [m.fsId, m]))
    for (const it of res.items || []) {
      const m = bySource.get(it.src)
      if (!m) continue
      const rev = (m.objects.find((o) => o.index === it.index) || {}).rev || ''
      const { rowCount } = await client.query(
        `insert into question_figures
           (user_id, source_type, source_id, object_index, page_index,
            storage_key, width, height, size_bytes, source_revision, engine_version)
         values ($1,'netdisk',$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (user_id, source_type, source_id, object_index) do update
            set page_index = excluded.page_index,
                storage_key = excluded.storage_key,
                width = excluded.width,
                height = excluded.height,
                size_bytes = excluded.size_bytes,
                source_revision = excluded.source_revision,
                engine_version = excluded.engine_version,
                built_at = now()`,
        [m.userId, m.sourceId, it.index, it.page, it.key, it.w, it.h, it.bytes, rev, ENGINE],
      )
      if (rowCount === 1) {
        total.rows++
        total.bytes += it.bytes
      }
    }

    await fss.rm(dir, { recursive: true, force: true }).catch(() => {})

    const el = (Date.now() - t0) / 1000
    console.log(
      `[figure] 批 ${Math.floor(i / BATCH) + 1}/${Math.ceil(target.length / BATCH)}  ` +
        `来源 ${total.files}/${target.length}  对象 ${total.objs}  定位 ${total.located}  ` +
        `入库 ${total.rows}  ${(total.bytes / 1048576).toFixed(1)}MB  ${el.toFixed(0)}s`,
    )
  }

  console.log('\n=========== 汇总 ===========')
  console.log(JSON.stringify({ ...total, elapsedSec: Math.round((Date.now() - t0) / 1000) }))
  console.log(
    `定位率 ${((100 * total.located) / Math.max(1, total.objs)).toFixed(1)}%  ` +
      `平均 ${(total.bytes / Math.max(1, total.rows) / 1024).toFixed(1)} KB/张`,
  )
}

async function main() {
  dotenv.config({ path: path.join(ROOT, '.env') })
  dotenv.config({ path: path.join(ROOT, '.env.secrets') })
  const client = new pg.Client({ connectionString: databaseUrl() })
  await client.connect()
  try {
    if (!APPLY) return await dryRun(client)
    await applyRun(client)
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error('生成失败：', e instanceof Error ? e.message : e)
  process.exit(1)
})
