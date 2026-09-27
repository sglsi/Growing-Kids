/**
 * Phase 2 后续：智能高清（SR）服务端限流 + 排队 动态测试。
 *
 * 依据压测结论（1 核 1600×1200）：x3/x4/espcn 为 CPU 密集重任务，需并发闸 + 用户配额保护。
 * 验证：
 *  ① 任务分级 classifySr（x2-classical 轻 / x3-x4-espcn 重 / cost 档位）
 *  ② 全局并发闸 SrGate（额度、排队、FIFO、权重计费、超时、队列满、额度不泄漏）
 *  ③ 用户配额 SrUserQuota（每分钟上限、同时进行数、用户隔离、释放）
 *  ④ 源码一致性：service 接入闸、controller 429/503 映射、前端降级、env 齐全
 * 运行：cd push-ready/server && npx tsx /workspace/dynamic-tests/run-image-v6.ts
 */
import * as fs from 'fs'
import {
  classifySr, SrGate, SrUserQuota, srGateEnabled,
} from '../server/src/image/sr-gate'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`) }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // ============ ① 任务分级 ============
  console.log('[1] classifySr 任务分级')
  {
    const a = classifySr(2, 'classical')
    ok('x2-classical → 轻任务/light/cost1', !a.heavy && a.lane === 'light' && a.cost === 1, JSON.stringify(a))

    const b = classifySr(3, 'classical')
    ok('x3-classical → 重/heavy/cost2', b.heavy && b.lane === 'heavy' && b.cost === 2, JSON.stringify(b))

    const c = classifySr(4, 'classical')
    ok('x4-classical → 重/heavy/cost3', c.heavy && c.lane === 'heavy' && c.cost === 3, JSON.stringify(c))

    const d = classifySr(2, 'espcn')
    ok('x2-espcn → 重/heavy/cost3', d.heavy && d.lane === 'heavy' && d.cost === 3, JSON.stringify(d))

    const e = classifySr(4, 'espcn')
    ok('x4-espcn → 重/heavy/cost3', e.heavy && e.lane === 'heavy' && e.cost === 3, JSON.stringify(e))
  }

  // ============ ② 全局并发闸 ============
  console.log('[2] SrGate 并发闸')
  {
    process.env.IMG_SR_CONCURRENCY_HEAVY = '1'
    process.env.IMG_SR_CONCURRENCY_LIGHT = '2'
    process.env.IMG_SR_QUEUE_MAX = '8'
    process.env.IMG_SR_QUEUE_TIMEOUT_MS = '5000'

    const g = new SrGate()
    const r1 = await g.acquire(1, 'heavy')
    ok('heavy 首个请求立即通过', r1.ok === true, JSON.stringify(r1))
    ok('stats.runningHeavyCost=1', g.stats().runningHeavyCost === 1)

    // 第二个 heavy 应排队（额度 1 已占满）
    let r2done = false
    const p2 = g.acquire(1, 'heavy').then((r) => { r2done = true; return r })
    await sleep(30)
    ok('heavy 第二个请求排队（未立即通过）', !r2done && g.stats().queued === 1)

    g.release(1, 'heavy')
    const r2 = await p2
    ok('release 后队首被唤醒并执行', r2.ok === true && r2done, JSON.stringify(r2))
    ok('唤醒后 runningHeavyCost=1', g.stats().runningHeavyCost === 1)
    g.release(1, 'heavy')
    ok('全部 release 后 runningHeavyCost=0', g.stats().runningHeavyCost === 0)

    // 权重计费：cost=3 占满 heavy（limit=1）后，cost=1 也必须排队
    process.env.IMG_SR_CONCURRENCY_HEAVY = '3'
    const g2 = new SrGate()
    const w1 = await g2.acquire(3, 'heavy')
    ok('cost=3 占满额度', w1.ok === true && g2.stats().runningHeavyCost === 3)
    let w2done = false
    const wp2 = g2.acquire(1, 'heavy').then((r) => { w2done = true; return r })
    await sleep(30)
    ok('额度满时 cost=1 也排队（权重计费生效）', !w2done)
    g2.release(3, 'heavy')
    const w2 = await wp2
    ok('release cost=3 后 cost=1 进入', w2.ok === true)
    g2.release(1, 'heavy')

    // 轻任务走独立泳道，不受 heavy 阻塞
    const g3 = new SrGate()
    process.env.IMG_SR_CONCURRENCY_HEAVY = '1'
    await g3.acquire(1, 'heavy')
    const l1 = await g3.acquire(1, 'light')
    ok('heavy 占用时 light 泳道仍可用', l1.ok === true, JSON.stringify(l1))
    g3.release(1, 'heavy'); g3.release(1, 'light')

    // 排队超时
    process.env.IMG_SR_QUEUE_TIMEOUT_MS = '60'
    const g4 = new SrGate()
    process.env.IMG_SR_CONCURRENCY_HEAVY = '1'
    await g4.acquire(1, 'heavy')
    const t0 = Date.now()
    const tr = await g4.acquire(1, 'heavy', { timeoutMs: 60 })
    ok('排队超时 → timeout', tr.ok === false && tr.reason === 'timeout', JSON.stringify(tr))
    ok('超时等待时长 ≈ 设定值', tr.waitedMs! >= 55 && Date.now() - t0 < 500, `waited=${tr.waitedMs}ms`)
    ok('超时后 queued 归零', g4.stats().queued === 0)
    g4.release(1, 'heavy')

    // 队列满
    process.env.IMG_SR_QUEUE_MAX = '2'
    process.env.IMG_SR_QUEUE_TIMEOUT_MS = '5000'
    const g5 = new SrGate()
    process.env.IMG_SR_CONCURRENCY_HEAVY = '1'
    await g5.acquire(1, 'heavy') // 占用，后续全部入队
    const q1 = g5.acquire(1, 'heavy')
    const q2 = g5.acquire(1, 'heavy')
    const q3 = await g5.acquire(1, 'heavy') // 第 3 个 → 超队列上限
    ok('队列满 → queue_full', q3.ok === false && q3.reason === 'queue_full', JSON.stringify(q3))
    g5.release(1, 'heavy')
    await Promise.all([q1, q2])

    // 额度不泄漏：异常后 reset 归零（模拟 finally release）
    const g6 = new SrGate()
    await g6.acquire(2, 'heavy')
    g6.release(2, 'heavy')
    ok('异常/正常路径 release 后归零', g6.stats().runningHeavyCost === 0 && g6.stats().runningLight === 0)

    // stats.rejected 统计
    ok('rejected 计数（超时+队列满）', g4.stats().rejected >= 1 || g5.stats().rejected >= 1)

    // ★ 回归（生产级致命场景）：cost > 配置额度 不得死锁
    //   真实默认 IMG_SR_CONCURRENCY_HEAVY=1，而 x3/x4/espcn 的 cost=2/3，
    //   若门槛不取 max(limit, cost)，这些任务会 100% 永远排队到超时被拒。
    process.env.IMG_SR_CONCURRENCY_HEAVY = '1'
    process.env.IMG_SR_QUEUE_TIMEOUT_MS = '200'
    const g7 = new SrGate()
    const c3a = await g7.acquire(3, 'heavy') // x4/espcn，cost=3 > limit=1
    ok('cost>limit 时首个重任务仍能进闸（不死锁）', c3a.ok === true && g7.stats().runningHeavyCost === 3, JSON.stringify(c3a))
    // 占满后第二个必须排队（而非并行放大负载）
    let heavy2done = false
    const hp2 = g7.acquire(2, 'heavy').then((r) => { heavy2done = true; return r })
    await sleep(30)
    ok('cost=3 在跑时 cost=2 排队（不并发放大）', !heavy2done)
    g7.release(3, 'heavy')
    const c2after = await hp2
    ok('释放后排队者进入', c2after.ok === true, JSON.stringify(c2after))
    g7.release(2, 'heavy')
    ok('全部释放后归零', g7.stats().runningHeavyCost === 0)
  }

  // ============ ③ 用户配额 ============
  console.log('[3] SrUserQuota 用户配额')
  {
    process.env.IMG_SR_USER_RATE = '3'
    process.env.IMG_SR_USER_CONCURRENT = '1'
    const q = new SrUserQuota()

    const c1 = q.check('u1')
    ok('首次通过', c1.ok === true)
    const c2 = q.check('u1')
    ok('同用户并发第 2 次 → SR_USER_BUSY', c2.ok === false && c2.code === 'SR_USER_BUSY', JSON.stringify(c2))

    q.releaseUser('u1')
    const c3 = q.check('u1')
    ok('release 后可再次通过', c3.ok === true)

    // 不同用户互不影响
    const cOther = q.check('u2')
    ok('不同用户互不影响', cOther.ok === true)

    // 每分钟上限：u1 已用 2 次（c1、c3），再 1 次到 3，第 4 次拒绝
    q.releaseUser('u1')
    q.check('u1') // 3
    q.releaseUser('u1')
    const c4 = q.check('u1') // 4 > 3
    ok('超过每分钟上限 → SR_RATE_LIMIT', c4.ok === false && c4.code === 'SR_RATE_LIMIT', JSON.stringify(c4))
    ok('限流附带 retryAfterMs', !c4.ok && c4.retryAfterMs > 0, !c4.ok ? `${c4.retryAfterMs}ms` : '')

    // sweep 清理
    q.sweep(Date.now() + 120_000)
    ok('sweep 过期窗口不抛', true)
  }

  // ============ ④ 源码一致性 ============
  console.log('[4] 源码一致性')
  {
    const svc = fs.readFileSync('/workspace/projects/server/src/image/image.service.ts', 'utf8')
    const ctrl = fs.readFileSync('/workspace/projects/server/src/image/image.controller.ts', 'utf8')
    const gate = fs.readFileSync('/workspace/projects/server/src/image/sr-gate.ts', 'utf8')
    const editor = fs.readFileSync('/workspace/projects/src/components/image-editor.tsx', 'utf8')
    const api = fs.readFileSync('/workspace/projects/src/services/api.ts', 'utf8')

    ok('service 导入 sr-gate', /from '\.\/sr-gate'/.test(svc))
    ok('service 用 classifySr', /classifySr\(scale, mode\)/.test(svc))
    ok('service 用户配额检查', /srUserQuota\.check\(userId\)/.test(svc))
    ok('service 过闸 acquire', /srGate\.acquire\(/.test(svc))
    ok('service finally release', /srGate\.release\(/.test(svc) && /finally/.test(svc))
    ok('service releaseUser 兜底', /srUserQuota\.releaseUser\(userId\)/.test(svc))
    ok('service 429 抛出', /HttpStatus\.TOO_MANY_REQUESTS/.test(svc))
    ok('service 503 抛出', /HttpStatus\.SERVICE_UNAVAILABLE/.test(svc))
    ok('service code=SR_QUEUE_TIMEOUT', /SR_QUEUE_TIMEOUT/.test(svc))
    ok('service suggest x2', /suggest: \{ scale: 2, mode: 'classical' \}/.test(svc))

    ok('controller 含限流豁免', /isRateLimitError/.test(ctrl) && /429 \|\| status === 503/.test(ctrl))

    ok('gate 导出 classifySr', /export function classifySr/.test(gate))
    ok('gate 导出 SrGate', /export class SrGate/.test(gate))
    ok('gate 导出 SrUserQuota', /export class SrUserQuota/.test(gate))
    ok('gate 含泳道与权重', /runningHeavyCost/.test(gate) && /lane/.test(gate))
    ok('gate 开关 IMG_SR_GATE', /IMG_SR_GATE/.test(gate))

    ok('前端 ApiError 携带 status/code', /export class ApiError/.test(api) && /this\.status = status/.test(api))
    ok('前端降级处理函数', /handleSrRateLimit/.test(editor))
    ok('前端 429/503 分支', /e\.status === 429/.test(editor) && /e\.status === 503/.test(editor))
    ok('前端降级重试一次（防循环）', /degradedRetry/.test(editor))
    ok('前端读取 suggest', /suggest\?\.scale/.test(editor))
  }

  // ============ ⑤ env 清单 ============
  console.log('[5] 环境变量齐全')
  {
    const gate = fs.readFileSync('/workspace/projects/server/src/image/sr-gate.ts', 'utf8')
    for (const k of ['IMG_SR_CONCURRENCY_LIGHT', 'IMG_SR_CONCURRENCY_HEAVY', 'IMG_SR_QUEUE_MAX', 'IMG_SR_QUEUE_TIMEOUT_MS', 'IMG_SR_USER_RATE', 'IMG_SR_USER_CONCURRENT', 'IMG_SR_GATE']) {
      ok(`含 ${k}`, gate.includes(k))
    }
    ok('srGateEnabled 默认 on', srGateEnabled() === true || (process.env.IMG_SR_GATE || 'on') === 'off')
  }

  console.log(`\n==== 结果：${pass} passed, ${fail} failed ====`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
