#!/usr/bin/env node
/**
 * 题库整理 · 去除「题干与解答完全相同」的重复对象（D-053）
 *
 * 为什么是这个判据（生产只读实测 2026-11-13，qobj-2 重建后 603,739 个 ok 对象）：
 *   按 (user_id, stem_text) 分组有 112,048 组重复 / 134,852 条冗余，但其中
 *   **51,671 组（58,434 条冗余）同题干而解析不同** —— 那是同一道题的不同解答，
 *   删掉会丢内容，一律保留。只处理 stem_text + solution_text 都完全相同的
 *   61,524 组 / 79,449 条冗余。
 *   重复主体是试卷模板文字（「回答第Ⅰ卷时…」「本试卷分第Ⅰ卷…」等答题卡说明）
 *   在十几份卷子里反复出现，被切题边界当成题目；短空壳只占 7.5%。
 *
 * 为什么标记而不物理删行：
 *   question_objects 是**派生表**（db-backup 跳过、可重建），且 question_figures /
 *   question_inline_figures 按 (user_id, source_type, source_id, object_index) 关联；
 *   删行会造成配图孤儿、破坏 object_index。改用 link_status='rejected'：
 *   validateStoredObject() 第二条即排除（question-match.ts:692）⇒ 读侧零改动生效；
 *   指纹入参不含 link_status（M45 B4）⇒ 标记不失配；可按 id 清单完整回滚。
 *
 * 🔴 判定层 question-match.ts 一行未动；不 bump ENGINE / CACHE 版本；
 *    **不宣称**命中提升 / 召回改善 / 误判归零。只声称：重复对象不再占检索候选位。
 *
 * ⚠️ 派生表重建会复活：question-objects-build.mjs 的 --apply 收尾会跑同口径去重
 *    （M47 守两处判据一致）；若手工重建，之后必须重跑本脚本。
 *
 * 用法（server/ 下）：
 *   node scripts/question-objects-dedupe.mjs --output ../.tmp/dedupe-ids.json
 *   node scripts/db-backup.mjs --no-upload
 *   node scripts/question-objects-dedupe.mjs --apply --i-have-backup --force --output ../.tmp/dedupe-ids.json
 *   node scripts/question-objects-dedupe.mjs --rollback ../.tmp/dedupe-ids.json --apply --i-have-backup
 *
 * 护栏：
 *   ① 默认 dry-run，不带 --apply 一行不写；
 *   ② --apply 必须同时给 --i-have-backup（D-031：备份未成功前不 apply）；
 *   ③ 命中超过全库 10% 直接拒绝，除非 --force（本次 12.9%，须显式放行）；
 *   ④ 只处理 link_status='ok'，绝不覆盖既有 rejected 的 link_reason；
 *   ⑤ 分批 UPDATE（默认 2000/批），每批校验行数，不一致立即停；
 *   ⑥ 结束后复核「仍为 ok 的重复项」必须归零。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = path.resolve(__dirname, '..')

const argv = process.argv.slice(2)
const has = (k) => argv.includes(k)
const arg = (k, d = '') => {
  const i = argv.indexOf(k)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}

const APPLY = has('--apply')
const BACKUP_ACK = has('--i-have-backup')
const FORCE = has('--force')
const OUTPUT = arg('--output')
const ROLLBACK_FILE = arg('--rollback')
const BATCH = Number(arg('--batch', '2000')) || 2000

const REASON = '题干与解答完全相同（保留同组首条），D-053 去重'

/**
 * 与 question-objects-build.mjs 收尾的 dedupeAfterBuild() 逐字同口径（M47 守漂移）。
 * 保留规则：PARTITION BY 内按 id 升序，rn=1 保留，rn>1 标记。确定性、可复算。
 */
const DUP_RANKED_CTE = `
  WITH ranked AS (
    SELECT id, row_number() OVER (
      PARTITION BY user_id, stem_text, coalesce(solution_text, '')
      ORDER BY id
    ) AS rn
    FROM question_objects
    WHERE link_status = 'ok'
  )
`
const SELECT_DUP_IDS = `${DUP_RANKED_CTE} SELECT id FROM ranked WHERE rn > 1 ORDER BY id`
const COUNT_DUP_LEFT = `${DUP_RANKED_CTE} SELECT count(*)::int AS n FROM ranked WHERE rn > 1`

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const envPath = path.resolve(SERVER_ROOT, '.env.migrate')
  if (fs.existsSync(envPath)) {
    const line = fs.readFileSync(envPath, 'utf8').split('\n')
      .find((l) => l.trim().startsWith('DATABASE_URL='))
    if (line) return line.trim().slice('DATABASE_URL='.length).replace(/^["']|["']$/g, '')
  }
  throw new Error('没有 DATABASE_URL（环境变量或 server/.env.migrate）')
}

const client = new pg.Client({ connectionString: databaseUrl() })
await client.connect()

function writeManifest(ids) {
  if (!OUTPUT) return
  const payload = {
    generatedAt: new Date().toISOString(),
    reason: REASON,
    criterion: "PARTITION BY user_id, stem_text, coalesce(solution_text,'')；按 id 升序保留 rn=1",
    count: ids.length,
    ids,
  }
  fs.mkdirSync(path.dirname(path.resolve(OUTPUT)), { recursive: true })
  fs.writeFileSync(path.resolve(OUTPUT), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(`  清单已导出：${path.resolve(OUTPUT)}（${ids.length} 条）`)
}

try {
  // ---------- 回滚模式 ----------
  if (ROLLBACK_FILE) {
    if (!fs.existsSync(ROLLBACK_FILE)) {
      console.error(`✗ 回滚清单不存在：${ROLLBACK_FILE}`)
      process.exit(2)
    }
    const ids = JSON.parse(fs.readFileSync(ROLLBACK_FILE, 'utf8')).ids || []
    console.log(`回滚模式：清单 ${ids.length} 条${APPLY ? '' : '（未加 --apply，仅预演）'}`)
    const { rows: probe } = await client.query(
      `SELECT count(*)::int n FROM question_objects
        WHERE id = ANY($1::varchar[]) AND link_status = 'rejected' AND link_reason = $2`,
      [ids, REASON],
    )
    console.log(`  可恢复行（reason 精确匹配）：${probe[0].n}`)
    if (!APPLY) {
      console.log('✓ 预演完成，一行未写。')
      process.exit(0)
    }
    if (!BACKUP_ACK) {
      console.error('✗ 写库必须显式给 --i-have-backup（D-031）')
      process.exit(2)
    }
    let restored = 0
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH)
      const r = await client.query(
        `UPDATE question_objects SET link_status = 'ok', link_reason = NULL
          WHERE id = ANY($1::varchar[]) AND link_status = 'rejected' AND link_reason = $2`,
        [chunk, REASON],
      )
      restored += r.rowCount
    }
    console.log(`✓ 回滚完成：恢复 ${restored} 行为 ok`)
    process.exit(0)
  }

  // ---------- 统计 ----------
  const { rows: totalRows } = await client.query('SELECT count(*)::int n FROM question_objects')
  const total = totalRows[0].n
  const { rows: distRows } = await client.query(
    `SELECT link_status, count(*)::int n FROM question_objects GROUP BY 1 ORDER BY 2 DESC`,
  )
  console.log('=== 题库去重 D-053 ===')
  console.log(`全库 ${total} 行｜${distRows.map((d) => `${d.link_status}=${d.n}`).join(' / ')}`)
  const { rows: leftRows } = await client.query(COUNT_DUP_LEFT)
  const hit = leftRows[0].n
  const pct = total ? (100 * hit) / total : 0
  console.log(`命中重复冗余 ${hit} 条（占全库 ${pct.toFixed(2)}%）`)
  console.log(`判据：user_id + stem_text + coalesce(solution_text,'') 完全相同，按 id 保留首条`)

  const { rows: sample } = await client.query(
    `${DUP_RANKED_CTE}, pick AS (
       SELECT id FROM ranked WHERE rn > 1 ORDER BY id LIMIT 8
     )
     SELECT q.id, left(replace(q.stem_text, chr(10), ' '), 60) AS head
       FROM pick JOIN question_objects q ON q.id = pick.id ORDER BY q.id`,
  )
  console.log('样本 8 条：')
  for (const s of sample) console.log(`  ${s.id}  ${s.head}`)

  const { rows: idRows } = await client.query(SELECT_DUP_IDS)
  const ids = idRows.map((r) => r.id)
  writeManifest(ids)

  if (!FORCE && pct > 10) {
    console.error(`✗ 命中 ${pct.toFixed(2)}% 超过 10% 护栏。复核清单无误后显式加 --force。`)
    process.exit(3)
  }
  if (!APPLY) {
    console.log('✓ dry-run 完成，一行未写。加 --apply --i-have-backup（必要时 --force）才写库。')
    process.exit(0)
  }
  if (!BACKUP_ACK) {
    console.error('✗ 写库必须显式给 --i-have-backup（D-031：备份未成功前不 apply）')
    process.exit(2)
  }

  // ---------- 分批写 ----------
  console.log(`--- APPLY：分批 ${BATCH} ---`)
  let done = 0
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH)
    const r = await client.query(
      `UPDATE question_objects SET link_status = 'rejected', link_reason = $2
        WHERE id = ANY($1::varchar[]) AND link_status = 'ok'`,
      [chunk, REASON],
    )
    if (r.rowCount !== chunk.length) {
      console.error(`✗ 批 ${Math.floor(i / BATCH) + 1} 期望 ${chunk.length} 实际 ${r.rowCount}，立即停止`)
      process.exit(4)
    }
    done += r.rowCount
    if ((Math.floor(i / BATCH) + 1) % 10 === 0 || i + BATCH >= ids.length) {
      console.log(`  已处理 ${done}/${ids.length}`)
    }
  }

  // ---------- 复核 ----------
  const { rows: afterRows } = await client.query(COUNT_DUP_LEFT)
  const { rows: distAfter } = await client.query(
    `SELECT link_status, count(*)::int n FROM question_objects GROUP BY 1 ORDER BY 2 DESC`,
  )
  console.log('--- 复核 ---')
  console.log(`  仍为 ok 的重复项 ${afterRows[0].n}（期望 0）`)
  console.log(`  link_status 分布：${distAfter.map((d) => `${d.link_status}=${d.n}`).join(' / ')}`)
  console.log(`  总行数 ${total} → ${distAfter.reduce((s, d) => s + d.n, 0)}（应不变：只标记不删行）`)
  if (afterRows[0].n !== 0) {
    console.error('✗ 复核未归零，请检查是否中途有新对象写入')
    process.exit(4)
  }
  console.log(`✓ 完成：标记 ${done} 行。回滚：--rollback <清单> --apply --i-have-backup`)
} finally {
  await client.end()
}
