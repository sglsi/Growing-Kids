// 模块 01：鉴权与身份隔离
//
// 这里覆盖的是**安全红线**，不是普通功能点。每条用例都对应一个真实事故：
//   · 裸 X-User-Id 可伪造     → R-技术-09
//   · 健康拨测被 401 误判后端挂 → R-技术-12
//   · 会话越权读              → v3 事故

import { Module } from '../lib/harness.mjs'

const m = new Module('M01', '鉴权与身份隔离')

m.test('引导路由用 X-Device-Id 换到身份令牌', async (c) => {
  const id = await c.ident('main')
  c.ok(!!id.token, '未回传 auth_token')
  c.ok(!!id.userId, '未回传 user_id')
  c.ok(/^v1\.[0-9a-f-]{36}\.\d+\.[0-9a-f]+$/.test(id.token), `令牌格式异常：${id.token}`)
})

m.test('同一设备重复引导得到同一匿名身份（幂等）', async (c) => {
  const a = await c.ident('main')
  const res = await c.api('POST', '/auth/anonymous', { device: a.deviceId })
  c.status(res, 200)
  c.eq(res.json?.data?.user_id, a.userId, '同一 device 换出了不同的 user_id')
})

m.test('不同设备得到不同身份', async (c) => {
  const a = await c.ident('main')
  const b = await c.foe()
  c.ok(a.userId !== b.userId, '两个 device 撞到了同一个 user_id')
})

m.test('业务路由完全不带身份 → 401', async (c) => {
  const res = await c.api('GET', '/timeline')
  c.status(res, [401, 403], '匿名访问业务路由应被拒')
})

m.test('🔴 裸 X-User-Id（严格模式）必须不被采信 → 401', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('GET', '/timeline', { userId: id.userId })
  c.status(res, [401, 403], '裸 X-User-Id 被放行了，等于任何人可伪造身份读写他人数据')
})

m.test('🔴 伪造的 X-Auth-Token 验签失败 → 401（不得回退）', async (c) => {
  const res = await c.api('GET', '/timeline', { token: c.forgedToken() })
  c.status(res, [401, 403], '验签失败却放行了，等于令牌机制形同虚设')
})

m.test('有效令牌访问 /auth/me → 200 且身份一致', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('GET', '/auth/me', { token: id.token })
  c.status(res, 200)
  c.eq(res.json?.data?.id, id.userId, 'me 返回的不是本人')
})

m.test('🔴 /api/health 不带令牌必须 200（否则巡检误判后端已挂）', async (c) => {
  for (const p of ['/health', '/health/runtime']) {
    const res = await c.api('GET', p)
    c.status(res, 200, `${p} 被鉴权拦住了，拨测会触发无意义重启`)
  }
})

m.test('🔴 /api/auth/logout 不带令牌必须 200（公开路由）', async (c) => {
  const res = await c.api('POST', '/auth/logout')
  c.status(res, 200, 'logout 不应要求身份')
})

m.test('响应头回传 X-Auth-Token（H5 扫码登录续签依赖）', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('GET', '/auth/me', { token: id.token })
  // 令牌已有效时不强制续签，仅当存在时校验格式
  const t = res.headers['x-auth-token']
  if (t) c.ok(t.startsWith('v1.'), `回传令牌格式异常：${t}`)
})

m.test('🔴 越权：A 拿不到 B 的学科（.eq(user_id) 生效）', async (c) => {
  const a = await c.ident('main')
  const b = await c.foe()
  const created = await c.api('POST', '/subjects', { token: a.token, body: { name: '越权测试-主' } })
  c.status(created, 200)
  const stolen = await c.api('GET', '/subjects', { token: b.token })
  c.status(stolen, 200)
  const names = (stolen.json?.data || []).map((s) => s.name)
  c.ok(!names.includes('越权测试-主'), `B 看到了 A 的数据：${names.join(',')}`)
  // 清理
  await c.api('DELETE', `/subjects/${created.json?.data?.id}`, { token: a.token })
})

m.test('🔴 越权：删除他人学科 → 成功响应但删 0 行', async (c) => {
  const a = await c.ident('main')
  const b = await c.foe()
  const created = await c.api('POST', '/subjects', { token: a.token, body: { name: '越权删除测试' } })
  c.status(created, 200)
  const sid = created.json?.data?.id
  const del = await c.api('DELETE', `/subjects/${sid}`, { token: b.token })
  c.status(del, [200, 404])
  // 关键：A 的数据必须还在
  const back = await c.api('GET', '/subjects', { token: a.token })
  const still = (back.json?.data || []).some((s) => s.id === sid)
  c.ok(still, '他人学科被删掉了，隔离失效')
  await c.api('DELETE', `/subjects/${sid}`, { token: a.token })
})

m.test('PATCH /auth/profile 更新昵称生效且可回读', async (c) => {
  const id = await c.ident('main')
  const nick = `测试用户-${Date.now().toString(36)}`
  const res = await c.api('PATCH', '/auth/profile', { token: id.token, body: { nickname: nick } })
  c.status(res, 200)
  const me = await c.api('GET', '/auth/me', { token: id.token })
  c.eq(me.json?.data?.nickname, nick, '昵称未落库')
})

m.test('账号注销 dry_run 只统计不真删', async (c) => {
  const id = await c.ident('main')
  const t0 = Date.now()
  const res = await c.api('DELETE', '/account', {
    token: id.token, query: { dry_run: '1' }, timeout: 180000,
  })
  const cost = Date.now() - t0
  c.status(res, 200)
  c.has(res.json, 'data', 'dry_run 未返回统计')
  c.eq(res.json?.data?.dryRun, true, 'dryRun 标记未回传')
  // dry-run 后身份仍可用
  const me = await c.api('GET', '/auth/me', { token: id.token })
  c.status(me, 200, 'dry_run 把账号真删了')
  // ⚠️ 性能红线：注销是用户可感知的同步操作，空账号实测 26s（跨境 DB 串行 5 轮）
  c.ok(cost < 60000, `注销 dry_run 耗时 ${(cost / 1000).toFixed(1)}s，超过 60s（串行 DB 往返，应并行化）`)
  c.state.dryRunCostMs = cost
})

export default m
