// 模块 31：长文档原题判定验收集（P-009 / D-012 · P0 判定层）
//
// 为什么单独一个模块：P-006 的 M27 用**单题片段**守住了「同专题不同题不得冒充答案」，
// 但生产正文里一份 docx 常是整本教辅（L3 实测 3.5 万字 / 76 道题 / 303 个【答案】标记）。
// 2026-11-06 只读实测：1 道真实几何题在这些正文上跑现网 judge() 判出 3 个 exact，
// 逐条核对 3 个全是别的题的解析（0/3）——M27 的单题断言**完全测不到**这个失效模式。
//
// 所以本模块用 L3 netdisk_files.text_content 的**只读取样**（4 份整本教辅，保留原始
// 题号 /【答案】【解析】/ OCR 噪音）真跑判定，钉死三件事：
//   ① 误判归零（负例），② 正例召回不低于下限，③ 来源定位 100% 正确。
// 外加：六条准入硬闸逐条可触发、多对象并列降级、软信号不得越权当硬闸、
//       以及「残余风险已登记 + P1/P2/P3 未批准」的文档级防篡改断言。
//
// ⚠️ 守的是**行为契约**，不是「文档里写了」。fixture 来自只读生产语料，
//    改判定阈值 / 切分规则 / 放宽闸门都会在这里当场红；改之前先改 P-009 / D-012。
// ⚠️ 本模块不涉及接口调用，不需要后端起服务；question-match.ts 保持零依赖单文件。

import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { Module } from '../lib/harness.mjs'

const m = new Module('M31', '长文档原题判定验收集（P-009 / D-012）')

const ROOT = path.resolve(process.cwd(), '..')
const TMP = path.join(ROOT, '.tmp', 'verify-question-objects')
const FIXTURE = 'server/scripts/verify/fixtures/question-object-cases.json'
const MATCH = 'server/src/shared/question-match.ts'
const REPORT = 'docs/reports/资料库正文召回-检索侧四步方案评审.md'
const PROPOSAL = 'docs/design/method/proposals/P-009-长文档原题判定口径与题目级切分.md'
const DECISION = 'docs/design/method/decision-log.md'

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const fixture = JSON.parse(read(FIXTURE))

let Q = null

/** 与 M27 / M15 / M26 同一套做法：零依赖纯函数 tsc 单编后 require */
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
}

/** 手工构造题目对象：逐条隔离验证硬闸，避免被其它否决项抢先触发 */
const makeObject = (stem, solution = SOLUTION, hasSolution = true) => ({
  stem,
  solution,
  hasSolution,
  source: {
    objectIndex: 0,
    label: '1．',
    charStart: 0,
    charEnd: stem.length + solution.length,
    stemStart: 0,
    stemEnd: stem.length,
  },
})

const STEM = '已知抛物线 y=x²+2x-3 与 x 轴交于 A、B 两点，与 y 轴交于点 C，顶点为 D，求 △BCD 的面积。'
const STEM_SHAPE = STEM.replace('求 △BCD 的面积。', '判断 △BCD 的形状并说明理由。')
const SOLUTION = '【答案】S=4\n【解析】由 y=x²+2x-3 得 A(-3,0)、B(1,0)、C(0,-3)，顶点 D(-1,-4)，故 △BCD 的面积为 4。'
const OTHER_SOLUTION = '【解析】由勾股定理得 AB=5，故选 C。'

const sourceOf = (doc) => ({ sourceId: doc.id, sourceName: doc.name })
const judgeOne = (q, o) => Q.judgeQuestionObject(q, o, Q.extractDistinctive(q).longAnchors, 1)

// ============================================================
// 一、编译与验收集来源
// ============================================================

m.test('单编：shared/question-match.ts 零依赖，且 P-009 新增导出齐备', async (c) => {
  try {
    compileCore()
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`
    throw new Error(`question-match.ts 单编失败（零依赖契约被破坏）：${out.slice(0, 300)}`)
  }
  const p = path.join(TMP, 'question-match.js')
  c.ok(fs.existsSync(p), '编译产物不存在')
  Q = await import(`file://${p.replace(/\\/g, '/')}`)
  for (const fn of [
    'splitQuestionObjects', 'extractAsk', 'compareAsk', 'solutionLink',
    'judgeQuestionObject', 'judgeObjects', 'judge',
  ]) {
    c.ok(typeof Q[fn] === 'function', `缺少 P-009 导出 ${fn}`)
  }
  for (const k of ['MATCH_MAX_OBJECT_CHARS', 'MATCH_MIN_SOLUTION_CHARS', 'MATCH_STRICT_ANCHOR_RATIO']) {
    c.ok(typeof Q[k] === 'number', `缺少判定常量 ${k}`)
  }
})

m.test('🔴 验收集是真实生产语料只读取样，不是合成占位文本', (c) => {
  c.ok(fixture.meta && /L3/.test(fixture.meta.origin), 'fixture 丢失 L3 只读取样来源标记')
  c.ok(/误判归零/.test(fixture.meta.purpose), 'fixture 未声明验收集用途')
  c.ok(fixture.meta.geometryQuestion && fixture.meta.geometryQuestion.length > 40, '缺真实几何题干')
  c.eq(fixture.documents.length, 4, 'L3 只读取样文档数应为 4 份')
  for (const d of fixture.documents) {
    c.ok(d.text.length >= 2000, `${d.id} 正文过短：${d.text.length}，不像整本教辅`)
    c.ok(/【(?:答案|解析|详解|解答|分析|解)】|\d{1,3}\s*[．.、]|【\s*例\s*\d+/.test(d.text),
      `${d.id} 缺少真实题号 / 解析标记 —— 换成语料会让验收集失去证明力`)
  }
  // 至少三份带【答案】/【解析】：讲义体只有【例 N】，不应被要求一定有解析段
  const withSolution = fixture.documents.filter((d) => /【(?:答案|解析|详解|解答|分析|解)】/.test(d.text))
  c.ok(withSolution.length >= 3, '带解析段的文档不足 3 份，正例样本量不够')
})

// ============================================================
// 二、一题一对象 + 来源位置
// ============================================================

m.test('🔴 整本教辅必须被切成多个题目对象（不是整份当一个判定单元）', (c) => {
  const counts = {}
  for (const d of fixture.documents) {
    const objs = Q.splitQuestionObjects(d.text, sourceOf(d))
    counts[d.id] = objs.length
    c.ok(objs.length >= 8, `${d.id} 只切出 ${objs.length} 个对象 —— 切分失效会让全文锚点重新拼凑`)
  }
  c.ok(Object.values(counts).some((n) => n >= 10), '没有一份切到 ≥10 个对象，长文档覆盖不足')
})

m.test('🔴 每个对象带合法且连续的来源位置（可追溯性的结构性前提）', (c) => {
  for (const d of fixture.documents) {
    const objs = Q.splitQuestionObjects(d.text, sourceOf(d))
    objs.forEach((o, i) => {
      const s = o.source
      c.eq(s.objectIndex, i, `${d.id} 第 ${i} 个对象 index 不连续`)
      c.eq(s.sourceId, d.id, `${d.id} sourceId 未透传`)
      c.eq(s.sourceName, d.name, `${d.id} sourceName 未透传（家长无法按文件名复核）`)
      c.ok(s.charStart >= 0 && s.charEnd <= d.text.length && s.charEnd > s.charStart,
        `${d.id} 第 ${i} 个对象字符区间越界`)
      c.ok(s.stemStart >= s.charStart && s.stemEnd <= s.charEnd && s.stemEnd >= s.stemStart,
        `${d.id} 第 ${i} 个对象题干区间不合法`)
      c.eq(d.text.slice(s.stemStart, s.stemEnd), o.stem, `${d.id} 第 ${i} 个对象题干区间与内容不一致`)
    })
  }
})

m.test('无题号的单题片段退化为 1 个对象（P-006 老行为不回退）', (c) => {
  const objs = Q.splitQuestionObjects(`${STEM}\n${SOLUTION}`, { sourceId: 'own' })
  c.eq(objs.length, 1)
  c.eq(objs[0].source.label, '')
  c.eq(objs[0].hasSolution, true)
  c.eq(Q.judge(STEM, `${STEM}\n${SOLUTION}`).exact, true, 'judge() 委托后单题 exact 行为回退了')
})

// ============================================================
// 三、误判归零（负例）
// ============================================================

m.test('🔴 1 道真实几何题 vs 4 份整本教辅：假 exact 必须为 0', (c) => {
  const q = fixture.meta.geometryQuestion
  for (const d of fixture.documents) {
    const r = Q.judgeObjects(q, d.text, sourceOf(d))
    c.eq(r.exact, false, `${d.id} 把别的题解析判成了本题 exact —— P-006 事故本体复发`)
    c.eq(r.solution, undefined, `${d.id} 不达标却给出了 solution（会流进 answer 字段）`)
    c.eq(r.sourceLocation, undefined, `${d.id} 不达标却带了 source_location（等于给无出处答案背书）`)
    c.ok(r.rejectReason && r.rejectReason.length > 0, `${d.id} 降级没有留痕，无法排障`)
    c.eq(r.passed, false, `${d.id} passed 与 exact 不一致`)
    c.eq(r.confidence, 0, `${d.id} 未放行却有非零置信度`)
  }
})

m.test('🔴 多因子不是摆设：只改设问、其余逐字不变，exact 必须从 true 翻成 false', (c) => {
  const body = `${STEM_SHAPE}\n${SOLUTION}`
  const same = Q.judgeObjects(STEM_SHAPE, body, { sourceId: 'ab' })
  const conflict = Q.judgeObjects(STEM, body, { sourceId: 'ab' })
  c.eq(same.exact, true, '设问一致的正例被误杀（对照组成立才能证明 A/B 有效）')
  c.eq(conflict.exact, false, '条件全同但设问不同却判成同题')
  c.ok(/设问冲突/.test(conflict.rejectReason || ''), `降级原因不是设问冲突：${conflict.rejectReason}`)
  c.ok(conflict.factors.anchorRatio >= 0.4,
    `该负例锚点命中率 ${conflict.factors.anchorRatio} 未过硬阈值 ⇒ 证明不了「光靠锚点会放行」`)
  c.eq(conflict.factors.askQuestion, 'area')
  c.eq(conflict.factors.askStem, 'shape')
})

m.test('🔴 锚点共现必须限定在题目对象内，不得跨题拼凑', (c) => {
  // 把一道题的条件拆到 3 个不同题目对象里：全文锚点能凑够，任一对象内都不够。
  // 这正是 L3 整本教辅的失效模式（3.5 万字 / 76 道题 / 303 个【答案】标记）。
  const parts = [
    '已知抛物线 y=x²+2x-3 与 x 轴交于 A、B 两点，',
    '另设抛物线与 y 轴交于点 C，顶点为 D，',
    '如图连接 BD、CD，求 △BCD 的面积。',
  ]
  const doc = parts.map((p, i) =>
    `${i + 1}．${p}\n【答案】略\n【解析】本小问按第 ${i + 1} 步推导即可，此处给出完整过程说明。`).join('\n')
  const objs = Q.splitQuestionObjects(doc, { sourceId: 'split' })
  c.eq(objs.length, 3, '三道题没被切开')

  // 对照组：P-006 的**全文级**原题判定在这个样本上确实会误放行，构造才算复现了 F1
  c.eq(Q.isSameQuestion(STEM, doc), true,
    '构造失效：旧全文判据本应把分散在三题里的锚点凑够，否则本用例证明不了任何事')

  // 每个对象单独判定都不达标
  const longAnchors = Q.extractDistinctive(STEM).longAnchors
  for (const o of objs) {
    c.eq(Q.judgeQuestionObject(STEM, o, longAnchors, objs.length).passed, false,
      `第 ${o.source.objectIndex} 个对象单独判定竟然达标（跨题拼凑没被挡住）`)
  }
  const r = Q.judgeObjects(STEM, doc, { sourceId: 'split' })
  c.eq(r.exact, false, '跨对象拼凑锚点又判出了 exact —— 题目级切分形同虚设')
  c.eq(r.solution, undefined)
  c.eq(r.sourceLocation, undefined)
  c.eq(r.factors.objectCount, 3, 'factors 没记录对象数，排障时看不出切分是否生效')
  // 委托后的 judge() 也必须一起收紧，否则 ima 等仍调 isSameQuestion 的链路会留口子
  c.eq(Q.judge(STEM, doc).exact, false, 'judge() 没有委托到对象级闸门')
})

// ============================================================
// 四、正例召回与来源定位
// ============================================================

m.test('🔴 真实题目自匹配：exact 100%、漏判 0（防「一律降级」刷零误判）', (c) => {
  let total = 0
  let exact = 0
  let locOk = 0
  for (const d of fixture.documents) {
    const objs = Q.splitQuestionObjects(d.text, sourceOf(d))
    for (const o of objs) {
      if (!o.hasSolution) continue
      const stem = o.stem.replace(/\n/g, ' ')
      if (stem.replace(/\s/g, '').length < 30) continue
      total++
      const r = Q.judgeObjects(stem, d.text, sourceOf(d))
      if (r.exact) {
        exact++
        if (r.sourceLocation && r.sourceLocation.objectIndex === o.source.objectIndex) locOk++
        c.ok(r.solution && r.solution.length > 0, `${d.id} 第 ${o.source.objectIndex} 题 exact 却没给解析`)
      }
    }
  }
  c.ok(total >= 20, `正例样本量只有 ${total} 道，不足以支撑准入判定`)
  c.eq(exact, total, `正例召回 ${exact}/${total} 低于 100%（下限 90%）—— 不得以「降低误判」为由做成永远判不出`)
  c.eq(locOk, total, `来源定位 ${locOk}/${total} 不达标：定位错了，解析照样张冠李戴`)
})

// ============================================================
// 五、六条准入硬闸逐条可触发（串联否决，不是加权求和）
// ============================================================

m.test('🔴 六条硬闸逐条隔离触发，且 rejectReason 逐条留痕', (c) => {
  const cases = [
    ['题干提不出 ≥3 个长锚点', '求 1+1', makeObject('求 1+1')],
    ['题目对象超长', STEM, makeObject(STEM + '补充条件'.repeat(1600))],
    ['设问冲突', STEM, makeObject(STEM_SHAPE)],
    ['对象内锚点共现不足', STEM, makeObject('如图，在△ABC中，D为BC中点，求 △ABD 的面积为多少。')],
    ['解析段混入下一题的题号', STEM, makeObject(STEM, `${SOLUTION}\n2．下一题题干与解析也跟着过来了`)],
    ['该题干后没有紧邻的有效解析段', STEM, makeObject(STEM, '这是一段没有答案标记的课文内容。', false)],
  ]
  for (const [reason, q, o] of cases) {
    const r = judgeOne(q, o)
    c.eq(r.passed, false, `硬闸「${reason}」没有拦住`)
    c.ok((r.rejectReason || '').includes(reason), `硬闸「${reason}」的降级原因不对：${r.rejectReason}`)
    c.eq(r.exact, false, `硬闸「${reason}」未拦却判了 exact`)
    c.eq(r.sourceLocation, undefined, `硬闸「${reason}」未拦却带了来源位置`)
  }
  // 对照组：六条都满足时必须放行，否则上面的「全红」可能只是实现全盘失效
  const good = judgeOne(STEM, makeObject(STEM))
  c.eq(good.passed, true, '对照组被误杀 —— 六条硬闸可能退化成「一律不放行」')
  c.ok(good.sourceLocation, 'exact 没有带来源位置')
  c.ok(good.confidence > 0 && good.confidence <= 1, 'confidence 越界')
})

m.test('🔴 设问未知时收紧锚点门槛（证据少一项，其余证据必须更强）', (c) => {
  c.ok(Q.MATCH_STRICT_ANCHOR_RATIO > Q.MATCH_MIN_LONG_RATIO, '收紧门槛没有真的比默认更严')
  const r = judgeOne(STEM, makeObject(STEM))
  c.eq(r.factors.requiredRatio, Q.MATCH_MIN_LONG_RATIO, '设问一致时应走默认门槛')
  const src = read(MATCH)
  c.ok(/askMatch === 'same' \? MATCH_MIN_LONG_RATIO : MATCH_STRICT_ANCHOR_RATIO/.test(src),
    '收紧门槛没被用到判据里（常量成了摆设）')
})

m.test('🔴 多个题目对象并列达标 ⇒ 按「宁可判不出」降级，且不带来源位置', (c) => {
  const dup = `1．${STEM}\n${SOLUTION}\n2．${STEM}\n${SOLUTION}`
  c.eq(Q.splitQuestionObjects(dup).length, 2)
  const r = Q.judgeObjects(STEM, dup, { sourceId: 'dup' })
  c.eq(r.exact, false, '无法唯一定位却给了 exact')
  c.ok(/无法唯一定位/.test(r.rejectReason || ''), `降级原因不对：${r.rejectReason}`)
  c.eq(r.solution, undefined)
  c.eq(r.sourceLocation, undefined, '无法唯一定位却给了来源位置（等于随机指一题）')
})

// ============================================================
// 六、软信号不得越权 + 残余风险登记（防「看起来达标」）
// ============================================================

m.test('🔴 解析段关系校验只是软置信度，不得当硬闸', (c) => {
  const own = Q.solutionLink(STEM, SOLUTION)
  const other = Q.solutionLink(STEM, OTHER_SOLUTION)
  // 这条是 ROC 证伪的最小复现：本题解析与别人的解析拿到**完全相同**的关系分
  c.eq(own.score, other.score, '关系信号竟然能区分本题解析与他人解析 —— 与 40/40 实测矛盾，需重新评估')
  const src = read(MATCH)
  c.ok(/只作置信分层，不作硬闸/.test(src), '源码没声明 solutionLink 是软信号')
  const gate = src.slice(src.indexOf('let rejectReason'), src.indexOf('const passed = rejectReason'))
  c.ok(!/solutionLink|link\.score|solutionLinkScore/.test(gate),
    '关系校验信号出现在放行判据里 —— 硬凑阈值会把「看起来达标」写进文档')
  c.ok(/confidence = passed/.test(src), 'confidence 必须建立在放行结果之上，不得反过来决定放行')
})

m.test('🔴 残余风险已登记，且 P1/P2/P3 明示未批准（防后人误以为已解决而放宽召回）', (c) => {
  const report = read(REPORT)
  c.ok(/^## 8\./m.test(report), '报告 §8「未达标不放行」缺失')
  c.ok(/仍会放行/.test(report) && /残余风险/.test(report), '报告 §8 没有如实登记解析段归属的残余风险')
  c.ok(/上线准入闸门未全绿/.test(report), '报告 §8 没有给出「方案自身未达标」的结论')
  c.ok(/P1 \/ P2 \/ P3 一律不启动/.test(report), '报告 §8 没有把闸门用在方案自己身上')
  const proposal = read(PROPOSAL)
  c.ok(/P1 \/ P2 \/ P3 全部未批准/.test(proposal), 'P-009 未明示后续阶段未批准')
  c.ok(/已登记的残余风险/.test(proposal), 'P-009 falsifier 没有登记残余风险')
  const decision = read(DECISION)
  c.ok(/### D-012/.test(decision), '台账缺 D-012')
  c.ok(/D-011.{0,12}falsifier\s*⑥/.test(decision), 'D-012 没有记录 D-011 falsifier ⑥ 提前触发')
  c.ok(/有 `exact` 但全是假的/.test(decision), 'D-012 没有登记「负收益形式」的触发口径')
})

m.test('🔴 缓存版本 v6 参与 qHash（P1 结构化判定后老缓存必须失效）', (c) => {
  const sv = read('server/src/answer-search/answer-search.service.ts')
  c.ok(/const CACHE_VERSION = 'v6'/.test(sv), 'CACHE_VERSION 不是 v6')
  c.ok(sv.includes('${CACHE_VERSION}:${question}'), '版本没参与 qHash，bump 无效')
})

export default m
