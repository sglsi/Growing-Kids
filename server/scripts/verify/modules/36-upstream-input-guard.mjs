// 模块 36：检索前输入合格性闸门禁收（P-014 / D-017）
//
// 为什么单独一个模块：M27/M31 守判定硬闸、M32 守结构化对象、M33 守公共归属、
// M34 守 P2/P3 排序与深挖、M35 守召回选词；**没有任何一模块守「哪段文本有资格
// 被送去检索」**。11-07 晚 8 条真实题实测：规则切题后唯一上升的 exact 是
// 「作文要求」片段（20 字、无设问）走 askQuestion=unknown 路径命中英语教辅第 80
// 对象、带 972 字解析 ⇒ 假 exact。P-014 拍板方向 A：不合格输入不送判定、如实告知。
//
// 🔴 本模块守的核心契约：**闸门只挡输入，判定层行为逐字不变**。
//    验收目标不是 exact 上升，而是「假 exact 归零 + 其余不变」（D-017 §⑥）。

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { createRequire } from 'module'
import { Module } from '../lib/harness.mjs'

const m = new Module('M36', '上游输入合格性闸门与假 exact 归零验收集（P-014 / D-017）')
const ROOT = path.resolve(process.cwd(), '..')
const require = createRequire(import.meta.url)
const ts = require('typescript')

const GUARD = 'server/src/shared/input-guard.ts'
const GUARD_MIRROR = 'src/constants/input-guard.ts'
const SERVICE_ND = 'server/src/netdisk/netdisk-search.service.ts'
const SERVICE_AS = 'server/src/answer-search/answer-search.service.ts'
const MATCH = 'server/src/shared/question-match.ts'
const PROPOSAL = 'docs/design/method/proposals/P-014-上游题干质量与命中准入.md'
const DECISION = 'docs/design/method/decision-log.md'
const QA16 = 'docs/design/GK-QA-16-运维、发布与故障处置手册.md'
const RECOGNIZE = 'src/pages/recognize/index.tsx'
const DIAGNOSE = 'server/scripts/kb-upstream-diagnose.mjs'

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** 把零依赖 TS 单文件编译成 CommonJS 后加载，验收集不需要起服务 */
function loadGuard(rel) {
  const js = ts.transpileModule(read(rel), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', js)(mod.exports, require, mod)
  return mod.exports
}

// 2026-11-07 真实登录态 timeline 的 8 条录入题代表样本（只留结构特征，不存整页全文）
const S_MULTI = '问题探究：\n1）如图1，ABCD，∠ABC=60°，AB=3，BC=5，M、N分别为AD、DC上的点，DM+DN=4，则四边形BMDN的面积最大值是多少？\n2）如图2，∠ACB90°，且AC+BC=4、连接AB，则△ABC的周长是否存在最小值？若存在，求出最小值；若不存在，说明理由。\n问题解决\n3）如图3，在四边形ABCD中，AD∥BC，对角线AC交BD于O，已知∠AOB=120°'
const S_ESSAY = '要求：1.应包含思维导图中的所有信息，可扩展；\n2.词数不少于70;\n3.文中不得提及真实的人名，校名等相关值息。'
const S_ESSAY_FRAGMENT = '文中不得提及真实的人名，校名等相关值息。'
const S_CLEAN = '16、如图，在△ABC中AC>AB,D点在AC上，AB=CD,E，F分别是BC，AD的中点，连接EF并延长，与BA的延长线交于点G，连结GD，若∠EFC=60°，DG=√3，AC=5，则△ABC的面积为多少'
const S_EN_CHOICE = 'With the development of modern technology, scientists got a photo of a black hole. A. result B. support C. advice D. description'
const S_WHOLE_PAGE = '九年级上册英语阶段测试卷\n时间：100 分钟 满分：100 分\n一、单项选择。（20 分）\n( )1. With the of modern technology, scientists got a photo of a black hole.\nA. result B. support C. advice D. description\n' + '（后续题目略）\n'.repeat(400)

const VERSION_MODULES = [
  'server/scripts/verify/modules/27-question-match.mjs',
  'server/scripts/verify/modules/31-question-objects.mjs',
  'server/scripts/verify/modules/32-question-objects-store.mjs',
  'server/scripts/verify/modules/33-public-library-text-recall.mjs',
  'server/scripts/verify/modules/34-p2-topn-p3-deep-source.mjs',
  'server/scripts/verify/modules/35-recall-anchors.mjs',
]

m.test('🔴 A1 8 条真实题的结构画像可复现（整页 / 多小问 / 非题目 / 干净单题）', (c) => {
  const g = loadGuard(GUARD)
  c.eq(g.INPUT_GUARD_MAX_CHARS, 1200, '整页阈值被改')
  c.eq(g.INPUT_GUARD_MIN_CHARS, 25, '最短题干阈值被改（假 exact 靠这条挡）')
  c.eq(g.INPUT_GUARD_MAX_ITEM_MARKS, 1, '多小问题号阈值被改')

  const whole = g.profileInput(S_WHOLE_PAGE)
  c.ok(whole.len > 1200, `整页样本长度不足：${whole.len}`)
  c.eq(g.guardQuestionInput(S_WHOLE_PAGE).reason, 'too_long', '整页没被拦')

  const multi = g.profileInput(S_MULTI)
  c.ok(multi.itemMarks >= 2, `多小问样本题号数不足：${multi.itemMarks}`)
  c.eq(g.guardQuestionInput(S_MULTI).reason, 'multi_item', '多小问连排没被拦')

  c.eq(g.guardQuestionInput(S_ESSAY).ok, false, '作文要求整条没被拦')
  c.eq(g.guardQuestionInput(S_CLEAN).ok, true, '干净几何单题被误拦')
  c.eq(g.guardQuestionInput(S_EN_CHOICE).ok, true, '英文选择题被误拦（选项信号缺失）')
})

m.test('🔴 A2 假 exact 归零：作文要求片段不得成为合格题干 / 合格单题', (c) => {
  const g = loadGuard(GUARD)
  const r = g.guardQuestionInput(S_ESSAY_FRAGMENT)
  c.eq(r.ok, false, '作文要求片段被放行 ⇒ 会撞出 11-07 实测的假 exact')
  c.eq(r.reason, 'not_a_question', `拒绝原因不是 not_a_question：${r.reason}`)
  c.ok(r.message.length > 0, '不合格时没有如实提示（20a M11）')
  c.eq(r.profile.len, S_ESSAY_FRAGMENT.length, '结构画像长度不一致')
  c.eq(g.isEligibleStem(S_ESSAY_FRAGMENT), false, '切题候选护栏放行了短碎片')
  c.eq(g.isEligibleStem(S_CLEAN), true, '切题候选护栏误挡了干净单题')
  c.eq(g.guardQuestionInput(S_CLEAN).message, '', '合格题干不应带提示')
})

m.test('🔴 A3 后端两条链路都接了闸门，且不改原文 / 不自动切题 / 不逐题检索', (c) => {
  const nd = read(SERVICE_ND)
  const as = read(SERVICE_AS)
  c.ok(/import \{ guardQuestionInput \} from '\.\.\/shared\/input-guard'/.test(nd), '网盘检索服务没引入闸门')
  c.ok(/import \{ guardQuestionInput \} from '\.\.\/shared\/input-guard'/.test(as), '答案服务没引入闸门')
  c.ok(/const guard = guardQuestionInput\(question\)/.test(nd), '网盘检索入口没调闸门')
  c.ok(/if \(!guard\.ok\) \{/.test(nd), '网盘检索不合格时没有提前返回')
  c.ok(/note: guard\.message/.test(nd), '网盘检索没有把提示写进 note')
  c.ok(/const inputGuard = guardQuestionInput\(question\)/.test(as), '答案服务没调闸门')
  c.ok(/if \(!settled && inputGuard\.ok\)/.test(as), '不合格输入仍会去查公共资料库')
  c.ok(/if \(!inputGuard\.ok && !settled\)/.test(as), '不合格输入没被如实告知')
  c.ok(/note: inputGuard\.message/.test(as), '答案服务提示没写进 note')
  c.ok(!/splitRealWorldStems|OCR_.*DICT|纠错字典/.test(nd + as), '顺手做了自动切题 / OCR 纠错字典（拍板明确不做）')
  c.ok(!/for \(const stem of|stems\.map\(/.test(nd), '出现逐候选多次检索（与 P95<3s 冲突）')
})

m.test('🔴 A4 判定层真相源零改动（与 M35 同一 sha256 基线）', (c) => {
  const src = read(MATCH).replace(/\r\n/g, '\n')
  c.eq(crypto.createHash('sha256').update(src, 'utf8').digest('hex'),
    '84f998ff9d2bb2f5e2d3cec70b7ea309deef8ee69bfb558a4b8180939258ed10',
    'question-match.ts 被改动 —— 走提案单，不要顺手改判定层')
  c.ok(!/guardQuestionInput|INPUT_GUARD_/.test(src), '闸门逻辑被塞进判定层真相源（必须保持零依赖单文件）')
})

m.test('🔴 A5 note 文案变了 ⇒ CACHE_VERSION v11 且 6 个旧模块断言同步', (c) => {
  const as = read(SERVICE_AS)
  c.ok(/const CACHE_VERSION = 'v11'/.test(as), 'CACHE_VERSION 没 bump 到 v11（老缓存会吐旧 note）')
  c.ok(as.includes('${CACHE_VERSION}:${question}'), '版本没参与 qHash，bump 无效')
  for (const f of VERSION_MODULES) {
    const t = read(f)
    c.ok(/CACHE_VERSION = 'v11'|CACHE_VERSION v11|CACHE_VERSION 不是 v11|没 bump 到 v11/.test(t),
      `${path.basename(f)} 的缓存版本断言没同步到 v11`)
    c.ok(!/CACHE_VERSION = 'v9'/.test(t), `${path.basename(f)} 还留着 v9 断言`)
  }
})

m.test('🔴 A6 前端镜像与后端真相源逐字一致，且录入侧真的挂了提示', (c) => {
  const keyLines = (s) => s.split(/\r?\n/).filter((l) =>
    /^(export const INPUT_GUARD_|const ITEM_START =|const ASK_HINT =|const OPTION_HINT =)/.test(l))
  const back = keyLines(read(GUARD))
  const front = keyLines(read(GUARD_MIRROR))
  c.ok(back.length >= 8, `后端关键行不足：${back.length}`)
  c.eq(JSON.stringify(front), JSON.stringify(back), '前端镜像常量/正则与后端不一致（跨端不 import，靠断言守）')
  const fg = loadGuard(GUARD_MIRROR)
  c.eq(fg.guardQuestionInput(S_ESSAY_FRAGMENT).ok, false, '前端镜像放行作文要求片段')
  c.eq(fg.guardQuestionInput(S_CLEAN).ok, true, '前端镜像误挡干净单题')
  const rz = read(RECOGNIZE)
  c.ok(/import \{ guardQuestionInput \} from '@\/constants\/input-guard'/.test(rz), 'recognize 页没引入镜像')
  c.ok(/guardQuestionInput\(e\.text\)/.test(rz), '录入卡片没按题干显示引导')
})

m.test('🔴 A7 文档：拍板 / 六栏 / 仍锁 / 不宣称 / 可重跑诊断', (c) => {
  const p = read(PROPOSAL)
  c.ok(/提案号：P-014/.test(p), 'P-014 缺编号')
  c.ok(/状态：已批准/.test(p), 'P-014 不是已批准（H1 合法枚举）')
  for (const mark of ['①', '②', '③', '④', '⑤', '⑥']) {
    c.ok(new RegExp(`^###\\s*${mark}`, 'm').test(p), `P-014 缺六栏之 ${mark}`)
  }
  c.ok(/假 exact 归零/.test(p), 'P-014 没写验收口径（拍板 Q4）')
  c.ok(/不宣称提命中|不得.*提升命中/.test(p), 'P-014 没写「不宣称提命中」')
  const d = read(DECISION)
  c.ok(/## D-017/.test(d), '台账缺 D-017')
  c.ok(/D-016/.test(d), '台账丢了 D-016 历史文本（追加式底线）')
  c.ok(/拍板/.test(d), '台账没记拍板')
  c.ok(fs.existsSync(path.join(ROOT, DIAGNOSE)), '只读诊断脚本丢了（证据链不可重跑）')
  const q = read(QA16)
  c.ok(/6\.1\.9/.test(q), 'QA-16 缺 §6.1.9 部署记录')
})

m.test('🔴 A8 既有边界未被顺手放宽，且无禁用宣称词', (c) => {
  const nd = read(SERVICE_ND)
  c.ok(/MAX_DEEP_FILES = Number\(process\.env\.NETDISK_DEEP_FILES \?\? 8\)/.test(nd), '深挖上限不是 8')
  c.ok(/DEEP_BUDGET_MS = Number\(process\.env\.NETDISK_DEEP_BUDGET_MS \?\? 8_000\)/.test(nd), '主预算不是 8s')
  c.ok(/DEEP_HARD_BUDGET_MS = 18_000/.test(nd), '18s 硬兜底被改')
  c.ok(/ONLINE_EXTRACT_ENABLED = process\.env\.NETDISK_ONLINE_EXTRACT === '1'/.test(nd), '默认禁在线抽取被改')
  c.ok(/TEXT_RECALL_KEYS = Number\(process\.env\.NETDISK_TEXT_RECALL_KEYS \?\? 4\)/.test(nd), '粗筛词数不是 4')
  // 只查**用户可见文案**（提示常量 + note 字面量 + 前端引导行），
  // 服务端注释里「不宣称提升命中」是诚实表述，不该被当成宣称词误杀。
  const lines = (s) => s.split(/\r?\n/)
  const userVisible = [
    ...[read(GUARD), read(GUARD_MIRROR)].flatMap((s) => lines(s).filter((l) =>
      /^export const INPUT_GUARD_(MESSAGE|NOT_QUESTION_MESSAGE) =/.test(l))),
    ...[read(SERVICE_ND), read(SERVICE_AS)].flatMap((s) => lines(s).filter((l) => /^\s*note:/.test(l))),
    ...lines(read(RECOGNIZE)).filter((l) => /提示：|引导/.test(l)),
  ].join('\n')
  c.ok(userVisible.length > 0, '抽不出任何用户可见文案，断言形同虚设')
  for (const w of ['都能搜到', '一搜即得', '精准定位到题', '已解决张冠李戴', '所有用户已可用', '误判归零', '提升命中', '修复有效']) {
    c.ok(!userVisible.includes(w), `用户可见文案出现禁用宣称词「${w}」`)
  }
})

export default m
