#!/usr/bin/env node
/**
 * 数据库迁移执行器（纯 Node ESM，无需编译）
 * ------------------------------------------------------------------
 * 目的：取代「记事本打开 .sql → 粘贴到 Supabase SQL Editor」的手工方式。
 * 手工粘贴的三个致命缺点（本项目已真实踩过）：
 *   1. 同名前缀文件极易拿错（曾有两个 0003_*.sql，只执行了其中一个）；
 *   2. SQL Editor 一次执行 = 一个隐式事务，任一语句报错则整批回滚，
 *      而界面只提示最后一行，容易误判为「执行成功」；
 *   3. 无法记录「哪些迁移跑过、哪些没跑」，状态全靠记忆。
 *
 * 本脚本：
 *   - 按文件名顺序执行 migrations/*.sql（0001 → 0007）；
 *   - 用 schema_migrations 表记录已执行文件（含内容 sha256），重复运行自动跳过；
 *   - 单个文件一个事务，失败立即回滚并精确报出文件名 + 错误位置；
 *   - 全部成功后 NOTIFY pgrst，强制刷新 PostgREST schema cache
 *     （否则新建的表在 REST 上仍会报 PGRST205 "Could not find the table"）；
 *   - 结尾打印 public schema 实际表清单，可直接核对。
 *
 * 用法：
 *   node server/scripts/migrate.mjs            # 执行所有未执行过的迁移
 *   node server/scripts/migrate.mjs --dry      # 干跑：只打印将要执行哪些文件
 *   node server/scripts/migrate.mjs --force    # 忽略已执行记录，全部重跑（脚本均为幂等）
 *   node server/scripts/migrate.mjs --only 0007_chat_schema.sql
 *   node server/scripts/migrate.mjs --ping     # 只验证连接串是否可用（推荐第一次先跑这个）
 *
 * 连接串（按优先级）：
 *   1) DATABASE_URL
 *   2) SUPABASE_DB_URL
 *   3) SUPABASE_URL / COZE_SUPABASE_URL + SUPABASE_DB_PASSWORD（自动拼直连串）
 *   全部从 server/.env 读取（也可直接用环境变量）。
 *   Supabase 获取：Dashboard → Project Settings → Database → Connection string → URI
 *   ⚠️ 必须用 URI（含密码），不是 anon/service_role key。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = path.resolve(__dirname, '..')
const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..')
const MIGRATIONS_DIR = path.resolve(PROJECT_ROOT, 'migrations')

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry')
const FORCE = argv.includes('--force')
const PING = argv.includes('--ping')
const onlyIdx = argv.indexOf('--only')
const ONLY = onlyIdx >= 0 ? argv[onlyIdx + 1] : null

/** 极简 .env 加载：不覆盖已有环境变量 */
function loadEnv() {
  for (const file of [path.join(SERVER_ROOT, '.env'), path.join(PROJECT_ROOT, '.env')]) {
    if (!fs.existsSync(file)) continue
    for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      let val = line.slice(eq + 1).trim()
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      if (process.env[key] === undefined) process.env[key] = val
    }
  }
}

/**
 * 连接串清洗：修掉从面板/文档复制时常见的两种畸形写法。
 * 实战案例（2026-10-19）：
 *   postgresql://postgres.<ref>:[pwd]@//aws-0-ap-southeast-1.pooler.supabase.com/:5432/postgres
 *   → host 前多了一对 //（UNC 风格残留），端口前多了一个 /，直接喂给 pg 会解析失败。
 */
function normalizeConn(raw) {
  let s = String(raw || '').trim()
  s = s.replace(/@\/\/+/g, '@')              // @//host → @host
  s = s.replace(/\/(\:\d{2,5})(?=\/|$)/, '$1') // host/:5432 → host:5432
  s = s.replace(/\s+/g, '')                  // 复制时夹带的空格/换行
  return s
}

/** 找出未替换的密码占位符：[YOUR-PASSWORD]、[*]、YOUR-PASSWORD */
function findPlaceholder(conn) {
  const bracket = /\[[^\]]*\]/.exec(conn)
  if (bracket) return bracket[0]
  if (/YOUR[-_]?PASSWORD/i.test(conn)) return 'YOUR-PASSWORD'
  return null
}

function resolveConn() {
  const direct = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL
  if (direct) return { conn: normalizeConn(direct), from: 'DATABASE_URL/SUPABASE_DB_URL' }

  const apiUrl = process.env.SUPABASE_URL || process.env.COZE_SUPABASE_URL
  const pwd = process.env.SUPABASE_DB_PASSWORD
  if (apiUrl && pwd) {
    let ref = ''
    try {
      ref = new URL(apiUrl).hostname.split('.')[0]
    } catch {
      /* 忽略 */
    }
    if (ref) {
      return {
        conn: `postgresql://postgres:${encodeURIComponent(pwd)}@db.${ref}.supabase.co:5432/postgres`,
        from: '拼接（SUPABASE_URL + SUPABASE_DB_PASSWORD，直连 5432）',
      }
    }
  }
  return { conn: null, from: null }
}

function redact(conn) {
  try {
    const u = new URL(conn)
    return `${u.protocol}//${u.username}:****@${u.host}${u.pathname}`
  } catch {
    return '(无法解析)'
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')

async function main() {
  loadEnv()

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  if (files.length === 0) {
    console.error(`[migrate] 未找到迁移文件：${MIGRATIONS_DIR}`)
    process.exit(1)
  }

  let todo = ONLY ? files.filter((f) => f === ONLY || f.includes(ONLY)) : files
  if (ONLY && todo.length === 0) {
    console.error(`[migrate] --only ${ONLY} 未匹配到任何迁移文件`)
    process.exit(1)
  }

  console.log('[migrate] 迁移目录：', MIGRATIONS_DIR)
  console.log('[migrate] 发现迁移：', files.length, '个')
  files.forEach((f) => console.log('   ·', f))

  const { conn, from } = resolveConn()
  if (!conn) {
    console.error('\n[migrate] ✗ 缺少数据库连接串。请在 server/.env 中配置任一：')
    console.error('   DATABASE_URL=postgresql://postgres:<密码>@<host>:5432/postgres')
    console.error('   SUPABASE_DB_URL=同上')
    console.error('   SUPABASE_DB_PASSWORD=<数据库密码>（配合已有的 SUPABASE_URL 自动拼接）')
    console.error('\n获取方式（Supabase 新版界面）：项目页顶部「Connect」按钮 → Session pooler → 复制 URI')
    console.error('⚠️ 注意：是「数据库连接串（含密码）」，不是 anon / service_role key。')
    console.error('   详细图文步骤见 docs/获取DATABASE_URL-操作指引.md')
    process.exit(2)
  }
  const placeholder = findPlaceholder(conn)
  if (placeholder) {
    console.error(`\n[migrate] ✗ 连接串里还有未替换的密码占位符：${placeholder}`)
    console.error('   把 [YOUR-PASSWORD] 换成真实数据库密码后重试。')
    console.error('   忘记密码：Supabase 项目页 Connect 面板 / Settings → Database → Reset password。')
    process.exit(2)
  }

  console.log('\n[migrate] 连接串来源：', from)
  console.log('[migrate] 目标：', redact(conn))
  if (/@db\..*supabase\.co/.test(conn)) {
    console.log('[migrate] ⚠️ 这是 Direct connection（IPv6）。国内网络大概率连接超时，建议换 Session pooler。')
  }

  if (DRY) {
    console.log('\n[migrate] --dry 干跑模式，未连接数据库。将执行：')
    todo.forEach((f) => console.log('   →', f))
    return
  }

  const client = new pg.Client({
    connectionString: conn,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  })

  try {
    await client.connect()
  } catch (e) {
    console.error('\n[migrate] ✗ 连接数据库失败：', e.message)
    console.error('\n排查（按概率排序）：')
    console.error('  ① 用了 Direct connection（db.<ref>.supabase.co:5432）—— 它默认走 IPv6，')
    console.error('     国内家庭/办公宽带基本连不上。请改用 Session pooler：')
    console.error('     postgresql://postgres.<ref>:<密码>@aws-0-<region>.pooler.supabase.com:5432/postgres')
    console.error('  ② 密码不对：Supabase 只在建库时显示一次，忘了去 Settings → Database 重置。')
    console.error('     密码含 & # ? 空格 等字符需 URL 编码（脚本会编码，但粘贴进 .env 请保持原样）。')
    console.error('  ③ 连接串没复制完整 / 少了 postgres 库名后缀。')
    console.error('\n详见 docs/获取DATABASE_URL-操作指引.md')
    process.exit(3)
  }

  try {
    // --ping：只验证连接串能否用，不执行任何迁移
    if (PING) {
      const { rows } = await client.query('select version()')
      console.log('\n[migrate] ✓ 连接成功')
      console.log('   Postgres:', String(rows[0]?.version || '').split(',')[0])
      const { rows: ts } = await client.query(`
        select table_name from information_schema.tables
         where table_schema = 'public' and table_type = 'BASE TABLE'
         order by table_name
      `)
      console.log(`   public 表 ${ts.length} 张：${ts.map((r) => r.table_name).join(', ')}`)
      return
    }

    await client.query(`
      create table if not exists schema_migrations (
        id          serial primary key,
        filename    text unique not null,
        checksum    text not null,
        executed_at timestamp with time zone not null default now()
      )
    `)

    const { rows: done } = await client.query('select filename, checksum from schema_migrations')
    const doneMap = new Map(done.map((r) => [r.filename, r.checksum]))

    let applied = 0
    let skipped = 0
    for (const file of todo) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
      const sum = sha256(sql)

      if (!FORCE && doneMap.has(file)) {
        if (doneMap.get(file) !== sum) {
          console.log(`\n[migrate] ⚠ 跳过 ${file}（已执行，但文件内容已变更；如需重跑请加 --force）`)
        } else {
          console.log(`\n[migrate] ⊘ 跳过 ${file}（已执行过）`)
        }
        skipped++
        continue
      }

      console.log(`\n[migrate] ▶ 执行 ${file} ...`)
      try {
        await client.query('begin')
        await client.query(sql)
        // 不用 $1 占位符：Transaction pooler（6543）不支持 prepared statement。
        // 值是文件名与 sha256（可控常量），单引号已转义，安全。
        const esc = (s) => `'${String(s).replace(/'/g, "''")}'`
        await client.query(
          `insert into schema_migrations (filename, checksum)
           values (${esc(file)}, ${esc(sum)})
           on conflict (filename) do update set checksum = excluded.checksum, executed_at = now()`,
        )
        await client.query('commit')
        console.log(`[migrate] ✓ ${file} 成功`)
        applied++
      } catch (e) {
        await client.query('rollback').catch(() => {})
        console.error(`\n[migrate] ✗ ${file} 失败（已回滚，数据库未受影响）`)
        console.error('   code   :', e.code || '-')
        console.error('   message:', e.message)
        if (e.position) console.error('   位置   : 第', e.position, '字符附近')
        console.error('\n请把上面这段错误发给我，或修正后重跑（脚本幂等，可反复执行）。')
        process.exit(4)
      }
    }

    // 刷新 PostgREST schema cache：否则新表在 REST 上仍报 PGRST205
    try {
      await client.query(`notify pgrst, 'reload schema'`)
      console.log('\n[migrate] 已通知 PostgREST 刷新 schema cache')
    } catch (e) {
      console.warn('\n[migrate] ⚠ PostgREST 缓存刷新失败（不影响建表）：', e.message)
    }

    const { rows: tables } = await client.query(`
      select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'
       order by table_name
    `)
    console.log('\n[migrate] public schema 现有表：')
    tables.forEach((r) => console.log('   ·', r.table_name))

    console.log(`\n[migrate] 完成：新增 ${applied} 个，跳过 ${skipped} 个。`)
  } finally {
    await client.end().catch(() => {})
  }
}

main().catch((e) => {
  console.error('[migrate] 未捕获异常：', e)
  process.exit(9)
})
