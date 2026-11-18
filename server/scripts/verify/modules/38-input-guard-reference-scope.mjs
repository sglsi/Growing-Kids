// 模块 38：输入闸门作用域与无结果呈现（P-016 / D-019）
//
// 为什么单独一个模块：M36 守「不合格输入不送判定」，M37 守「参考例题是并列第二层」，
// 但没有任何一模块守「闸门**只**拦判定层、不能把第二层一起关掉」，也没有模块守
// 「source='none' 时如实告知必须常驻」。2026-11-08 10:42 的生产报障正是这两个缺口：
// 服务 200、干净单题 refs=3，但整页输入 0.065s 返回 source:'none'，
// 前端不渲染卡片 + toast 被 hideLoading 抢关 ⇒ 用户看到「点了什么都没有」。
//
// 🔴 本模块守的核心契约：**判定层一行未动、不合格输入仍不送判定、answer 恒空、
//    声明先于内容、直连不绕过、如实告知常驻**。这是 D-018 已批准作用域的代码落地，
//    不是放宽任何硬闸。

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { Module } from '../lib/harness.mjs'

const m = new Module('M38', '输入闸门作用域与无结果呈现验收集（P-016 / D-019）')
const ROOT = path.resolve(process.cwd(), '..')

const MATCH = 'server/src/shared/question-match.ts'
const GUARD = 'server/src/shared/input-guard.ts'
const GUARD_MIRROR = 'src/constants/input-guard.ts'
const SERVICE_ND = 'server/src/netdisk/netdisk-search.service.ts'
const CONTROLLER_ND = 'server/src/netdisk/netdisk.controller.ts'
const SERVICE_AS = 'server/src/answer-search/answer-search.service.ts'
const EDITOR = 'src/components/answer-editor.tsx'
const PROPOSAL = 'docs/design/method/proposals/P-016-输入闸门作用域与无结果呈现.md'
const DECISION = 'docs/design/method/decision-log.md'

const VERSION_MODULES = [
  'server/scripts/verify/modules/27-question-match.mjs',
  'server/scripts/verify/modules/31-question-objects.mjs',
  'server/scripts/verify/modules/32-question-objects-store.mjs',
  'server/scripts/verify/modules/33-public-library-text-recall.mjs',
  'server/scripts/verify/modules/34-p2-topn-p3-deep-source.mjs',
  'server/scripts/verify/modules/35-recall-anchors.mjs',
  'server/scripts/verify/modules/36-upstream-input-guard.mjs',
  'server/scripts/verify/modules/37-reference-examples.mjs',
]

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const lines = (s) => s.replace(/\r\n/g, '\n').split('\n')

m.test('🔴 A1 判定层真相源一行未动（与 M35/M36/M37 同基线）', (c) => {
  const src = read(MATCH).replace(/\r\n/g, '\n')
  c.eq(crypto.createHash('sha256').update(src, 'utf8').digest('hex'),
    '84f998ff9d2bb2f5e2d3cec70b7ea309deef8ee69bfb558a4b8180939258ed10',
    'question-match.ts 被改动 —— 走提案单，不要顺手改判定层')
  c.ok(!/referenceMode|examplesOnly|guardQuestionInput/.test(src), '闸门/参考层逻辑被塞进判定层真相源')
})

m.test('🔴 A2 只读 examples 模式存在，且默认仍是 judge', (c) => {
  const nd = read(SERVICE_ND)
  c.ok(/referenceMode\?: 'judge' \| 'examples'/.test(nd), 'search() 缺 referenceMode 选项')
  c.ok(/const examplesOnly = opts\.referenceMode === 'examples'/.test(nd), '缺 examples 模式标志')
  c.ok(/if \(!guard\.ok && !examplesOnly\)/.test(nd), '闸门短路没有限定为默认模式')
  c.ok(/hits: \[\], keys: \[\], exactCount: 0, tookMs: Date\.now\(\) - started,/.test(nd) ||
    /hits: \[\], keys: \[\], exactCount: 0,/.test(nd), 'examples 模式没清空命中')
  c.ok(/这段输入未做原题判定/.test(nd), 'examples 模式没有如实说明未做判定')
})

m.test('🔴 A3 /api/netdisk/search 直连仍按 P-014 短路（双入口不绕过）', (c) => {
  const ctl = read(CONTROLLER_ND)
  const nd = read(SERVICE_ND)
  c.ok(/this\.svc\.search\(question, \{ deep: deep !== '0' \}\)/.test(ctl) ||
    /search\(question, \{[^}]*deep/.test(ctl), '直连 controller 调用形式变了')
  c.ok(!/referenceMode/.test(ctl), '直连 controller 传了 referenceMode（会绕过闸门）')
  c.ok(/if \(!guard\.ok && !examplesOnly\)/.test(nd), '默认模式不再短路')
  c.ok(/return \{[\s\S]{0,220}note: guard\.message/.test(nd), '不合格输入默认模式不再如实告知')
})

m.test('🔴 A4 examples 模式绝不调用判定层，answer-search 结构上不给 exact', (c) => {
  const nd = read(SERVICE_ND)
  const as = read(SERVICE_AS)
  c.ok(/const j = examplesOnly\s*\?\s*\(\{[\s\S]{0,260}exact: false/.test(nd),
    'examples 模式仍可能调用 judgeWithStore / 产出 exact')
  c.ok(/: judgeWithStore\(question, text, rows,/.test(nd), '默认模式没有照常走判定层')
  c.ok(/inputGuard\.ok \? \{\} : \{ referenceMode: 'examples' \}/.test(as),
    'answer-search 没在闸门不合格时改用 examples 模式')
  c.ok(/const exact = inputGuard\.ok\s*\?\s*disk\?\.hits\.find/.test(as),
    '不合格输入仍可能从 disk.hits 取 exact')
  c.ok(/if \(!settled\) \{[\s\S]{0,260}referenceMode: 'examples'/.test(as),
    '合格输入的检索路径被改坏了')
  c.ok(/rejectReason: 'P-016 仅参考例题模式：未送原题判定'/.test(nd), '空判定对象没有可排查标记')
})

m.test('🔴 A5 不合格输入的告知是合并式：references 留下、answer/verified 清空', (c) => {
  const as = read(SERVICE_AS)
  c.ok(as.includes('if (!inputGuard.ok && !settled)'), '如实告知分支被删（M37 透传段断言也依赖它）')
  const tail = as.slice(as.indexOf('if (!inputGuard.ok && !settled)'))
  const block = tail.slice(0, tail.indexOf('\n      }'))
  c.ok(/\.\.\.result/.test(block), '告知分支整体覆盖清空（会把 references 一起抹掉）')
  c.ok(/const hasExamples = \(result\.references\?\.length \?\? 0\) > 0/.test(block), '没判断是否有参考例题')
  c.ok(/answer: '', solution: '', refs: \[\], confidence: 0/.test(block), 'answer/refs 没强制清空')
  c.ok(/verified: false/.test(block), 'verified 没强制置 false')
  c.ok(/inputGuard\.message/.test(block), '没保留 P-014 的「请单独录入小题」提示')
  c.ok(!/source: 'none', verified: false, match_level: 'none',/.test(block),
    '又变回整体覆盖（references 会被丢）')
})

m.test('🔴 A6 前端 source=none 常驻渲染 + toast 与 hideLoading 时序', (c) => {
  const ed = read(EDITOR)
  c.ok(/\{candidate \? \(/.test(ed), 'source=none 时结果卡片不渲染（如实告知会消失）')
  c.ok(/candidate\.source === 'none'\s*\?\s*'这次没有可用结果'/.test(ed), '缺「这次没有可用结果」标题')
  c.ok(/candidate\.note \? \(/.test(ed), 'note 没有常驻渲染')
  c.ok(/let pendingToast = ''/.test(ed), 'toast 没有收进延迟变量')
  c.ok(ed.indexOf('hideLoadingSafe()') > 0 && ed.indexOf('hideLoadingSafe()') < ed.indexOf('if (pendingToast) Taro.showToast'),
    'showToast 仍在 hideLoading 之前（微信下会被抢关）')
  c.ok(/\.\.\.result|&& !hasRefs/.test(ed) && /match_level !== 'topic'/.test(ed),
    'canAdopt 闸门被动过，参考例题可能被采纳成本题答案')
})

m.test('🔴 A7 CACHE_VERSION v14、9 个旧模块断言同步、无 v11/v12 残留', (c) => {
  const as = read(SERVICE_AS)
  c.ok(/const CACHE_VERSION = 'v14'/.test(as), 'CACHE_VERSION 不是 v14（旧缓存会继续吐「什么都没有」）')
  c.ok(as.includes('${CACHE_VERSION}:${question}'), '版本没参与 qHash，bump 无效')
  for (const f of VERSION_MODULES) {
    const t = read(f)
    c.ok(/CACHE_VERSION = 'v14'|CACHE_VERSION v14|CACHE_VERSION 不是 v14|没 bump 到 v14/.test(t),
      `${path.basename(f)} 的缓存版本断言没同步到 v14`)
    c.ok(!/CACHE_VERSION = 'v1[23]'/.test(t), `${path.basename(f)} 还留着上一版断言（P-017 已 bump v14）`)
  }
})

m.test('🔴 A8 声明先于内容、同源配对未动、输入闸门镜像逐字一致', (c) => {
  const ed = read(EDITOR)
  const nd = read(SERVICE_ND)
  c.ok(ed.indexOf('事先声明') < ed.indexOf('candidate?.references?.map'),
    '事先声明没排在参考例题之前')
  c.ok(/注意：\{REFERENCE_ITEM_HINT\}/.test(ed), '每条例题没有重复声明')
  c.ok(/collectReferences\(question, rows,/.test(nd), '同源配对的取数入口被改')
  c.ok(/storeValidationOpts\(text\)/.test(nd), '参考层没用与判定层同源的对象校验')
  // 闸门判据 / 文案一个字都不许动（D-017 的假 exact 归零仍要成立）
  const keyLines = (s) => lines(s).filter((l) =>
    /^(export const INPUT_GUARD_|const ITEM_START =|const ASK_HINT =|const OPTION_HINT =)/.test(l))
  c.eq(keyLines(read(GUARD)).join('\n'), keyLines(read(GUARD_MIRROR)).join('\n'),
    '前端输入闸门镜像漂移')
  c.ok(/export const INPUT_GUARD_MAX_CHARS = 1200/.test(read(GUARD)), '闸门长度阈值被改')
  c.ok(/export const INPUT_GUARD_MAX_ITEM_MARKS = 1/.test(read(GUARD)), '题号阈值被改')
})

m.test('🔴 A9 不新增检索调用、examples 预算更保守、硬兜底不变', (c) => {
  const nd = read(SERVICE_ND)
  c.ok(/Math\.min\(MAX_DEEP_FILES, 4\)/.test(nd), 'examples 深挖上限没收紧')
  c.ok(/Math\.min\(DEEP_BUDGET_MS, 4_000\)/.test(nd), 'examples 主预算没收紧')
  c.ok(/DEEP_HARD_BUDGET_MS = 18_000/.test(nd), '18s 硬兜底被改')
  c.ok(/MAX_DEEP_FILES = Number\(process\.env\.NETDISK_DEEP_FILES \?\? 8\)/.test(nd), '合格输入深挖上限被改')
  c.ok(/DEEP_BUDGET_MS = Number\(process\.env\.NETDISK_DEEP_BUDGET_MS \?\? 8_000\)/.test(nd), '合格输入主预算被改')
  c.ok((nd.match(/this\.searchLocal\(/g) || []).length === 1, '出现多次本地检索（逐题检索被禁）')
  c.ok(!/for \(const stem of|splitRealWorldStems\(|autoSplitQuestions\(/.test(nd),
    '出现自动切题 / 逐题检索的调用（注释里写「不逐题检索」不算）')
})

m.test('🔴 A10 文档六栏 / falsifier / 不宣称词', (c) => {
  const p = read(PROPOSAL)
  const d = read(DECISION)
  c.ok(/提案号：P-016/.test(p), 'P-016 缺编号')
  c.ok(/状态：(已批准|已实施)/.test(p), 'P-016 不是「已批准 / 已实施」（H1 合法枚举）')
  c.ok(/关联决策：D-019/.test(p), 'P-016 缺关联决策')
  for (const mark of ['①', '②', '③', '④', '⑤', '⑥']) {
    c.ok(new RegExp(`^###\\s*${mark}`, 'm').test(p), `P-016 缺六栏之 ${mark}`)
  }
  c.ok(/falsifier/.test(p) && /不自动切题/.test(p), 'P-016 缺 falsifier 或边界')
  c.ok(/D-019 输入闸门作用域与无结果呈现/.test(d), '台账缺 D-019')
  const visible = [
    ...lines(read(SERVICE_ND)).filter((l) => /^\s*note\b/.test(l)),
    ...lines(read(SERVICE_AS)).filter((l) => /^\s*note\b/.test(l)),
    ...lines(read(EDITOR)).filter((l) => /这次没有可用结果|思路相近的例题|事先声明|例题 \{i \+ 1\}/.test(l)),
  ].join('\n')
  c.ok(visible.length > 0, '抽不出任何用户可见文案，断言形同虚设')
  for (const w of ['都能搜到', '一搜即得', '精准定位到题', '所有用户已可用', '误判归零', '提升命中', '修复有效']) {
    c.ok(!visible.includes(w), `用户可见文案出现禁用宣称词「${w}」`)
  }
})

export default m
