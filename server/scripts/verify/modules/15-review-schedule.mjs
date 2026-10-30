// 模块 15：复习排程（C4 · 分散练习）
//
// 为什么单独一个模块：
//   这是全项目效应量最高的机制（d = 0.85，GK-SRS-20b §4.1），也是最容易「看起来做了、
//   其实没生效」的地方——旧实现按 created_at 现算、且只有一个「今天复习了 ✓」按钮，
//   做对做错一个样。本模块同时钉住两件事：
//     ① 纯函数层：间隔推进 / 回退 / 到期判定（时间无法快进的边界只能在这里测）
//     ② 接口层：真实后端的排程流转、越权、鉴权
//
// 到期判定为什么必须用纯函数测：
//   「今天到期」要等到明天才出现，接口层无法把时间拨过去。
//   buildReviewPlan 接受注入的 now，可以直接构造昨天/今天/明天三种情形。

import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { Module } from '../lib/harness.mjs'

const m = new Module('M15', '复习排程（分散练习）')

const ROOT = path.resolve(process.cwd(), '..')          // server/ → 仓库根
const TMP = path.join(ROOT, '.tmp', 'verify-review')

/** review.ts 是零 import 的纯计算模块 ⇒ tsc 单编后可直接 require */
function compileCore() {
  fs.mkdirSync(TMP, { recursive: true })
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/timeline/review.ts',
      '--outDir', TMP,
      '--module', 'commonjs',
      '--target', 'es2019',
      '--skipLibCheck',
      '--lib', 'es2019',
    ],
    { cwd: process.cwd(), stdio: 'pipe', encoding: 'utf8' },
  )
}

let R = null

const DAY = 24 * 3600 * 1000
/** 距今天的天数（四舍五入，容忍几秒偏差） */
function daysFromNow(iso, now = new Date()) {
  return Math.round((new Date(iso).getTime() - now.getTime()) / DAY)
}
const isoDaysAgo = (n) => new Date(Date.now() - n * DAY).toISOString()

async function ensureSubject(c) {
  if (c.state.subjectId) return c.state.subjectId
  const id = await c.ident('main')
  const res = await c.api('GET', '/subjects', { token: id.token })
  c.state.subjectId = res.json.data[0].id
  return c.state.subjectId
}

async function newQuestion(c, question) {
  const id = await c.ident('main')
  const subjectId = await ensureSubject(c)
  const res = await c.api('POST', '/timeline', {
    token: id.token,
    body: {
      kind: 'question',
      subject_id: subjectId,
      content: { question, answer: 'x = 4', status: 'answered' },
    },
  })
  c.status(res, 200, `建题失败: ${res.text.slice(0, 200)}`)
  return res.json.data
}

async function addToBook(c, id) {
  return c.api('POST', '/timeline/review-book', { token: (await c.ident('main')).token, body: { ids: [id] } })
}

async function review(c, id, result) {
  const idt = await c.ident('main')
  return c.api('POST', `/timeline/${id}/review`, {
    token: idt.token, body: result === undefined ? {} : { result },
  })
}

async function detail(c, id) {
  const idt = await c.ident('main')
  const res = await c.api('GET', `/timeline/${id}`, { token: idt.token })
  c.status(res, 200)
  return res.json.data
}

// ============================================================
// 一、纯函数层（排程算法本身）
// ============================================================

m.test('单编：timeline/review.ts 可独立编译（零 import 契约）', async (c) => {
  try {
    compileCore()
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`
    throw new Error(`review.ts 单编失败（破坏了"零 import"契约）：${out.slice(0, 300)}`)
  }
  const p = path.join(TMP, 'review.js')
  c.ok(fs.existsSync(p), '编译产物不存在')
  R = await import(`file://${p.replace(/\\/g, '/')}`)
  for (const fn of ['buildReviewPlan', 'advanceReview', 'firstReviewAt', 'isDue', 'endOfLocalDay', 'canReview']) {
    c.ok(typeof R[fn] === 'function', `缺少导出 ${fn}`)
  }
})

m.test('间隔表 = [1,3,7,14,28]（改动必须有证据支撑，防手滑调参）', async (c) => {
  c.ok(Array.isArray(R.REVIEW_INTERVALS), 'REVIEW_INTERVALS 不是数组')
  c.eq(R.REVIEW_INTERVALS.join(','), '1,3,7,14,28',
    `间隔表被改动为 ${R.REVIEW_INTERVALS.join(',')} —— 依据见 GK-SRS-20b §4.3，改前请先改文档`)
  c.eq(R.REVIEW_STAGES, 5)
})

m.test('做对：档位 +1，按**新档位**的间隔等待', async (c) => {
  const now = new Date()
  const a = R.advanceReview({ review_count: 0 }, 'correct', now)
  c.eq(a.review_count, 1, '首次做对后档位应为 1')
  c.eq(daysFromNow(a.next_review_at, now), 3, '第 1 档做对后应等 3 天（不是 1 天）')

  const b = R.advanceReview({ review_count: 1 }, 'correct', now)
  c.eq(b.review_count, 2)
  c.eq(daysFromNow(b.next_review_at, now), 7, '第 2 档做对后应等 7 天')

  const d = R.advanceReview({ review_count: 3 }, 'correct', now)
  c.eq(daysFromNow(d.next_review_at, now), 28, '第 4 档做对后应等 28 天')
})

m.test('做对到顶：第 5 档毕业，next_review_at 置空', async (c) => {
  const now = new Date()
  const a = R.advanceReview({ review_count: 4 }, 'correct', now)
  c.eq(a.review_count, 5, '第 5 次做对后档位应为 5')
  c.eq(a.next_review_at, null, '毕业后不应再有到期时间（否则永远挂在待办里）')
  // 已经满档再点一次不得溢出
  const b = R.advanceReview({ review_count: 5 }, 'correct', now)
  c.eq(b.review_count, 5, '档位溢出（>5）')
  c.eq(b.next_review_at, null)
})

m.test('🔴 做错：档位归零 + 明天再来 + 记账 lapses', async (c) => {
  const now = new Date()
  const a = R.advanceReview({ review_count: 3, review_lapses: 1 }, 'wrong', now)
  c.eq(a.review_count, 0, '做错后档位必须归零（提取失败就不能按原间隔等）')
  c.eq(a.review_lapses, 2, '做错次数未记账')
  c.eq(daysFromNow(a.next_review_at, now), 1, '做错后应明天再来（1 天，不是立即重做）')
})

m.test('🔴 到期判定：昨天/今天/明天/未排程/已毕业 各自状态正确', async (c) => {
  const now = new Date()
  const base = { in_review_book: true, review_count: 1 }

  const y = R.buildReviewPlan({ ...base, next_review_at: isoDaysAgo(1) }, now)
  c.eq(y.status, 'due', '昨天的题应为 due')
  c.eq(y.overdue_days, 1, `逾期天数应为 1，实际 ${y.overdue_days}`)
  c.eq(y.days_until_due, 0)

  const td = R.buildReviewPlan({ ...base, next_review_at: new Date().toISOString() }, now)
  c.eq(td.status, 'due', '今天（当天任意时刻）都算到期')
  c.eq(td.overdue_days, 0, '今天到期不应算逾期')

  const tm = R.buildReviewPlan({ ...base, next_review_at: isoDaysAgo(-2) }, now)
  c.eq(tm.status, 'upcoming', '明天的题不应提前算到期')
  c.eq(tm.days_until_due, 2, `距到期应为 2 天，实际 ${tm.days_until_due}`)

  const un = R.buildReviewPlan({ ...base, next_review_at: null }, now)
  c.eq(un.status, 'unscheduled', '无到期时间应为 unscheduled')

  const gr = R.buildReviewPlan({ in_review_book: true, review_count: 5, next_review_at: null }, now)
  c.eq(gr.status, 'graduated', '满档且无到期时间应为 graduated')
  c.eq(gr.completed, true)

  const out = R.buildReviewPlan({ in_review_book: false, next_review_at: isoDaysAgo(3) }, now)
  c.eq(out.status, 'out', '不在复习本应为 out')
})

m.test('排程健壮性：脏数据不抛错（count 越界 / 非法日期 / 空对象）', async (c) => {
  const cases = [
    {},
    { review_count: -3, in_review_book: true },
    { review_count: 999, in_review_book: true },
    { review_count: NaN, in_review_book: true },
    { in_review_book: true, next_review_at: 'not-a-date' },
    { in_review_book: true, next_review_at: '2026-13-45T99:99:99Z' },
  ]
  for (const cs of cases) {
    let plan
    try {
      plan = R.buildReviewPlan(cs)
    } catch (e) {
      throw new Error(`脏数据 ${JSON.stringify(cs)} 抛错：${e.message}`)
    }
    c.ok(plan.review_count >= 0 && plan.review_count <= R.REVIEW_STAGES,
      `档位未 clamp 到 [0,${R.REVIEW_STAGES}]：${JSON.stringify(cs)} → ${plan.review_count}`)
    c.ok(Array.isArray(plan.schedule) && plan.schedule.length === R.REVIEW_STAGES, 'schedule 结构不全')
  }
})

m.test('canReview：不在本 / 已毕业 都不该再显示复习按钮', async (c) => {
  c.eq(R.canReview({ in_review_book: false, completed: false }), false)
  c.eq(R.canReview({ in_review_book: true, completed: true }), false)
  c.eq(R.canReview({ in_review_book: true, completed: false }), true)
})

// ============================================================
// 二、接口层（真实后端流转）
// ============================================================

m.test('🔴 加入复习本就排程（不再是「无排程、按加入时间排序」）', async (c) => {
  const item = await newQuestion(c, '排程：加入即排程检查')
  const add = await addToBook(c, item.id)
  c.status(add, 200)
  c.ok((add.json?.data?.scheduled ?? 0) >= 1, `新条目未被排程：${JSON.stringify(add.json?.data)}`)

  const d = await detail(c, item.id)
  c.ok(!!d.next_review_at, '加入复习本后 next_review_at 仍为空 —— 排程没落地，等于回到 C4 之前')
  const days = daysFromNow(d.next_review_at)
  c.ok(days === 0 || days === 1, `首次排程应在 1 天内（实际 ${days} 天）`)
  c.eq(d.review_count, 0, '新加入的题档位应为 0')
  c.ok(d.review_plan && d.review_plan.status === 'upcoming',
    `详情应附带 review_plan 且状态为 upcoming，实际 ${JSON.stringify(d.review_plan?.status)}`)
})

m.test('做对：接口推进档位并推后到期', async (c) => {
  const item = await newQuestion(c, '排程：做对推进')
  await addToBook(c, item.id)
  const res = await review(c, item.id, 'correct')
  c.status(res, 200, `复习提交失败：${res.text.slice(0, 200)}`)
  c.eq(res.json.data.review_count, 1, '做对后档位应为 1')
  c.eq(daysFromNow(res.json.data.next_review_at), 3, '做对后应等 3 天')
  const d = await detail(c, item.id)
  c.eq(d.review_count, 1, '档位未落库（只返回了没写库）')
  c.ok(!!d.last_reviewed_at, 'last_reviewed_at 未写入')
})

m.test('🔴 做错：接口回退到第 1 档（做对做错必须能区分）', async (c) => {
  const item = await newQuestion(c, '排程：做错回退')
  await addToBook(c, item.id)
  await review(c, item.id, 'correct')
  await review(c, item.id, 'correct')
  const before = await detail(c, item.id)
  c.eq(before.review_count, 2)

  const res = await review(c, item.id, 'wrong')
  c.status(res, 200)
  c.eq(res.json.data.review_count, 0, '做错后档位应归零')
  c.eq(res.json.data.review_lapses, 1, '做错次数未累加')
  c.eq(daysFromNow(res.json.data.next_review_at), 1, '做错后应明天再来')
})

m.test('参数校验：非法 result → 400（不得静默当成做对）', async (c) => {
  const item = await newQuestion(c, '排程：非法 result')
  await addToBook(c, item.id)
  const res = await review(c, item.id, 'maybe')
  c.status(res, 400, '非法 result 被接受了 —— 会把脏结果当成功推进档位')
  const d = await detail(c, item.id)
  c.eq(d.review_count, 0, '非法请求竟然改了档位')
})

m.test('兼容：不传 result 按做对处理（旧前端包仍可用）', async (c) => {
  const item = await newQuestion(c, '排程：旧客户端兼容')
  await addToBook(c, item.id)
  const res = await review(c, item.id, undefined)
  c.status(res, 200)
  c.eq(res.json.data.review_count, 1)
})

m.test('毕业：连续 5 次做对后不再排程，summary.graduated 增加', async (c) => {
  const idt = await c.ident('main')
  const before = await c.api('GET', '/timeline/review/summary', { token: idt.token })
  c.status(before, 200)
  const gradBefore = before.json.data.graduated

  const item = await newQuestion(c, '排程：走完五档')
  await addToBook(c, item.id)
  let last = null
  for (let i = 0; i < 5; i++) {
    const res = await review(c, item.id, 'correct')
    c.status(res, 200)
    last = res.json.data
  }
  c.eq(last.review_count, 5, '五次做对后应满档')
  c.eq(last.next_review_at, null, '毕业后仍有到期时间 —— 会永远挂在「今日待复习」里')
  c.eq(last.plan?.status, 'graduated')

  const after = await c.api('GET', '/timeline/review/summary', { token: idt.token })
  c.eq(after.json.data.graduated, gradBefore + 1, 'summary 的 graduated 未随毕业增加（缓存没失效？）')
})

m.test('🔴 到期过滤：未到期的题不该出现在 due 列表与 due_today 里', async (c) => {
  const idt = await c.ident('main')
  const item = await newQuestion(c, '排程：未到期不该冒出来')
  await addToBook(c, item.id)   // 排到 1 天后 ⇒ 今天不到期

  const dueList = await c.api('GET', '/timeline', { token: idt.token, query: { scope: 'review', due: '1', page_size: 100 } })
  c.status(dueList, 200)
  c.ok(!(dueList.json.data.list || []).some((x) => x.id === item.id),
    '明天才到期的题今天就出现在「今日该复习」里 —— due 过滤失效（会把待办雪崩造出来）')

  const sum = await c.api('GET', '/timeline/review/summary', { token: idt.token })
  c.status(sum, 200)
  const overdue = (dueList.json.data.list || []).length
  c.eq(sum.json.data.due_today, overdue,
    `summary.due_today(${sum.json.data.due_today}) 与 due 列表条数(${overdue}) 不一致 —— 两个数字必须同源`)
})

m.test('复习本排序：默认按到期先后（不再按加入时间）', async (c) => {
  const idt = await c.ident('main')
  const list = await c.api('GET', '/timeline', { token: idt.token, query: { scope: 'review', page_size: 50 } })
  c.status(list, 200)
  const rows = list.json.data.list || []
  const withDue = rows.filter((x) => x.next_review_at)
  let prev = -Infinity
  let okOrder = true
  for (const r of withDue) {
    const t = new Date(r.next_review_at).getTime()
    if (t < prev) okOrder = false
    prev = t
  }
  c.ok(okOrder, '复习本未按 next_review_at 升序 —— 分散练习要求「先复习最该复习的」')
  // 已毕业/未排程（null）必须垫底，不能插在中间
  const firstNull = rows.findIndex((x) => !x.next_review_at)
  if (firstNull >= 0) {
    c.ok(rows.slice(firstNull).every((x) => !x.next_review_at),
      '无到期时间的条目夹在到期条目中间（NULL 应垫底）')
  }
})

m.test('移出复习本即取消排程；再次加入恢复排程且保留档位', async (c) => {
  const idt = await c.ident('main')
  const item = await newQuestion(c, '排程：移出与再加回')
  await addToBook(c, item.id)
  await review(c, item.id, 'correct')

  const rm = await c.api('DELETE', '/timeline/review-book', { token: idt.token, body: { ids: [item.id] } })
  c.status(rm, 200)
  let d = await detail(c, item.id)
  c.eq(d.in_review_book, false)
  c.eq(d.next_review_at, null, '移出复习本后仍在排程里 —— 会继续占「今日待复习」的位')
  c.eq(d.review_count, 1, '移出复习本不该抹掉已走的档位（白费之前的复习）')

  await addToBook(c, item.id)
  d = await detail(c, item.id)
  c.ok(!!d.next_review_at, '再次加入后未重新排程')
  c.eq(d.review_count, 1, '再次加入把档位清零了')
})

m.test('重复加入不重置已有排程（否则反复勾选能把间隔锁死在最短档）', async (c) => {
  const item = await newQuestion(c, '排程：重复加入')
  await addToBook(c, item.id)
  await review(c, item.id, 'correct')     // 档位 1，下次 +3 天
  const first = (await detail(c, item.id)).next_review_at

  const again = await addToBook(c, item.id)
  c.status(again, 200)
  const second = (await detail(c, item.id)).next_review_at
  c.eq(second, first, '重复加入把到期时间重置了')
})

m.test('🔴 越权：B 无法对 A 的题提交复习', async (c) => {
  const item = await newQuestion(c, '排程：越权复习')
  await addToBook(c, item.id)
  const foe = await c.foe()
  const res = await c.api('POST', `/timeline/${item.id}/review`, { token: foe.token, body: { result: 'correct' } })
  c.ok([403, 404].includes(res.status), `他人竟能提交复习（${res.status}）`)
  const d = await detail(c, item.id)
  c.eq(d.review_count, 0, '他人提交竟然改了 A 的档位')
})

m.test('🔴 鉴权：新端点不带令牌一律 401', async (c) => {
  const sum = await c.api('GET', '/timeline/review/summary')
  c.status(sum, 401, '排程汇总免鉴权可达 —— 会泄露「这家人有多少错题」')
  const rev = await c.api('POST', '/timeline/not-a-real-id/review', { body: { result: 'correct' } })
  c.status(rev, 401)
})

m.test('summary 结构完整（三个计数各司其职）', async (c) => {
  const idt = await c.ident('main')
  const res = await c.api('GET', '/timeline/review/summary', { token: idt.token })
  c.status(res, 200)
  const d = res.json.data
  for (const k of ['in_book', 'due_today', 'unscheduled', 'graduated']) {
    c.ok(typeof d[k] === 'number', `缺少数值字段 ${k}`)
  }
  c.ok('next_due_at' in d, '缺少 next_due_at')
  c.ok(d.due_today <= d.in_book, `due_today(${d.due_today}) 不应大于 in_book(${d.in_book})`)
  c.ok(d.graduated <= d.in_book, 'graduated 不应大于 in_book')
})

m.test('详情附带 review_plan 与列值一致（前端不再自己算）', async (c) => {
  const item = await newQuestion(c, '排程：计划与列一致')
  await addToBook(c, item.id)
  await review(c, item.id, 'wrong')
  const d = await detail(c, item.id)
  c.ok(d.review_plan, '详情缺少 review_plan')
  c.eq(d.review_plan.review_count, d.review_count, 'plan.review_count 与列不一致')
  c.eq(d.review_plan.review_lapses, d.review_lapses, 'plan.review_lapses 与列不一致')
  c.eq(d.review_plan.next_review_at, new Date(d.next_review_at).toISOString(),
    'plan.next_review_at 与列不一致')
})

// ------------------------------------------------------------------
// 结果指标的可观测性（GK-OPS-22 §6）
//
// 为什么这里用**静态断言**而不是跑真实查询：
//   OPS-22 §6 规定唯一够格的结果指标是「到期首次作答正确率（按档位分组）」，
//   而它依赖 `review_events`（迁移 0021）——本地验证环境连的是远端 Supabase，
//   建表与否不该决定一条门能不能跑。真正会漂移的是**口径文本**，
//   所以把它们锁在源码与迁移文件里；落到数据上的部分留给出数时人工看（只报不拦）。
//
// ⚠️ 不写「文件存在」「字段非空」这类永真断言（OPS-22 §8 反模式）。
//    这两条分别锁死：口径的两个关键片段、埋点不阻断作答。
// ------------------------------------------------------------------
const MIGRATION_0021 = path.join(ROOT, 'migrations', '0021_review_events.sql')
const SERVICE_FILE = path.join(process.cwd(), 'src', 'timeline', 'timeline.service.ts')

m.test('结果指标口径：迁移里锁住「首次作答 + 排除提前作答」两个关键片段', (c) => {
  const txt = fs.readFileSync(MIGRATION_0021, 'utf8')
  // ① 同一次到期里只取最早一条 —— 少了它，孩子答错后重做会把正确率系统性高估
  c.ok(txt.includes('distinct on (item_id, due_on)'),
    '迁移 0021 缺少 distinct on (item_id, due_on)：会把重试也算成首次作答')
  // ② 只算「到期当天或之后」的作答 —— 少了它，提前复习也会进分母，L1 延迟前提被破坏
  c.ok(txt.includes("due_on <= (occurred_at at time zone 'Asia/Shanghai')::date"),
    '迁移 0021 缺少到期过滤：提前复习会被算进「到期作答」')
  // ③ 出数门槛写清楚，避免 3 条样本就说「机制有效」
  c.ok(/样本\s*<\s*30/.test(txt), '迁移 0021 未写明出数门槛（每档样本 < 30 的处置）')
})

m.test('埋点不得阻断作答：写入失败只记日志，不抛给前端', (c) => {
  const txt = fs.readFileSync(SERVICE_FILE, 'utf8')
  const seg = txt.slice(txt.indexOf("from('review_events')"))
  c.ok(seg.length > 0, 'timeline.service.ts 里找不到 review_events 写入（埋点被删了？）')
  const head = txt.slice(Math.max(0, txt.indexOf("from('review_events')") - 600), txt.indexOf("from('review_events')"))
  c.ok(head.includes('try {'), '埋点不在 try 里：一次插入失败就会让孩子刚做完的这次作答报错')
  const tail = seg.slice(0, 1500)
  c.ok(tail.includes('console.error'), '埋点失败必须记日志（否则「没出数」会被误判成「没人复习」）')
  // ⚠️ 先剥行注释再匹配：源码注释里讨论「不能空 catch」是正常且必要的，
  //    直接扫原文会把注释里的字样当成代码判失败（本次实测就撞上一次）。
  const codeOnly = tail.replace(/\/\/.*$/gm, '')
  c.ok(!/catch\s*\{\s*\}/.test(codeOnly), '禁空 catch：埋点失败需要留痕')
})

export default m
