#!/usr/bin/env node
/**
 * 清理「零数据匿名空壳」（P-007 / D-010，A 方案的存量部分）
 *
 * 背景：现网 197 个 users 行里绝大多数是零数据空壳。根因是
 *   `findOrCreateByDeviceId()` 对每个陌生 X-Device-Id 无条件 insert 一行；
 *   测试脚本 / 开发者工具重编译 / 反复重扫码不断换新串，而匿名号的
 *   「滑动续期」让空壳永不过期 ⇒ maintenance 的 expire_at 清理永远扫不到。
 *
 * 本脚本只做**存量清理**，不碰增量（增量由 anon-bootstrap-guard.ts 闸门治）。
 *
 * 用法（在 server/ 下）：
 *   node scripts/cleanup-empty-anonymous.mjs                 # dry-run：只列候选，不删
 *   node scripts/cleanup-empty-anonymous.mjs --apply        # 真删
 *   node scripts/cleanup-empty-anonymous.mjs --limit 50     # 最多处理多少个候选
 *
 * 🔴 P-007 明确：**本轮不在生产执行删除**。脚本只交付，由人在 L3 上
 *    先跑 dry-run、核对输出，再自行带 --apply 执行。
 *
 * 安全六条（M28 静态断言逐条钉住）：
 *  ① 默认 dry-run：dryRun = !APPLY，不传 --apply 一律不动库；
 *  ② 候选只取 is_anonymous = true，正式账号（有 openid）永不进候选；
 *  ③ 删前逐表查零数据：USER_DATA_TABLES 全表核对，任一表有一行即保留；
 *  ④ apply 时对每批**重新核对**零数据，防 dry-run 到 apply 之间有人写入；
 *  ⑤ 分批（BATCH_SIZE = 10）+ `DELETE ... RETURNING id` 校行数
 *     （等价 supabase 的 `.select('id')` 校行数），行数不符立即中止；
 *  ⑥ 不碰 ocr_results / blob_objects / knowledge_articles 等跨用户共享表；
 *     不显式删业务表行，靠 users 的 ON DELETE CASCADE（与 maintenance 同口径）。
 *
 * ⚠️ 连库用 .env.migrate（gk_owner 可写，见 GK-QA-16 §4A-2）；
 *    生产上执行前先确认库与文件备份都在（P-007 ⑤ falsifier #3）。
 */
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'

const APPLY = process.argv.includes('--apply')
const dryRun = !APPLY
const limitIdx = process.argv.indexOf('--limit')
const LIMIT = limitIdx > -1 ? Math.max(1, Number.parseInt(process.argv[limitIdx + 1], 10) || 200) : 200
const BATCH_SIZE = 10

/**
 * 所有带 user_id 的业务表（据 migrations/ 全量核对，2026-11-05）。
 * ⚠️ 新增任何带 user_id 的表都要回来加一行：漏一张表 = 把有数据的用户
 *    误判成空壳删掉（P-007 ⑤ falsifier #3）。
 * 不含：ocr_results / blob_objects / knowledge_articles（跨用户共享、无 user_id）、
 *      login_tickets（扫码票据，ON DELETE SET NULL，是临时系统数据不是用户内容）。
 */
const USER_DATA_TABLES = [
  'subjects',
  'timeline_items',
  'library_docs',
  'documents',
  'memories',
  'memory_media',
  'questions',
  'materials',
  'answer_cache',
  'netdisk_files',
  'async_jobs',
  'review_events',
  'chat_messages',
  'user_quota',
]

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const p = path.resolve(process.cwd(), '.env.migrate')
  if (!fs.existsSync(p)) throw new Error(`找不到 ${p}，请把 DATABASE_URL 放进 server/.env.migrate`)
  const line = fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith('DATABASE_URL='))
  if (!line) throw new Error('.env.migrate 里没有 DATABASE_URL')
  return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
}

/**
 * 逐表查「这些 user_id 里哪些有数据」，返回有数据的 id 集合。
 * 表名来自上面的硬编码常量（不是外部输入），拼进 SQL 无注入面。
 * 表不存在时跳过并打印（本地开发库可能没跑全部 migration）。
 */
async function busyIds(client, ids) {
  const busy = new Set()
  if (!ids.length) return busy
  for (const table of USER_DATA_TABLES) {
    const reg = await client.query('select to_regclass($1) as reg', [table])
    if (!reg.rows[0]?.reg) {
      console.log(`  · 表 ${table} 不存在，跳过`)
      continue
    }
    const { rows } = await client.query(
      `select distinct user_id::text as uid from ${table} where user_id::text = any($1::text[])`,
      [ids],
    )
    for (const r of rows) busy.add(r.uid)
  }
  return busy
}

const client = new pg.Client({ connectionString: databaseUrl() })
await client.connect()

try {
  const { rows: anons } = await client.query(
    `select id, device_id, created_at, expire_at
       from users
      where is_anonymous = true
      order by created_at, id`,
  )
  console.log(`匿名用户共 ${anons.length} 个；开始逐表核对零数据…`)

  const busy = await busyIds(client, anons.map((r) => r.id))
  const candidates = anons.filter((r) => !busy.has(r.id)).slice(0, LIMIT)

  console.log(
    `其中「有数据」${busy.size} 个 ⇒ 保留；「零数据空壳」${anons.length - busy.size} 个` +
      ` ⇒ 本次候选 ${candidates.length} 个（LIMIT=${LIMIT}）`,
  )
  for (const r of candidates.slice(0, 20)) {
    console.log(
      `  · ${r.id}  device=${String(r.device_id || '').slice(0, 24)}` +
        `  at=${r.created_at?.toISOString?.() || r.created_at}`,
    )
  }
  if (candidates.length > 20) console.log(`  · …其余 ${candidates.length - 20} 个省略`)

  if (dryRun) {
    console.log('\n[dry-run] 未传 --apply，一行都没删。确认无误后带 --apply 重跑。')
  } else {
    console.log('\n[apply] 开始分批删除（每批 ≤ 10，删前重新核对零数据）…')
    let deleted = 0
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE)
      const ids = batch.map((b) => b.id)
      // 🔴 删前重新核对：dry-run 到 apply 之间可能刚好有用户写了第一道题
      const stillBusy = await busyIds(client, ids)
      const toDelete = ids.filter((id) => !stillBusy.has(id))
      if (toDelete.length < ids.length) {
        console.log(`  · 第 ${i / BATCH_SIZE + 1} 批：${ids.length - toDelete.length} 个刚写入数据，跳过不删`)
      }
      if (!toDelete.length) continue
      const { rows } = await client.query(
        `delete from users where id = any($1::text[]) and is_anonymous = true returning id`,
        [toDelete],
      )
      // 校行数（等价 supabase 的 .select('id')）：返回行数必须与请求删除的行数一致
      if (rows.length !== toDelete.length) {
        throw new Error(`删除行数不符：请求 ${toDelete.length}，实际 ${rows.length}，立即中止`)
      }
      deleted += rows.length
      console.log(`  · 第 ${i / BATCH_SIZE + 1} 批：删除 ${rows.length} 个（累计 ${deleted}）`)
    }
    console.log(`[apply] 完成，共删除 ${deleted} 个零数据匿名空壳。`)
  }
} finally {
  await client.end()
}
