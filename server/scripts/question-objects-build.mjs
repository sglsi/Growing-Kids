#!/usr/bin/env node
/**
 * 题目级结构化对象离线构建（P-010 / D-013 · P1）
 *
 * 为什么要有这一步（报告《资料库正文召回-检索侧四步方案评审》§7 / §8）：
 *   P0 的「一题一对象」是**检索时现场从全文切**出来的，对象没有稳定身份、
 *   没有来源坐标，家长反馈「答案讲的是另一道题」时只能改算法、一改误杀一片。
 *   业界（TextIn）把这个卡点的根因归为「题目 / 答案 / 解析对应关系缺乏工程管控」，
 *   不在 OCR。本脚本把绑定关系**前移到入库阶段**，一次切分、可复算、可定点排除。
 *
 * 🔴 它做不到的（不得越线宣称）：
 *   纯文本没有版面坐标。若原始文本流本身把别人的解析排在这道题后面，结构化切分
 *   照样会把它们绑一起。P1 消除的是「运行时猜关系」+「错了改不动」，
 *   **不是**「已证明解析段归属」。彻底消除需要版面坐标（后续阶段，未批准）。
 *
 * ── 铁律 ────────────────────────────────────────────────────────────────
 *  ① 默认 dry-run：不带 `--apply` 一行都不写；
 *  ② 只写 `question_objects`，**绝不改** `netdisk_files` / `library_docs` 的任何列；
 *  ③ 切分逻辑只从 `dist/shared/question-match.js` require，禁止在脚本里另写题号规则；
 *     编译产物比源码旧会**直接退出**（防止「改了源码忘了 build」造成静默漂移）；
 *  ④ 幂等：`(user_id, source_type, source_id, object_index)` upsert；
 *     `source_revision` + `engine_version` 都没变就跳过；
 *  ⑤ 三条防误删护栏：本轮零对象不删 / 待删超库内一半要 `--force-clean` /
 *     dry-run 不删；
 *  ⑥ PostgreSQL text 不接受 U+0000（P-008 踩过），写库前统一 `stripNul()`；
 *  ⑦ 长任务在 L3 上必须远端 `nohup` + 远端日志，`sudo -u gk -H`（`.env.migrate` 600）。
 *
 * ── 用法（在 server/ 下，先 `npx nest build`）────────────────────────────
 *   node scripts/question-objects-build.mjs --from-fixture \
 *        scripts/verify/fixtures/question-object-cases.json --output ../.tmp/qobj.json
 *   node scripts/question-objects-build.mjs                      # 全库 dry-run
 *   node scripts/question-objects-build.mjs --user <uuid> --limit 20
 *   node scripts/question-objects-build.mjs --apply --limit 20  # 小批量试建
 *   node scripts/question-objects-build.mjs --apply --force     # 全量重建
 *
 * ⚠️ 本轮批准范围是**本地 / 开发库 + fixture 验证**。
 *    在 L3 生产库（`42.192.36.120`）执行 `--apply` 属写生产数据，须思傅单独拍板；
 *    且须先 `sudo -n -u gk node scripts/db-backup.mjs --no-upload` 备份。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import dotenv from 'dotenv'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = path.resolve(__dirname, '..')

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const FORCE = argv.includes('--force')
const FORCE_CLEAN = argv.includes('--force-clean')
const arg = (name, fallback = '') => {
  const i = argv.indexOf(name)
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const FROM_FIXTURE = arg('--from-fixture')
const OUTPUT = arg('--output')
const COMPILED = arg('--compiled', 'dist/shared/question-match.js')
const USER_ID = arg('--user')
const LIMIT = Number(arg('--limit', '0')) || 0
const SOURCE_TYPE = arg('--source-type', 'all') // netdisk | library | all
const BATCH = Number(arg('--batch', '200')) || 200
/** 单个对象上限：超出多半是题号没识别出来，标 rejected 不参与 exact */
const MAX_OBJECT_CHARS = 100_000
/**
 * 🔴 必须与 `answer-search.service.ts#searchLibraryDocs()` 的 `.slice(0, 60_000)` 逐字一致。
 * 判定层看到的是截断后的正文，source_revision 就必须按截断后的正文算，
 * 否则 library 对象会被永远判「正文已变化，对象过期」（M32 有静态断言）。
 */
const LIBRARY_TEXT_MAX_CHARS = 60_000

// ---------- 唯一切分真相源 ----------
const SRC = path.resolve(SERVER_ROOT, 'src/shared/question-match.ts')
const COMPILED_PATH = path.resolve(SERVER_ROOT, COMPILED)
if (!fs.existsSync(COMPILED_PATH)) {
  console.error(`✗ 找不到编译产物 ${COMPILED_PATH}\n  先跑：cd server && npx nest build`)
  process.exit(2)
}
if (fs.statSync(COMPILED_PATH).mtimeMs < fs.statSync(SRC).mtimeMs) {
  console.error('✗ 编译产物比源码旧，拒绝运行（防止切分规则静默漂移）\n  先跑：cd server && npx nest build')
  process.exit(2)
}
const Q = require(COMPILED_PATH)
if (typeof Q.splitQuestionObjects !== 'function' || !Q.OBJECT_ENGINE_VERSION) {
  console.error('✗ 编译产物缺少 splitQuestionObjects / OBJECT_ENGINE_VERSION')
  process.exit(2)
}

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const stripNul = (s) => (s || '').replace(/\u0000/g, '')

/**
 * 题干是否「无实义」：切题边界把纯题号 / 纯数值碎片当成了题干。
 *
 * 为什么必须有这道闸（D-047 只读实测，2026-11-13）：生产库 656,898 个对象里，
 * **12,938 条题干只有一个题号**（`19.` / `28.` / `63.`），**30,556 条连一个汉字
 * 或拉丁字母都没有**（`5.50` / `0.307` / `0.231/10` / `30.（1）`）。抽样 24 条
 * 无一例外是公式与答案区的数字碎片被题号边界误切。
 * `stem_text` 非空 ⇒ 现有三道闸（空题干 / 超长 / 解析串题号）一条都拦不住；
 * `validateStoredObject()` 也只查「非空」，于是它们一路以 `link_status='ok'`
 * 入库、占用检索候选位。
 *
 * 判据刻意取「有没有实义字符」而不是「长度」：
 *   - 长度阈值会误杀短真题干（「求 x 的值」只有 6 字）；
 *   - 「是否含汉字或拉丁字母」是**确定性**判据：不含的必然不是一道题。
 * 边界（本条**不**覆盖，别据此宣称已解决）：
 *   - 纯英文题（`1. A`）、含字母公式（`x²+2x+1=0`）→ 有字母，不拦；
 *   - 含汉字但其实是答案行（`3、做功 内能 10 20`）→ 有汉字，不拦（另一条风险）。
 */
const STEM_MEANINGFUL_RE = /[\u4e00-\u9fa5\u3400-\u4dbfa-zA-Z]/
/**
 * 第③条：整串只由「无害字符」构成才叫碎片。白名单里只放空白/数字/常用标点/数学符号。
 *
 * 为什么要这一步、而不是「不含汉字字母就算碎片」：实测有 5,610 条 stem_text 含
 * 编码损坏产生的替换字符与 Latin-1 残字（GBK 被误当 latin1 解码），原文其实是
 * 真题目（知识／文化／信息交流…）。它们同样不含汉字与拉丁字母，只按①②判会被
 * 当成碎片拒掉，把「编码缺陷」错误地伪装成「切题缺陷」。白名单把它们排除在外。
 */
const STEM_ALLOWED_ONLY_RE = /^[0-9\s.,;:+*/=^%()\[\]{}<>|_、。，；：！？…—－×÷·~√△∵∴°℃①-⑩-]+$/
// 刻意不 export：本脚本顶层直接执行，被 import 会连带跑一次构建。
// 验证走 `--from-fixture` 黑盒（M45），不引入跨文件副作用。
function isStemMeaningless(stem) {
  const t = stripNul(String(stem || '')).trim()
  if (!t) return false
  if (STEM_MEANINGFUL_RE.test(t)) return false
  return STEM_ALLOWED_ONLY_RE.test(t)
}

/**
 * 把一份正文切成结构化对象行。
 * 指纹只吃「内容 + 位置 + 规则版本」，重跑必须得同一个值。
 */
function buildRows(text, meta, maxChars = 0) {
  const raw = stripNul(String(text || ''))
  const clean = maxChars > 0 ? raw.slice(0, maxChars) : raw
  if (!clean.trim()) return { revision: sha256(clean), rows: [] }
  const revision = sha256(clean)
  const objects = Q.splitQuestionObjects(clean, {
    sourceId: meta.sourceId,
    sourceName: meta.sourceName,
  })
  const rows = objects.map((o) => {
    const stem = stripNul(o.stem)
    const solution = stripNul(o.solution)
    const row = {
      user_id: meta.userId,
      source_type: meta.sourceType,
      source_id: String(meta.sourceId),
      source_name: meta.sourceName || null,
      object_index: o.source.objectIndex,
      label: (o.source.label || '').slice(0, 32),
      char_start: o.source.charStart,
      char_end: o.source.charEnd,
      stem_start: o.source.stemStart,
      stem_end: o.source.stemEnd,
      stem_text: stem,
      solution_text: solution || null,
      has_solution: !!o.hasSolution,
      object_fingerprint: '',
      source_revision: revision,
      link_status: 'ok',
      link_reason: null,
      engine_version: Q.OBJECT_ENGINE_VERSION,
    }
    // 入库结构校验：只拒绝、不放行。可疑对象永不参与 exact，
    // 且可按 object_fingerprint 定点排查 / 人工改 link_status。
    let reason = ''
    if (!stem.trim()) reason = '题干为空'
    else if (isStemMeaningless(stem)) reason = '题干无实义（纯题号/纯数值碎片），切题边界不可信'
    else if (stem.length + solution.length > MAX_OBJECT_CHARS) reason = '对象超长，题号边界可能没切开'
    else if (o.hasSolution && Q.solutionBoundaryBroken(solution)) reason = '解析段混入下一题题号'
    if (reason) {
      row.link_status = 'rejected'
      row.link_reason = reason
    }
    row.object_fingerprint = sha256(Q.objectFingerprintInput(row))
    return row
  })
  return { revision, rows }
}

const FIELDS = [
  'user_id', 'source_type', 'source_id', 'source_name', 'object_index', 'label',
  'char_start', 'char_end', 'stem_start', 'stem_end', 'stem_text', 'solution_text',
  'has_solution', 'object_fingerprint', 'source_revision', 'link_status',
  'link_reason', 'engine_version',
]
const CONFLICT_UPDATE = FIELDS.filter((f) =>
  !['user_id', 'source_type', 'source_id', 'object_index'].includes(f))
  .map((f) => `${f} = excluded.${f}`).join(', ')

function upsertSql(n) {
  const cols = FIELDS.join(', ')
  const vals = []
  for (let i = 0; i < n; i++) {
    vals.push(`(${FIELDS.map((_, j) => `$${i * FIELDS.length + j + 1}`).join(', ')})`)
  }
  return `insert into question_objects (${cols}) values ${vals.join(', ')}
    on conflict (user_id, source_type, source_id, object_index)
    do update set ${CONFLICT_UPDATE}`
}

async function bulkUpsert(client, rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH)
    const params = chunk.flatMap((r) => FIELDS.map((f) => r[f]))
    await client.query(upsertSql(chunk.length), params)
  }
}

/** 三条防误删护栏：只在确有可用对象、且删除量不异常时才清理多余行 */
async function pruneExtra(client, meta, keepCount) {
  if (keepCount <= 0) return { deleted: 0, skipped: '本轮零对象，按护栏不清库' }
  const { rows: cur } = await client.query(
    `select count(*)::int as n, max(engine_version) as engine
       from question_objects
      where user_id = $1 and source_type = $2 and source_id = $3`,
    [meta.userId, meta.sourceType, String(meta.sourceId)],
  )
  const existing = cur[0]?.n || 0
  const toDelete = existing - keepCount
  if (toDelete <= 0) return { deleted: 0, skipped: '' }
  if (toDelete > existing / 2 && !FORCE_CLEAN) {
    return { deleted: 0, skipped: `待删 ${toDelete}/${existing} 超半数，需 --force-clean` }
  }
  const r = await client.query(
    `delete from question_objects
      where user_id = $1 and source_type = $2 and source_id = $3 and object_index >= $4`,
    [meta.userId, meta.sourceType, String(meta.sourceId), keepCount],
  )
  return { deleted: r.rowCount, skipped: '' }
}

// ---------- fixture 模式：零 DB 依赖，供验收集与端到端复现 ----------
async function runFixture() {
  const raw = JSON.parse(fs.readFileSync(path.resolve(FROM_FIXTURE), 'utf8'))
  const docs = raw.documents || []
  const userId = USER_ID || '00000000-0000-4000-8000-000000000001'
  const all = []
  for (const d of docs) {
    const meta = {
      userId,
      sourceType: 'library',
      sourceId: String(d.id),
      sourceName: d.name || String(d.id),
    }
    const { rows } = buildRows(d.text, meta)
    all.push(...rows)
    console.log(`  ${String(d.id).padEnd(14)} objects=${String(rows.length).padStart(3)} ok=${rows.filter((r) => r.link_status === 'ok').length} rejected=${rows.filter((r) => r.link_status === 'rejected').length}`)
  }
  if (OUTPUT) {
    fs.mkdirSync(path.dirname(path.resolve(OUTPUT)), { recursive: true })
    fs.writeFileSync(path.resolve(OUTPUT), JSON.stringify({
      meta: {
        origin: 'question-objects-build.mjs --from-fixture',
        engine_version: Q.OBJECT_ENGINE_VERSION,
        user_id: userId,
        built_at: new Date().toISOString(),
      },
      rows: all,
    }, null, 2))
    console.log(`  → 已写出 ${path.resolve(OUTPUT)}（${all.length} 行）`)
  }

  // --apply 时把 fixture 对象真正写进库，用于验证「入库链路」端到端可跑。
  // 必须给真实 --user：user_id 有外键，默认占位 UUID 会直接被 PG 拒绝。
  let written = 0, deleted = 0
  if (APPLY) {
    if (!USER_ID) {
      console.error('✗ --from-fixture --apply 必须给 --user <真实 uuid>（question_objects.user_id 有外键）')
      process.exit(2)
    }
    const client = new pg.Client({ connectionString: databaseUrl() })
    await client.connect()
    try {
      await bulkUpsert(client, all)
      written = all.length
      for (const d of docs) {
        const meta = { userId: USER_ID, sourceType: 'library', sourceId: String(d.id) }
        const p = await pruneExtra(client, meta, all.filter((r) => r.source_id === String(d.id)).length)
        deleted += p.deleted
        if (p.skipped) console.log(`  ⚠ ${d.id}: ${p.skipped}`)
      }
    } finally {
      await client.end()
    }
  }
  return {
    sources: docs.length,
    rows: all.length,
    ok: all.filter((r) => r.link_status === 'ok').length,
    ...(APPLY ? { written, deleted } : {}),
  }
}

// ---------- 数据库模式 ----------
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

const SOURCES = [
  {
    type: 'netdisk',
    table: 'netdisk_files',
    extra: 'and is_dir = false',
    nameCol: 'name',
  },
  {
    type: 'library',
    table: 'library_docs',
    extra: 'and deleted_at is null',
    nameCol: 'name',
  },
]

async function runDb() {
  dotenv.config({ path: path.resolve(SERVER_ROOT, '.env') })
  dotenv.config({ path: path.resolve(SERVER_ROOT, '.env.migrate') })
  const client = new pg.Client({ connectionString: databaseUrl() })
  await client.connect()
  const stats = { sources: 0, rows: 0, ok: 0, skipped: 0, written: 0, deleted: 0 }
  try {
    for (const src of SOURCES) {
      if (SOURCE_TYPE !== 'all' && SOURCE_TYPE !== src.type) continue
      let cursor = ''
      for (;;) {
        if (LIMIT > 0 && stats.sources >= LIMIT) break
        const params = [USER_ID || null, cursor, 50]
        const { rows: batch } = await client.query(
          `select id, user_id, ${src.nameCol} as name, text_content
             from ${src.table}
            where text_status = 'ok' and text_content is not null
              and ($1::text is null or user_id = $1)
              and id::text > $2
              ${src.extra}
            order by id limit $3`,
          params,
        )
        if (batch.length === 0) break
        for (const r of batch) {
          cursor = String(r.id)
          stats.sources++
          if (LIMIT > 0 && stats.sources > LIMIT) break
          const meta = {
            userId: String(r.user_id),
            sourceType: src.type,
            sourceId: String(r.id),
            sourceName: String(r.name || ''),
          }
          const { revision, rows } = buildRows(
            r.text_content,
            meta,
            src.type === 'library' ? LIBRARY_TEXT_MAX_CHARS : 0,
          )
          // 幂等：正文与规则都没变就跳过
          if (!FORCE) {
            const { rows: done } = await client.query(
              `select count(*)::int as n, max(source_revision) as rev, max(engine_version) as eng
                 from question_objects
                where user_id = $1 and source_type = $2 and source_id = $3`,
              [meta.userId, meta.sourceType, meta.sourceId],
            )
            const d = done[0]
            if (d && d.n === rows.length && d.rev === revision && d.eng === Q.OBJECT_ENGINE_VERSION) {
              stats.skipped++
              continue
            }
          }
          stats.rows += rows.length
          stats.ok += rows.filter((x) => x.link_status === 'ok').length
          if (APPLY) {
            await bulkUpsert(client, rows)
            stats.written += rows.length
            const p = await pruneExtra(client, meta, rows.length)
            stats.deleted += p.deleted
            if (p.skipped) console.log(`  ⚠ ${meta.sourceId}: ${p.skipped}`)
          }
          if (stats.sources % 50 === 0) {
            console.log(`  … ${stats.sources} 份 / ${stats.rows} 对象 / 写入 ${stats.written}`)
          }
        }
        if (batch.length < 50) break
      }
    }
  } finally {
    await client.end()
  }
  return stats
}

// ---------- main ----------
const started = Date.now()
console.log(`=== 题目对象构建 P1（engine=${Q.OBJECT_ENGINE_VERSION}）===`)
console.log(`模式：${FROM_FIXTURE ? 'fixture' : 'database'}｜${APPLY ? '🔴 APPLY 写库' : 'dry-run 只读'}${FORCE ? '｜force' : ''}`)
if (!APPLY && !OUTPUT) console.log('（未指定 --output，只打印统计；零写入）')

const result = FROM_FIXTURE ? await runFixture() : await runDb()
console.log('--- 汇总 ---')
console.log(JSON.stringify({ ...result, elapsedMs: Date.now() - started }, null, 2))
if (!APPLY && !FROM_FIXTURE) console.log('✓ dry-run 完成，一行未写。加 --apply 才写 question_objects。')
