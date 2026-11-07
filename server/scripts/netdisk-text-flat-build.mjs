#!/usr/bin/env node
/**
 * P-011 / D-014 · P2：`netdisk_files.text_flat` 离线回填。
 *
 * 为什么需要这一步：P-008 已把 10,454 份正文抽进 `text_content`，但检索 keys 是
 * **去标点**的（`normalizeForMatch`），正文里却全是标点与换行 ⇒ 直接 `ilike` 永远
 * 0 命中（报告 §3.2）。本脚本把正文归一化成 `text_flat`，让 `searchLocal()` 的
 * 正文通道真正能召回原题。
 *
 * 🔴 归一化口径**唯一真相源**是编译产物 `dist/shared/public-library.js#flatText()`
 *    （内部调 `question-match.ts#normalizeForMatch`）。禁止在脚本里另写正则，
 *    否则 keys 与正文又会错配。运行前先 `npx nest build`，脚本会检查产物是否比源码旧。
 *
 * 🔴 工程护栏（与 P-008 / P-010 构建脚本同规格）：
 *    · 默认 **dry-run**，只有 `--apply` 才写；
 *    · **只写 `text_flat` 一列**，绝不碰 `text_content` / `text_status` / 任何元数据；
 *    · 默认只补 `text_flat is null` 的行，重跑 `written 0`（幂等）；
 *    · `--all` 全量重算（正文被重新抽取后自愈，可挂每周 timer）；
 *    · PG `text` 不接受 U+0000 ⇒ `flatText()` 内部先剥 NUL；
 *    · 每行写回都校 `rowCount === 1`，不符立即抛错中止。
 *
 * 🔴 L3 长任务两条铁律（QA-16 §1 / P-008 踩过）：
 *    ① 远端 `nohup` + 远端日志 + 另开 ssh 轮询，别用 `ssh host 'node …'` 前台跑；
 *    ② `sudo -u gk -H bash -c '…'`（`.env.migrate` 是 600 gk:gk）。
 *
 * 用法（在 `server/` 下）：
 *   node scripts/netdisk-text-flat-build.mjs                       # 全库 dry-run
 *   node scripts/netdisk-text-flat-build.mjs --apply --limit 200  # 小批量试写
 *   node scripts/netdisk-text-flat-build.mjs --apply              # 全量（低峰窗口）
 *   node scripts/netdisk-text-flat-build.mjs --apply --all        # 全量重算
 *   node scripts/netdisk-text-flat-build.mjs --user <uuid>        # 只看/只写某个归属
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import pg from 'pg'
import dotenv from 'dotenv'

const require = createRequire(import.meta.url)

// ============ 参数 ============
const APPLY = process.argv.includes('--apply')
const ALL = process.argv.includes('--all')
const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(name)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const USER_ID = arg('--user')
const LIMIT = Number(arg('--limit', '0')) || 0
const BATCH = Math.min(500, Math.max(1, Number(arg('--batch', '200')) || 200))
const COMPILED = arg('--compiled', 'dist/shared/public-library.js')

// ============ 口径唯一真相源 ============
function loadFlatText() {
  const compiledPath = path.resolve(process.cwd(), COMPILED)
  const srcPath = path.resolve(process.cwd(), 'src/shared/public-library.ts')
  if (!fs.existsSync(compiledPath)) {
    throw new Error(`找不到编译产物 ${compiledPath}；先在 server/ 下跑 npx nest build`)
  }
  if (fs.existsSync(srcPath) && fs.statSync(compiledPath).mtimeMs < fs.statSync(srcPath).mtimeMs) {
    throw new Error('编译产物比 src/shared/public-library.ts 旧，先 npx nest build（禁止用旧口径回填）')
  }
  const mod = require(compiledPath)
  if (typeof mod.flatText !== 'function') {
    throw new Error(`${COMPILED} 没有导出 flatText()`)
  }
  // 自检：与 question-match.ts 的 normalizeForMatch 口径逐字一致
  const sample = 'AB=6，平行四边形 ABCD！\u0000\n第 3 题'
  if (mod.flatText(sample) !== 'AB6平行四边形ABCD第3题') {
    throw new Error('flatText() 归一化口径异常（标点/空白/NUL 未清理干净）')
  }
  return mod.flatText
}

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const p = path.resolve(process.cwd(), '.env.migrate')
  if (!fs.existsSync(p)) throw new Error(`找不到 ${p}`)
  const line = fs.readFileSync(p, 'utf8').split(/\r?\n/)
    .find((l) => l.trim().startsWith('DATABASE_URL='))
  if (!line) throw new Error('.env.migrate 里没有 DATABASE_URL')
  return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
}

/**
 * 查询条件。🔴 `user_id` 固定占 `$1`，分页游标与 limit 从 `$2` 起，
 * 这样 dry-run / --apply / --all 三条路径的参数顺序完全一致，不会错位。
 */
const scopeSql = () => {
  const parts = [`is_dir = false`, `text_status = 'ok'`]
  if (!ALL) parts.push('text_flat is null')
  if (USER_ID) parts.push('user_id = $1')
  return parts.join(' and ')
}
const scopeParams = () => (USER_ID ? [USER_ID] : [])

// ============ dry-run ============
async function dryRun(client, flatText) {
  const scope = scopeSql()
  const params = scopeParams()
  const todo = await client.query(`select count(*)::int as n from netdisk_files where ${scope}`, params)
  const totalSql = `select count(*)::int as n from netdisk_files
      where is_dir = false and text_status = 'ok'${USER_ID ? ' and user_id = $1' : ''}`
  const total = await client.query(totalSql, scopeParams())

  // 抽样 20 份估算产出字符量（不把 9,450 万字全读进内存）
  const sample = await client.query(
    `select text_content from netdisk_files where ${scope} order by id limit 20`,
    scopeParams(),
  )
  const avgFlat = sample.rows.length
    ? Math.round(sample.rows.reduce((s, r) => s + flatText(r.text_content || '').length, 0) / sample.rows.length)
    : 0

  console.log('\n=== P2 text_flat 回填 · DRY-RUN（一行都不写）===')
  console.log(`模式            : ${ALL ? '--all 全量重算' : '只补 text_flat is null'}`)
  console.log(`已抽正文文件    : ${total.rows[0].n}`)
  console.log(`本次待处理      : ${todo.rows[0].n}`)
  console.log(`抽样平均归一化长: ${avgFlat} 字 / 份`)
  console.log(`预计新增正文量  : ${(todo.rows[0].n * avgFlat / 10000 / 10000).toFixed(2)} 千万字`)
  console.log(`写库列          : 仅 text_flat（不碰 text_content / text_status / 元数据）`)
  console.log('\n确认无误后加 --apply 才会写库。\n')
}

// ============ apply ============
async function apply(client, flatText) {
  const scope = scopeSql()
  let lastId = ''
  let scanned = 0
  let written = 0
  let chars = 0
  const started = Date.now()

  while (true) {
    const p = scopeParams()
    p.push(lastId, BATCH)
    const cursor = `$${p.length - 1}`
    const batchLimit = `$${p.length}`
    const { rows } = await client.query(
      `select id, user_id, text_content
         from netdisk_files
        where ${scope}
          and id > ${cursor}
        order by id
        limit ${batchLimit}`,
      p,
    )
    if (rows.length === 0) break
    for (const row of rows) {
      lastId = row.id
      scanned++
      // 只补 null 模式：读出来后复查一次，避免与运行时 saveCache 并发覆盖
      if (!ALL) {
        const chk = await client.query(
          `select 1 from netdisk_files where id = $1 and user_id = $2 and text_flat is null`,
          [row.id, row.user_id],
        )
        if (chk.rowCount === 0) continue
      }
      const flat = flatText(row.text_content || '')
      const { rowCount } = await client.query(
        `update netdisk_files set text_flat = $1 where id = $2 and user_id = $3`,
        [flat, row.id, row.user_id],
      )
      if (rowCount !== 1) {
        throw new Error(`写库行数不符：id=${row.id} user=${row.user_id}，实际 ${rowCount} 行`)
      }
      written++
      chars += flat.length
      if (LIMIT > 0 && written >= LIMIT) break
    }
    if (LIMIT > 0 && written >= LIMIT) break
    if (written > 0 && written % 1000 === 0) {
      console.log(`  … 已写 ${written} 行 / ${(chars / 10000).toFixed(1)} 万字 / ${((Date.now() - started) / 1000).toFixed(1)}s`)
    }
  }

  console.log('\n=== P2 text_flat 回填 · APPLY 完成 ===')
  console.log(`扫描 ${scanned} 行 / 写入 ${written} 行 / 归一化 ${(chars / 10000).toFixed(1)} 万字`)
  console.log(`耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
  console.log(`写库列：仅 text_flat；源表 text_content / text_status 未改动\n`)
}

async function main() {
  dotenv.config({ path: path.resolve(process.cwd(), '.env') })
  dotenv.config({ path: path.resolve(process.cwd(), '.env.secrets') })
  const flatText = loadFlatText()
  const client = new pg.Client({ connectionString: databaseUrl() })
  await client.connect()
  try {
    // 0027 未跑时给一句人话，别把 PG 的「column does not exist」当成脚本坏了
    const col = await client.query(
      `select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'netdisk_files' and column_name = 'text_flat'`,
    )
    if (col.rowCount === 0) {
      throw new Error('目标库缺 netdisk_files.text_flat 列：先跑 migrations/0027_netdisk_text_flat.sql（本脚本只回填、不建列）')
    }
    if (!APPLY) await dryRun(client, flatText)
    else await apply(client, flatText)
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error(`[netdisk-text-flat] 失败: ${e instanceof Error ? e.stack : e}`)
  process.exit(1)
})
