#!/usr/bin/env node
/**
 * P-018 / D-021：题干原位重建 —— 把 docx 里的几何图与公式按原文位置抠出来、入库存映射。
 *
 * 为什么要有这一步：
 *   P-017 的「原题快照」是整页一条横带贴在题干下面，图与公式虽然都在，但题干文字本身
 *   是残的（`extract_docx` 把 `<w:object>` 整块当标签剥掉），读起来是
 *   「关于x的一元二次方程␠␠有两个相等的实数根」。思傅 2026-11-08 拍板走 C：
 *   **直接从 doc 抠图，按字符偏移插回题干中间**。
 *
 * 两段式（node 管下载/入库，python 管解析/裁切）：
 *   ① 本脚本取「有题目对象的 docx 来源」→ 下载原文件 → 写 manifest.json；
 *   ② 调 `netdisk-inline-crop.py`：几何图取 docx 原图，公式按 PDF IMAGE bbox 精确裁切；
 *   ③ 读 result.json upsert `question_inline_figures`，图本体落 `figures/<2>/<sha>.webp`。
 *
 * 用法（在 server/ 下，先 `npx nest build` 保证 dist 是最新的）：
 *   node scripts/netdisk-inline-build.mjs                     # dry-run：只统计规模
 *   node scripts/netdisk-inline-build.mjs --apply --limit 3    # 小批量试跑
 *   node scripts/netdisk-inline-build.mjs --apply --shard 0/1  # 全量（单 worker）
 *   node scripts/netdisk-inline-build.mjs --apply --force      # 连已做过的重做
 *
 * 🔴 运行纪律（沿用 P-017 用事故换来的那套，别放宽）：
 *   一次只处理 1 份文档（BATCH 恒为 1）；每份开始前查可用内存 < 700MB 就等；
 *   单份超时 15 分钟；>20MB 的超大 docx 跳过留给专门批次；
 *   必须 `ionice -c3 nice -n19`；同时最多 1 个 worker。
 * 🔴 只写 `question_inline_figures`，绝不改 `question_objects` / `netdisk_files` / `question_figures`。
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
const WORK = process.env.INLINE_WORK_DIR || '/tmp/gkinline-work'
/** 本 worker 专属的 LibreOffice 用户配置目录（与 python 侧 lo_profile_arg() 同一路径） */
const LO_PROFILE = path.join(WORK, 'lo-profile')
const ENGINE = 'inline-v1'
const MIN_FREE_MB = Number(process.env.INLINE_MIN_FREE_MB || 700)
const DOC_TIMEOUT_MS = Number(process.env.INLINE_DOC_TIMEOUT_MS || 15 * 60_000)
const MAX_MB = Number(process.env.INLINE_MAX_MB || 20)
const MAX_OBJECTS = Number(process.env.INLINE_MAX_OBJECTS || 1500)

dotenv.config({ path: path.join(ROOT, '.env') })

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, d) => {
  const i = argv.indexOf(f)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const APPLY = has('--apply')
const FORCE = has('--force')
const LIMIT = Number(val('--limit', 0))
const SHARD = val('--shard', '')
const SOURCE = val('--source', '')

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const host = process.env.DB_HOST || process.env.POSTGRES_HOST || '127.0.0.1'
  const port = process.env.DB_PORT || process.env.POSTGRES_PORT || '5432'
  const user = process.env.DB_USER || process.env.POSTGRES_USER
  const pass = process.env.DB_PASSWORD || process.env.POSTGRES_PASSWORD
  const name = process.env.DB_NAME || process.env.POSTGRES_DB
  if (!user || !name) throw new Error('缺数据库连接配置（DATABASE_URL 或 DB_*）')
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(pass || '')}@${host}:${port}/${name}`
}

function storageDir() {
  return process.env.STORAGE_LOCAL_DIR || path.resolve(ROOT, '.local-storage')
}

function inShard(id) {
  if (!SHARD) return true
  const [i, n] = SHARD.split('/').map(Number)
  let h = 0
  for (let k = 0; k < id.length; k++) h = (h * 31 + id.charCodeAt(k)) % 100003
  return h % n === i
}

async function memAvailableMb() {
  try {
    const t = await fss.readFile('/proc/meminfo', 'utf8')
    const m = /MemAvailable:\s+(\d+) kB/.exec(t)
    return m ? Math.round(Number(m[1]) / 1024) : 99999
  } catch {
    return 99999
  }
}

async function waitForMemory(tag) {
  for (let i = 0; i < 60; i++) {
    const mb = await memAvailableMb()
    if (mb >= MIN_FREE_MB) return mb
    console.log(`[inline] ${tag} 可用内存 ${mb}MB < ${MIN_FREE_MB}MB，等 30s`)
    await new Promise((r) => setTimeout(r, 30_000))
  }
  throw new Error(`可用内存持续不足 ${MIN_FREE_MB}MB，停止`)
}

async function pendingSources(client) {
  const cond = FORCE
    ? ''
    : `and not exists (
         select 1 from question_inline_done d
          where d.source_id = nf.id and d.user_id = nf.user_id)`
  const { rows } = await client.query(
    `select nf.id as source_id, nf.user_id, nf.fs_id, nf.name, nf.size_bytes,
            count(qo.id)::int as objs
       from netdisk_files nf
       join question_objects qo
         on qo.source_id = nf.id and qo.user_id = nf.user_id
      where nf.ext = 'docx'
        and coalesce(nf.is_dir, false) = false
        and qo.stem_text is not null
        and length(qo.stem_text) >= 10
        ${cond}
      group by 1, 2, 3, 4, 5
      having count(qo.id) > 0
      order by count(qo.id) desc`,
  )
  return rows
}

async function objectsOf(client, sourceId, userId) {
  const { rows } = await client.query(
    `select object_index as index, coalesce(char_start, 0)::int as start,
            stem_text as stem, source_revision
       from question_objects
      where source_id = $1 and user_id = $2
      order by object_index
      limit $3`,
    [sourceId, userId, MAX_OBJECTS],
  )
  return rows
}

async function dryRun(client) {
  const rows = await pendingSources(client)
  const sized = rows.filter((r) => Number(r.size_bytes || 0) <= MAX_MB * 1048576)
  const tooBig = rows.length - sized.length
  const objs = sized.reduce((s, r) => s + Number(r.objs || 0), 0)
  console.log('===========================================================')
  console.log(`待处理 docx 来源   ${sized.length} 份（跳过 >${MAX_MB}MB ${tooBig} 份）`)
  console.log(`题目对象            ${objs} 个`)
  console.log(`估算：每份转换 8s + 每 100 个公式 20s ⇒ 约 ${((sized.length * 8 + objs * 0.2) / 3600).toFixed(1)} 小时`)
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

  const all = (await pendingSources(client)).filter(
    (s) => inShard(String(s.source_id)) && (!SOURCE || String(s.source_id) === SOURCE),
  )
  const sized = all.filter((s) => Number(s.size_bytes || 0) <= MAX_MB * 1048576)
  if (all.length > sized.length) {
    console.warn(`[inline] 跳过 ${all.length - sized.length} 份 >${MAX_MB}MB 的超大文件`)
  }
  const target = LIMIT > 0 ? sized.slice(0, LIMIT) : sized
  console.log(`[inline] 待处理 ${target.length} 份（候选 ${all.length}，shard=${SHARD || '-'}）`)

  const py = process.env.OCR_PYTHON || 'python3'
  const total = { files: 0, ok: 0, objs: 0, figures: 0, bytes: 0, rows: 0, failed: 0 }
  const t0 = Date.now()

  for (let i = 0; i < target.length; i++) {
    const s = target[i]
    const dir = path.join(WORK, String(s.source_id))
    await waitForMemory(`第 ${i + 1}/${target.length} 份`)
    await fss.rm(dir, { recursive: true, force: true }).catch(() => {})
    await fss.mkdir(path.join(dir, 'src'), { recursive: true })
    total.files++

    try {
      const buf = await nd.downloadByFsId(s.fs_id)
      if (!buf || !buf.length) throw new Error('下载为空')
      const docx = path.join(dir, 'src', `${s.fs_id}.docx`)
      await fss.writeFile(docx, buf)

      const objs = await objectsOf(client, s.source_id, s.user_id)
      if (!objs.length) throw new Error('无题目对象')
      const rev = objs[0].source_revision || ''
      const manifest = {
        docx,
        pdf: path.join(dir, 'src', `${s.fs_id}.pdf`),
        storageDir: sdir,
        objects: objs.map((o) => ({ index: o.index, start: o.start, stem: o.stem })),
      }
      const mfPath = path.join(dir, 'manifest.json')
      await fss.writeFile(mfPath, JSON.stringify(manifest))
      total.objs += objs.length

      const { stdout } = await exec(py, [path.join(ROOT, 'scripts/netdisk-inline-crop.py'), mfPath], {
        maxBuffer: 16 << 20,
        timeout: DOC_TIMEOUT_MS,
      }).catch(async (e) => {
        // 🔴 2026-11-08 压测第三个坑：python 被超时 kill 时，soffice 会变成孤儿进程
        // 继续吃 100% CPU（实测转了 15 分钟），而且同 worker 的下一份会连到这个孤儿
        // 实例上继续挂死。这里按本 worker 的 profile 目录精确清理。
        await exec('/usr/bin/pkill', ['-9', '-f', `UserInstallation=file://${LO_PROFILE}`])
          .catch(() => {})
        return { stdout: e.stdout || '' }
      })

      const resPath = path.join(dir, 'src', 'result.json')
      if (!fs.existsSync(resPath)) throw new Error(`无 result.json（${String(stdout).slice(0, 120)}）`)
      const res = JSON.parse(await fss.readFile(resPath, 'utf8'))
      const items = res.items || []
      const bytes = Number((res.stat || {}).bytes || 0)
      total.figures += items.length
      total.bytes += bytes

      if (APPLY) {
        const chunk = 200
        for (let k = 0; k < items.length; k += chunk) {
          const part = items.slice(k, k + chunk)
          const cols = ['user_id', 'source_type', 'source_id', 'object_index', 'seq',
            'char_offset', 'kind', 'storage_key', 'width', 'height', 'size_bytes',
            'page_index', 'source_revision', 'engine_version']
          const vals = []
          const ph = part.map((it, idx) => {
            const b = idx * cols.length
            vals.push(s.user_id, 'netdisk', s.source_id, it.index, it.seq, it.offset, it.kind,
              it.key, it.w, it.h, it.size || 0, it.page, rev, ENGINE)
            return `(${cols.map((_, j) => `$${b + j + 1}`).join(',')})`
          })
          await client.query(
            `insert into question_inline_figures (${cols.join(',')})
             values ${ph.join(',')}
             on conflict (user_id, source_type, source_id, object_index, seq)
             do update set char_offset = excluded.char_offset, kind = excluded.kind,
               storage_key = excluded.storage_key, width = excluded.width,
               height = excluded.height, size_bytes = excluded.size_bytes,
               page_index = excluded.page_index,
               source_revision = excluded.source_revision,
               engine_version = excluded.engine_version, built_at = now()`,
            vals,
          )
        }
        total.rows += items.length
        await client.query(
          `insert into question_inline_done
             (user_id, source_id, objects, figures, bytes, status, engine_version)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (user_id, source_id) do update set objects = excluded.objects,
             figures = excluded.figures, bytes = excluded.bytes, status = excluded.status,
             engine_version = excluded.engine_version, scanned_at = now()`,
          [s.user_id, s.source_id, objs.length, items.length, bytes,
            items.length ? 'ok' : 'empty', ENGINE],
        )
      }
      total.ok++
      const secs = ((Date.now() - t0) / 1000).toFixed(0)
      console.log(
        `[inline] ${i + 1}/${target.length} ${String(s.name).slice(0, 28)} ` +
          `对象 ${objs.length} → 图 ${items.length}` +
          `${items.length ? '' : '（本份无可内联图，记 empty）'}（${secs}s 累计）`,
      )
    } catch (e) {
      total.failed++
      console.warn(`[inline] 失败 ${String(s.name).slice(0, 30)}: ${e instanceof Error ? e.message : e}`)
    } finally {
      await fss.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  console.log('===========================================================')
  console.log(JSON.stringify(total, null, 1))
  console.log(`耗时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`)
}

async function main() {
  const client = new pg.Client({ connectionString: databaseUrl() })
  await client.connect()
  try {
    if (!APPLY) {
      await dryRun(client)
      console.log('（dry-run，加 --apply 才执行）')
      return
    }
    await applyRun(client)
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error('[inline] 终止：', e)
  process.exit(1)
})
