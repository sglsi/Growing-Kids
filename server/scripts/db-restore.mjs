#!/usr/bin/env node
/**
 * 数据库恢复（db-restore.mjs）—— 含「恢复演练」模式
 * ------------------------------------------------------------------
 * 为什么必须有演练模式：
 *   没有演练的备份等于没有备份。文件大小正常、能解密、能解压——都不代表能恢复。
 *   真正会翻车的地方在后面：迁移链跑不通、外键顺序错、序列没重置、列已改过。
 *   这些**只有真的灌进一个空库才会暴露**。
 *
 * 演练怎么做到不碰生产数据：
 *   用 postgres 超级用户（有 CREATEDB）建一个临时库 `gk_rehearsal_<时间戳>`
 *   → 在这个空库里原样跑一遍 migrations/
 *   → 灌入备份数据 → 逐表按"行内容多重集 sha256"比对
 *   → 删库。全程 public schema 一条语句都没碰。
 *   （migrator 角色没有 CREATE 权限，所以只能用超级用户串，见 .env.migrate.bak-postgres）
 *
 * 用法：
 *   node scripts/db-restore.mjs --verify                      演练最新一份本地备份
 *   node scripts/db-restore.mjs --verify --file backups/x.gkbk
 *   node scripts/db-restore.mjs --verify --netdisk gk-db-....gkbk   （先从网盘拉下来）
 *   node scripts/db-restore.mjs --inspect --file x.gkbk        只读清单，不连库、不建库
 *   node scripts/db-restore.mjs --apply --target <url> --yes   真恢复（会 TRUNCATE，慎用）
 *
 * 退出码：0 成功 ｜ 1 失败
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import pg from 'pg'
import {
  databaseUrl,
  maskUrl,
  pgConfig,
  PROJECT_ROOT,
  SERVER_ROOT,
  superUserUrl,
  withDatabase,
} from './lib/gk-env.mjs'
import { BACKUP_DIR, diagnoseDecryptFailure, ensurePassphrase, open } from './lib/backup-format.mjs'
import { Netdisk } from './lib/netdisk.mjs'

const SERVER_ROOT_FOR_LOG = SERVER_ROOT

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(`--${n}`)
function opt(n, d) {
  const i = argv.indexOf(`--${n}`)
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]
  const inline = argv.find((a) => a.startsWith(`--${n}=`))
  return inline ? inline.slice(n.length + 3) : d
}

const MODE_VERIFY = flag('verify')
const MODE_INSPECT = flag('inspect')
const MODE_APPLY = flag('apply')
const FORCE_PROD = flag('force-prod')
const ASSUME_YES = flag('yes')
const FILE_RE = /^gk-db-\d{8}-\d{6}\.gkbk$/

/** 与 db-backup.mjs 完全一致的序列化规则（比对能成立的前提） */
function jsonReplacer(_k, v) {
  return v instanceof Buffer ? { $b64: v.toString('base64') } : v
}
function jsonReviver(_k, v) {
  if (v && typeof v === 'object' && typeof v.$b64 === 'string' && Object.keys(v).length === 1) {
    return Buffer.from(v.$b64, 'base64')
  }
  return v
}

function fail(msg) {
  console.error(`[restore] ❌ ${msg}`)
  process.exit(1)
}

function latestLocal() {
  if (!fs.existsSync(BACKUP_DIR)) fail(`本地备份目录不存在：${BACKUP_DIR}`)
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => FILE_RE.test(f)).sort((a, b) => b.localeCompare(a))
  if (!files.length) fail('本地没有任何备份文件')
  return path.join(BACKUP_DIR, files[0])
}

/** 取备份文件 Buffer：--file > --netdisk > 本地最新 */
async function resolveSource() {
  const file = opt('file')
  if (file) {
    const p = path.resolve(file)
    if (!fs.existsSync(p)) fail(`文件不存在：${p}`)
    return { buf: fs.readFileSync(p), label: p }
  }
  const remoteName = opt('netdisk')
  if (remoteName) {
    const nd = new Netdisk()
    if (!nd.enabled()) fail(`网盘未启用（缺 ${nd.missingKeys().join(' / ')}）`)
    const buf = await nd.download(`${nd.root}/${remoteName}`)
    if (!buf) fail(`从网盘下载失败：${remoteName}`)
    console.log(`[restore] 已从网盘下载 ${remoteName}（${(buf.length / 1024).toFixed(1)} KB）`)
    return { buf, label: `netdisk:${remoteName}` }
  }
  const p = latestLocal()
  return { buf: fs.readFileSync(p), label: p }
}

/** 解密 + 解压 + 解析成 { manifest, rows: Map<table, object[]> } */
function parseDump(buf, passphrase, label = '') {
  let plainGz
  try {
    plainGz = open(buf, passphrase)
  } catch (e) {
    // ⚠️ 「口令代次不对」与「文件损坏」的报错完全相同（都是 GCM 失败），必须补一句区分，
    //    否则会重演 2026-10-31：把旧口令加密的可用备份误判成损坏而丢弃。
    const isNetdisk = String(label).startsWith('netdisk:')
    const name = isNetdisk ? String(label).slice(8) : label ? path.basename(String(label)) : ''
    const dirs = [BACKUP_DIR]
    if (label && !isNetdisk && fs.existsSync(String(label))) {
      dirs.unshift(path.dirname(path.resolve(String(label))))
    }
    let hint = ''
    for (const d of dirs) {
      hint = name ? diagnoseDecryptFailure(name, passphrase, d) : ''
      if (hint) break
    }
    throw new Error(`${e.message}${hint ? `\n  ${hint}` : ''}`)
  }
  const ndjson = zlib.gunzipSync(plainGz).toString('utf8')
  const rows = new Map()
  let manifest = null
  for (const line of ndjson.split('\n')) {
    if (!line.trim()) continue
    const obj = JSON.parse(line, jsonReviver)
    if (obj.__manifest) {
      manifest = obj.__manifest
      continue
    }
    if (!obj.t) continue
    if (!rows.has(obj.t)) rows.set(obj.t, [])
    rows.get(obj.t).push(obj.r)
  }
  if (!manifest) throw new Error('备份文件缺少 manifest（最后一行），文件可能被截断')
  return { manifest, rows, ndjson }
}

/** 每张表的行内容多重集 sha256：与行顺序、插入顺序无关，只比"内容是否一模一样" */
function tableDigest(rows) {
  const lines = rows.map((r) => JSON.stringify(r, jsonReplacer)).sort()
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex')
}

async function runMigrations(client, log) {
  const dir = path.join(PROJECT_ROOT, 'migrations')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()

  // ⚠️ schema_migrations 是 migrate.mjs 自己的记账表，**不在 migrations/ 里**。
  //    空库直接跑迁移会缺它 ⇒ 后面灌数据报 "relation does not exist"（演练踩过一次）。
  //    DDL 与 migrate.mjs 保持逐字一致，改一边必须改另一边。
  await client.query(`
    create table if not exists schema_migrations (
      id          serial primary key,
      filename    text unique not null,
      checksum    text not null,
      executed_at timestamp with time zone not null default now()
    )
  `)

  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8')
    await client.query('begin')
    try {
      await client.query(sql)
      await client.query('commit')
      log(`[restore]   迁移 ${f} ✓`)
    } catch (e) {
      await client.query('rollback').catch(() => {})
      throw new Error(`迁移 ${f} 执行失败：${e.message}`)
    }
  }
  return files
}

/** 按外键依赖拓扑排序（父表先插入）；自引用边忽略 */
async function topoOrder(client, tables) {
  const q = await client.query(
    `select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
       from pg_constraint c
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace`,
  )
  const parents = new Map(tables.map((t) => [t, new Set()]))
  for (const { child, parent } of q.rows) {
    const c = child.replace(/^public\./, '').replace(/"/g, '')
    const p = parent.replace(/^public\./, '').replace(/"/g, '')
    if (c === p) continue // 自引用：先插父行再回填，本脚本按单批插入，交给约束延迟即可
    if (parents.has(c) && tables.includes(p)) parents.get(c).add(p)
  }
  const out = []
  const done = new Set()
  let guard = 0
  while (out.length < tables.length && guard++ < tables.length * tables.length + 10) {
    for (const t of tables) {
      if (done.has(t)) continue
      const need = [...parents.get(t)].filter((p) => !done.has(p))
      if (!need.length) {
        out.push(t)
        done.add(t)
      }
    }
  }
  // 兜底：环引用（真实存在时只能靠 SET CONSTRAINTS ALL DEFERRED 或事后修）
  for (const t of tables) if (!done.has(t)) out.push(t)
  return out
}

async function insertRows(client, table, rows, log) {
  if (!rows.length) return
  const cols = Object.keys(rows[0])
  const colList = cols.map((c) => `"${c}"`).join(', ')
  const BATCH = Math.max(1, Math.min(200, Math.floor(60000 / Math.max(1, cols.length))))
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH)
    const values = []
    const params = []
    let n = 0
    for (const row of slice) {
      const ph = cols.map((c) => {
        params.push(row[c] === undefined ? null : row[c])
        n += 1
        return `$${n}`
      })
      values.push(`(${ph.join(', ')})`)
    }
    await client.query(`insert into public."${table}" (${colList}) values ${values.join(', ')}`, params)
  }
  log(`[restore]   ${table.padEnd(20)} 灌入 ${rows.length} 行`)
}

async function resetSequences(client) {
  const q = await client.query(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public'
        and (column_default like 'nextval%' or is_identity = 'YES')`,
  )
  for (const { table_name, column_name } of q.rows) {
    const seq = await client.query(`select pg_get_serial_sequence($1, $2) as s`, [
      `public.${table_name}`,
      column_name,
    ])
    const seqName = seq.rows[0]?.s
    if (!seqName) continue
    await client.query(
      `select setval($1, coalesce((select max("${column_name}") from public."${table_name}"), 0) + 1, false)`,
      [seqName],
    )
  }
}

/**
 * 把库里的 public schema 清空重建（等价于"回到刚建库的空状态"）。
 *
 * 为什么用「清 schema」而不是「删库再建」：
 *   Supabase 走 pooler，客户端 end() 之后服务端会话仍会滞留几十秒，
 *   `drop database` 会稳定报 "is being accessed by other users"（实测连试 10 次 50 秒仍失败）。
 *   而我们本来就是该库的客户端，`drop schema` 不会撞这个限制 —— 更快也更可靠。
 *   附带好处：演练结束后数据被擦掉，实例上**不残留一份用户数据副本**。
 */
async function resetSchema(client) {
  await client.query('drop schema if exists public cascade')
  await client.query('create schema public')
}

async function main() {
  const passphrase = ensurePassphrase(false).passphrase
  const { buf, label } = await resolveSource()
  const t0 = Date.now()

  let parsed
  try {
    parsed = parseDump(buf, passphrase, label)
  } catch (e) {
    fail(`解析备份失败：${e.message}`)
  }
  const { manifest, rows } = parsed
  // 0 行的表在 NDJSON 里没有任何行 ⇒ 解析后不在 map 里。显式补空数组，
  // 否则「空表在恢复后变成不存在」这类问题会被比对漏掉。
  for (const t of manifest.tables) if (!rows.has(t.name)) rows.set(t.name, [])
  const srcDigests = new Map([...rows.entries()].map(([t, r]) => [t, tableDigest(r)]))

  console.log(`[restore] 来源 ${label}`)
  console.log(
    `[restore] 备份时间 ${manifest.createdAt} ｜ ${manifest.tableCount} 表 / ${manifest.totalRows} 行 ｜ ` +
      `源库 ${manifest.databasePretty} ｜ ${manifest.pgVersion}`,
  )

  if (MODE_INSPECT) {
    console.log('\n表'.padEnd(24) + '行数')
    for (const t of manifest.tables) console.log(`  ${t.name.padEnd(22)} ${String(t.rows).padStart(6)}`)
    console.log(`\n迁移快照（${manifest.migrations.length} 个）：`)
    for (const m of manifest.migrations) console.log(`  ${m.file}  ${m.sha256.slice(0, 12)}`)
    return
  }

  // ---------------- 演练 ----------------
  if (MODE_VERIFY) {
    const suUrl = superUserUrl()
    // 固定库名：反复演练只用一个壳，不会在实例上越积越多
    const dbName = 'gk_rehearsal'
    const admin = new pg.Client(pgConfig(suUrl))
    await admin.connect()
    const log = (m) => console.log(m)

    let target = null
    try {
      const exists = (
        await admin.query('select 1 from pg_database where datname = $1', [dbName])
      ).rowCount
      if (!exists) {
        await admin.query(`create database "${dbName}"`)
        log(`[restore] 已建演练库 ${dbName}（${maskUrl(suUrl)}）`)
      } else {
        log(`[restore] 复用演练库 ${dbName}`)
      }

      target = new pg.Client(pgConfig(withDatabase(suUrl, dbName)))
      await target.connect()
      await resetSchema(target)
      log('[restore] public schema 已清空（回到空库状态）')

      {
        const migFiles = await runMigrations(target, log)
        log(`[restore] 迁移链 ${migFiles.length} 个文件全部执行成功`)

        const order = await topoOrder(target, [...rows.keys()])
        log(`[restore] 按外键依赖排序：${order.join(' → ')}`)

        await target.query('begin')
        for (const t of order) await insertRows(target, t, rows.get(t) || [], log)
        await resetSequences(target)
        await target.query('commit')
        log('[restore] 数据灌入完成，序列已重置')

        // 逐表比对：内容多重集 sha256
        let okCount = 0
        const mismatches = []
        for (const [t, srcRows] of rows.entries()) {
          const q = await target.query(`select * from public."${t}"`)
          const gotDigest = tableDigest(q.rows)
          const wantDigest = srcDigests.get(t)
          if (gotDigest === wantDigest) {
            okCount += 1
          } else {
            mismatches.push({ table: t, want: srcRows.length, got: q.rows.length })
          }
        }

        const gotTables = (
          await target.query(
            `select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`,
          )
        ).rows.map((r) => r.table_name)
        const missing = gotTables.filter((t) => !rows.has(t))
        const extra = [...rows.keys()].filter((t) => !gotTables.includes(t))

        console.log('')
        console.log(`[restore] ===== 演练结果 =====`)
        console.log(`[restore] 逐表内容比对：${okCount}/${rows.size} 表完全一致`)
        if (mismatches.length) {
          for (const m of mismatches) console.log(`[restore]   ✗ ${m.table}：备份 ${m.want} 行 / 恢复后 ${m.got} 行`)
        }
        if (missing.length) console.log(`[restore]   ⚠️ 迁移新建但备份中没有的表（正常）：${missing.join(', ')}`)
        if (extra.length) console.log(`[restore]   ⚠️ 备份有但迁移后不存在（schema 漂移）：${extra.join(', ')}`)

        const pass = !mismatches.length && !extra.length
        console.log(
          `[restore] ${pass ? '✅ 演练通过：这份备份可以在空库上完整恢复' : '❌ 演练未通过：见上面差异'}` +
            `（用时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`,
        )
        if (!pass) process.exitCode = 1

        // 演练留证据：计划任务跑的时候控制台输出会被任务计划程序丢掉，
        // 没有落盘记录就等于"没人能证明演练做过"（合规与自证都需要这条）。
        try {
          fs.mkdirSync(path.join(SERVER_ROOT_FOR_LOG, 'logs'), { recursive: true })
          const line =
            JSON.stringify({
              ts: new Date().toISOString(),
              script: 'db-restore',
              mode: 'verify',
              ok: pass,
              source: label,
              backupCreatedAt: manifest.createdAt,
              tables: rows.size,
              rows: manifest.totalRows,
              matched: okCount,
              mismatch: mismatches,
              driftTables: extra,
              ms: Date.now() - t0,
            }) + '\n'
          fs.appendFileSync(
            path.join(SERVER_ROOT_FOR_LOG, 'logs', `drill-${new Date().toISOString().slice(0, 10)}.log`),
            line,
            'utf8',
          )
        } catch (e) {
          console.error('[restore] 写演练日志失败（不阻断）', e?.message || e)
        }
      }
    } finally {
      // 演练数据是用户数据的副本 ⇒ 结束必须擦掉，实例上不留第二份（隐私）
      if (target) {
        await resetSchema(target).catch((e) => {
          console.error(`[restore] ⚠️ 清空演练数据失败（请手工 drop schema public cascade）：${e.message}`)
        })
        await target.end().catch(() => {})
      }
      await admin.end().catch(() => {})
    }
    return
  }

  // ---------------- 真恢复 ----------------
  if (MODE_APPLY) {
    const targetUrl = opt('target')
    if (!targetUrl) fail('--apply 必须显式给 --target <连接串>，不允许默认打生产库')
    const prodUrl = databaseUrl()
    const isProd = targetUrl === prodUrl
    if (isProd && !FORCE_PROD) fail('目标就是生产库：确认无误请再加 --force-prod')
    if (!ASSUME_YES) fail('--apply 会清空目标库现有数据，请加 --yes 表示明白')

    console.log(`[restore] ⚠️ 即将把备份灌入 ${maskUrl(targetUrl)}（现有数据将被 TRUNCATE）`)
    const client = new pg.Client(pgConfig(targetUrl))
    await client.connect()
    try {
      const order = await topoOrder(client, [...rows.keys()])
      const all = order.map((t) => `public."${t}"`).join(', ')
      await client.query('begin')
      await client.query(`truncate table ${all} restart identity cascade`)
      for (const t of order) await insertRows(client, t, rows.get(t) || [], console.log)
      await resetSequences(client)
      await client.query('commit')
      let okCount = 0
      for (const [t, srcRows] of rows.entries()) {
        const q = await client.query(`select * from public."${t}"`)
        if (tableDigest(q.rows) === srcDigests.get(t)) okCount += 1
        else console.error(`[restore]   ✗ ${t} 比对不一致（备份 ${srcRows.length} / 恢复 ${q.rows.length}）`)
      }
      console.log(`[restore] 恢复完成：${okCount}/${rows.size} 表内容一致`)
    } finally {
      await client.end().catch(() => {})
    }
    return
  }

  console.log('[restore] 未指定模式。用 --verify（演练）、--inspect（看清单）或 --apply（真恢复）')
  process.exitCode = 1
}

main().catch((e) => fail(e?.message || String(e)))
