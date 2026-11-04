// 模块 26：年级属性与按年级检索（P-005 / D-008）
//
// 为什么单独一个模块：
//   「相邻年级」是一句自然语言，落到代码里却有好几种可能的序列（±1 谁先？能不能跨学段？
//   边界怎么截断？）。这类「一句话对多种实现」的地方最容易悄悄漂移，
//   所以本模块把它拆成两层各钉一遍：
//     ① 纯函数层：序列与学年计算逐字锁定（时间无法快进的边界只能在这里测）
//     ② 接口层：未选年级不拦截 / 本年级优先 / 0 命中才扩散 / NULL 兜底 / 跨用户隔离
//
// ⚠️ 本模块守的是**行为契约**，不是「文档里写了」：
//   断言失败要么是实现偏了，要么是提案单改了——两种都必须先改文档再改这里。

import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { Module } from '../lib/harness.mjs'

const m = new Module('M26', '年级属性与按年级检索')

const ROOT = path.resolve(process.cwd(), '..')          // server/ → 仓库根
const TMP = path.join(ROOT, '.tmp', 'verify-grade')

/** grade.ts 只依赖自身 ⇒ tsc 单编后可直接 require（与 M15 单编 review.ts 同一套做法） */
function compileCore() {
  fs.mkdirSync(TMP, { recursive: true })
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/shared/grade.ts',
      '--outDir', TMP,
      '--module', 'commonjs',
      '--target', 'es2019',
      '--skipLibCheck',
      '--lib', 'es2019',
    ],
    { cwd: process.cwd(), stdio: 'pipe', encoding: 'utf8' },
  )
}

let G = null

async function ensureSubject(c) {
  if (c.state.subjectId) return c.state.subjectId
  const idt = await c.ident('main')
  const res = await c.api('GET', '/subjects', { token: idt.token })
  c.state.subjectId = res.json.data[0].id
  return c.state.subjectId
}

/**
 * 建题。`grade` 传 undefined = 走默认（取用户当前年级）；传 null = 显式不标年级。
 * ⚠️ 两者语义不同，必须用 `arguments.length` 区分，不能用 `??`。
 */
async function newQuestion(c, question, grade, hasGrade = false) {
  const idt = await c.ident('main')
  const subjectId = await ensureSubject(c)
  const body = {
    kind: 'question',
    subject_id: subjectId,
    content: { question, answer: 'x = 4', status: 'answered' },
  }
  if (hasGrade) body.grade = grade
  const res = await c.api('POST', '/timeline', { token: idt.token, body })
  c.status(res, 200, `建题失败: ${res.text.slice(0, 200)}`)
  return res.json.data
}

async function setGrade(c, grade) {
  const idt = await c.ident('main')
  return c.api('PUT', '/settings/grade', { token: idt.token, body: { grade } })
}

// ============================================================
// 一、纯函数层
// ============================================================

m.test('单编：shared/grade.ts 可独立编译（零依赖纯函数契约）', async (c) => {
  try {
    compileCore()
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`
    throw new Error(`grade.ts 单编失败（破坏了"零依赖"契约）：${out.slice(0, 300)}`)
  }
  const p = path.join(TMP, 'grade.js')
  c.ok(fs.existsSync(p), '编译产物不存在')
  G = await import(`file://${p.replace(/\\/g, '/')}`)
  for (const fn of [
    'isValidGrade', 'normalizeGrade', 'gradeLabel', 'gradeSpread', 'schoolYearStart', 'suggestGrade',
  ]) {
    c.ok(typeof G[fn] === 'function', `缺少导出 ${fn}`)
  }
})

m.test('年级字典：12 档连续编号，且与前端 constants/grades.ts 逐字一致', (c) => {
  c.eq(G.GRADES.length, 12, '年级档数应为 12（小学 1-6 / 初中 7-9 / 高中 10-12）')
  c.eq(G.GRADES.map((g) => g.value).join(','), '1,2,3,4,5,6,7,8,9,10,11,12',
    '年级必须是连续编号 —— 否则「相邻 = ±1」不成立')
  c.eq(G.GRADE_MIN, 1)
  c.eq(G.GRADE_MAX, 12)

  // 两端文案漂移（后端叫初三、前端叫九年级）会让家长在两个页面看到不同说法
  const fe = fs.readFileSync(path.join(ROOT, 'src', 'constants', 'grades.ts'), 'utf8')
  for (const g of G.GRADES) {
    c.ok(fe.includes(`label: '${g.label}'`), `前端缺少标签「${g.label}」——两端年级文案已漂移`)
  }
})

m.test('🔴 扩散序列：本年级在最前，±1 → ±2，低年级优先，边界不越界', (c) => {
  // 提案单决策 2/3 的逐字落地 —— 这条断言就是「相邻」的定义
  c.eq(G.gradeSpread(3).join(','), '3,2,4,1,5', 'grade=3 的扩散序列不对（应为 本年级→-1→+1→-2→+2）')
  c.eq(G.gradeSpread(6).join(','), '6,5,7,4,8', 'grade=6 应允许跨学段到初一')
  c.eq(G.gradeSpread(9).join(','), '9,8,10,7,11', 'grade=9 应允许跨学段到高一')
  c.eq(G.gradeSpread(1).join(','), '1,2,3', '下界越界：一年级不该出现 0 / -1')
  c.eq(G.gradeSpread(12).join(','), '12,11,10', '上界越界：高三不该出现 13 / 14')
  c.eq(G.gradeSpread(2).join(','), '2,1,3,4', 'grade=2 的 -2 越界后应只剩 +2')
  c.eq(G.gradeSpread(11).join(','), '11,10,12,9', 'grade=11 的 +2 越界后应只剩 -2')

  // 非法输入一律空序列（不扩散），而不是抛错
  c.eq(G.gradeSpread(null).length, 0)
  c.eq(G.gradeSpread(0).length, 0)
  c.eq(G.gradeSpread(13).length, 0)

  // 上限参数必须生效（防有人把 2 偷偷改成 5 变成「全库召回」）
  c.eq(G.gradeSpread(6, 1).join(','), '6,5,7', 'maxStep=1 时应只扩一级')
  c.eq(G.gradeSpread(6, 0).join(','), '6', 'maxStep=0 时应不扩散')
})

m.test('normalizeGrade：空串 / "0" / 越界 / 非数字 一律 null（不能落成一年级）', (c) => {
  c.eq(G.normalizeGrade(3), 3)
  c.eq(G.normalizeGrade('3'), 3, '字符串数字应被接受（query 参数都是字符串）')
  c.eq(G.normalizeGrade(' 7 '), 7)

  // ⚠️ Number('') === 0、Number(null) === 0：直接转会把「没填」变成「一年级」
  c.eq(G.normalizeGrade(''), null, '空串被当成了年级（会静默变成一年级）')
  c.eq(G.normalizeGrade('   '), null)
  c.eq(G.normalizeGrade(null), null)
  c.eq(G.normalizeGrade(undefined), null)
  c.eq(G.normalizeGrade('0'), null, '"0" 被当成了年级')
  c.eq(G.normalizeGrade(0), null)
  c.eq(G.normalizeGrade(13), null)
  c.eq(G.normalizeGrade(-1), null)
  c.eq(G.normalizeGrade(3.5), null, '小数年级应被拒绝')
  c.eq(G.normalizeGrade('abc'), null)
  c.eq(G.normalizeGrade({}), null)
})

m.test('学年边界：9/1 起算新学年（东八区，不能用服务器时区）', (c) => {
  c.eq(G.schoolYearStart(new Date('2026-09-01T12:00:00+08:00')), 2026, '9/1 应进入 2026 学年')
  c.eq(G.schoolYearStart(new Date('2026-08-31T12:00:00+08:00')), 2025, '8/31 仍属 2025 学年')
  c.eq(G.schoolYearStart(new Date('2027-03-15T12:00:00+08:00')), 2026, '次年 3 月仍属上一学年')
  // 东八区 9/1 凌晨（UTC 还是 8/31）——用服务器 UTC 会算错一年
  c.eq(G.schoolYearStart(new Date('2026-09-01T01:00:00+08:00')), 2026,
    '东八区 9/1 凌晨被判成了上一学年（时区没按 +8 处理）')
})

m.test('升年级建议：跨一学年 +1；本学年不提示；高三不再推', (c) => {
  const now = new Date('2026-11-04T12:00:00+08:00')
  c.eq(G.suggestGrade(3, 2025, now), 4, '跨一学年应从三年级建议四年级')
  c.eq(G.suggestGrade(3, 2024, now), 5, '跨两学年应建议五年级（缺一年没确认也按实际补）')
  c.eq(G.suggestGrade(3, 2026, now), null, '本学年已确认过不应再提示')
  c.eq(G.suggestGrade(12, 2025, now), null, '高三毕业不再建议升学')
  c.eq(G.suggestGrade(null, 2025, now), null, '没设年级不应提示')
  c.eq(G.suggestGrade(3, null, now), null, '没有确认记录时不打扰')
  c.eq(G.suggestGrade(3, 0, now), null, '脏数据（confirmed_year=0）应被忽略')
})

m.test('静态：提示文案是引导而非门槛（GK-SRS-20a M11）', (c) => {
  const idx = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'index', 'index.tsx'), 'utf8')
  c.ok(idx.includes('勾选年级后，优先找同年级的题目'),
    '首页缺少年级引导文案（P-005 决策 8）')
  // 门槛型话术一旦出现，「提醒」就变成了「准入」
  c.ok(!/必须勾选年级|不选年级(就)?不能/.test(idx),
    '文案把年级写成了检索门槛 —— M11 禁止把引导升级为条件')
})

// ============================================================
// 二、接口层
// ============================================================

m.test('🔴 未选年级不拦截：不传 grade 照常返回，且不带 grade_scope', async (c) => {
  const idt = await c.ident('main')
  const res = await c.api('GET', '/timeline', {
    token: idt.token, query: { scope: 'recent', page_size: 5 },
  })
  c.status(res, 200, '未选年级时检索被拦截了 —— 年级只能是引导，不能是门槛（M11）')
  c.ok(Array.isArray(res.json.data.list), '缺少 list')
  c.ok(!('grade_scope' in res.json.data),
    '未传 grade 却返回了 grade_scope —— 前端会把「没筛」误判成「筛了没命中」')
})

m.test('设置年级：返回值与标签正确；非法值 400；缺参数 400', async (c) => {
  const ok = await setGrade(c, 3)
  c.status(ok, 200)
  c.eq(ok.json.data.grade, 3)
  c.eq(ok.json.data.grade_label, '三年级', '年级标签不对（前端直接展示这个值）')

  const bad = await c.api('PUT', '/settings/grade', {
    token: (await c.ident('main')).token, body: { grade: 99 },
  })
  c.status(bad, 400, '非法年级被接受了 —— 会静默存成 null，用户以为设好了')

  const missing = await c.api('PUT', '/settings/grade', {
    token: (await c.ident('main')).token, body: {},
  })
  c.status(missing, 400, '缺 grade 被当成「不改」放过 —— 契约要求显式传 null 才表示取消')

  const clear = await setGrade(c, null)
  c.status(clear, 200)
  c.eq(clear.json.data.grade, null, '取消年级失败')
})

m.test('创建题目：默认带用户年级快照；显式值覆盖；显式 null 不回退', async (c) => {
  await setGrade(c, 3)
  const auto = await newQuestion(c, '年级快照：默认取用户年级')
  c.eq(auto.grade, 3, `新建题目未带年级快照（实际 ${auto.grade}）—— 「默认归并到该年级」没落地`)

  const explicit = await newQuestion(c, '年级快照：显式指定', 5, true)
  c.eq(explicit.grade, 5, '显式 grade 未覆盖用户年级')

  // ⚠️ 显式 null 是「这条不标年级」的合法意图，不能被用户默认值悄悄填上
  const none = await newQuestion(c, '年级快照：显式不标', null, true)
  c.eq(none.grade, null, '显式 null 被用户默认年级覆盖了')
})

m.test('🔴 本年级有命中 ⇒ 不扩散（返回结果的年级全部是本年级或未标注）', async (c) => {
  const idt = await c.ident('main')
  await setGrade(c, 3)
  const tag = `本档探针${Date.now()}`
  await newQuestion(c, `${tag} 三年级题`, 3, true)
  // 同关键词下放一条相邻年级的题：若扩散逻辑错了，它会被一起捞出来
  await newQuestion(c, `${tag} 二年级题`, 2, true)

  const res = await c.api('GET', '/timeline', {
    token: idt.token, query: { scope: 'recent', keyword: tag, grade: '3', page_size: 50 },
  })
  c.status(res, 200)
  const rows = res.json.data.list || []
  c.ok(rows.length > 0, '本年级明明有题，却返回空列表')
  c.eq(res.json.data.grade_scope?.spread, false, '本年级有命中却发生了扩散')
  c.eq((res.json.data.grade_scope?.used || []).join(','), '3', '有命中时 used 应只含本年级')
  c.ok(rows.every((x) => x.grade === 3 || x.grade === null),
    `扩散了：结果里出现了非本年级的题 ${rows.map((x) => x.grade).join(',')}`)
})

m.test('🔴 本年级 0 命中 ⇒ 扩散到相邻年级，并标注扩散范围', async (c) => {
  const idt = await c.ident('main')
  await setGrade(c, 3)
  const tag = `扩散探针${Date.now()}`
  const target = await newQuestion(c, `${tag} 二年级题`, 2, true)

  const res = await c.api('GET', '/timeline', {
    token: idt.token, query: { scope: 'recent', keyword: tag, grade: '3', page_size: 50 },
  })
  c.status(res, 200)
  const rows = res.json.data.list || []
  c.ok(rows.some((x) => x.id === target.id),
    '本年级 0 命中却没有扩散到相邻年级 —— 新用户/新年级会看到空列表')
  c.eq(res.json.data.grade_scope?.spread, true, 'grade_scope.spread 应为 true')
  c.eq((res.json.data.grade_scope?.used || []).join(','), '3,2,4,1,5',
    '扩散序列与纯函数不一致 —— 接口层没有复用 gradeSpread()')
})

m.test('🔴 老题兜底：未标注年级的存量题仍可见（不能被年级筛掉）', async (c) => {
  const idt = await c.ident('main')
  await setGrade(c, 3)
  const tag = `兜底探针${Date.now()}`
  const legacy = await newQuestion(c, `${tag} 未标注年级`, null, true)

  const res = await c.api('GET', '/timeline', {
    token: idt.token, query: { scope: 'recent', keyword: tag, grade: '3', page_size: 50 },
  })
  c.status(res, 200)
  c.ok((res.json.data.list || []).some((x) => x.id === legacy.id),
    '未标注年级的题在按年级检索时消失了 —— 存量内容看起来像丢了')
})

m.test('🔴 隔离：B 按同年级检索看不到 A 的题', async (c) => {
  const idt = await c.ident('main')
  await setGrade(c, 3)
  const tag = `越权探针${Date.now()}`
  const mine = await newQuestion(c, `${tag} A 的三年级题`, 3, true)

  const foe = await c.foe()
  const res = await c.api('GET', '/timeline', {
    token: foe.token, query: { scope: 'recent', keyword: tag, grade: '3', page_size: 50 },
  })
  c.status(res, 200)
  c.ok(!(res.json.data.list || []).some((x) => x.id === mine.id),
    '他人按年级检索看到了 A 的题 —— user_id 隔离被年级过滤绕过了')
})

m.test('清理：测试账号年级复位为未选择', async (c) => {
  const res = await setGrade(c, null)
  c.status(res, 200)
  c.eq(res.json.data.grade, null, '清理失败：测试账号仍留着年级，会影响后续模块')
})

export default m
