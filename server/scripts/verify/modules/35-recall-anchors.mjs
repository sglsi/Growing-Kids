// 模块 35：召回侧锚点选择验收集（P-013 / D-016）
//
// 为什么单独一个模块：M27/M31 守判定硬闸、M32 守结构化对象、M33 守公共归属、
// M34 守 P2/P3 的排序与深挖；**没有任何一模块守「拿哪些词去 SQL 粗筛」**。
// 11-07 晚 6 条真实录入题 exact=0，根因正是这里：textAnchors 取 dist.keys 前 4 个，
// 而 keys 被 12 个 6 字滑窗占满 ⇒ 几何题用 DABC60/C60AB3/AB3BC5/BC5MN分，
// 英文题用 tsun/unam/swep，L3 里 47 份含 BMDN 的原题文件一份都进不了深挖池。
//
// 🔴 本模块守的核心契约：**召回选词改了，判定层行为必须逐字不变**。
//    `longAnchors` 基线快照 + 六条硬闸常量 + 深挖/预算/strict 一个都不能顺手改。
//    这是 D-014/D-015「召回变宽 ≠ 放行变宽」在 P-013 的延续。

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { Module } from '../lib/harness.mjs'

const m = new Module('M35', '召回侧锚点选择与判定层零改动验收集（P-013 / D-016）')
const ROOT = path.resolve(process.cwd(), '..')
const TMP = path.join(ROOT, '.tmp', 'verify-recall-anchors')
const require = createRequire(import.meta.url)
const ts = require('typescript')

const SERVICE_ND = 'server/src/netdisk/netdisk-search.service.ts'
const SERVICE_AS = 'server/src/answer-search/answer-search.service.ts'
const MATCH = 'server/src/shared/question-match.ts'
const PROPOSAL = 'docs/design/method/proposals/P-013-召回侧锚点选择与真实题命中修复.md'
const DECISION = 'docs/design/method/decision-log.md'
const DIAGNOSE = 'server/scripts/kb-hit-diagnose.mjs'

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const Q_GEO = '如图1，ABCD，∠ABC=60°，AB=3，BC=5，M、N分别为AD、DC上的点，DM+DN=4，则四边形BMDN的面积最大值是多少？'
const Q_EN = 'With the development of modern technology, scientists got a photo of a black hole. A. result B. support C. advice D. description'
const Q_TSUNAMI = 'The tsunami swept through the village and destroyed many houses.'
const Q_JIAOAN = '（2022·江苏淮安·统考一模）【问题探究】如图②，在菱形ABCD中，∠ABC＝120°，AB＝4，动点M、N分别在AD、CD上，若∠MBN＝60°'

// 判定层行为基线（2026-11-07 P-013 实施前，question-match.ts 编译产物实测）。
// 改动判定层就必须改这里 —— 强制走提案单，不能顺手放宽。
const LONG_ANCHOR_BASELINE = {
  [Q_GEO]: ['DABC60', 'C60AB3', 'AB3BC5', 'BC5MN分', 'MN分别为A', '别为ADDC', 'DDC上的点', '上的点DMD', 'DMDN4则', 'N4则四边形', '四边形BMD', 'BMDN的面', 'C60A', 'ABCD', 'ADDC', 'DMDN', 'BMDN'],
  [Q_EN]: [],
  [Q_JIAOAN]: ['2022江苏', '2江苏淮安统', '淮安统考一模', '考一模问题探', '问题探究如图', '究如图在菱形', '在菱形ABC', 'ABCD中A', 'D中ABC1', 'BC120A', '20AB4动', 'B4动点MN', '2022', 'C120A', 'ABCD', 'ADCD'],
}

let Q = null
/** 与 M27/M31 同一套做法：零依赖纯函数 tsc 单编后 require */
function compileCore() {
  fs.mkdirSync(TMP, { recursive: true })
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/shared/question-match.ts',
      '--outDir', TMP,
      '--module', 'commonjs',
      '--target', 'es2019',
      '--skipLibCheck',
      '--lib', 'es2019',
    ],
    { cwd: process.cwd(), stdio: 'pipe', encoding: 'utf8' },
  )
  Q = require(path.join(TMP, 'question-match.js'))
}

/**
 * 从 netdisk-search.service.ts 抽出纯函数段（isNoise / plainBlocks / extractKeys /
 * LATIN_STOP / isGenericPointLabel / pickTextAnchors），注入常量后单编执行。
 * 不引入 Nest / Supabase，验收集不需要起服务。
 */
function loadRecallFns() {
  if (!Q) compileCore()
  const svc = read(SERVICE_ND)
  const start = svc.indexOf('function isNoise(')
  const anchorAt = svc.indexOf('export function pickTextAnchors')
  const endMark = '\n  return out.slice(0, limit)\n}'
  const endAt = svc.indexOf(endMark, anchorAt)
  if (start < 0 || anchorAt < 0 || endAt < 0) throw new Error('抽不出召回纯函数段')
  const body = svc.slice(start, endAt + endMark.length)
  const prelude = [
    `const TOPIC_WORDS = ${JSON.stringify(Q.TOPIC_WORDS)};`,
    `const NOISE_PREFIX = ${JSON.stringify(Q.NOISE_PREFIX)};`,
    'const MAX_KEYS = 6;',
    'const TEXT_RECALL_KEYS = 4;',
    '',
  ].join('\n')
  const js = ts.transpileModule(prelude + body, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', js)(mod.exports, require, mod)
  return mod.exports
}

m.test('🔴 A1 判定层真相源本轮零改动（行为快照逐字一致）', (c) => {
  if (!Q) compileCore()
  for (const [q, expected] of Object.entries(LONG_ANCHOR_BASELINE)) {
    const got = Q.extractDistinctive(q).longAnchors
    c.eq(JSON.stringify(got), JSON.stringify(expected), `longAnchors 变了：${q.slice(0, 24)}`)
  }
  c.eq(Q.MATCH_MIN_LONG_ANCHORS, 3, '硬闸 ① ≥3 长锚点被改')
  c.eq(Q.MATCH_MIN_LONG_RATIO, 0.4, '长锚点比例被改')
  c.eq(Q.MATCH_MAX_OBJECT_CHARS, 6000, '对象 ≤6000 字被改')
  c.eq(Q.MATCH_MIN_SOLUTION_CHARS, 8, '相邻解析段 ≥8 字被改')
  c.eq(Q.MATCH_STRICT_ANCHOR_RATIO, 0.55, 'strict 锚点比例被改')
  c.eq(Q.OBJECT_ENGINE_VERSION, 'qobj-1', '对象引擎版本被改')
  const src = read(MATCH)
  c.ok(!/pickTextAnchors|LATIN_STOP|isGenericPointLabel/.test(src),
    '召回侧函数被塞进判定层真相源（question-match.ts 必须保持零依赖单文件）')
  const norm = src.replace(/\r\n/g, '\n')
  c.eq(crypto.createHash('sha256').update(norm, 'utf8').digest('hex'),
    '84f998ff9d2bb2f5e2d3cec70b7ea309deef8ee69bfb558a4b8180939258ed10',
    '判定层源码哈希变化 —— 走提案单，不要顺手改')
})

m.test('🔴 A2 深挖预算 / 在线抽取 / strict / 粗筛词数全部未动', (c) => {
  const svc = read(SERVICE_ND)
  c.ok(/MAX_DEEP_FILES = Number\(process\.env\.NETDISK_DEEP_FILES \?\? 8\)/.test(svc), '深挖上限不是 8')
  c.ok(/DEEP_BUDGET_MS = Number\(process\.env\.NETDISK_DEEP_BUDGET_MS \?\? 8_000\)/.test(svc), '主预算不是 8s')
  c.ok(/DEEP_HARD_BUDGET_MS = 18_000/.test(svc), '18s 硬兜底被改')
  c.ok(/ONLINE_EXTRACT_ENABLED = process\.env\.NETDISK_ONLINE_EXTRACT === '1'/.test(svc), '默认禁在线抽取被改')
  c.ok(/TEXT_RECALL_KEYS = Number\(process\.env\.NETDISK_TEXT_RECALL_KEYS \?\? 4\)/.test(svc), '粗筛词数被改（拍板保持 4）')
  c.ok(/NETDISK_TEXT_RECALL !== '0'|textRecallEnabled\(\)/.test(svc), '正文召回回退开关丢了')
  c.ok(/QUESTION_OBJECTS_STRICT/.test(svc) === false || /strict=1/.test(read(PROPOSAL)), 'strict 仍锁没写明')
  c.ok(/status === 'ok'|text_status', 'ok'/.test(svc), '正文通道不再只消费离线铺量内容')
})

m.test('🔴 A3 选词策略已换：pickTextAnchors 接管，不再取 dist.keys 前 4 个', (c) => {
  const svc = read(SERVICE_ND)
  c.ok(/export function pickTextAnchors/.test(svc), '缺 pickTextAnchors')
  c.ok(/const textAnchors = textRecallEnabled\(\)\s*\?\s*pickTextAnchors\(question, dist, TEXT_RECALL_KEYS\)/.test(svc),
    'search() 没有改用 pickTextAnchors')
  c.ok(!/distKeys\.filter\(\(k\) => k\.length >= 4\)\]\.slice\(0, TEXT_RECALL_KEYS\)/.test(svc),
    '旧的「取 keys 前 4 个」还在')
  c.ok(/const dist = extractDistinctive\(question\)/.test(svc), '没保留完整 Distinctive（anchors/longAnchors 是选词依据）')
  c.ok(/isGenericPointLabel/.test(svc) && /ABCD[\s\S]{0,400}5,027/.test(svc), '没写清通用点名的 DF 实测依据')
})

m.test('🔴 A4 拉丁块按整词取，不再切成 4 字碎片', (c) => {
  const svc = read(SERVICE_ND)
  c.ok(/LATIN_STOP/.test(svc), '缺英文停用词表')
  c.ok(/if \(\/\^\[A-Za-z\]\+\$\/\.test\(block\)\)/.test(svc), 'extractKeys 缺拉丁整词分支')
  c.ok(/tsun|unam|swep/.test(svc), '没记录被修复的碎片实例')
  const f = loadRecallFns()
  const enKeys = f.extractKeys(Q_TSUNAMI)
  c.ok(!enKeys.some((k) => /^(tsun|unam|swep|thro|roug|vill)$/.test(k)),
    `英文题干仍被切成碎片：${JSON.stringify(enKeys)}`)
  c.ok(enKeys.includes('tsunami'), `英文整词没进召回词：${JSON.stringify(enKeys)}`)
  const enAnchors = f.pickTextAnchors(Q_TSUNAMI, Q.extractDistinctive(Q_TSUNAMI), 4)
  c.ok(enAnchors.includes('tsunami'), `英文正文粗筛词不含 tsunami：${JSON.stringify(enAnchors)}`)
})

m.test('🔴 A5 几何题粗筛词含判别性点名、不含高频通用点名', (c) => {
  const f = loadRecallFns()
  const dist = Q.extractDistinctive(Q_GEO)
  const got = f.pickTextAnchors(Q_GEO, dist, 4)
  c.eq(got.length, 4, '粗筛词数量不是 4（拍板保持 4）')
  c.ok(got.includes('BMDN') || got.includes('DMDN'), `判别性点名没进粗筛词：${JSON.stringify(got)}`)
  c.ok(!got.includes('ABCD'), 'ABCD（DF=5027）没被排除，会吃满 2000 行扫描上限')
  c.ok(!got.includes('ADDC'), 'ADDC（相邻重复的通用点名粘连）没被排除')
  c.ok(!got.includes('DABC60'), '仍在只取题干开头的滑窗碎片')
  c.eq(f.isGenericPointLabel ? f.isGenericPointLabel('ABCD') : true, true, 'ABCD 应判为通用点名')
})

m.test('🔴 A6 结果内容会变 ⇒ CACHE_VERSION 必须 bump', (c) => {
  const svc = read(SERVICE_AS)
  c.ok(/const CACHE_VERSION = 'v9'/.test(svc), 'CACHE_VERSION 不是 v9（旧缓存会继续返回 topic）')
  c.ok(/P-013 \/ D-016/.test(svc), '没写明 bump 原因')
  c.ok(!/const CACHE_VERSION = 'v8'/.test(svc), '还留着 v8')
})

m.test('🔴 A7 文档：六栏 / 拍板 / 诊断脚本 / 不宣称 / 仍锁', (c) => {
  const p = read(PROPOSAL), d = read(DECISION)
  c.ok(/提案号：P-013/.test(p) && /状态：已批准/.test(p), 'P-013 缺编号或已批准状态')
  c.ok(/^### [①-⑥]/m.test(p), 'P-013 缺六栏结构')
  c.ok(/A\+B 分两步/.test(p) && /英文题干一起修|一起修/.test(p), 'P-013 没记拍板结果')
  c.ok(/D-016/.test(d), '台账缺 D-016')
  c.ok(fs.existsSync(path.join(ROOT, DIAGNOSE)), '缺只读诊断脚本 kb-hit-diagnose.mjs')
  c.ok(/不作召回率结论|不得据此计算召回率/.test(p), 'P-013 没写「不作召回率结论」')
  c.ok(/所有用户已可用/.test(p) && /误判归零/.test(p), 'P-013 没写禁用宣称词')
  c.ok(/QUESTION_OBJECTS_STRICT=1/.test(p) && /第二层上线准入/.test(p), 'P-013 没写仍锁项')
  c.ok(/上游 OCR/.test(p) && /证伪/.test(p), 'P-013 没订正上一轮的错误归因')
})

m.test('🔴 A8 只改召回、不碰答案形态（双减 §15）', (c) => {
  const svc = read(SERVICE_ND)
  c.ok(/matchLevel: j\.exact \? 'exact' : 'topic'/.test(svc), 'matchLevel 判定被改')
  c.ok(/question-match[^\n]*一行未动|判定层一行未动|\*\*`shared\/question-match\.ts` 一行未动\*\*/.test(svc),
    '源码注释没写明判定层零改动')
  c.ok(/judgeObjects\(question, text, source\)/.test(svc), '原题判定调用被改或绕过')
  c.ok(/source_location|sourceLocation/.test(svc), 'exact 的来源定位被去掉了')
})

export default m
