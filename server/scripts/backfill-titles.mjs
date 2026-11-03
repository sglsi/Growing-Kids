#!/usr/bin/env node
/**
 * 存量题目标题回填：把老数据的 title 改成新版命名口径「科目 日期 第N题」
 *
 * 背景（思傅 2026-11-03）：服务端已把**新**条目的标题改成「科目 2026-11-03 第3题」，
 * 但库里老条目的 title 还是「题干前 40 字」，同一张卷子十道题看起来几乎一样。
 * 本脚本按 created_at 顺序重排一遍，让老数据也符合新口径。
 *
 * 用法（在 server/ 下）：
 *   node scripts/backfill-titles.mjs            # 干跑，只打印样本与统计
 *   node scripts/backfill-titles.mjs --apply    # 真写
 *   node scripts/backfill-titles.mjs --apply --user <uuid>   # 只处理某个用户
 *
 * 口径（必须与 timeline.service.ts 的 nextTitle 一致，改一处要改两处）：
 *   - 序号按「用户 + 学科 + 东八区自然日」分组，组内按 created_at 升序 1,2,3…
 *   - 未分类（subject_id 为空）单独一档，标题前缀「未分类」
 *   - 软删条目也参与编号（否则恢复回收站里的条目时会撞号）
 *
 * 安全：
 *   - 默认干跑，必须显式 --apply 才写库；
 *   - 只改 title 一列，不动 updated_at / content；
 *   - 整个写入在一个事务里，任何一步报错全部回滚。
 */
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'

const APPLY = process.argv.includes('--apply')
const userArgIdx = process.argv.indexOf('--user')
const ONLY_USER = userArgIdx > -1 ? process.argv[userArgIdx + 1] : ''

/** 从 .env.migrate 读 DATABASE_URL（低权 migrator，够改 title） */
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

/** UTC 时间 → 东八区自然日 YYYY-MM-DD（与 timeline.service.ts 同口径） */
function localDay(d) {
  const t = new Date(new Date(d).getTime() + 8 * 60 * 60 * 1000)
  const p = (n) => (n < 10 ? `0${n}` : String(n))
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`
}

const client = new pg.Client({ connectionString: databaseUrl() })
await client.connect()

try {
  const params = ONLY_USER ? [ONLY_USER] : []
  const { rows } = await client.query(
    `select t.id, t.user_id, t.subject_id, t.title, t.created_at, coalesce(s.name, '') as subject_name
       from timeline_items t
       left join subjects s on s.id = t.subject_id
      where t.kind = 'question'${ONLY_USER ? ' and t.user_id = $1' : ''}
      order by t.user_id, t.created_at, t.id`,
    params,
  )

  const counters = new Map()
  const changes = []
  for (const r of rows) {
    const day = localDay(r.created_at)
    const key = `${r.user_id}|${r.subject_id || ''}|${day}`
    const seq = (counters.get(key) || 0) + 1
    counters.set(key, seq)
    const title = `${r.subject_name || '未分类'} ${day} 第${seq}题`
    if (title !== r.title) changes.push({ id: r.id, title, old: r.title })
  }

  console.log(`扫描 ${rows.length} 条题目，其中 ${changes.length} 条标题需要改写`)
  for (const c of changes.slice(0, 8)) {
    console.log(`  ${c.id}  ${JSON.stringify(c.old)}  →  ${c.title}`)
  }
  if (changes.length > 8) console.log(`  …另外 ${changes.length - 8} 条`)

  if (!APPLY) {
    console.log('\n干跑结束（未写库）。确认无误后加 --apply 真跑。')
  } else if (!changes.length) {
    console.log('无需改动。')
  } else {
    await client.query('begin')
    for (let i = 0; i < changes.length; i += 500) {
      const chunk = changes.slice(i, i + 500)
      const values = chunk.map((_, k) => `($${k * 2 + 1}, $${k * 2 + 2})`).join(',')
      const flat = chunk.flatMap((c) => [c.id, c.title])
      await client.query(
        `update timeline_items as t set title = v.title
           from (values ${values}) as v(id, title)
          where t.id = v.id`,
        flat,
      )
    }
    await client.query('commit')
    console.log(`已写入 ${changes.length} 条标题。`)
  }
} catch (e) {
  try {
    await client.query('rollback')
  } catch {
    /* 事务可能压根没开，忽略 */
  }
  console.error('回填失败：', e)
  process.exitCode = 1
} finally {
  await client.end()
}
