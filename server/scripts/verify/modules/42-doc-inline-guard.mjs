// 模块 42：老式 .doc 题干抠图「未放行守卫」（P-020 / D-026 → D-027 → D-033，v3）
//
// 为什么单独一个模块：P-018 的 M40 守 docx 原位抠图，P-019 的 M41 守正文补抽，
// 本模块守的是两者之间那道最容易被人「顺手接上」的口子——
// `netdisk-inline-build.mjs` 候选 SQL 写死 ext='docx'，只要有人把它扩到 .doc，
// 就会在 F0/F2/F5 未验、`w:object` 未定性时，把错位图写进生产。
//
// 🔴 v2（D-027，Q1①/Q2①/Q3①/Q4①、Q5 未授权）：只准影子、不准写入。
// 🔴 v3（D-033，思傅「A授权；B/C 均选择2；D给出复核步骤」）：
//    · F4 获批，但采取**独立链路**实现：新建 `doc-inline-figure-build.mjs` /
//      `doc-inline-figure-crop.py`，`netdisk-inline-build.mjs` 一行不动（docx 零回归）。
//    · Q5 的 --apply 已由 D-032 授权，但 C② 让写库**顺延**到 `m:oMath`/`w:object`
//      定性独立提案（P-023）与 40 条人工复核完成 ⇒ v3 对独立链路加**结构性硬锁**：
//      常量 APPLY_ENABLED=false + 环境变量 DOC_INLINE_APPLY_APPROVED 双闸，
//      --apply 一律 exit 3。
//    · 「抠图仍不放行」总裁定**不推翻**；P-020 历史行不涂改，只在 §7 加 D-033 指针。
//    · 守卫顺序：先把 v3 的门写好（B2/B4/B7/B9/B10），再动实现代码，不得倒序。
// 🔴 负向断言一律先剥注释/docstring，否则注释里出现的表名会造成假阳性。

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { Module } from '../lib/harness.mjs'

const m = new Module('M42', '老式 .doc 抠图未放行守卫（P-020 / D-033，v3）')
const ROOT = path.resolve(process.cwd(), '..')

const MATCH = 'server/src/shared/question-match.ts'
const SERVICE_AS = 'server/src/answer-search/answer-search.service.ts'
const BUILD = 'server/scripts/netdisk-inline-build.mjs'
const CROP = 'server/scripts/netdisk-inline-crop.py'
const SHADOW_MJS = 'server/scripts/doc-inline-shadow.mjs'
const SHADOW_PY = 'server/scripts/doc-inline-shadow.py'
const PROPOSAL = 'docs/design/method/proposals/P-020-老式doc题干抠图坐标系专项.md'
const PROPOSAL22 = 'docs/design/method/proposals/P-022-F4候选扩展与Q5小批量放行前置评估.md'
const PROPOSAL23 = 'docs/design/method/proposals/P-023-老式doc公式与OLE对象定性.md'
const DOC_FIGURE_MJS = 'server/scripts/doc-inline-figure-build.mjs'
const DOC_FIGURE_PY = 'server/scripts/doc-inline-figure-crop.py'
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

m.test('🔴 B2 docx 零回归：inline-build 候选 SQL 仍限定 docx，.doc 走独立链路', (c) => {
  const s = codeJs(read(BUILD))
  c.ok(/where nf\.ext = 'docx'/.test(s), '候选 SQL 的 ext 过滤消失了')
  c.ok(!/ext\s+in\s*\(\s*'docx'\s*,\s*'doc'\s*\)/i.test(s),
    '候选 SQL 被扩到 .doc —— D-033 要求 .doc 走独立链路，docx 侧零回归')
  c.ok(!/doc_convert_done|text_sha256/.test(s),
    'F0 同源闸门被塞进 inline-build —— .doc 的 F0 只准在独立链路里')
  c.ok(fs.existsSync(path.join(ROOT, DOC_FIGURE_MJS)) && fs.existsSync(path.join(ROOT, DOC_FIGURE_PY)),
    'D-033 授权的独立 .doc 产图链路文件缺失（先补门再动代码：门已写好，待实现）')
})

m.test('🔴 B3 未放行守卫：生产 crop 真相源未被 .doc 分支或 F0/F2 改动', (c) => {
  const s = codePy(read(CROP))
  c.ok(/def parse_docx\(/.test(s) && /def offset_in_stem\(/.test(s), 'P-018 定位链路核心函数缺失')
  c.ok(!/q_exp|char_start.*expect|doc_convert_done|text_sha256/.test(s),
    'F2 消歧 / F0 闸门被塞进生产 crop.py —— 只允许存在于影子脚本')
  c.ok(/ns\.find\(ns_stem\)/.test(s), 'P-018 的锚点重定位写法被改动，须重新实证')
})

m.test('🔴 B4 总裁定不推翻 + P-020/P-022 §7 的 D-033 指针 + Q5 顺延边界', (c) => {
  const p = read(PROPOSAL)
  c.ok(/提案号：P-020/.test(p), 'P-020 缺提案号')
  c.ok(/状态：已批准/.test(p), 'P-020 未标已批准（仅阶段 1）—— 状态改动须同步 M42')
  c.ok(/批准范围＝仅阶段 1/.test(p), 'P-020 缺「仅阶段 1」批准范围限定')
  c.ok(/Q1/.test(p) && /Q5/.test(p), '逐题确认清单 Q1–Q5 缺失')
  c.ok(/抠图仍不放行/.test(p), 'P-020 的「抠图仍不放行」总裁定被推翻 —— D-033 不推翻')
  c.ok(/D-033/.test(p), 'P-020 §7 缺 D-033 当前状态指针（历史行不涂改，只追加）')
  const p22 = read(PROPOSAL22)
  c.ok(/D-033/.test(p22) && /顺延/.test(p22), 'P-022 §7 缺「Q5 --apply 顺延 + D-033」登记')
  c.ok(fs.existsSync(path.join(ROOT, PROPOSAL23)), 'C② 要求的 P-023 定性独立提案缺失')
  c.ok(/顺延/.test(read(PROPOSAL23)), 'P-023 未登记 Q5 --apply 顺延')
  for (const f of ['F0', 'F1', 'F2', 'F3', 'F4', 'F5']) {
    c.ok(p.includes(f), `闸门缺 ${f}（历史行保留，F5/F5b 见 D-032/D-033）`)
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

m.test('🔴 B7 阶段 1 影子脚本：四闸齐备、永久只读、零产图、硬拒 --apply', (c) => {
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
    '影子驱动未硬拒 --apply（写库统一由独立链路执行，本链路永久只读）')
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

m.test('🔴 B9 独立 .doc 产图链路：默认只读 / --apply 双硬锁 / Python 侧零写库', (c) => {
  const js = codeJs(read(DOC_FIGURE_MJS))
  const py = codePy(read(DOC_FIGURE_PY))
  const both = js + '\n' + py
  c.ok(/APPLY_ENABLED\s*=\s*false/.test(js),
    '硬锁常量 APPLY_ENABLED 不是 false —— P-023 定性与 40 条人工复核未签核前不得写库')
  c.ok(/DOC_INLINE_APPLY_APPROVED/.test(js), '缺二次授权环境变量 DOC_INLINE_APPLY_APPROVED')
  c.ok(/argv\.includes\('--apply'\)/.test(js) && /process\.exit\(3\)/.test(js),
    '独立链路 --apply 未硬拒（exit 3）')
  c.ok(/netdisk-inline-crop\.py/.test(both), '未复用生产真相源 crop.py（禁止另起口径）')
  c.ok(/semantic_gate|run_shadow/.test(py), 'Python 侧未复用 F5/F5b 判定（会绕过看得懂闸）')
  c.ok(!/question_inline_figures|question_inline_done/.test(py), 'Python 侧出现写库目标表')
  c.ok(!/insert\s+into|update\s+\w+\s+set|delete\s+from/i.test(py), 'Python 侧出现 DML')
  c.ok(/F5B_NOISE|semantic_gate/.test(py), '独立链路未带 F5b 新规则')
})

m.test('🔴 B10 F5b「换行+短数字串」专项规则与可对照基线', (c) => {
  const py = read(SHADOW_PY)
  c.ok(/F5B_NOISE/.test(py) && /F5B_ALLOW_WORDS/.test(py), 'F5b 规则 / 允许词缺失')
  c.ok(/newline_short_number_(after|before)/.test(py), 'F5b drop_reason 缺失')
  for (const k of ['f5b_leak_1', 'f5b_leak_2', 'f5b_leak_3', 'f5b_allow_导学号']) {
    c.ok(py.includes(k), `D-032 §4① 边界候选自测缺 ${k}`)
  }
  c.ok(/f5b_normal_year|f5b_underscore_fill/.test(py), 'F5b 防误伤反例缺失')
  const js = read(SHADOW_MJS)
  c.ok(/f4_in_this_script:\s*false/.test(js) && /apply_in_this_script:\s*false/.test(js),
    '影子驱动未明确「本链路不实现 F4 / 不写库」')
  c.ok(/25\/25/.test(js), 'F5b 自测口径未同步到 summary 元数据')
})

export default m
