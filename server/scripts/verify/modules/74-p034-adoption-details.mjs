// 模块 74：P-034 暂停语义与采纳层细部修正（D-096）
//
// 锁住 P-034 §3 的落地：
//   A1 迁移 0035（暂停列 + 档数设置列 + 幂等 + 约束 2/5）
//   A2 后端：暂停/恢复/已暂停/档数读写端点齐全，且暂停不写 review_events
//   A3 后端：档数默认 5、非法回退、毕业判定与汇总统计都按 stages（非写死裸数字）
//   A4 前端：错因只在「做错了」之后问、可跳过；作答卡仍不持有提示数据（M73 A6 边界延续）
//   A5 前端：暂停入口/恢复面板/档数切换/挂起提示都在；今日进度只陈述事实
//   A6 边界：间隔表 1/3/7/14/28 未动、做错归零未动、判定层未动、无连续天数/徽章
//   A7 禁令：未点题不得默认按做对（review_events 写入点仍在 review() 内、按真实 result）

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M74', 'P-034 暂停语义与采纳层细部（D-096）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const exists = (f) => fs.existsSync(path.join(ROOT, f))

const REVIEW = 'server/src/timeline/review.ts'
const SVC = 'server/src/timeline/timeline.service.ts'
const CTRL = 'server/src/timeline/timeline.controller.ts'
const API = 'src/services/api.ts'
const QUEUE = 'src/components/review-queue.tsx'
const PICKER = 'src/components/review-mistake-picker.tsx'
const SUBJECT = 'src/pages/subject/index.tsx'

m.test('A1 迁移 0035：暂停列 + 档数列 + 幂等 + 2/5 约束', async (c) => {
  const f = 'migrations/0035_pause_and_graduate_stages.sql'
  c.ok(exists(f), '须有迁移 0035')
  const sql = read(f)
  c.ok(/add column if not exists review_paused/i.test(sql), '须加 review_paused 列（幂等）')
  c.ok(/add column if not exists review_paused_at/i.test(sql), '须加 review_paused_at（恢复排序基准）')
  c.ok(/add column if not exists review_graduate_stages/i.test(sql), 'users 须加毕业档数列')
  c.ok(/default\s+5/i.test(sql), '档数默认 5（标准档，与 M15 一致）')
  c.ok(/in\s*\(2,\s*5\)/i.test(sql), '档数约束只许 2/5')
  c.ok(!/delete\s+from/i.test(sql), '迁移不得删行')
})

m.test('A2 后端端点齐全 + 暂停不写 review_events', async (c) => {
  const ctrl = read(CTRL)
  for (const ep of ["Get('review/paused')", "Post('review/paused')", "Delete('review/paused')",
    "Get('review/stages')", "Put('review/stages')"]) {
    c.ok(ctrl.includes(ep), `须有端点 ${ep}`)
  }
  const svc = read(SVC)
  const pauseAt = svc.indexOf('async pauseFromReviewBook(')
  c.ok(pauseAt >= 0, '须有 pauseFromReviewBook')
  const pauseBody = svc.slice(pauseAt, pauseAt + 1600)
  c.ok(/review_paused:\s*true/.test(pauseBody), '暂停须写 review_paused=true')
  c.ok(!/review_events/.test(pauseBody), '暂停路径不得写 review_events（不是作答，不进正确率分母）')
  const restoreBody = svc.slice(svc.indexOf('async restorePaused('), svc.indexOf('async restorePaused(') + 2200)
  c.ok(/review_paused:\s*false/.test(restoreBody), '恢复须清暂停标记')
  c.ok(/firstReviewAt\(\)/.test(restoreBody), '恢复滞留过期的题须重排（与入本错峰同理）')
  // 已暂停列表必须带 user 隔离
  const listBody = svc.slice(svc.indexOf('async listPaused('), svc.indexOf('async listPaused(') + 900)
  c.ok(/\.eq\('user_id',\s*userId\)/.test(listBody), '已暂停列表须带 user_id 隔离（无 RLS）')
})

m.test('A3 档数：默认5 + 非法回退 + 判定/统计都按 stages', async (c) => {
  const rev = read(REVIEW)
  c.ok(/export type GraduateStages\s*=\s*2\s*\|\s*5/.test(rev), '档数类型须是 2|5')
  c.ok(/normalizeGraduateStages/.test(rev), '须有非法值回退函数')
  c.ok(/n === 2 \? 2 : 5/.test(rev), '非法值须回退标准 5')
  const svc = read(SVC)
  c.ok(/async graduateStages\(/.test(svc), 'service 须有档数读取（失败降级 5）')
  c.ok(/async setGraduateStages\(/.test(svc), 'service 须有档数写入')
  c.ok(/value !== 2 && value !== 5/.test(svc), '写入须拒绝非法值（BadRequest，不静默回退）')
  // 毕业判定与汇总统计都按 stages，不能写死 5
  c.ok(/const stages = await this\.graduateStages\(userId\)/.test(svc), 'review() 须按用户档数')
  const sumAt = svc.indexOf('async reviewSummary(')
  c.ok(/const stages = await this\.graduateStages\(userId\)/.test(svc.slice(sumAt, sumAt + 500)), '汇总须按用户档数')
})

m.test('A4 错因只在做错后问 + 作答卡不持有提示（M73 A6 延续）', async (c) => {
  c.ok(exists(PICKER), '须有独立错因选择器组件')
  const q = read(QUEUE)
  c.ok(/ReviewMistakePicker/.test(q), '队列须引入错因选择器')
  c.ok(/pickingFor/.test(q), '须有 pickingFor 状态（只在做错后置位）')
  // 做对直接提交、做错才进入选择——两条分支都要在
  c.ok(/commitAnswer\('correct',\s*null\)/.test(q), '做对须直接提交（不弹错因）')
  c.ok(/setPickingFor\(cur\.id\)/.test(q), '做错才置 pickingFor')
  // 选项可跳过（onPick(null) 也能落库）
  c.ok(/onPick=\{\(choice\)\s*=>\s*void commitAnswer\('wrong',\s*choice\)\}/.test(q), '错因选择须统一走 commitAnswer（可 null 跳过）')
  // 作答卡本体仍不得有提示字段（与 M73 A6 同口径）
  const codeOnly = q.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  c.ok(!/\.answer\b/.test(codeOnly), '作答卡不得渲染答案')
  c.ok(!/\.solution\b/.test(codeOnly), '作答卡不得渲染解析')
  c.ok(!/error_analysis|errorAnalysis/.test(codeOnly), '作答卡不得直接持有错因字段（经 label prop 投影）')
  const p = read(PICKER)
  c.ok(/existingLabel/.test(p), '选择器只收展示名，不收整段错因对象')
  c.ok(/跳过/.test(p), '须有跳过入口')
})

m.test('A5 前端：暂停/恢复/档数/挂起提示 + 只陈述事实', async (c) => {
  const s = read(SUBJECT)
  c.ok(/handleMorePause/.test(s), '更多操作须有暂停入口')
  c.ok(/暂停这题/.test(s), '暂停文案须与移出区分')
  c.ok(/openPaused/.test(s) && /restore\(/.test(s), '须有已暂停入口与恢复')
  c.ok(/changeStages/.test(s), '须有档数切换')
  c.ok(/sum\.stale/.test(s) && /sum\.paused/.test(s), '横幅须显示挂起与暂停数')
  // M11 边界：不得出现施压/承诺话术
  c.ok(!/最佳时间|快来复习|坚持打卡/.test(s), '不得出现施压话术（M11 只许陈述事实）')
  const api = read(API)
  for (const fn of ['pauseFromReviewBook', 'restorePaused', 'fetchPaused', 'fetchGraduateStages', 'setGraduateStages', 'recordMistakeReason']) {
    c.ok(new RegExp(`function ${fn}\\(`).test(api), `api 须有 ${fn}`)
  }
})

m.test('A6 边界：间隔表/归零/判定层未动 + 无连续天数徽章', async (c) => {
  const rev = read(REVIEW)
  c.ok(/REVIEW_INTERVALS\s*=\s*\[1,\s*3,\s*7,\s*14,\s*28\]\s*as const/.test(rev), '间隔表必须仍是 1/3/7/14/28（M8）')
  c.ok(/review_count:\s*0,/.test(rev), '做错仍须归零')
  c.ok(exists('server/src/shared/question-match.ts'), '判定层仍在原位')
  // 去注释后再查：文件头有「不做连续天数」的禁用声明，那是纪律不是功能，不能误伤
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const q = stripComments(read(QUEUE)) + stripComments(read(SUBJECT))
  c.ok(!/连续天数|打卡|徽章|成长值|streak/i.test(q), '不得做连续天数/徽章（M3 挤出效应）')
})

m.test('A7 未点题不得默认按做对（唯一指标红线）', async (c) => {
  const svc = read(SVC)
  const at = svc.indexOf('async review(')
  const body = svc.slice(at, at + 4200)
  c.ok(/from\('review_events'\)/.test(body), 'review_events 写入点仍须在 review() 内')
  c.ok(/result,\s*\n/.test(body) || /result: result/.test(body) || /^\s*result,/m.test(body), '写入的 result 须来自真实作答参数，不得写死 correct')
  // 挂起统计只读、不写事件
  const sumAt = svc.indexOf('async reviewSummary(')
  c.ok(!/review_events/.test(svc.slice(sumAt, sumAt + 6500)), '挂起统计路径不得写 review_events')
  const p = read('docs/design/method/proposals/P-034-暂停语义与采纳层细部修正.md')
  c.ok(/明确反对|默认按对/.test(p), '提案须留痕「拒绝未点默认按做对」的判断')
})

export default m
