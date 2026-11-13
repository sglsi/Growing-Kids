// 模块 45：题库入库「题干无实义」闸门守卫（D-046 → D-047）
//
// 为什么要有这个模块：D-046 逐份看图签核时发现，样张 03 的库内 stem_text 就是
// 「3、2100J 21000W 38%」这一行答案数据；顺着这条线只读实测生产库，暴露出一个
// **规模化的数据质量问题**（2026-11-13）：
//
//   656,898 个 question_objects 中
//     · 12,938 条题干只有一个题号（`19.` / `20.` / `28.`）
//     · 30,556 条连一个汉字或拉丁字母都没有（`5.50` / `0.307` / `0.231/10` / `30.（1）`）
//   随机抽 24 条，24/24 都是公式与答案区的数字碎片被题号边界误切。
//
// 现有三道入库闸（空题干 / 对象超长 / 解析串题号）一条都拦不住它们，
// `validateStoredObject()` 也只查「非空」⇒ 它们以 link_status='ok' 一路入库、
// 占用检索候选位，且即使被命中也不可解（P-024 §4「读得懂≠题目可解」）。
//
// 🔴 本模块只守**构建侧的第四道闸**，不碰判定层：
//    `question-match.ts` sha 必须仍是 baseline（六条硬闸、锚点、设问一致性零改动）。
//    闸门放在 buildRows 的「入库结构校验」里，与既有三道闸同级、同语义（只拒绝不放行）。
//
// ⚠️ 边界（本条**不**宣称解决）：含汉字但其实是答案行的题干（如 03 那种）有实义字符，
//    这条闸不拦；纯英文题与含字母公式也不拦（刻意不误伤）。它们属另一条风险。

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import { Module } from '../lib/harness.mjs'

const m = new Module('M45', '题库入库「题干无实义」闸门守卫（D-047）')
const ROOT = path.resolve(process.cwd(), '..') // server/ → 仓库根
const SERVER = path.join(ROOT, 'server')

const BUILD_SCRIPT = 'server/scripts/question-objects-build.mjs'
const MARK_SCRIPT = 'server/scripts/question-objects-mark-meaningless.mjs'
const SQL_MEASURE = 'server/scripts/measure-object-meaningless.sql'
const GATE_FIXTURE = 'server/scripts/verify/fixtures/question-object-gate-cases.json'
const MATCH = 'server/src/shared/question-match.ts'
const TMP_OUT = path.join(ROOT, '.tmp', 'verify-object-gate.json')

/** 判定层真相源基线 sha（与 M42 B1 / M43 / M44 同一常量口径） */
const MATCH_BASELINE_SHA = '84f998ff9d2bb2f5e2d3cec70b7ea309deef8ee69bfb558a4b8180939258ed10'

function read(rel) {
  const p = path.join(ROOT, rel)
  if (!fs.existsSync(p)) throw new Error(`文件不存在：${rel}`)
  return fs.readFileSync(p, 'utf8')
}

/** 一次性黑盒跑 fixture（dry-run，不写库），返回输出行 */
let cachedRows = null
function runFixture() {
  if (cachedRows) return cachedRows
  fs.mkdirSync(path.dirname(TMP_OUT), { recursive: true })
  execFileSync(
    process.execPath,
    ['scripts/question-objects-build.mjs', '--from-fixture', 'scripts/verify/fixtures/question-object-gate-cases.json', '--output', TMP_OUT],
    { cwd: SERVER, stdio: 'pipe', encoding: 'utf8' },
  )
  cachedRows = JSON.parse(fs.readFileSync(TMP_OUT, 'utf8')).rows
  return cachedRows
}

// ---------- 静态断言 ----------

m.test('A1 闸门函数存在、且刻意不 export（防 import 副作用）', (c) => {
  const src = read(BUILD_SCRIPT)
  c.ok(src.includes('function isStemMeaningless('), '缺少 isStemMeaningless 定义')
  c.ok(!/export\s+function\s+isStemMeaningless/.test(src), 'isStemMeaningless 不得 export（本脚本顶层直接执行）')
  c.ok(src.includes('STEM_MEANINGFUL_RE'), '缺少实义字符判定正则')
  // 判据必须是「有没有汉字/拉丁字母」，不能退化成「长度阈值」
  c.ok(src.includes('\\u4e00-\\u9fa5'), '实义判定必须包含汉字区间')
  c.ok(src.includes('a-zA-Z'), '实义判定必须包含拉丁字母（否则误伤纯英文题）')
})

m.test('A2 闸门位置：紧跟「题干为空」、且在「对象超长」之前', (c) => {
  const src = read(BUILD_SCRIPT)
  const iEmpty = src.indexOf("reason = '题干为空'")
  const iMeaningless = src.indexOf("reason = '题干无实义")
  const iTooLong = src.indexOf("reason = '对象超长")
  c.ok(iEmpty > 0, '找不到「题干为空」闸')
  c.ok(iMeaningless > 0, '找不到「题干无实义」闸')
  c.ok(iTooLong > 0, '找不到「对象超长」闸')
  // 三道闸同处一条 if/else 链，顺序即优先级
  c.ok(iEmpty < iMeaningless, '「题干无实义」必须排在「题干为空」之后')
  c.ok(iMeaningless < iTooLong, '「题干无实义」必须排在「对象超长」之前')
  c.ok(src.includes("row.link_status = 'rejected'"), '命中的对象必须置 rejected（只拒绝、不放行）')
})

m.test('A3 判定层零改动：question-match.ts sha 仍为 baseline', (c) => {
  const sha = crypto.createHash('sha256').update(read(MATCH), 'utf8').digest('hex')
  c.ok(sha === MATCH_BASELINE_SHA, `判定层被改动：${sha.slice(0, 12)}… ≠ ${MATCH_BASELINE_SHA.slice(0, 12)}…`)
})

m.test('A4 fixture 覆盖真实生产形态（不是只造好看样本）', (c) => {
  const fx = JSON.parse(read(GATE_FIXTURE))
  const text = JSON.stringify(fx)
  for (const real of ['19.', '0.307', '0.231/10']) {
    c.ok(text.includes(real), `fixture 缺少生产实测形态样本 ${real}`)
  }
  c.ok(/(求|如图)/.test(text), 'fixture 缺少正常题目样本（否则测不出误伤）')
  c.ok(/Choose|answer/i.test(text), 'fixture 缺少纯英文题样本（否则测不出拉丁字母误伤）')
})

m.test('A5 三处判据同口径（构建闸 / 标记脚本 / SQL 算子），防单边改', (c) => {
  const srcs = [
    ['SQL 算子', read(SQL_MEASURE)],
    ['标记脚本', read(MARK_SCRIPT)],
    ['构建脚本', read(BUILD_SCRIPT)],
  ]
  for (const [name, src] of srcs) {
    c.ok(src.includes('a-zA-Z'), `${name} 缺少拉丁字母判定（会误伤纯英文题）`)
    c.ok(src.includes('①-⑩'), `${name} 缺少碎片白名单（会把编码损坏的乱码题干误判成碎片）`)
  }
  // 标记脚本必须保留「只改标注列」与备份闸，否则会变成删数据/无闸写库
  const mark = read(MARK_SCRIPT)
  c.ok(mark.includes('--i-have-backup'), '标记脚本缺少备份确认闸（D-031）')
  c.ok(!/DELETE\s+FROM\s+question_objects/i.test(mark), '标记脚本不得删除对象行')
  c.ok(!/SET\s+stem_text/i.test(mark), '标记脚本不得改写题干原文')
  c.ok(mark.includes("link_status = 'rejected'"), '标记脚本必须置 rejected')
})

// ---------- 黑盒断言（真跑构建脚本） ----------

m.test('B1 纯题号碎片：全部 rejected，原因指向切题边界', (c) => {
  const rows = runFixture().filter((r) => r.source_id === 'gate-pure-mark')
  c.ok(rows.length > 0, '纯题号样本没有被切出任何对象（fixture 失效）')
  c.ok(rows.every((r) => r.link_status === 'rejected'), `仍有 ${rows.filter((r) => r.link_status === 'ok').length} 条纯题号被放行`)
  c.ok(rows.every((r) => String(r.link_reason || '').includes('题干无实义')), '拒绝原因未指向「题干无实义」')
})

m.test('B2 纯数值碎片：全部 rejected', (c) => {
  const rows = runFixture().filter((r) => r.source_id === 'gate-pure-number')
  c.ok(rows.length > 0, '纯数值样本没有被切出任何对象（fixture 失效）')
  c.ok(rows.every((r) => r.link_status === 'rejected'), `仍有 ${rows.filter((r) => r.link_status === 'ok').length} 条纯数值被放行`)
})

m.test('B3 不误伤：含汉字 / 含拉丁字母 / 编码损坏的题干必须放行', (c) => {
  const rows = runFixture()
  const cn = rows.filter((r) => r.source_id === 'gate-normal-stem')
  const en = rows.filter((r) => r.source_id === 'gate-latin-stem')
  const moji = rows.filter((r) => r.source_id === 'gate-mojibake-stem')
  c.ok(cn.length > 0 && cn.every((r) => r.link_status === 'ok'), '含汉字的正常题被判 rejected（误伤）')
  c.ok(en.length > 0 && en.every((r) => r.link_status === 'ok'), '纯英文题被判 rejected（误伤）')
  c.ok(moji.length > 0 && moji.every((r) => r.link_status === 'ok'), '编码损坏题干被判 rejected（把编码缺陷误当切题缺陷）')
  c.ok(cn.every((r) => !r.link_reason), '放行对象不应带 link_reason')
})

m.test('B4 指纹不受 link_status 影响（否则事后改标记会让对象永久失配）', (c) => {
  const rows = runFixture()
  c.ok(rows.length > 0, '无对象')
  c.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(String(r.object_fingerprint || ''))), '存在对象缺 64 位指纹')
  // 真相源：objectFingerprintInput 的入参字段必须与标记无交集
  const src = read(MATCH)
  const start = src.indexOf('export function objectFingerprintInput')
  c.ok(start > 0, '找不到 objectFingerprintInput')
  const body = src.slice(start, src.indexOf('}', src.indexOf('): string {', start)))
  c.ok(!body.includes('link_status'), '指纹入参含 link_status ⇒ 改标记会破坏内容寻址')
  c.ok(!body.includes('link_reason'), '指纹入参含 link_reason ⇒ 改标记会破坏内容寻址')
})

export default m
