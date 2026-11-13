#!/usr/bin/env node
/**
 * 存量「题干无实义」标记脚本（D-047）
 *
 * 为什么要有这个脚本：`question-objects-build.mjs` 的第四道闸只挡**未来**构建；
 * 生产库已有的 35,109 条（2026-11-13 只读实测，占 656,898 的 5.34%）已经在库里、
 * 且全部 `link_status='ok'`，不处理就会继续占检索候选位。
 *
 * 它做什么：把命中对象的 `link_status` 从 `ok` 改成 `rejected`，并写 `link_reason`。
 * 检索侧**零代码改动**即生效——`validateStoredObject()` 第二条就是
 * `if (row.link_status !== 'ok') return '该对象已被标记排除…'`（question-match.ts:692）。
 *
 * 🔴 它刻意**只改两个标注列**：
 *   - 不删行、不改 `stem_text` / 坐标 / 指纹 / 版本 ⇒ 可随时按 id 清单回滚；
 *   - 指纹入参不含 `link_status`（M45 B4 有断言）⇒ 标记不会让对象「指纹失配」；
 *   - 判定层六闸、锚点、设问一致性一行不动。
 *
 * 判据与 `measure-object-meaningless.sql`、`isStemMeaningless()` 同口径：
 *   ① 不含汉字 ② 不含拉丁字母 ③ 整串只由空白/数字/常用标点数学符号构成。
 *   第 ③ 条是白名单，专门排除**编码损坏的乱码题干**（实测 5,610 条，原文是真题目）。
 *
 * ── 用法（server/ 下）──────────────────────────────────────────────────
 *   # 1) 先只看：统计 + 导出待标记清单（零写入）
 *   node scripts/question-objects-mark-meaningless.mjs --output ../.tmp/meaningless-ids.json
 *
 *   # 2) 复核清单无误、且**已完成备份**后，才允许写
 *   node scripts/db-backup.mjs --no-upload
 *   node scripts/question-objects-mark-meaningless.mjs --apply --i-have-backup --output ../.tmp/meaningless-ids.json
 *
 *   # 3) 回滚（按 id 清单）
 *   node scripts/question-objects-mark-meaningless.mjs --rollback ../.tmp/meaningless-ids.json --i-have-backup
 *
 * ── 护栏 ──────────────────────────────────────────────────────────────
 *   ① 默认 dry-run，不带 `--apply` 一行不写；
 *   ② `--apply` 必须同时给 `--i-have-backup`（沿用 D-031「备份未成功前不 apply」）；
 *   ③ 只处理 `link_status='ok'`；命中数超过全库 10% 直接拒绝（除非 `--force`）；
 *   ④ 分批 UPDATE（默认 2000/批），任一批失败立即停并报告已改行数；
 *   ⑤ 每批都带原条件复查，绝不按「上一批最后 id」滑动（防止中途数据变化漏标）。
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
const ROLLBACK = has('--rollback')
const OUTPUT = arg('--output')
const BATCH = Number(arg('--batch', '2000')) || 2000
const LIMIT = Number(arg('--limit', '0')) || 0

/** 与 measure-object-meaningless.sql / isStemMeaningless() 同口径（M45 A5 守漂移） */
const RE_NO_CJK = String.raw`[一-龥]`
const RE_NO_LATIN = String.raw`[a-zA-Z]`
// D-053：补全角句点 `．`(U+FF0E)——QUESTION_START 认 `N．` 作题号，旧白名单漏收，
// 使 `1．` 这类纯题号空壳逃过标记。与 build.mjs / measure sql 三处必须逐字同口径（M45 A5）。
const RE_ALLOWED_ONLY = String.raw`^[[:space:]0-9.,;:+*/=^%()\[\]{}<>|_、。，．；：！？…—－×÷·~√△∵∴°℃①-⑩-]+$`
const REASON = '题干无实义（纯题号/纯数值碎片），切题边界不可信'

const WHERE_HIT = `
  btrim(stem_text) !~ $1
  AND btrim(stem_text) !~ $2
  AND btrim(stem_text) ~ $3
`
const WHERE_HIT_OK = `${WHERE_HIT} AND link_status = 'ok'`
const PARAMS = [RE_NO_CJK, RE_NO_LATIN, RE_ALLOWED_ONLY]

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

try {
  // ---------- 回滚模式 ----------
  if (ROLLBACK) {
    const file = arg('--rollback') || OUTPUT
    if (!file || !fs.existsSync(file)) {
      console.error('✗ 回滚需要 id 清单文件：--rollback <json>')
      process.exit(2)
    }
    const ids = JSON.parse(fs.readFileSync(file, 'utf8')).ids || []
    console.log(`回滚模式：清单 ${ids.length} 条${APPLY ? '' : '（未加 --apply，仅预演）'}`)
    if (!APPLY) {
      const { rows } = await client.query(
        `SELECT count(*)::int n FROM question_objects WHERE id = ANY($1::varchar[]) AND link_status = 'rejected'`,
        [ids],
      )
      console.log(`  将被恢复为 ok 的现有 rejected 行：${rows[0].n}`)
      console.log('✓ 预演完成，一行未写。')
      process.exit(0)
    }
    if (!BACKUP_ACK) {
      console.error('✗ 写库必须显式给 --i-have-backup（D-031）')
      process.exit(2)
    }
    let restored = 0
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH)
      const r = await client.query(
        `UPDATE question_objects SET link_status = 'ok', link_reason = NULL
         WHERE id = ANY($1::varchar[]) AND link_status = 'rejected'`,
        [slice],
      )
      restored += r.rowCount
      console.log(`  批 ${i / BATCH + 1}: +${r.rowCount}（累计 ${restored}）`)
    }
    console.log(`✓ 回滚完成：恢复 ${restored} 行`)
    process.exit(0)
  }

  // ---------- 统计 ----------
  const total = (await client.query('SELECT count(*)::int n FROM question_objects')).rows[0].n
  const hitAll = (await client.query(`SELECT count(*)::int n FROM question_objects WHERE ${WHERE_HIT}`, PARAMS)).rows[0].n
  const hitOk = (await client.query(`SELECT count(*)::int n FROM question_objects WHERE ${WHERE_HIT_OK}`, PARAMS)).rows[0].n
  const guardExcluded = (await client.query(
    `SELECT count(*)::int n FROM question_objects
     WHERE btrim(stem_text) !~ $1 AND btrim(stem_text) !~ $2 AND btrim(stem_text) !~ $3`,
    PARAMS,
  )).rows[0].n

  console.log('=== 存量「题干无实义」===')
  console.log(`  全库对象        ${total}`)
  console.log(`  判据命中        ${hitAll}（${((100 * hitAll) / total).toFixed(2)}%）`)
  console.log(`  其中仍是 ok     ${hitOk}  ← 本次要标的就是这些`)
  console.log(`  已标 rejected   ${hitAll - hitOk}`)
  console.log(`  编码损坏排除    ${guardExcluded}  ← 原文是真题目，白名单挡下，不标记`)

  if (hitOk === 0) {
    console.log('✓ 无待标记对象，退出。')
    process.exit(0)
  }
  if (!FORCE && hitOk / total > 0.1) {
    console.error(`✗ 命中占全库 ${((100 * hitOk) / total).toFixed(2)}% > 10%，判据可能失效，拒绝继续（真要执行加 --force）`)
    process.exit(3)
  }

  // ---------- 取清单 ----------
  const limitSql = LIMIT > 0 ? `LIMIT ${LIMIT}` : ''
  const { rows } = await client.query(
    `SELECT id, source_type, source_id, object_index, left(btrim(stem_text), 40) AS preview
     FROM question_objects WHERE ${WHERE_HIT_OK} ORDER BY md5(id) ${limitSql}`,
    PARAMS,
  )
  const ids = rows.map((r) => r.id)
  console.log(`  已取清单        ${ids.length} 条`)

  if (OUTPUT) {
    fs.mkdirSync(path.dirname(path.resolve(OUTPUT)), { recursive: true })
    fs.writeFileSync(path.resolve(OUTPUT), JSON.stringify({
      meta: {
        generated_at: new Date().toISOString(),
        purpose: 'D-047 存量「题干无实义」标记的可回滚 id 清单',
        criterion: { no_cjk: RE_NO_CJK, no_latin: RE_NO_LATIN, allowed_only: RE_ALLOWED_ONLY },
        reason: REASON,
        total_objects: total,
        hit_ok: hitOk,
      },
      ids,
      samples: rows.slice(0, 20),
    }, null, 2))
    console.log(`  → 清单已写出 ${path.resolve(OUTPUT)}`)
  }

  if (!APPLY) {
    console.log('✓ dry-run 完成，一行未写。加 --apply --i-have-backup 才写库。')
    process.exit(0)
  }
  if (!BACKUP_ACK) {
    console.error('✗ 写库必须显式给 --i-have-backup（D-031：备份未成功前不 apply）')
    process.exit(2)
  }

  // ---------- 分批写 ----------
  console.log(`--- APPLY：分批 ${BATCH} ---`)
  let done = 0
  for (let round = 1; round <= 200; round += 1) {
    const r = await client.query(
      `WITH batch AS (
         SELECT id FROM question_objects WHERE ${WHERE_HIT_OK} ORDER BY md5(id) LIMIT $4
       )
       UPDATE question_objects q SET link_status = 'rejected', link_reason = $5
       FROM batch WHERE q.id = batch.id`,
      [...PARAMS, BATCH, REASON],
    )
    done += r.rowCount
    console.log(`  批 ${round}: +${r.rowCount}（累计 ${done}/${ids.length}）`)
    if (r.rowCount === 0) break
  }

  // ---------- 复核 ----------
  const after = (await client.query(`SELECT count(*)::int n FROM question_objects WHERE ${WHERE_HIT_OK}`, PARAMS)).rows[0].n
  const dist = (await client.query(
    `SELECT link_status, count(*)::int n FROM question_objects GROUP BY 1 ORDER BY 2 DESC`,
  )).rows
  console.log('--- 复核 ---')
  console.log(`  仍为 ok 的命中对象 ${after}（期望 0）`)
  console.log(`  link_status 分布：${dist.map((d) => `${d.link_status}=${d.n}`).join(' / ')}`)
  if (after !== 0) {
    console.error('✗ 复核未归零，请检查是否中途有新对象写入')
    process.exit(4)
  }
  console.log(`✓ 完成：标记 ${done} 行。回滚：--rollback <清单> --apply --i-have-backup`)
} finally {
  await client.end()
}
