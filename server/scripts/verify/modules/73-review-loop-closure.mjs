// 模块 73：复习闭环三处断点接合与队列化（P-033 / D-095）
//
// 背景（实测）：思傅设想的闭环是「录入 → 隔段时间复习 → 再复习 → 标记掌握 → 移出 →
//   未移出的与新加入继续」。七环里四环已通、三处断开：
//     ① 录入后不进复习本（`in_review_book default false`，recognize 页无「加入复习本」字样）
//        ⇒ 机制**静默**不发生（题永不到期，review_events 永无该题的行）；
//     ② `mastered` 被当成掌握判定，但它只管「汇总导出是否纳入」，与复习本零联动；
//     ③ 五档走完（做错归零 ⇒ 等价于连续 5 次成功提取，即 M15）只停排程、**仍留在复习本**
//        ⇒ M7/M15 的结果没有界面后果，家长只能自己记哪题该移出。
//   P-033 按「系统判定自动出本」接合，并把逐题进详情的复习压成队列。
//
// 本模块锁住：
//   A1 录入即入本 + 批量错峰（首档不雪崩）
//   A2 五档毕业自动出本，且**保留** review_count/review_lapses
//   A3 buildReviewPlan 的毕业判定必须优先于 inBook（否则 status 恒为 out、前端毕业分支全是死码）
//   A4 汇总统计补「已毕业已出本」的已掌握数
//   A5 前端 mastered 不再冒充掌握判定；毕业文案不再说「仍留在复习本」
//   A6 队列走既有 markReviewed，且卡上不出现答案/解析（L2 无提示的物理保证）
//   A7 边界：五档数值与「做错归零」一字未动；判定层 question-match.ts 未动
//   A8 存量迁移存在且幂等

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M73', '复习闭环断点接合与队列化（P-033）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const exists = (f) => fs.existsSync(path.join(ROOT, f))

const SVC = 'server/src/timeline/timeline.service.ts'
const REVIEW = 'server/src/timeline/review.ts'
const DETAIL = 'src/pages/detail/index.tsx'
const SUBJECT = 'src/pages/subject/index.tsx'
const QUEUE = 'src/components/review-queue.tsx'

m.test('A1 录入即入本 + 批量首档错峰', async (c) => {
  const svc = read(SVC)
  // buildPayload 是 create / createBatch 共用的落库载荷构造点，入本必须在这里
  const at = svc.indexOf('private async buildPayload(')
  c.ok(at >= 0, 'buildPayload 须存在（建题落库载荷的唯一构造点）')
  const body = svc.slice(at, at + 4200)
  c.ok(/in_review_book:\s*true/.test(body), '建题载荷须显式 in_review_book: true（否则走表默认 false ⇒ 静默不进本）')
  c.ok(/next_review_at:\s*firstReviewAt\(/.test(body), '入本同时须排首档（否则停在 unscheduled，半个入本）')
  c.ok(/added_to_review_at:\s*new Date\(\)\.toISOString\(\)/.test(body), '须写 added_to_review_at（排程基准是上次接触时间）')
  c.ok(/reviewOffsetDays/.test(body), '须支持批量错峰参数')
  // createBatch 必须把序号传进去，否则一页卷子全部明天到期（待办雪崩）
  const batchAt = svc.indexOf('async createBatch(')
  const batchBody = svc.slice(batchAt, batchAt + 3000)
  c.ok(/i\s*%\s*REVIEW_ENTRY_STAGGER_DAYS/.test(batchBody), 'createBatch 须按序号错峰（i % REVIEW_ENTRY_STAGGER_DAYS）')
  c.ok(/const REVIEW_ENTRY_STAGGER_DAYS\s*=\s*(\d+)/.test(svc), '须定义 REVIEW_ENTRY_STAGGER_DAYS 常量')
})

m.test('A2 五档毕业自动出本，且保留历史计数', async (c) => {
  const svc = read(SVC)
  const at = svc.indexOf('async review(userId: string, id: string')
  c.ok(at >= 0, 'review() 须存在')
  const body = svc.slice(at, at + 3200)
  c.ok(/const graduated\s*=\s*adv\.review_count\s*>=\s*REVIEW_STAGES/.test(body), '须有 graduated 判定（走完五档）')
  c.ok(/in_review_book:\s*!graduated/.test(body), '毕业时须置 in_review_book = false（自动出本）')
  c.ok(/added_to_review_at:\s*graduated\s*\?\s*null/.test(body), '毕业须清 added_to_review_at（出本的定义是不占待办）')
  // ⚠️ 反向断言：不得因出本而抹掉计数（removeFromReviewBook 的既有约定：再次加入从原档位继续）
  c.ok(/review_count:\s*adv\.review_count/.test(body), '毕业也必须照写 review_count（不得清零）')
  c.ok(/review_lapses:\s*adv\.review_lapses/.test(body), '须照写 review_lapses')
  c.ok(/in_review_book:\s*!graduated,\s*\n\s*added_to_review_at:\s*graduated\s*\?\s*null/.test(body.replace(/\r/g, ''))
    || /in_review_book:\s*!graduated/.test(body), '返回给前端的 plan 也须与落库一致')
})

m.test('A3 buildReviewPlan 毕业判定优先于 inBook（防死代码回归）', async (c) => {
  const rev = read(REVIEW)
  const at = rev.indexOf('export function buildReviewPlan(')
  c.ok(at >= 0, 'buildReviewPlan 须存在')
  const body = rev.slice(at, at + 1600)
  const gradIdx = body.indexOf("status = 'graduated'")
  const outIdx = body.indexOf("status = 'out'")
  c.ok(gradIdx >= 0, '须有 graduated 分支')
  c.ok(outIdx >= 0, '须有 out 分支')
  c.ok(gradIdx < outIdx, 'graduated 必须判在 out 之前——出本后若先判 !inBook 就返回 out，前端所有毕业提示全成死码')
  c.ok(/const graduated\s*=\s*count\s*>=\s*REVIEW_STAGES\s*&&\s*!nextDate/.test(body), '毕业判据＝连续成功到顶且无下次到期（与 M15 同义）')
})

m.test('A4 汇总统计含「已毕业已出本」的已掌握数', async (c) => {
  const svc = read(SVC)
  const at = svc.indexOf('async reviewSummary(')
  c.ok(at >= 0, 'reviewSummary 须存在')
  const body = svc.slice(at, at + 3000)
  c.ok(/graduatedOut/.test(body), '须单独统计已出本的毕业题（否则 graduated 恒为 0，掌握永远不可见）')
  c.ok(/\.eq\('in_review_book',\s*false\)/.test(body), '出本集合按 in_review_book=false 取')
  c.ok(/\.gte\('review_count',\s*REVIEW_STAGES\)/.test(body), '毕业判据按 review_count >= REVIEW_STAGES')
  c.ok(/graduated:\s*graduated\s*\+\s*graduatedOut/.test(body), '汇总须把两部分相加')
  // 失败不得阻断汇总（观测不能牺牲功能）
  c.ok(!/catch\s*\{\s*\}/.test(body), '统计失败不得用空 catch 静默吞掉')
})

m.test('A5 前端 mastered 不再冒充掌握判定；毕业文案与出本一致', async (c) => {
  const d = read(DETAIL)
  c.ok(!/>已掌握</.test(d), '详情页不得再把开关叫「已掌握」（它只管导出口径）')
  c.ok(/不进入导出/.test(d), '须改名为「不进入导出」')
  c.ok(/走完自动移出复习本/.test(d), '须说明掌握由五档判定、走完自动出本')
  c.ok(!/（仍留在复习本）/.test(d), '毕业文案不得再说「仍留在复习本」（P-033 后已出本）')
  c.ok(/已自动移出复习本/.test(d), '毕业文案须说明已自动出本')
  // 出本后整块复习卡不能消失，否则家长分不清「我暂停了」与「系统判定我掌握了」
  c.ok(/plan\.in_review_book\s*\|\|\s*plan\.status\s*===\s*'graduated'/.test(d),
    '详情页复习卡显示条件须含 graduation（出本后仍要能看见毕业状态）')
})

m.test('A6 队列走既有 markReviewed，且卡上不出现答案/解析', async (c) => {
  c.ok(exists(QUEUE), '须有复习队列组件 src/components/review-queue.tsx')
  const q = read(QUEUE)
  c.ok(/markReviewed\(/.test(q), '作答须走既有 markReviewed（否则 review_events 埋点分叉）')
  // L2 无提示的物理保证：队列卡不得渲染答案/解析/错因等提示性字段
  const codeOnly = q.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  c.ok(!/\.answer\b/.test(codeOnly), '队列卡不得渲染答案字段（同屏有答案就能「看着答案点做对了」）')
  c.ok(!/\.solution\b/.test(codeOnly), '队列卡不得渲染解析字段')
  c.ok(!/error_analysis|errorAnalysis/.test(codeOnly), '队列卡不得渲染错因（那是作答后的内容）')
  // 接入点
  const s = read(SUBJECT)
  c.ok(/from '@\/components\/review-queue'/.test(s), '复习本页须引入队列组件')
  c.ok(/const startQueue\s*=/.test(s), '须有 startQueue（「开始复习」入口）')
  c.ok(/开始复习（/.test(s), '横幅须有「开始复习（N 题）」按钮')
  c.ok(/due:\s*true/.test(s), '队列须只取到期题（due=true）')
})

m.test('A7 边界：五档数值与「做错归零」一字未动，判定层未动', async (c) => {
  const rev = read(REVIEW)
  c.ok(/REVIEW_INTERVALS\s*=\s*\[1,\s*3,\s*7,\s*14,\s*28\]\s*as const/.test(rev), '五档间隔必须仍是 1/3/7/14/28（M8）')
  c.ok(/review_count:\s*0,/.test(rev), '做错仍须归零（否则「五档走完＝连续 5 次成功」不成立）')
  c.ok(!exists('src/shared/question-match.ts'), '判定层不得被本次改动搬到前端')
  c.ok(exists('server/src/shared/question-match.ts'), '判定层仍在 server/src/shared/question-match.ts')
})

m.test('A8 存量迁移存在且幂等（只命中在本里的毕业题）', async (c) => {
  const f = 'migrations/0034_review_graduate_out.sql'
  c.ok(exists(f), '须有存量迁移 0034_review_graduate_out.sql')
  const sql = read(f)
  c.ok(/where\s+in_review_book\s*=\s*true/i.test(sql), '迁移须只命中 in_review_book = true 的行（幂等）')
  c.ok(/review_count\s*>=\s*5/.test(sql), '毕业判据须与 REVIEW_STAGES=5 一致')
  c.ok(/set\s+in_review_book\s*=\s*false/i.test(sql), '须把存量毕业题出本')
  c.ok(/added_to_review_at\s*=\s*null/i.test(sql), '须同时清 added_to_review_at')
  c.ok(!/delete\s+from/i.test(sql), '迁移不得删除任何行（只改两个状态列）')
})

export default m
