// 模块 37：相似例题思路借鉴与事先声明（P-015 / D-018）
//
// 为什么单独一个模块：M27/M31 守判定硬闸、M32 守结构化对象、M33 守公共归属、
// M34 守 P2/P3、M35 守召回选词、M36 守输入闸门；**没有任何一模块守「非 exact
// 时额外呈现的参考例题」**。思傅 2026-11-07 重锚最终目的＝「拿到正确解答思路
// 和过程」，允许题目不完全一致但思路可借鉴时提供库内题目与解析，**须事先声明**。
//
// 🔴 本模块守的核心契约：**判定层一行未动、answer 口径零放宽、声明先于内容**。
//    参考例题是并列的第二层，不是 exact 的降级替代，更不是「放宽硬闸」。

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { createRequire } from 'module'
import { Module } from '../lib/harness.mjs'

const m = new Module('M37', '相似例题思路借鉴与事先声明验收集（P-015 / D-018）')
const ROOT = path.resolve(process.cwd(), '..')
const require = createRequire(import.meta.url)
const ts = require('typescript')

const MATCH = 'server/src/shared/question-match.ts'
const REF = 'server/src/shared/question-reference.ts'
const REF_MIRROR = 'src/constants/reference-disclaimer.ts'
const SERVICE_ND = 'server/src/netdisk/netdisk-search.service.ts'
const SERVICE_AS = 'server/src/answer-search/answer-search.service.ts'
const STORE = 'server/src/shared/question-object-store.ts'
const TYPES_AS = 'server/src/answer-search/answer-search.types.ts'
const API_TS = 'src/services/api.ts'
const EDITOR = 'src/components/answer-editor.tsx'
const GUARD = 'server/src/shared/input-guard.ts'
const PROPOSAL = 'docs/design/method/proposals/P-015-相似例题思路借鉴与事先声明.md'
const DECISION = 'docs/design/method/decision-log.md'
const QA16 = 'docs/design/GK-QA-16-运维、发布与故障处置手册.md'

const VERSION_MODULES = [
  'server/scripts/verify/modules/27-question-match.mjs',
  'server/scripts/verify/modules/31-question-objects.mjs',
  'server/scripts/verify/modules/32-question-objects-store.mjs',
  'server/scripts/verify/modules/33-public-library-text-recall.mjs',
  'server/scripts/verify/modules/34-p2-topn-p3-deep-source.mjs',
  'server/scripts/verify/modules/35-recall-anchors.mjs',
  'server/scripts/verify/modules/36-upstream-input-guard.mjs',
]

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** 把零依赖 TS 单文件编译成 CommonJS；deps 映射相对 import（不跨端、不起服务） */
function loadTs(rel, deps = {}) {
  const js = ts.transpileModule(read(rel), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText
  const mod = { exports: {} }
  const req = (id) => (id in deps ? deps[id] : require(id))
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', js)(mod.exports, req, mod)
  return mod.exports
}

/**
 * 行为测试用「校验桩」隔离：对象入库校验本身由 M31 覆盖，
 * 这里专测参考层的筛选判据。A2 静态断言钉住 collectReferences 必调
 * validateStoredObject，A3 再用「桩改为全拒绝」反证它真的生效。
 */
let validate = () => ''
function loadRef() {
  const qm = loadTs(MATCH)
  const stub = { ...qm, validateStoredObject: (...args) => validate(...args) }
  return {
    qm,
    qr: loadTs(REF, { './question-match': stub }),
  }
}

const Q = '如图，在△ABC中，E、F分别是BC、AD的中点，∠EFC=60°，AC=5，求四边形ABCD的面积最大值'
const GOOD_STEM = '如图，在四边形ABCD中，E、F分别是BC、AD的中点，∠EFC=60°，AB=4，求三角形AEF的周长最小值'
const GOOD_SOL = '【分析】连接BD，由中点条件可得EF为梯形的中位线；再利用∠EFC=60°构造等边三角形，' +
  '把周长转化为两点之间线段最短问题。【详解】∵E、F分别是BC、AD的中点，∴EF∥AB且EF=(AB+CD)/2，' +
  '作点A关于EF的对称点A′，连接A′F，则当A′、F、D三点共线时周长取得最小值，代入AB=4可得结果。'

const mkRow = (i, over = {}) => ({
  source_id: 'src-A', source_name: '几何专题.pdf', object_index: i, label: String(i + 1),
  char_start: 0, char_end: 200, stem_start: 0, stem_end: 60,
  stem_text: GOOD_STEM, solution_text: GOOD_SOL, has_solution: true,
  source_revision: 'rev', link_status: 'ok', engine_version: 'qobj-1',
  object_fingerprint: 'x', ...over,
})

const OPTS = { hash: (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex'), expectedRevision: 'rev' }

m.test('🔴 A1 判定层真相源零改动（与 M35/M36 同一 sha256 基线）', (c) => {
  const src = read(MATCH).replace(/\r\n/g, '\n')
  c.eq(crypto.createHash('sha256').update(src, 'utf8').digest('hex'),
    '84f998ff9d2bb2f5e2d3cec70b7ea309deef8ee69bfb558a4b8180939258ed10',
    'question-match.ts 被改动 —— 参考例题层必须并列，不许顺手放宽六条硬闸')
  const ref = read(REF)
  c.ok(!/^import .*(?:database|supabase|netdisk|http|axios|crypto)/m.test(ref), '参考层引入了业务依赖（必须零业务依赖单文件）')
  c.ok(/import \{ extractDistinctive, validateStoredObject \} from '\.\/question-match'/.test(ref), '参考层没复用判定层纯函数')
  c.ok(/六条硬闸|判定层.*零改动|判定层.*一行未动/.test(ref), '参考层没写清与判定层的边界')
})

m.test('🔴 A2 判据静态钉死：同源配对 / 阈值 / 上限 / 截断 / 必调入库校验', (c) => {
  const s = read(REF)
  const { qr } = loadRef()
  c.eq(qr.MIN_SOLUTION_CHARS, 60, '解析长度阈值被改')
  c.eq(qr.MIN_SHARED_SIGNALS, 3, '共现信号阈值被放宽')
  c.eq(qr.MAX_REFERENCES, 3, '参考例题上限被改')
  c.eq(qr.STEM_LIMIT, 500, '题干截断长度被改')
  c.eq(qr.SOLUTION_LIMIT, 1200, '解析截断长度被改')
  c.ok(/if \(validateStoredObject\(row, validation\)\) continue/.test(s), '没调用入库校验（对象可信性会漂移）')
  c.ok(/if \(!row\.has_solution \|\| solution\.replace\(\/\\s\+\/g, ''\)\.length < MIN_SOLUTION_CHARS\) continue/.test(s), '没守「必须有解题过程」')
  c.ok(/signals\.length < MIN_SHARED_SIGNALS/.test(s), '没守共现信号')
  c.ok(/同源配对/.test(s), '没写同源配对约束')
  // 同源配对：stem 与 solution 必须取自同一个 row
  const body = s.slice(s.indexOf('export function collectReferences'), s.indexOf('export function mergeReferences'))
  c.eq((body.match(/row\.stem_text/g) || []).length, 1, 'stem 取了不止一次（可能跨对象拼接）')
  c.eq((body.match(/row\.solution_text/g) || []).length, 1, 'solution 取了不止一次（可能跨对象拼接）')
  c.ok(/const stem = String\(row\.stem_text/.test(body) && /const solution = String\(row\.solution_text/.test(body),
    'stem/solution 不是从同一个 row 就地取值')
  c.ok(/sourceId: row\.source_id/.test(body) && /objectIndex: row\.object_index/.test(body), '来源定位不是取自同一 row')
})

m.test('🔴 A3 行为：筛出带完整解析的相似题、排除噪声、上限与去重生效', (c) => {
  validate = () => ''
  const { qm, qr } = loadRef()
  const longAnchors = qm.extractDistinctive(Q).longAnchors
  const signals = qr.sharedSignals(Q, GOOD_STEM, longAnchors)
  c.ok(signals.length >= qr.MIN_SHARED_SIGNALS, `构造样本共现信号不足：${JSON.stringify(signals)}`)

  const picked = qr.collectReferences(Q, [mkRow(0)], OPTS)
  c.eq(picked.length, 1, '合格的带解析相似题没被挑出')
  c.eq(picked[0].stem, GOOD_STEM, '题干不是库内原题')
  c.eq(picked[0].solution, GOOD_SOL, '解析不是同一道原题自己的解析（同源配对被破坏）')
  c.eq(picked[0].sourceId, 'src-A', '来源 ID 丢失')
  c.eq(picked[0].objectIndex, 0, '题号定位丢失')

  // 短解析 / 无解析 / 不相关题干 / exact 已放行对象 ⇒ 一律排除
  c.eq(qr.collectReferences(Q, [mkRow(1, { solution_text: '答案：30' })], OPTS).length, 0, '只给答案没过程的题被当成可借鉴')
  c.eq(qr.collectReferences(Q, [mkRow(2, { has_solution: false })], OPTS).length, 0, '无解析的题被当成可借鉴')
  c.eq(qr.collectReferences(Q, [mkRow(3, { stem_text: '1+1等于几' })], OPTS).length, 0, '不相关题干被当成可借鉴')
  c.eq(qr.collectReferences(Q, [mkRow(4)], { ...OPTS, excludeObjectIndexes: [4] }).length, 0, 'exact 已放行对象没排除')

  // 入库校验真的生效（反证：桩改为全拒绝）
  validate = () => '对象不可信'
  c.eq(qr.collectReferences(Q, [mkRow(0)], OPTS).length, 0, '入库校验被绕过（会放进不可信对象）')
  validate = () => ''

  // 上限 3 + 跨来源去重
  const many = Array.from({ length: 8 }, (_, i) => mkRow(i))
  c.eq(qr.collectReferences(Q, many, OPTS).length, 3, '单来源没守 3 条上限')
  const merged = qr.mergeReferences([[mkRowToRef(0)], [mkRowToRef(0), mkRowToRef(1)]])
  c.eq(merged.length, 2, 'mergeReferences 没按 sourceId#objectIndex 去重')

  // 截断
  const long = qr.collectReferences(Q, [mkRow(9, {
    stem_text: GOOD_STEM + '补充'.repeat(400),
    solution_text: GOOD_SOL + '推导步骤'.repeat(400),
  })], OPTS)
  c.eq(long[0].stem.length, qr.STEM_LIMIT, '题干没截断')
  c.eq(long[0].solution.length, qr.SOLUTION_LIMIT, '解析没截断')
})

/** 供去重用例：直接走一次 collectReferences 拿到真实 ReferenceExample 形状 */
function mkRowToRef(i) {
  validate = () => ''
  const { qr } = loadRef()
  return qr.collectReferences(Q, [mkRow(i)], OPTS)[0]
}

m.test('🔴 A4 事先声明：两端逐字一致、三要素齐备、声明排在所有参考内容之前', (c) => {
  const back = read(REF)
  const front = read(REF_MIRROR)
  const grab = (s) => (s.match(/export const REFERENCE_DISCLAIMER = '([^']*)'/) || [])[1]
  const grabItem = (s) => (s.match(/export const REFERENCE_ITEM_HINT = '([^']*)'/) || [])[1]
  const d = grab(back)
  c.ok(!!d, '后端缺 REFERENCE_DISCLAIMER')
  c.eq(grab(front), d, '前后端声明文案不逐字一致（旧包会显示成没声明）')
  c.eq(grabItem(front), grabItem(back), '每条卡片的重复声明不一致')
  for (const w of ['不是本题答案', '仅供借鉴解题思路', '请先自己想一想']) {
    c.ok(d.includes(w), `声明缺要素「${w}」`)
  }
  const ed = read(EDITOR)
  const pDecl = ed.indexOf('事先声明')
  const pItem = ed.indexOf('例题 {i + 1}')
  const pAnswer = ed.indexOf('{candidate.answer ? (')
  c.ok(pDecl > 0 && pItem > pDecl, '声明没有排在参考例题之前')
  c.ok(pDecl > 0 && pAnswer > pDecl, '声明没有排在本题 answer 之前')
  c.ok(/candidate\?\.reference_disclaimer \|\| REFERENCE_DISCLAIMER/.test(ed), '前端没有镜像兜底（服务端缺字段会变成无声明内容）')
  c.ok(/注意：\{REFERENCE_ITEM_HINT\}/.test(ed), '每条例题卡片没有重复声明')
})

m.test('🔴 A5 结构不变量：参考例题永不进 answer / 不置 verified / 不提供采纳', (c) => {
  const as = read(SERVICE_AS)
  const nd = read(SERVICE_ND)
  const types = read(TYPES_AS)
  const api = read(API_TS)
  const ed = read(EDITOR)
  // 透传段只做展开，不带 answer / verified
  const seg = as.slice(as.indexOf('if (!settled && disk?.references?.length)'), as.indexOf('if (!inputGuard.ok && !settled)'))
  c.ok(seg.length > 0, '找不到参考例题透传段')
  c.ok(!/answer:/.test(seg), '透传段改了 answer（会冒充本题答案）')
  c.ok(!/verified:\s*true/.test(seg), '透传段把 verified 置 true')
  c.ok(/!settled/.test(seg), '没有 exact 答案时之外的分支也会塞参考例题')
  c.ok(/reference_disclaimer/.test(seg), '透传段没带声明')
  c.ok(/const CACHE_VERSION = 'v13'/.test(as), 'CACHE_VERSION 没 bump（旧缓存会吐无声明内容）')
  c.ok(/references\?: ReferenceExample\[\]/.test(types), '后端结果类型缺 references')
  c.ok(/reference_disclaimer\?: string/.test(types), '后端结果类型缺声明字段')
  c.ok(/references\?: ReferenceExample\[\]/.test(api), '前端契约缺 references')
  c.ok(/reference_disclaimer\?: string/.test(api), '前端契约缺声明字段')
  c.ok(/&& !hasRefs/.test(ed), '带参考例题时仍可能显示「采纳」按钮')
  // P-016 / D-019：source='none' 也必须渲染（如实告知常驻），见 M38 A4
  c.ok(/\{candidate \? \(/.test(ed), 'source=none 时结果卡片不渲染（如实告知会只剩转瞬即逝的 toast）')
  // 网盘直连也必须带声明
  c.ok(/referenceDisclaimer: REFERENCE_DISCLAIMER/.test(nd), '/api/netdisk/search 直连会返回无声明的内容')
  c.ok(/references\?: ReferenceExample\[\]/.test(nd), '网盘检索结果类型缺 references')
})

m.test('🔴 A6 接线：与判定共用校验口径、只在深挖已有 rows 时收集、不扩大召回面', (c) => {
  const nd = read(SERVICE_ND)
  const store = read(STORE)
  c.ok(/export function storeValidationOpts/.test(store), '缺共用校验口径（参考层与判定层会漂移）')
  const jw = store.slice(store.indexOf('export function judgeWithStore'), store.length)
  c.ok(/\.\.\.storeValidationOpts\(text\)/.test(jw), 'judgeWithStore 没改用共用口径')
  c.ok(/storeValidationOpts\(text\)/.test(nd), '参考层没用共用口径')
  c.ok(/if \(rows\.length > 0\) \{[\s\S]{0,400}collectReferences/.test(nd), 'collectReferences 不是放在已加载 rows 之后')
  c.ok(!/collectReferences\([\s\S]{0,120}searchLocal/.test(nd), '参考层额外发了检索请求')
  c.ok(/mergeReferences\(referencePools\)/.test(nd), '没做跨来源汇总去重')
  c.ok(/excludeObjectIndexes/.test(nd), '没排除 exact 已放行对象')
  c.ok(/MAX_DEEP_FILES = Number\(process\.env\.NETDISK_DEEP_FILES \?\? 8\)/.test(nd), '深挖上限被改')
  c.ok(/DEEP_BUDGET_MS = Number\(process\.env\.NETDISK_DEEP_BUDGET_MS \?\? 8_000\)/.test(nd), '主预算被改')
  c.ok(/TEXT_RECALL_KEYS = Number\(process\.env\.NETDISK_TEXT_RECALL_KEYS \?\? 4\)/.test(nd), '粗筛词数被改')
  c.ok(/ONLINE_EXTRACT_ENABLED = process\.env\.NETDISK_ONLINE_EXTRACT === '1'/.test(nd), '默认禁在线抽取被改')
  const g = read(GUARD)
  c.ok(/export const INPUT_GUARD_MAX_CHARS = 1200/.test(g), 'P-014 输入闸门被改动')
  c.ok(/export const INPUT_GUARD_MAX_ITEM_MARKS = 1/.test(g), 'P-014 输入闸门被改动')
})

m.test('🔴 A7 CACHE_VERSION v13 且 9 个旧模块断言同步、无 v11/v12 残留', (c) => {
  const as = read(SERVICE_AS)
  c.ok(/const CACHE_VERSION = 'v13'/.test(as), 'CACHE_VERSION 不是 v13')
  c.ok(as.includes('${CACHE_VERSION}:${question}'), '版本没参与 qHash')
  for (const f of VERSION_MODULES) {
    const t = read(f)
    c.ok(/CACHE_VERSION = 'v13'|CACHE_VERSION v13|CACHE_VERSION 不是 v13|没 bump 到 v13/.test(t),
      `${path.basename(f)} 的缓存版本断言没同步到 v13`)
    c.ok(!/CACHE_VERSION = 'v1[12]'/.test(t), `${path.basename(f)} 还留着上一版断言（P-017 已 bump v13）`)
  }
})

m.test('🔴 A8 文档：六栏 / 主流方案对比 / 拍板 / falsifier / 仍锁 / 不宣称', (c) => {
  const p = read(PROPOSAL)
  c.ok(/提案号：P-015/.test(p), 'P-015 缺编号')
  c.ok(/状态：已批准/.test(p), 'P-015 不是已批准（H1 合法枚举）')
  for (const mark of ['①', '②', '③', '④', '⑤', '⑥']) {
    c.ok(new RegExp(`^###\\s*${mark}`, 'm').test(p), `P-015 缺六栏之 ${mark}`)
  }
  for (const w of ['作业帮', '夸克', 'CN119990146A', '试题库规模必然是可穷尽的', '向量', 'Reranker']) {
    c.ok(p.includes(w), `主流方案对比缺「${w}」`)
  }
  c.ok(/事先声明/.test(p) && /同源配对/.test(p), '没写清事先声明或同源配对')
  c.ok(/falsifier/.test(p), 'P-015 缺 falsifier')
  c.ok(/不宣称/.test(p), 'P-015 没写「不宣称」边界')
  c.ok(/仍锁/.test(p), 'P-015 没写仍锁项')
  c.ok(/思傅 2026-11-07 23:50/.test(p), '没记录拍板依据')
  const d = read(DECISION)
  c.ok(/## D-018/.test(d), '台账缺 D-018')
  c.ok(/D-017/.test(d), '台账丢了 D-017 历史文本（追加式底线）')
  const q = read(QA16)
  c.ok(/6\.1\.10/.test(q), 'QA-16 缺 §6.1.10 部署记录')
})

m.test('🔴 A9 无禁用宣称词（只查用户可见文案，不误伤注释里的诚实表述）', (c) => {
  const lines = (s) => s.split(/\r?\n/)
  const userVisible = [
    ...lines(read(REF)).filter((l) => /^export const REFERENCE_(DISCLAIMER|ITEM_HINT) =/.test(l)),
    ...lines(read(REF_MIRROR)).filter((l) => /^export const REFERENCE_/.test(l)),
    ...[read(SERVICE_ND), read(SERVICE_AS)].flatMap((s) => lines(s).filter((l) => /^\s*note\b/.test(l))),
    ...lines(read(EDITOR)).filter((l) => /事先声明|思路相近的例题|例题 \{i \+ 1\}|展开完整题目/.test(l)),
  ].join('\n')
  c.ok(userVisible.length > 0, '抽不出任何用户可见文案，断言形同虚设')
  for (const w of ['都能搜到', '一搜即得', '精准定位到题', '已解决张冠李戴', '所有用户已可用', '误判归零', '提升命中', '修复有效']) {
    c.ok(!userVisible.includes(w), `用户可见文案出现禁用宣称词「${w}」`)
  }
})

export default m
