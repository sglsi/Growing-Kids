// 模块 42：老式 .doc 题干抠图「未放行守卫」（P-020 / D-026）
//
// 为什么单独一个模块：P-018 的 M40 守 docx 原位抠图，P-019 的 M41 守正文补抽，
// 本模块守的是两者之间那道最容易被人「顺手接上」的口子——
// `netdisk-inline-build.mjs` 候选 SQL 写死 ext='docx'，只要有人把它扩到 .doc，
// 就会在 F0/F2/F3 闸门尚未实现、w:object 尚未定性时，把错位图写进生产。
//
// 🔴 本模块是「未放行守卫」：断言的是**代码尚未被改动**。
//    待 P-020 的 Q1–Q5 批准、闸门实现时，必须同步更新本模块，
//    不允许先改代码后补门。与 M41 同坑：负向断言一律先剥注释。

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { Module } from '../lib/harness.mjs'

const m = new Module('M42', '老式 .doc 抠图未放行守卫（P-020 / D-026）')
const ROOT = path.resolve(process.cwd(), '..')

const MATCH = 'server/src/shared/question-match.ts'
const SERVICE_AS = 'server/src/answer-search/answer-search.service.ts'
const BUILD = 'server/scripts/netdisk-inline-build.mjs'
const CROP = 'server/scripts/netdisk-inline-crop.py'
const PROPOSAL = 'docs/design/method/proposals/P-020-老式doc题干抠图坐标系专项.md'
const REPORT = 'docs/reports/P-019-阶段3-坐标系复判与定位链路实证报告.md'
const DECISION = 'docs/design/method/decision-log.md'

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** JS：去块注释与整行 // 注释；Python：去整行 # 注释与 docstring 行 */
function codeJs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}
function codePy(src) {
  return src
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
}

m.test('🔴 B1 判定层真相源一行未动（与 M35–M41 同基线）', (c) => {
  const src = read(MATCH).replace(/\r\n/g, '\n')
  c.eq(
    crypto.createHash('sha256').update(src, 'utf8').digest('hex'),
    '84f998ff9d2bb2f5e2d3cec70b7ea309deef8ee69bfb558a4b8180939258ed10',
    'question-match.ts 被改动 —— 走提案单，不要顺手改判定层',
  )
})

m.test('🔴 B2 未放行守卫：inline-build 候选 SQL 仍限定 docx', (c) => {
  const s = codeJs(read(BUILD))
  c.ok(/where nf\.ext = 'docx'/.test(s), '候选 SQL 的 ext 过滤消失了')
  c.ok(!/ext\s+in\s*\(\s*'docx'\s*,\s*'doc'\s*\)/i.test(s),
    '候选 SQL 已被扩到 .doc —— P-020 尚未批准实施，须先过 Q1–Q5 并同步更新 M42')
  c.ok(!/doc_convert_done|text_sha256/.test(s),
    'F0 同源闸门已被塞进 inline-build，但 P-020 仍为草稿')
})

m.test('🔴 B3 未放行守卫：crop 脚本未混入 .doc 分支与 F2 消歧', (c) => {
  const s = codePy(read(CROP))
  c.ok(/def parse_docx\(/.test(s) && /def offset_in_stem\(/.test(s), 'P-018 定位链路核心函数缺失')
  c.ok(!/q_exp|char_start.*expect|doc_convert_done|text_sha256/.test(s),
    'F2 消歧 / F0 闸门已被塞进 crop.py，但 P-020 仍为草稿')
  c.ok(/ns\.find\(ns_stem\)/.test(s), 'P-018 的锚点重定位写法被改动，须重新实证')
})

m.test('🔴 B4 P-020 状态与逐题确认清单', (c) => {
  const p = read(PROPOSAL)
  c.ok(/提案号：P-020/.test(p), 'P-020 缺提案号')
  c.ok(/状态：(草稿|待批准)/.test(p), 'P-020 状态不是草稿/待批准 —— 若已批准实施，须同步更新 M42')
  c.ok(/Q1/.test(p) && /Q5/.test(p), '逐题确认清单 Q1–Q5 缺失')
  for (const f of ['F0', 'F1', 'F2', 'F3', 'F4']) {
    c.ok(p.includes(f), `五道闸门缺 ${f}`)
  }
})

m.test('🔴 B5 复判报告与 D-026 台账、不宣称', (c) => {
  const r = read(REPORT)
  c.ok(/抠图仍不放行/.test(r), '复判报告缺「抠图仍不放行」结论')
  c.ok(/28\s*\/\s*28/.test(r), '复判报告缺 28/28 同源实证')
  c.ok(/244\s*\/\s*244/.test(r), '复判报告缺 F2 消歧实证')
  const d = read(DECISION)
  c.ok(/## D-026 /.test(d), '台账缺 D-026 条目')
  const d26 = d.slice(d.indexOf('## D-026'))
  for (const bad of ['命中提升', '修复有效', '误判归零', '所有用户已可用', '图形全覆盖']) {
    c.ok(!d26.includes(`「${bad}」`), `D-026 出现宣称词「${bad}」`)
  }
})

m.test('🔴 B6 前后端契约未被本提案改动', (c) => {
  const as = read(SERVICE_AS)
  c.ok(/const CACHE_VERSION = 'v14'/.test(as), 'CACHE_VERSION 被改动（本提案不改 result 结构，不该 bump）')
  const p = read(PROPOSAL)
  c.ok(/前端与共享契约/.test(p) || /前端.*一行不改/.test(p), '提案缺「前端契约零改动」约束')
})

export default m
