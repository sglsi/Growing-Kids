// 模块 27：资料库搜题「原题判定 + 诚实化」（P-006 / D-009）
//
// 为什么单独一个模块：
//   2026-11-04 生产实测：搜「数学 2026-10-29 第 1 题」，返回的是
//   「专题6 二次函数与平行四边形存在性问题」里另一道题的【分析】片段 + 5 个文件名，
//   却标了 verified:true、塞进 answer、还常驻「采纳」按钮 —— 用户点一下就把别的题
//   解析写进本题答案。P-006 把它定性为「把同主题资料片段当答案」，D 降维处理后重写。
//
//   这个病最容易悄悄复发：后人只要把「找资料」和「认原题」重新混成一件事，
//   或给某个新数据源开个「有结果就当答案」的口子，就会原地复活。
//   所以本模块分三层各钉一遍：
//     ① 纯函数层：判定阈值、解析段定位、降级路径逐字锁定（不连后端也能跑）
//     ② 静态源码层：缓存版本、契约一致性、每个 exact 组装点的闸门、采纳双保险
//     ③ 接口层：真实 mode=kb 调用，断言同专题不同题的答案没被冒充进来
//
// ⚠️ 本模块守的是**行为契约**，不是「文档里写了」。断言失败要么是实现偏了，
//    要么是提案单改了 —— 两种都必须先改 P-006 / D-009 再改这里。

import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { Module } from '../lib/harness.mjs'

const m = new Module('M27', '资料库搜题原题判定与诚实化')

const ROOT = path.resolve(process.cwd(), '..')          // server/ → 仓库根
const TMP = path.join(ROOT, '.tmp', 'verify-question-match')
const SERVICE = 'server/src/answer-search/answer-search.service.ts'
const TYPES = 'server/src/answer-search/answer-search.types.ts'
const FE_API = 'src/services/api.ts'
const EDITOR = 'src/components/answer-editor.tsx'
const MATCH = 'server/src/shared/question-match.ts'

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** question-match.ts 零依赖 ⇒ tsc 单编后可直接 require（与 M15 / M26 同一套做法） */
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

let Q = null

// ---------------------------------------------------------------
// 测试语料：一道二次函数面积题 + 三种「看起来很像」的干扰正文
//   SAME       = 题干原文 + 【答案】 + 【解析】            ⇒ 必须 exact
//   OTHER      = 同专题（二次函数 / 平行四边形）但另一道题 ⇒ 必须降级
//   NO_SECTION = 题干原文但没有任何解析段标记             ⇒ 必须降级
// ---------------------------------------------------------------
const QUESTION = '已知抛物线 y=x²+2x-3 与 x 轴交于 A、B 两点，与 y 轴交于点 C，顶点为 D，求 △BCD 的面积。'
const OTHER_Q = '如图，抛物线 y=x²-2x-3 与 x 轴交于 A、B，与 y 轴交于 C，点 M 在抛物线上，点 N 在直线 BC 上，是否存在以点 D、E、M、N 为顶点的四边形是平行四边形？'

const SAME = [
  '专题：二次函数与三角形面积',
  QUESTION,
  '【答案】S=4',
  '【解析】由 y=x²+2x-3 得 A(-3,0)、B(1,0)、C(0,-3)，顶点 D(-1,-4)，故 △BCD 的面积为 4。',
  '【点评】本题考查二次函数图象与坐标轴交点及面积计算。',
].join('\n')

const OTHER = [
  '专题6 二次函数与平行四边形存在性问题',
  OTHER_Q,
  '【分析】设 N(t, t-3)，分 DE 为边与 DE 为对角线两种情况讨论，利用中点坐标公式列方程。',
  '【答案】N(2,-1) 或 N(4,1)。',
].join('\n')

const NO_SECTION = [
  QUESTION,
  '这是一道常见的二次函数综合题，涉及交点坐标与面积计算，解题时先求交点再算面积即可。',
].join('\n')

// ============================================================
// 一、纯函数层
// ============================================================

m.test('单编：shared/question-match.ts 可独立编译（零依赖纯函数契约）', async (c) => {
  try {
    compileCore()
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`
    throw new Error(`question-match.ts 单编失败（破坏了"零依赖"契约）：${out.slice(0, 300)}`)
  }
  const p = path.join(TMP, 'question-match.js')
  c.ok(fs.existsSync(p), '编译产物不存在')
  Q = await import(`file://${p.replace(/\\/g, '/')}`)
  for (const fn of [
    'normalizeForMatch', 'isTopicOrNoiseSegment', 'extractDistinctive',
    'countAnchorHits', 'isSameQuestion', 'locateSolution', 'judge',
  ]) {
    c.ok(typeof Q[fn] === 'function', `缺少导出 ${fn}`)
  }
})

m.test('归一化：只留汉字/字母/数字，消除 OCR 与排版标点差异', (c) => {
  c.eq(Q.normalizeForMatch('已知 抛物线 y=x²+2x-3，求 S=4。'), '已知抛物线yx2x3求S4')
  c.eq(Q.normalizeForMatch('A(-3,0)、B(1,0)'), 'A30B10')
  c.eq(Q.normalizeForMatch(''), '')
  c.eq(Q.normalizeForMatch(null), '')
})

m.test('🔴 主题词与噪声前缀不得单独成为原题判定锚点', (c) => {
  // 这些片段只说明「属于哪个专题」，不说明「是哪一道题」
  c.eq(Q.isTopicOrNoiseSegment('二次函数'), true)
  c.eq(Q.isTopicOrNoiseSegment('二次函数与平'), true)
  c.eq(Q.isTopicOrNoiseSegment('已知抛物线y'), true)
  c.eq(Q.isTopicOrNoiseSegment('12345'), true, '纯数字串交给数值锚点处理，6 字窗口本身不收')
  c.eq(Q.isTopicOrNoiseSegment('ABCD'), true, '纯字母串交给变量锚点处理')
  c.eq(Q.isTopicOrNoiseSegment('3与x轴交于'), false, '带数值/变量的条件片段应保留为判定锚点')
  c.ok(Array.isArray(Q.TOPIC_WORDS) && Q.TOPIC_WORDS.includes('二次函数'))
  c.ok(Array.isArray(Q.NOISE_PREFIX) && Q.NOISE_PREFIX.includes('已知'))
  // 而带数值 / 变量的条件片段必须能进锚点
  const d = Q.extractDistinctive(QUESTION)
  c.ok(d.longAnchors.includes('3与x轴交于'), '题干特有的条件片段被误当成噪声剔除了')
  c.ok(d.longAnchors.length >= 3, '题干提不出足够的长锚点')
})

m.test('🔴 粗筛词只收 ≥4 字长锚点（短数值/字母只进判定锚点，不进 SQL ilike）', (c) => {
  const d = Q.extractDistinctive(QUESTION)
  c.ok(d.keys.length > 0, '没有生成任何粗筛词')
  c.ok(d.keys.every((k) => k.length >= 4), `keys 混入短片段，会让 ilike 命中一大片：${d.keys.join(',')}`)
  c.ok(d.anchors.length > d.longAnchors.length, '短锚点应存在（判定用）但被排除出 keys')
  c.ok(!d.keys.includes('AB'), '2 字大写变量串不该进 ilike 粗筛')
  c.ok(d.anchors.includes('AB'), '2 字大写变量串仍应作为判定锚点')
  c.ok(!d.keys.includes('3与'), '2 字数值片段不该进 ilike 粗筛')
})

m.test('🔴 题干原文 + 【答案】/【解析】段 ⇒ exact，且答案取自解析段而非任意上下文', (c) => {
  const j = Q.judge(QUESTION, SAME)
  c.eq(j.exact, true)
  c.eq(j.anchorsHit, 9, '同题正文应命中全部 9 个长锚点')
  c.eq(j.anchorsTotal, 9)
  c.eq(j.hasSolutionSection, true)
  c.ok(j.solution && j.solution.includes('S=4'), '解析段没给出结论（只有一个结论对推导不够）')
  c.ok(j.solution && j.solution.includes('由 y=x²+2x-3 得'), '解析段没给出推导过程')
  c.ok(!j.solution.includes('专题：'), '把题目前面的章节标题当成了解析段（旧的 snippetFor 行为）')
})

m.test('🔴 同专题不同题不得冒充答案（P-006 / D-009 核心断言）', (c) => {
  const h = Q.countAnchorHits(QUESTION, OTHER)
  c.eq(h.total, 9)
  c.eq(h.hit, 3, '同专题不同题只应命中前 3 个泛化片段')
  c.ok(h.ratio < Q.MATCH_MIN_LONG_RATIO, `命中率 ${h.ratio} 应低于阈值 ${Q.MATCH_MIN_LONG_RATIO}`)
  c.eq(Q.isSameQuestion(QUESTION, OTHER), false, '同专题不同题被判成了同一道题')

  const j = Q.judge(QUESTION, OTHER)
  c.eq(j.exact, false, '同专题不同题被标成了 exact —— 这正是生产事故本体')
  c.eq(j.solution, undefined, '非原题却给出了 solution（会流进 answer 字段）')
  c.eq(j.hasSolutionSection, true,
    'OTHER 里明明有【分析】段 —— 降级必须来自原题判定，而不是「碰巧没解析段」')
})

m.test('🔴 多锚点共现阈值：只命中 1 个 ⇒ 不判同题（哪怕正文里有【答案】段）', (c) => {
  const partial = '抛物线 y=x²+2x'
  const h = Q.countAnchorHits(QUESTION, partial)
  c.eq(h.hit, 1)
  c.eq(Q.isSameQuestion(QUESTION, partial), false)
  const j = Q.judge(QUESTION, `${partial}\n【答案】S=4\n【解析】随便写点推导。`)
  c.eq(j.exact, false)
  c.eq(j.hasSolutionSection, true, '这条要证明：有解析段也不够，必须多锚点共现')
})

m.test('🔴 原题判定通过但正文没有【答案】/【解析】段 ⇒ 仍降级（双前提缺一不可）', (c) => {
  const j = Q.judge(QUESTION, NO_SECTION)
  c.eq(j.anchorsHit, 9)
  c.eq(j.hasSolutionSection, false)
  c.eq(j.exact, false, '没有解析段却判了 exact —— 会拿一段课文当答案')
  c.eq(j.solution, undefined)
  c.eq(Q.locateSolution(NO_SECTION, QUESTION), null)
})

m.test('短题干提不出 ≥3 个长锚点 ⇒ 一律降级（宁可判不出，也不冒充）', (c) => {
  const j = Q.judge('求 1+1', '求 1+1 等于 2')
  c.eq(j.anchorsTotal, 0)
  c.eq(j.exact, false)
  c.eq(j.solution, undefined)
})

m.test('判定参数锁定：≥3 个长锚点共现且命中率 ≥40%', (c) => {
  c.eq(Q.MATCH_MIN_LONG_ANCHORS, 3, '收紧/放宽阈值必须同步改 P-006 ⑥ 与本模块')
  c.eq(Q.MATCH_MIN_LONG_RATIO, 0.4)
  // 阈值常量必须真的被 isSameQuestion / judge 用到，而不是摆设
  const src = read(MATCH)
  c.ok(/h\.total >= MATCH_MIN_LONG_ANCHORS/.test(src), 'isSameQuestion 没用阈值常量')
  c.ok(/h\.ratio >= MATCH_MIN_LONG_RATIO/.test(src), 'isSameQuestion 没用命中率常量')
})

// ============================================================
// 二、静态源码层：四处必须同时改，缺一即静默失败
// ============================================================

m.test('🔴 缓存版本已 bump 到 v6（否则老 answer_cache 会绕过后续人工修复）', (c) => {
  const s = read(SERVICE)
  // P-006 v4；P-009 / D-012 v5（新增 source_location、一题一对象）；
  // P-010 / D-013 v6（exact 改走入库结构化对象）：老缓存可能存着「后来被标
  // rejected 的对象」放行的 exact，不 bump 会让人工定点修复对缓存命中无效。
  c.ok(/const CACHE_VERSION = 'v6'/.test(s), 'CACHE_VERSION 不是 v6')
  c.ok(!/const CACHE_VERSION = 'v[1-5]'/.test(s), '还留着旧版本号的赋值')
  c.ok(s.includes('${CACHE_VERSION}:${question}'), 'CACHE_VERSION 必须参与 qHash，否则 bump 无效')
})

m.test('🔴 P-009：来源位置三处契约同步（后端类型 / service / 前端 api）', (c) => {
  const t = read(TYPES)
  const sv = read(SERVICE)
  const fe = read(FE_API)
  for (const [name, s] of [['后端类型', t], ['前端 api', fe]]) {
    c.ok(s.includes('source_location?:'), `${name} 缺少 source_location 可选字段`)
    c.ok(/object_index:\s*number/.test(s), `${name} source_location 缺 object_index`)
    c.ok(/char_start:\s*number/.test(s) && /char_end:\s*number/.test(s), `${name} source_location 缺字符区间`)
  }
  c.ok(sv.includes('function toSourceLocation'), 'service 缺来源位置收敛函数')
  c.ok(sv.includes('source_location: toSourceLocation'), 'exact 结果没有真正带上来源位置')
  // 硬闸：topic / none 绝不能出现 source_location（否则等于给无出处答案背书）
  const exactBlocks = [...sv.matchAll(/match_level: 'exact'/g)]
  c.ok(exactBlocks.length >= 2, 'exact 组装点不足两处')
  c.ok(!/match_level: 'topic'[\s\S]{0,200}source_location/.test(sv), 'topic 结果带了 source_location')
})

m.test('🔴 P-009：两个正文数据源都走 judgeObjects 硬闸（无数据源豁免）', (c) => {
  const sv = read(SERVICE)
  const nd = read('server/src/netdisk/netdisk-search.service.ts')
  c.ok(nd.includes('judgeObjects(question, text,'), '网盘深挖没有改用 judgeObjects')
  c.ok(sv.includes('judgeObjects(question, text,'), 'library_docs 没有改用 judgeObjects')
  c.ok(!/const j = judge\(/.test(nd + sv), '仍有全文件级 judge() 在给 exact 供数')
  // ima 是语义高亮片段，按 P-006 口径仍用 isSameQuestion，但不得因此绕过闸门
  c.ok(sv.includes('isSameQuestion(question, joined)'), 'ima 分支原题判定被删了')
})

m.test('🔴 match_level 契约三处同名同值域（后端类型 / service / 前端 api）', (c) => {
  const t = read(TYPES)
  const sv = read(SERVICE)
  const fe = read(FE_API)
  const decl = /match_level\?:\s*'exact'\s*\|\s*'topic'\s*\|\s*'none'/
  c.ok(decl.test(t), '后端 answer-search.types.ts 缺少 match_level 或值域不一致')
  c.ok(decl.test(fe), '前端 src/services/api.ts 缺少 match_level 或值域不一致')
  const vals = [...sv.matchAll(/match_level:\s*'(\w+)'/g)].map((x) => x[1])
  c.ok(vals.length >= 3, 'service 里没有 match_level 分档赋值')
  c.ok(vals.every((v) => ['exact', 'topic', 'none'].includes(v)), `service 出现越界档位：${vals.join(',')}`)
  c.ok(vals.includes('exact') && vals.includes('topic') && vals.includes('none'), '三档没有全部落地')
})

m.test('🔴 ima 语义检索结果也必须过原题判定（不得「有结果就 verified:true」）', (c) => {
  const s = read(SERVICE)
  c.ok(s.includes('isSameQuestion(question, joined)'),
    'ima 分支缺少原题判定闸门 —— 它查询链被降级成主题词，命中同专题不同题几乎必然')
  c.ok(!/if \(items\.length > 0\)\s*\{[\s\S]{0,200}?verified:\s*true/.test(s),
    '仍存在「if (items.length > 0) { … verified: true }」的旧模式')
  const iJudge = s.indexOf('isSameQuestion(question, joined)')
  const iAnswer = s.indexOf("answer: (top.summary || top.snippet || '')")
  c.ok(iJudge > -1 && iAnswer > iJudge, 'ima 的答案组装跑到了原题判定之前')
  c.ok(s.includes('imaItems = items.slice(0, 5)'), '判不出原题的 ima 条目必须留给兜底如实列出，不能丢')
})

m.test('🔴 topic 结果 answer 必须为空、verified 必须为 false；answer 不再来自 top.snippet', (c) => {
  const s = read(SERVICE)
  c.ok(!s.includes('answer: (top.snippet'), '仍在把网盘正文片段塞进 answer')
  c.ok(s.includes("answer: '', // 🔴 D-009"), 'topic 兜底未显式置空 answer')
  const blocks = [...s.matchAll(/match_level: 'topic'/g)]
  c.ok(blocks.length > 0, 'service 里没有 topic 分档')
  for (const b of blocks) {
    const chunk = s.slice(Math.max(0, b.index - 300), b.index + 300)
    c.ok(/verified:\s*false/.test(chunk), 'topic 结果却标了 verified:true')
    c.ok(/answer:\s*''/.test(chunk), 'topic 结果 answer 非空')
  }
})

m.test('🔴 新增查库两处必须 .eq(user_id)：searchOwnAnswers / searchLibraryDocs', (c) => {
  const s = read(SERVICE)
  for (const fn of ['searchOwnAnswers', 'searchLibraryDocs']) {
    const at = s.indexOf(`private async ${fn}(`)
    c.ok(at > -1, `缺少 ${fn}`)
    const body = s.slice(at, at + 1400)
    c.ok(body.includes(".eq('user_id', userId)"), `${fn} 缺少用户隔离（无 RLS，会读到别人的答案）`)
  }
})

m.test('🔴 采纳闸门双保险：前端条件渲染 + handleAdopt 保存前再拦', (c) => {
  const s = read(EDITOR)
  c.ok(/const canAdopt = .*candidate\.match_level !== 'topic'.*candidate\.match_level !== 'none'/.test(s),
    'canAdopt 没有同时排除 topic / none')
  c.ok(/if \(!canAdopt\)/.test(s), 'handleAdopt 没有第二道拦截（异常返回也拦得住才算双保险）')
  c.ok(s.includes("Taro.showToast({ title: '非本题答案，不能采纳'"), '拒绝时没有给用户明确提示')
  c.ok(/\{canAdopt \? \(/.test(s), '「采纳」按钮不是条件渲染 —— 旧实现按钮常驻，点一下就污染题库')
})

m.test('🔴 分档呈现：topic 明说「没找到这道题的答案」，且不把文件名清单当解题过程渲染', (c) => {
  const s = read(EDITOR)
  c.ok(s.includes('没找到这道题的答案，以下是同主题资料'), '缺少诚实化文案')
  c.ok(s.includes('找到这道题的参考答案'), 'exact 分档标题缺失')
  c.ok(/candidate\.solution && candidate\.match_level !== 'topic'/.test(s),
    'topic 的 solution（文件名清单）仍被 MathText 当解题过程渲染')
  c.ok(s.includes("candidate.source === 'netdisk' || candidate.source === 'kb'"),
    'kb 来源未纳入分档 —— ima 同专题条目会继续冒充「资料库检索结果」')
})

m.test('🔴 H2 口径：搜题结果文案不含宣称词与门槛话术', (c) => {
  const s = read(SERVICE) + read(EDITOR)
  for (const w of ['必须开启 AI', '智能匹配', '精准推荐', '自动解题', '帮你做对', '提升正确率', 'ZPD', '最近发展区']) {
    c.ok(!s.includes(w), `出现禁用宣称词「${w}」（GK-SRS-20a M10 / H2 口径门）`)
  }
  c.ok(!/必须勾选年级|不选年级(就)?不能/.test(read('src/pages/index/index.tsx')), '年级被写成了检索门槛')
})

// ============================================================
// 三、接口层：真实 mode=kb 调用
// ============================================================

async function ensureSubject(c) {
  if (c.state.subjectId) return c.state.subjectId
  const idt = await c.ident('m27')
  const res = await c.api('GET', '/subjects', { token: idt.token })
  c.status(res, 200, '取学科失败')
  c.state.subjectId = res.json.data[0].id
  return c.state.subjectId
}

m.test('🔴 接口：mode=kb 结果带 match_level；同专题不同题的已有答案不得被冒充', async (c) => {
  const idt = await c.ident('m27')
  const subjectId = await ensureSubject(c)
  // 唯一标记：既保证题干内容不同（不命中答案缓存），也是「有没有被误采纳」的探针
  const marker = `P006M27_NO_ADOPT_${Date.now()}`

  // ① 同专题、但**不是同一道题**、且带答案 —— 若 searchOwnAnswers 判错，它会被当成答案
  const other = await c.api('POST', '/timeline', {
    token: idt.token,
    body: {
      kind: 'question', subject_id: subjectId,
      content: { question: OTHER_Q, answer: marker, status: 'answered' },
    },
  })
  c.status(other, 200, `造同专题不同题失败：${other.text.slice(0, 200)}`)

  // ② 目标题
  const target = await c.api('POST', '/timeline', {
    token: idt.token,
    body: {
      kind: 'question', subject_id: subjectId,
      content: { question: `${QUESTION}（验证 ${marker}）`, status: 'answered' },
    },
  })
  c.status(target, 200, `造目标题失败：${target.text.slice(0, 200)}`)

  const res = await c.api('POST', `/answer-search/${target.json.data.id}`, {
    token: idt.token, body: { mode: 'kb' },
  })
  c.status(res, 200, `kb 搜题失败：${res.text.slice(0, 200)}`)
  const d = res.json.data
  c.ok(d && typeof d === 'object', '缺少 data')
  c.ok('match_level' in d, 'v4 契约：结果必须带 match_level（否则前端分档与采纳闸门全部失效）')
  c.ok(['exact', 'topic', 'none'].includes(d.match_level), `match_level 越界：${d.match_level}`)
  c.ok(!String(d.answer || '').includes(marker),
    '把同专题不同题的答案当成了本题答案 —— P-006 要治的就是这个')
  c.ok(!String(d.solution || '').includes(marker),
    '把同专题不同题的解析列进了本题解题过程')
  if (d.match_level !== 'exact') {
    c.eq(d.answer, '', '非 exact 却填了 answer')
    c.eq(d.verified, false, '非 exact 却标了 verified:true')
  }
})

export default m
