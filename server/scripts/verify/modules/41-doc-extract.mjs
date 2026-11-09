// 模块 41：老式 .doc 正文补抽（P-019 / D-024 阶段 1）
//
// 为什么单独一个模块：P-018 守的是「图按字符偏移插回题干」，P-019 守的是
// 「.doc 这批资料从未进过索引」这条供给前提。它是 L1 索引工程，不改判定层、
// 不放宽任何硬闸、不产生效果证据；但一旦写歪，会静默污染候选池或让
// `char_start` 在阶段 3 抠图时整片错位。
//
// 🔴 本模块钉住六件事：默认零写库 / 白名单三列 / 薄文本不进索引 /
//    单次转换产物同源钉子 / 2 worker 与资源护栏 / 阶段 2 双次转换硬门。
// 与 M38–M40 同坑：说明性注释里会写「绝不写库」「不得顶替」，负向断言
// 一律先剥注释，否则会被自己的说明打成 FAIL。

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { Module } from '../lib/harness.mjs'

const m = new Module('M41', '老式 .doc 正文补抽验收集（P-019 / D-024）')
const ROOT = path.resolve(process.cwd(), '..')

const MATCH = 'server/src/shared/question-match.ts'
const SERVICE_AS = 'server/src/answer-search/answer-search.service.ts'
const SERVICE_ND = 'server/src/netdisk/netdisk-search.service.ts'
const EXTRACT = 'server/scripts/netdisk-extract-text.mjs'
const BUILDER_QO = 'server/scripts/question-objects-build.mjs'
const MIG31 = 'migrations/0031_doc_convert_done.sql'
const PROPOSAL = 'docs/design/method/proposals/P-019-老式doc补抽与库覆盖扩面.md'
const DECISION = 'docs/design/method/decision-log.md'

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** JS/TS：去掉块注释与整行 // 注释 */
function codeJs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

/** SQL：去掉整行 -- 注释 */
function codeSql(src) {
  return src
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
}

m.test('🔴 B1 判定层真相源一行未动（与 M35–M40 同基线）', (c) => {
  const src = read(MATCH).replace(/\r\n/g, '\n')
  c.eq(
    crypto.createHash('sha256').update(src, 'utf8').digest('hex'),
    '84f998ff9d2bb2f5e2d3cec70b7ea309deef8ee69bfb558a4b8180939258ed10',
    'question-match.ts 被改动 —— 走提案单，不要顺手改判定层',
  )
  c.ok(!/doc_convert_done|inlineFigures|charOffset|question_inline/.test(src), '补抽/抠图逻辑被塞进判定层真相源')
})

m.test('🔴 B2 迁移 0031：记账表、唯一键、status 枚举、同源列齐全，且不动其它表', (c) => {
  const sql = read(MIG31)
  c.ok(/create table if not exists doc_convert_done/i.test(sql), '缺 0031 建表')
  for (const col of [
    'user_id', 'source_id', 'status', 'meaningful_chars', 'text_sha256',
    'docx_sha256', 'drawing_count', 'object_count', 'omath_count',
    'convert_ms', 'bytes', 'engine_version', 'scanned_at',
  ]) {
    c.ok(new RegExp(`\\b${col}\\b`).test(sql), `0031 缺列 ${col}`)
  }
  c.ok(/primary key \(user_id, source_id\)/i.test(sql), '缺主键（记账必须幂等）')
  c.ok(
    /check \(status in \('ok', 'none', 'review', 'failed', 'too_big'\)\)/i.test(sql),
    'status 枚举没有包含薄文本 review，或放宽了枚举',
  )
  const body = codeSql(sql)
  c.ok(!/(alter|drop|truncate)\s+table/i.test(body), '0031 不得改动其它表')
  c.ok(!/(insert into|update)\s+netdisk_files/i.test(body), '0031 不得写 netdisk_files')
  c.ok(!/(insert into|update)\s+question_objects/i.test(body), '0031 不得写题目对象')
})

m.test('🔴 B3 dry-run 与 --probe 零写库（writeRow / writeDocDone 双 guard）', (c) => {
  const s = codeJs(read(EXTRACT))
  c.ok(/const PROBE = Number\(arg\('--probe', '0'\)\) \|\| 0/.test(s), '缺 --probe 只读探测开关')
  const guards = (s.match(/if \(PROBE > 0\) return/g) || []).length
  c.ok(guards >= 2, `probe guard 只有 ${guards} 处：writeRow 与 writeDocDone 都要拦`)
  c.ok(/\[只读探测 --probe\]/.test(s), '探测模式没有醒目标记')
  c.ok(/一行都没写/.test(s), '探测结果没有明确「零写库」结论')
  const main = s.slice(s.indexOf('async function main()'))
  c.ok(/if \(!APPLY\) \{[\s\S]{0,160}await dryRun\(client\)/.test(main), '默认 dry-run 分支被改')
})

m.test('🔴 B4 --apply 未授权：main 与 applyDocRun 双重闸门', (c) => {
  const s = codeJs(read(EXTRACT))
  c.ok(/const DOC_APPLY_APPROVED = process\.env\.DOC_EXTRACT_APPLY_APPROVED === '1'/.test(s), '缺显式批准开关')
  const main = s.slice(s.indexOf('async function main()'))
  c.ok(/if \(DOC_MODE && APPLY && !DOC_APPLY_APPROVED\)/.test(main), 'main 缺 --apply 闸门')
  c.ok(/DOC_EXTRACT_APPLY_APPROVED=1/.test(main), '闸门没写清批准方式')
  c.ok(/if \(APPLY && !DOC_APPLY_APPROVED\)/.test(s), 'applyDocRun 缺二次防御闸门')
  c.ok(/to_regclass\('doc_convert_done'\)/.test(s), '--apply 前没检查 0031 迁移是否已建')
})

m.test('🔴 B5 写库白名单：只碰三列 + 带 user_id + 记账幂等，不碰任何题目/图表', (c) => {
  const s = codeJs(read(EXTRACT))
  const at = s.indexOf('async function writeRow')
  const wr = s.slice(at, at + 800)
  c.ok(
    /update netdisk_files\s+set text_content = \$1, text_status = \$2, text_updated_at = now\(\)/.test(wr),
    'writeRow 不是「只写三列」',
  )
  c.ok(/where id = \$3 and user_id = \$4/.test(wr), '写库没带 user_id 双重限定（数据隔离红线）')
  c.ok(!/set\s+name\s*=|\bsize_bytes\s*=|\bsynced_at\s*=|\btext_flat\s*=/.test(wr), 'writeRow 写了白名单之外的列')
  c.ok(/rowCount !== 1/.test(wr), '缺写库行数校验')
  c.ok(/on conflict \(user_id, source_id\) do update/.test(s), '记账不是幂等 upsert')
  c.ok(!/(insert into|update)\s+question_objects/i.test(s), '补抽脚本不得写 question_objects（属阶段 2）')
  c.ok(!/(insert into|update)\s+question_figures|question_inline_figures/i.test(s), '补抽脚本不得写任何图表')
  c.ok(!/insert into blob_objects/i.test(s), '转换产物不得落 blob_objects')
})

m.test('🔴 B6 薄文本复核队列：50~199 字标 review，不进索引也不被在线重抽', (c) => {
  const s = codeJs(read(EXTRACT))
  c.ok(/const REVIEW_MIN_CHARS = MIN_MEANINGFUL_CHARS/.test(s), '复核下界没有与 MIN_MEANINGFUL_CHARS 对齐')
  c.ok(/const REVIEW_MAX_CHARS = 200/.test(s), '复核上界不是 200（思傅「2加」）')
  c.ok(
    /meaningful < REVIEW_MIN_CHARS \? 'none'[\s\S]{0,160}'review' : 'ok'/.test(s),
    '缺 none / review / ok 三态判定',
  )
  c.ok(/stat\.review\+\+/.test(s) && /thin_text_review/.test(s), 'review 没有单独计数与留痕')
  c.ok(/rec\.status === 'none' \? null : written/.test(s), 'none 应写 null，不得留空串充正文')
  const qo = read(BUILDER_QO)
  c.ok(
    /where text_status = 'ok' and text_content is not null/.test(qo),
    '阶段 2 切题候选没有只取 ok ⇒ review 会漏进题目索引',
  )
  const svc = read(SERVICE_ND)
  c.ok(/if \(!ONLINE_EXTRACT_ENABLED\)/.test(svc), '服务端默认在线抽取未关 ⇒ review 可能被重抽覆盖')
})

m.test('🔴 B7 同源铁律：单次转换 + text_sha256 钉「真正写入的文本」+ 阶段 2 硬门', (c) => {
  const s = codeJs(read(EXTRACT))
  c.ok((s.match(/await convertDocToDocx\(/g) || []).length === 1, '转换调用点不止一处（会破坏单次产物复用）')
  c.ok(/kind: 'docx'/.test(s), '正文抽取没复用 extract_docx 口径（char_start 会换坐标系）')
  c.ok(/const written = stripNul\(text\)\.slice\(0, MAX_TEXT_CHARS\)/.test(s), '缺 stripNul + 截断（PG text 不收 U+0000）')
  c.ok(
    /rec\.text_sha256 = crypto\.createHash\('sha256'\)\.update\(written, 'utf8'\)/.test(s),
    'text_sha256 钉的不是写入 text_content 的那份文本',
  )
  c.ok(/rec\.docx_sha256 = crypto\.createHash\('sha256'\)\.update\(docxBuf\)/.test(s), '缺转换产物 docx 哈希')
  c.ok(!/blob_objects|storage_key/.test(s), '转换产物不得入库或落盘为内容寻址对象')
  const d24 = read(DECISION).slice(read(DECISION).indexOf('## D-024'))
  c.ok(/阶段 2 硬门/.test(d24), 'D-024 缺「阶段 2 硬门」条目')
  c.ok(/双次转换/.test(d24), 'D-024 缺双次转换文字流哈希对比的验收判据')
})

m.test('🔴 B8 全量 2 worker + P-018 资源护栏 + 长尾隔离', (c) => {
  const s = codeJs(read(EXTRACT))
  c.ok(/Number\(arg\('--concurrency', DOC_MODE \? '2' : '1'\)\)/.test(s), '全量并发不是拍板的 2 worker')
  c.ok(/Math\.min\(2, Math\.max\(1/.test(s), '并发未压到 ≤2（11-08 事故铁律）')
  c.ok(/UserInstallation=file:\/\/\$\{profile\}/.test(s), '缺每 worker 独立 LO profile（共用会挂死在单实例锁）')
  c.ok(/process\.kill\(-child\.pid, 'SIGKILL'\)/.test(s), '超时缺 killpg 清理孤儿 soffice')
  c.ok(/'nice'[\s\S]{0,80}'ionice'/.test(s), '缺 nice 19 / ionice -c3')
  c.ok(/const DOC_MAX_TRIES = 2/.test(s), '缺长尾换 profile 回插重试（阶段 0 实测 74s 长尾）')
  c.ok(/function assertDocFontGate\(\)/.test(s), '缺 Symbol 字体闸门')
  c.ok(/execFileSync\('fc-match', \['Symbol'\]/.test(s), '字体闸门没查 fc-match Symbol')
  c.ok(/DOC_CONVERT_TIMEOUT_BIG_MS/.test(s), '大文件没有放宽超时')
})

m.test('🔴 B9 零回归：不带 --doc 时方案 A 候选口径与两条主分支逐字不变', (c) => {
  const s = read(EXTRACT)
  c.ok(/const BASE_SCOPE_SQL = `/.test(s), '缺 BASE_SCOPE_SQL（历史口径被就地改写）')
  c.ok(
    /ext = 'docx' or ext = 'txt' or \(ext = 'pdf' and coalesce\(size_bytes, 0\) < \$\{PDF_MAX_BYTES\}\)/.test(s),
    '方案 A 的 docx/txt/pdf<1MB 候选口径被改动',
  )
  c.ok(/const DOC_SCOPE_SQL = `[\s\S]{0,200}ext = 'doc'/.test(s), '.doc 分支没有单独成批')
  c.ok(/const SCOPE_SQL = DOC_MODE \? DOC_SCOPE_SQL : BASE_SCOPE_SQL/.test(s), 'opt-in 切换缺失')
  c.ok(/async function applyRun\(client\)/.test(s), '历史 applyRun 消失')
  c.ok(/const YIELD_RATE = \{ docx: 0\.95, pdf: 0\.9, txt: 1\.0 \}/.test(s), '历史可抽率模型被改')
})

m.test('🔴 B10 缓存版本、提案状态、D-024 台账与不宣称', (c) => {
  const as = read(SERVICE_AS)
  c.ok(/const CACHE_VERSION = 'v14'/.test(as), 'CACHE_VERSION 被本提案改动（结果结构没变，不该 bump）')
  const p = read(PROPOSAL)
  c.ok(/提案号：P-019/.test(p) && /状态：已批准/.test(p), 'P-019 缺编号或不是已批准')
  c.ok(/阶段 2 硬门/.test(p), '提案缺阶段 2 硬门')
  const d = read(DECISION)
  c.ok(/## D-024 /.test(d), '台账缺 D-024 条目')
  const d24 = d.slice(d.indexOf('## D-024'))
  for (const bad of ['命中提升', '修复有效', '误判归零', '所有用户已可用', '图形全覆盖']) {
    c.ok(!d24.includes(`「${bad}」`), `D-024 出现宣称词「${bad}」`)
  }
})

export default m
