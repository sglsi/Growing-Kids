#!/usr/bin/env node
/**
 * 数据库备份（db-backup.mjs）—— 纯 Node，不依赖 pg_dump
 * ------------------------------------------------------------------
 * 背景（为什么不用 pg_dump）：
 *   本机未安装 PostgreSQL 客户端工具，而计划任务里"找不到命令"是典型的**静默失败**——
 *   任务显示已执行、备份目录空空如也，等到要恢复才发现三个月没有备份。
 *   所以这里用项目已有的 `pg` 依赖自己导数据，零外部二进制。
 *
 * 为什么只导数据、不导结构：
 *   本项目既定原则——`migrations/*.sql` 是 schema 的**唯一真相源**（Drizzle schema.ts 已失真，
 *   见 OPS-18 `R-工程-09`）。恢复流程就是「空库跑 migrations → 灌数据」，
 *   顺带每次演练都在验证迁移链本身是否可用。结构另存一份反而会与 migrations 漂移。
 *
 * 备份链路：
 *   一致性快照（REPEATABLE READ）→ 逐表导出 NDJSON → gzip → AES-256-GCM 加密
 *   → 本地 server/backups/ → 上传百度网盘 /apps/GrowingKids/GrowingKids备份/
 *   → 读回自检（解密+解压+比对 sha256，确认"这份文件真的能恢复"）
 *
 * 用法：
 *   node scripts/db-backup.mjs                 正常备份（本地 + 网盘）
 *   node scripts/db-backup.mjs --no-upload     只备份到本地（排障/离线）
 *   node scripts/db-backup.mjs --keep 30       本地与网盘各保留 30 份（默认 14）
 *   node scripts/db-backup.mjs --out D:/bk     自定义本地目录
 *   node scripts/db-backup.mjs --quiet         只输出一行 JSON（计划任务用）
 *
 * 退出码：0 成功 ｜ 1 致命失败 ｜ 2 本地成功但网盘上传失败（需人工关注）
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import pg from 'pg'
import { databaseUrl, env, maskUrl, pgConfig, PROJECT_ROOT, SERVER_ROOT } from './lib/gk-env.mjs'
import { BACKUP_DIR, ensurePassphrase, open, seal } from './lib/backup-format.mjs'
import { Netdisk } from './lib/netdisk.mjs'

// ---------------- 参数 ----------------
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]
  const inline = argv.find((a) => a.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : fallback
}

const NO_UPLOAD = flag('no-upload')
const QUIET = flag('quiet')
const KEEP = Math.max(1, Number(opt('keep', '14')) || 14)
const OUT_DIR = path.resolve(opt('out', BACKUP_DIR))
const PAGE_SIZE = 2000
export const FILE_RE = /^gk-db-(\d{8})-(\d{6})\.gkbk$/

const startedAt = Date.now()

function log(msg) {
  if (!QUIET) console.log(msg)
}

function writeRunLog(result) {
  try {
    const dir = path.join(SERVER_ROOT, 'logs')
    fs.mkdirSync(dir, { recursive: true })
    const day = new Date().toISOString().slice(0, 10)
    const line = JSON.stringify({ ts: new Date().toISOString(), script: 'db-backup', ...result }) + '\n'
    fs.appendFileSync(path.join(dir, `backup-${day}.log`), line, 'utf8')
  } catch (e) {
    console.error('[backup] 写运行日志失败（不阻断）', e?.message || e)
  }
}

/** JSON 序列化时把 Buffer 编成可逆标记（bytea 列极少，但不能想当然） */
function jsonReplacer(_k, v) {
  return v instanceof Buffer ? { $b64: v.toString('base64') } : v
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 文件名时间戳定长 ⇒ 字符串排序即时间排序；返回"第 keep 新"之外的旧文件 */
function pruneList(files, keep) {
  return [...files].sort((a, b) => b.localeCompare(a)).slice(keep)
}

function readMigrations() {
  const dir = path.join(PROJECT_ROOT, 'migrations')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((x) => x.endsWith('.sql'))
    .sort()
    .map((f) => {
      const body = fs.readFileSync(path.join(dir, f))
      return { file: f, bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') }
    })
}

async function main() {
  const url = databaseUrl()
  log(`[backup] 开始 · 源库 ${maskUrl(url)}`)

  const client = new pg.Client(pgConfig(url))
  await client.connect()
  let tmpPath = ''

  try {
    // ① 一致性快照：所有表必须同一时间点，否则会导出"有订单没用户"这种不可恢复的中间态
    await client.query('begin isolation level repeatable read read only')

    const ver = await client.query('select version() as v')
    const sizeRow = await client.query(
      'select pg_database_size(current_database()) as bytes, pg_size_pretty(pg_database_size(current_database())) as pretty',
    )
    const tbl = await client.query(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
    )
    const tables = tbl.rows.map((r) => r.table_name)
    if (!tables.length) throw new Error('public schema 里没有任何表，疑似连错库')

    // ② 逐表分页导出（ctid 键集分页：比 OFFSET 快，大表也不会一次性吃满内存）
    const lines = []
    const tableStats = []
    let totalRows = 0

    for (const name of tables) {
      let lastCtid = null
      let rows = 0
      for (;;) {
        const sql = lastCtid
          ? `select ctid::text as __ctid, * from public."${name}" where ctid > $1::tid order by ctid limit ${PAGE_SIZE}`
          : `select ctid::text as __ctid, * from public."${name}" order by ctid limit ${PAGE_SIZE}`
        const q = await client.query(sql, lastCtid ? [lastCtid] : [])
        if (!q.rows.length) break
        for (const row of q.rows) {
          lastCtid = row.__ctid
          delete row.__ctid
          lines.push(JSON.stringify({ t: name, r: row }, jsonReplacer))
          rows += 1
        }
        if (q.rows.length < PAGE_SIZE) break
      }
      tableStats.push({ name, rows })
      totalRows += rows
      log(`[backup]   ${name.padEnd(20)} ${String(rows).padStart(6)} 行`)
    }

    // ③ 清单放最后一行：写数据时还不知道最终行数
    const manifest = {
      format: 'gkbk',
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      source: maskUrl(url),
      pgVersion: String(ver.rows[0].v).split(',')[0],
      databaseBytes: Number(sizeRow.rows[0].bytes),
      databasePretty: sizeRow.rows[0].pretty,
      tables: tableStats,
      tableCount: tableStats.length,
      totalRows,
      migrations: readMigrations(),
      tool: 'server/scripts/db-backup.mjs',
      node: process.version,
    }
    lines.push(JSON.stringify({ __manifest: manifest }))
    await client.query('commit')

    const ndjson = lines.join('\n') + '\n'
    const plainGz = zlib.gzipSync(Buffer.from(ndjson, 'utf8'), { level: 9 })
    const payloadSha256 = crypto.createHash('sha256').update(plainGz).digest('hex')
    log(
      `[backup] 快照完成：${tableStats.length} 表 / ${totalRows} 行 / ` +
        `NDJSON ${(Buffer.byteLength(ndjson) / 1024).toFixed(1)} KB → gzip ${(plainGz.length / 1024).toFixed(1)} KB`,
    )

    // ④ 加密（导出含全体用户数据，落消费级网盘前必须先加密）
    const { passphrase, created } = ensurePassphrase(true)
    if (created) {
      log('')
      log('  ⚠️  已生成备份加密口令并写入 server/.env.secrets 的 BACKUP_PASSPHRASE')
      log('  ⚠️  同时托管在 server/backups/KEY-ESCROW.txt —— 请立刻抄进密码管理器！')
      log('  ⚠️  口令丢失 = 所有备份永久无法恢复，没有后门。')
      log('')
    }
    const sealed = seal(plainGz, passphrase)

    // ⑤ 落本地（先写 .tmp 再原子改名：计划任务被中途杀掉不会留下半个文件）
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const fileName = `gk-db-${stamp()}.gkbk`
    const filePath = path.join(OUT_DIR, fileName)
    tmpPath = `${filePath}.tmp`
    fs.writeFileSync(tmpPath, sealed)
    fs.renameSync(tmpPath, filePath)
    tmpPath = ''
    log(`[backup] 已写入 ${filePath}（${(sealed.length / 1024).toFixed(1)} KB）`)

    // ⑥ 读回自检：解密 → 解压 → 比对 sha256。"有大小"不等于"能恢复"
    const unsealed = open(fs.readFileSync(filePath), passphrase)
    const roundSha = crypto.createHash('sha256').update(unsealed).digest('hex')
    if (roundSha !== payloadSha256) throw new Error('读回自检失败：解密后 sha256 与写入前不一致')
    zlib.gunzipSync(unsealed) // 再验一次 gzip 完整性
    log('[backup] 读回自检通过（解密 + 解压 + sha256 一致）')

    // ⑦ 本地保留策略
    const localPruned = pruneList(
      fs.readdirSync(OUT_DIR).filter((f) => FILE_RE.test(f)),
      KEEP,
    )
    for (const f of localPruned) {
      try {
        fs.unlinkSync(path.join(OUT_DIR, f))
      } catch (e) {
        console.error('[backup] 删旧备份失败', f, e?.message || e)
      }
    }
    if (localPruned.length) log(`[backup] 本地清理 ${localPruned.length} 份旧备份（保留 ${KEEP} 份）`)

    // ⑧ 上传网盘
    const result = {
      ok: true,
      file: fileName,
      bytes: sealed.length,
      payloadSha256,
      tableCount: tableStats.length,
      totalRows,
      localPruned: localPruned.length,
      uploaded: false,
      uploadPath: '',
      uploadError: '',
      ms: 0,
    }

    if (!NO_UPLOAD) {
      const nd = new Netdisk()
      if (!nd.enabled()) {
        result.uploadError = `网盘未配置（缺 ${nd.missingKeys().join(' / ')}），仅保留本地副本`
        log(`[backup] ⚠️ ${result.uploadError}`)
      } else {
        try {
          result.uploadPath = await nd.upload(fileName, sealed)
          result.uploaded = true
          log(`[backup] 已上传 ${result.uploadPath}`)

          // 上传后核对大小：网盘"返回成功但文件不完整"是真实存在过的失败模式
          const listed = (await nd.list(nd.root)).find((f) => f.server_filename === fileName)
          if (!listed) throw new Error('上传后目录里找不到该文件')
          if (Number(listed.size) !== sealed.length) {
            throw new Error(`上传大小不一致：本地 ${sealed.length}B，网盘 ${listed.size}B`)
          }
          log(`[backup] 网盘校验通过（size ${listed.size}B 一致）`)

          const remote = (await nd.list(nd.root))
            .filter((f) => FILE_RE.test(String(f.server_filename)) && Number(f.isdir) !== 1)
            .map((f) => String(f.server_filename))
          const remotePruned = pruneList(remote, KEEP)
          for (const f of remotePruned) await nd.remove(`${nd.root}/${f}`)
          result.remotePruned = remotePruned.length
          if (remotePruned.length) log(`[backup] 网盘清理 ${remotePruned.length} 份旧备份（保留 ${KEEP} 份）`)
        } catch (e) {
          result.uploadError = e?.message || String(e)
          log(`[backup] ⚠️ 网盘上传失败：${result.uploadError}（本地副本已成功，可人工补传）`)
        }
      }
    }

    result.ms = Date.now() - startedAt
    writeRunLog(result)

    if (QUIET) {
      console.log(
        JSON.stringify({
          ok: true,
          file: result.file,
          rows: result.totalRows,
          uploaded: result.uploaded,
          uploadError: result.uploadError || undefined,
        }),
      )
    } else {
      log(`[backup] 完成，用时 ${(result.ms / 1000).toFixed(1)}s`)
    }

    process.exitCode = result.uploaded || NO_UPLOAD ? 0 : 2
  } finally {
    if (tmpPath) fs.rmSync(tmpPath, { force: true })
    await client.end().catch(() => {})
  }
}

main().catch((e) => {
  const msg = e?.message || String(e)
  console.error(`[backup] ❌ 失败：${msg}`)
  if (e?.stack && env('BACKUP_DEBUG') === '1') console.error(e.stack)
  writeRunLog({ ok: false, error: msg, ms: Date.now() - startedAt })
  process.exitCode = 1
})
