// 模块 42：老式 .doc 题干抠图「未放行守卫」（P-020 / D-026 → D-027，v2）
//
// 为什么单独一个模块：P-018 的 M40 守 docx 原位抠图，P-019 的 M41 守正文补抽，
// 本模块守的是两者之间那道最容易被人「顺手接上」的口子——
// `netdisk-inline-build.mjs` 候选 SQL 写死 ext='docx'，只要有人把它扩到 .doc，
// 就会在 F4 未评审、`w:object` 未定性时，把错位图写进生产。
//
// 🔴 v2（D-027，思傅 2026-11-10 逐题拍板 Q1①/Q2①/Q3①/Q4①、Q5 未授权）：
//    批准范围**仅阶段 1 影子链路**。守卫语义从「提案仍是草稿」升级为
//    「只准影子、不准写入」：F4 未实现、--apply 未授权、影子脚本零写库零产图。
//    阶段 2 获批时须再升 v3，不允许先改代码后补门。
// 🔴 负向断言一律先剥注释/docstring，否则注释里出现的表名会造成假阳性。

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { Module } from '../lib/harness.mjs'

const m = new Module('M42', '老式 .doc 抠图未放行守卫（P-020 / D-027）')
const ROOT = path.resolve(process.cwd(), '..')

const MATCH = 'server/src/shared/question-match.ts'
const SERVICE_AS = 'server/src/answer-search/answer-search.service.ts'
const BUILD = 'server/scripts/netdisk-inline-build.mjs'
const CROP = 'server/scripts/netdisk-inline-crop.py'
const SHADOW_MJS = 'server/scripts/doc-inline-shadow.mjs'
const SHADOW_PY = 'server/scripts/doc-inline-shadow.py'
const PROPOSAL = 'docs/design/method/proposals/P-020-老式doc题干抠图坐标系专项.md'
const REPORT = 'docs/reports/P-019-阶段3-坐标系复判与定位链路实证报告.md'
const DECISION = 'docs/design/method/decision-log.md'

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** JS：去块注释与整行 // 注释；Python：去 docstring、整行 # 注释 */
function codeJs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}
function codePy(src) {
  return src
    .replace(/"""[\s\S]*?"""/g, '')
    .replace(/'''[\s\S]*?'''/g, '')
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

m.test('🔴 B2 未放行守卫：inline-build 候选 SQL 仍限定 docx（F4 未实现）', (c) => {
  const s = codeJs(read(BUILD))
  c.ok(/where nf\.ext = 'docx'/.test(s), '候选 SQL 的 ext 过滤消失了')
  c.ok(!/ext\s+in\s*\(\s*'docx'\s*,\s*'doc'\s*\)/i.test(s),
    '候选 SQL 已被扩到 .doc —— F4 未获独立评审，须先批准并同步更新 M42')
  c.ok(!/doc_convert_done|text_sha256/.test(s),
    'F0 同源闸门已被塞进 inline-build，但阶段 2 / Q5 未获授权')
})

m.test('🔴 B3 未放行守卫：生产 crop 真相源未被 .doc 分支或 F0/F2 改动', (c) => {
  const s = codePy(read(CROP))
  c.ok(/def parse_docx\(/.test(s) && /def offset_in_stem\(/.test(s), 'P-018 定位链路核心函数缺失')
  c.ok(!/q_exp|char_start.*expect|doc_convert_done|text_sha256/.test(s),
    'F2 消歧 / F0 闸门被塞进生产 crop.py —— 只允许存在于影子脚本')
  c.ok(/ns\.find\(ns_stem\)/.test(s), 'P-018 的锚点重定位写法被改动，须重新实证')
})

m.test('🔴 B4 P-020 状态、Q1–Q4 拍板与 Q5 未授权', (c) => {
  const p = read(PROPOSAL)
  c.ok(/提案号：P-020/.test(p), 'P-020 缺提案号')
  c.ok(/状态：已批准/.test(p), 'P-020 未标已批准（仅阶段 1）—— 状态改动须同步 M42')
  c.ok(/批准范围＝仅阶段 1/.test(p), 'P-020 缺「仅阶段 1」批准范围限定')
  c.ok(/Q1/.test(p) && /Q5/.test(p), '逐题确认清单 Q1–Q5 缺失')
  c.ok(/Q5\*\*.*未授权|--apply.*未授权|Q5 未授权/.test(p), 'Q5 未授权口径缺失')
  c.ok(/F4 \| ⛔ \*\*未实现、未授权\*\*/.test(p), 'F4 未实现状态被改动')
  for (const f of ['F0', 'F1', 'F2', 'F3', 'F4']) {
    c.ok(p.includes(f), `五道闸门缺 ${f}`)
  }
})

m.test('🔴 B5 复判报告与 D-026 / D-027 台账、不宣称', (c) => {
  const r = read(REPORT)
  c.ok(/抠图仍不放行/.test(r), '复判报告缺「抠图仍不放行」结论')
  c.ok(/28\s*\/\s*28/.test(r), '复判报告缺 28/28 同源实证')
  c.ok(/244\s*\/\s*244/.test(r), '复判报告缺 F2 消歧实证')
  const d = read(DECISION)
  c.ok(/## D-026 /.test(d), '台账缺 D-026 条目')
  c.ok(/## D-027 /.test(d), '台账缺 D-027 拍板条目')
  const d26 = d.slice(d.indexOf('## D-026'))
  for (const bad of ['命中提升', '修复有效', '误判归零', '所有用户已可用', '图形全覆盖']) {
    c.ok(!d26.includes(`「${bad}」`), `台账出现宣称词「${bad}」`)
  }
})

m.test('🔴 B6 前后端契约未被本提案改动', (c) => {
  const as = read(SERVICE_AS)
  c.ok(/const CACHE_VERSION = 'v14'/.test(as), 'CACHE_VERSION 被改动（本提案不改 result 结构，不该 bump）')
  const p = read(PROPOSAL)
  c.ok(/前端与共享契约/.test(p) || /前端.*一行不改/.test(p), '提案缺「前端契约零改动」约束')
})

m.test('🔴 B7 阶段 1 影子脚本：四闸齐备且零写库 / 零产图 / 拒绝 --apply', (c) => {
  const py = codePy(read(SHADOW_PY))
  const js = codeJs(read(SHADOW_MJS))
  c.ok(fs.existsSync(path.join(ROOT, SHADOW_PY)) && fs.existsSync(path.join(ROOT, SHADOW_MJS)),
    '影子脚本缺失')
  // F0 / F1 / F2 / F3 的实现特征串
  c.ok(/f0_hash|textSha256/.test(py), 'F0 同源硬闸缺失')
  c.ok(/strict_prefix|b_len/.test(py), 'F1 判据修正缺失')
  c.ok(/q_exp|nearest|ambiguous/.test(py), 'F2 char_start 唯一最近消歧缺失')
  c.ok(/ole_skipped|formula/.test(py), 'F3 OLE 全跳过缺失')
  c.ok(/--selftest/.test(py) && /--selftest/.test(js), '合成反例自测入口缺失')
  // --apply 必须被明确拒绝
  c.ok(/argv\.includes\('--apply'\)/.test(js) && /process\.exit\(3\)/.test(js),
    '影子驱动未硬拒 --apply（Q5 未授权）')
  // 零写库 / 零产图 / 无 F4
  const both = py + '\n' + js
  c.ok(!/question_inline_figures|question_inline_done/.test(both),
    '影子脚本出现内联图写入目标表 —— 阶段 1 只准零写库')
  c.ok(!/insert\s+into|update\s+\w+\s+set|delete\s+from/i.test(both),
    '影子脚本出现 INSERT/UPDATE/DELETE —— 阶段 1 只准 SELECT')
  c.ok(!/save_webp|render\(scale|writeFile\([^)]*webp/.test(both),
    '影子脚本出现产图 / 写 storage 路径')
  c.ok(!/ext\s+in\s*\(\s*'docx'\s*,\s*'doc'\s*\)/i.test(both),
    '影子脚本私自扩了候选 SQL（F4 未授权）')
  c.ok(/select\b/i.test(js), '影子驱动缺只读 SELECT 链路')
})

m.test('🔴 B8 数据门与显式不宣称', (c) => {
  const p = read(PROPOSAL)
  c.ok(/不计算召回率/.test(p), 'P-020 缺「不计算召回率」')
  c.ok(/不外推/.test(p), 'P-020 缺「样本不外推全库」')
  c.ok(/定位不到不入库不下发/.test(p), 'P-020 缺 P-018 铁律')
  c.ok(/`question_inline_figures` 仍 0 行 `.doc` 来源|\.doc` 来源 `formula` 输出恒 0/.test(p),
    'P-020 缺数据门口径')
})

export default m
