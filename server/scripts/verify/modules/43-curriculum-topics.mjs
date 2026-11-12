// 模块 43：国家课标自建多科目知识点维度表（P-027 / D-039）
//
// 为什么单独一个模块：M27/M31 守判定硬闸、M37 守参考例题契约、M42 守 .doc 抠图，
// **没有模块守「新增的知识点维度表有没有越界」**。P-027 最容易出的三类事故：
//   ① 把教材〔2025〕1号里与项目库无关的科目（科学/信息科技/艺术/劳动…）
//      或项目库里没有国标课标的「生活」一并导进来；
//   ② 把 cc BY-NC 第三方图谱的编号/转述条文改名当成「国标」写进 seed；
//   ③ 顺手把新词表并进 `sharedSignals()`，破 P-025 T4 契约 sha 与 CACHE_VERSION。
//
// 🔴 本模块守的核心契约：**范围只 9 科／数据分层标注／判定层一行未动**。
//    纯静态断言，不连后端、不查库；写库结果由 D-039 台账与迁移回查另行记录。

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { Module } from '../lib/harness.mjs'

const m = new Module('M43', '国家课标自建多科目知识点维度表守卫（P-027 / D-039）')
const ROOT = path.resolve(process.cwd(), '..')          // server/ → 仓库根

const SQL = 'migrations/0032_curriculum_topics.sql'
const TS = 'server/src/shared/curriculum-topics.ts'
const MATCH = 'server/src/shared/question-match.ts'
const REF = 'server/src/shared/question-reference.ts'
const CACHE = 'server/src/answer-search/answer-search.service.ts'
const PROPOSAL = 'docs/design/method/proposals/P-027-国家课标自建多科目知识点维度表实施.md'
const DECISION = 'docs/design/method/decision-log.md'
const SUBJECTS = 'server/src/subjects/subjects.types.ts'

// M42 B1 已在用的判定层真相源基线 sha；本模块复用，保证判定层一行未动
const MATCH_BASELINE_SHA = '84f998ff9d2bb2f5e2d3cec70b7ea309deef8ee69bfb558a4b8180939258ed10'

const ALLOWED = ['chinese', 'math', 'english', 'physics', 'chemistry', 'biology', 'history', 'geography', 'politics'].sort()
const FORBIDDEN_SUBJECTS = ['生活', '科学', '信息科技', '体育与健康', '艺术', '劳动', '日语', '俄语']
const FORBIDDEN_CODES = ['life', 'science', 'info_tech', 'pe', 'art', 'labor', 'japanese', 'russian']
const THIRD_PARTY_MARKS = ['cms-2022', 'ccs-2022', 'verbatim', 'marble', 'os-taxonomy', 'cn-math-taxonomy', '3ecd054']

function read(rel) {
  const p = path.join(ROOT, rel)
  if (!fs.existsSync(p)) throw new Error(`文件不存在：${rel}`)
  return fs.readFileSync(p, 'utf8')
}

/** 取 insert ... values 之后的数据行（注释 / DDL 不参与解析） */
function parseRows(sql) {
  const anchor = ') values'
  const i = sql.indexOf(anchor)
  if (i < 0) throw new Error('migration 缺少 insert ... values 段')
  const body = sql.slice(i + anchor.length)
  const lines = body.split(/\r?\n/).filter((l) => l.trim().startsWith('('))
  return lines.map((l) => {
    let s = l.trim()
    if (s.endsWith(',')) s = s.slice(0, -1).trim()
    if (!s.endsWith(')')) throw new Error(`数据行未闭合：${s.slice(0, 80)}`)
    s = s.slice(1, -1)
    // 所有值都用单引号包裹（数字/布尔除外），且值内不含半角逗号 ⇒ 可直接 split
    const parts = s.split(',').map((x) => x.trim())
    const unq = (v) => (v.startsWith("'") && v.endsWith("'") ? v.slice(1, -1).replace(/''/g, "'") : v)
    return parts.map(unq)
  })
}

const COLS = ['subject_code', 'subject_name', 'standard_name', 'stage', 'grade_min', 'grade_max',
  'domain', 'topic', 'term', 'standard_version', 'standard_doc', 'source_url',
  'framework_verified', 'term_origin', 'version_note']

let cached = null
function rows() {
  if (!cached) cached = parseRows(read(SQL))
  return cached
}
const col = (r, name) => r[COLS.indexOf(name)]

m.test('B1 migration 存在、幂等、与 question_objects 解耦', (c) => {
  const sql = read(SQL)
  c.ok(sql.includes('create table if not exists curriculum_topics'), '缺少 create table if not exists')
  c.ok(sql.includes('create index if not exists'), '索引未幂等')
  c.ok(/on conflict \(subject_code, stage, domain, topic, term\) do nothing/i.test(sql), '缺少 on conflict do nothing（幂等硬门）')
  c.ok(!/alter\s+table\s+question_objects/i.test(sql), '🔴 不得改动 question_objects（656,898 行）')
  c.ok(!/insert\s+into\s+question_objects/i.test(sql), '🔴 不得向 question_objects 回填')
  c.ok(!/references\s+question_objects/i.test(sql), '🔴 不得与题目表建外键')
})

m.test('B2 seed 可解析：每行 15 列、唯一键无重复', (c) => {
  const rs = rows()
  c.ok(rs.length > 0, 'seed 为空')
  const bad = rs.findIndex((r) => r.length !== 15)
  c.eq(bad, -1, `第 ${bad + 1} 行列数不等于 15（实际 ${bad >= 0 ? rs[bad].length : '-'}）`)
  const keys = rs.map((r) => [col(r, 'subject_code'), col(r, 'stage'), col(r, 'domain'), col(r, 'topic'), col(r, 'term')].join('|'))
  c.eq(new Set(keys).size, keys.length, '唯一键 (subject_code,stage,domain,topic,term) 有重复')
})

m.test('🔴 B3 科目范围恰好 9 科，无无关科目 code', (c) => {
  const codes = [...new Set(rows().map((r) => col(r, 'subject_code')))].sort()
  c.eq(codes.join(','), ALLOWED.join(','), 'subject_code 集合与 P-027 §1.1 的 9 科不一致')
  for (const f of FORBIDDEN_CODES) {
    c.ok(!codes.includes(f), `🔴 引入了无关科目 code：${f}`)
  }
})

m.test('🔴 B4 「生活」与教材文件中其他科目未作为学科写入', (c) => {
  const names = [...new Set(rows().map((r) => col(r, 'subject_name')))]
  for (const f of FORBIDDEN_SUBJECTS) {
    c.ok(!names.includes(f), `🔴 subject_name 出现不应引入的学科：${f}`)
  }
  const subs = read(SUBJECTS)
  const defs = subs.match(/\{ name: '[^']+'/g) || []
  const defaults = defs.map((s) => s.replace(/.*name: '([^']+)'.*/, '$1'))
  c.eq(defaults.length, 10, '项目库 DEFAULT_SUBJECTS 应为 10 门（科目范围真相源）')
  c.ok(names.every((n) => defaults.includes(n)), 'seed 的学科名必须来自项目库 DEFAULT_SUBJECTS')
})

m.test('B5 数据分层标注：term_origin 恒为 project，framework_verified 为布尔', (c) => {
  for (const r of rows()) {
    c.eq(col(r, 'term_origin'), 'project', 'term_origin 只能为 project（不得冒充课标条文）')
    c.ok(['true', 'false'].includes(col(r, 'framework_verified')), `framework_verified 非布尔：${col(r, 'framework_verified')}`)
  }
  const high = rows().filter((r) => col(r, 'stage') === '高中')
  c.ok(high.length > 0, '缺少高中段数据')
  c.ok(high.every((r) => col(r, 'framework_verified') === 'false'), '🔴 高中段领域未逐科核对官方文本，framework_verified 必须 false')
})

m.test('B6 每行版本 / 出处非空，学段与年级合法', (c) => {
  for (const r of rows()) {
    for (const k of ['standard_version', 'standard_doc', 'source_url', 'domain', 'topic', 'term']) {
      c.ok(String(col(r, k) || '').trim().length > 0, `${k} 为空（subject=${col(r, 'subject_code')} term=${col(r, 'term')}）`)
    }
    c.ok(['小学', '初中', '高中'].includes(col(r, 'stage')), `非法学段：${col(r, 'stage')}`)
    const lo = Number(col(r, 'grade_min'))
    const hi = Number(col(r, 'grade_max'))
    c.ok(lo >= 1 && hi <= 12 && lo <= hi, `年级区间非法：${lo}..${hi}`)
  }
})

m.test('B7 义教物理 / 生物学版本标注「待官方核对」', (c) => {
  const target = rows().filter((r) => ['physics', 'biology'].includes(col(r, 'subject_code')) && col(r, 'stage') !== '高中')
  c.ok(target.length > 0, '缺少义教物理/生物学数据')
  c.ok(target.every((r) => String(col(r, 'version_note')).includes('待教育部官方附件核对')),
    '🔴 2025 修订版转载清单未列物理/生物学，必须标注待核对、不得宣称已核实')
  c.ok(target.every((r) => col(r, 'standard_version') === '2022年版'), '义教物理/生物学应按 2022 版登记')
})

m.test('🔴 B8 seed 中零第三方图谱表达 / 自编编号', (c) => {
  const sql = read(SQL)
  const anchor = ') values'
  const data = sql.slice(sql.indexOf(anchor) + anchor.length)
  const low = data.toLowerCase()
  for (const mark of THIRD_PARTY_MARKS) {
    c.ok(!low.includes(mark.toLowerCase()), `🔴 seed 数据区出现第三方图谱标记：${mark}`)
  }
  c.ok(!/verbatim\s*=\s*false/.test(low), '不得复制第三方 verbatim 字段')
})

m.test('B9 TS 共享契约与 migration 的 9 科逐字一致，且不接入检索链路', (c) => {
  const ts = read(TS)
  const block = ts.slice(ts.indexOf('SUBJECT_STANDARD_MAP'), ts.indexOf('/** `curriculum_topics`'))
  const keys = [...block.matchAll(/^\s{2}(\w+):\s*\{/gm)].map((x) => x[1]).sort()
  c.eq(keys.join(','), ALLOWED.join(','), 'TS SUBJECT_STANDARD_MAP 与 migration 科目集合不一致')
  const codes = [...new Set(rows().map((r) => col(r, 'subject_code')))].sort()
  c.eq(keys.join(','), codes.join(','), 'TS 常量与 seed 的 subject_code 不一致')
  // ⚠️ 负向断言必须先剥注释：红线注释里本来就会提到 sharedSignals()，直接扫全文会假阳性
  const code = ts.replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n')
  c.ok(!code.includes('sharedSignals('), '🔴 共享模块不得调用 sharedSignals()')
  c.ok(ts.includes('不接入检索链路'), '共享模块必须保留「不接入检索链路」红线注释')
})

m.test('🔴 B10 判定层与参考例题层一行未动、CACHE_VERSION 未 bump', (c) => {
  const match = read(MATCH).replace(/\r\n/g, '\n')
  c.eq(crypto.createHash('sha256').update(match, 'utf8').digest('hex'), MATCH_BASELINE_SHA,
    'question-match.ts 被改动 —— 走提案单，不要顺手改判定层')
  const ref = read(REF)
  c.ok(!ref.includes('curriculum_topics'), '🔴 question-reference.ts 不得引用新维度表')
  c.ok(!ref.includes('SUBJECT_STANDARD_MAP'), '🔴 question-reference.ts 不得引入新科目映射')
  const terms = ref.slice(ref.indexOf('const TOPIC_TERMS'), ref.indexOf(']', ref.indexOf('const TOPIC_TERMS')))
  c.eq((terms.match(/'[^']+'/g) || []).length, 55, 'TOPIC_TERMS 应仍为 55 词（P-025 T4 契约 sha 零改动口径）')
  const cache = read(CACHE)
  c.ok(/const CACHE_VERSION = 'v14'/.test(cache), '🔴 CACHE_VERSION 必须保持 v14')
})

m.test('B11 流程门：P-027 实施提案与 D-039 台账齐备', (c) => {
  const p = read(PROPOSAL)
  c.ok(/提案号：P-027/.test(p), 'P-027 提案号缺失')
  c.ok(/状态：已批准/.test(p), 'P-027 必须为已批准的实施提案')
  for (const k of ['① 判据', '② 归因', '③ 证据', '④ 算子', '⑤ falsifier', '⑥ 验收断言']) {
    c.ok(p.includes(`### ${k}`), `P-027 六栏缺 ${k}`)
  }
  const d = read(DECISION)
  c.ok(d.includes('D-039'), 'D-039 台账未登记')
  c.ok(d.includes('NQ1＝本轮就写库'), 'D-039 未登记 NQ1 拍板')
})

m.test('B12 不宣称：迁移注释与提案保留来源级别与待核项', (c) => {
  const sql = read(SQL)
  c.ok(sql.includes('唯一取数源＝教育部官方文本'), '缺少取数源判据')
  c.ok(sql.includes('不是课标条文'), '缺少 term 非课标条文的声明')
  c.ok(sql.includes('未逐科核对官方文本'), '缺少未核验标注')
  c.ok(sql.includes('不宣称覆盖课标全部内容') || sql.includes('不宣称覆盖'), '缺少「不宣称全覆盖」')
  const p = read(PROPOSAL)
  c.ok(p.includes('不宣称'), 'P-027 缺少不宣称纪律')
})

export default m
