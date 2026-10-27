// 模块 02：学科（subjects）

import { Module } from '../lib/harness.mjs'

const m = new Module('M02', '学科管理')

m.test('列表：新用户首次访问自动铺设默认学科', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('GET', '/subjects', { token: id.token })
  c.status(res, 200)
  const list = res.json?.data || []
  c.ok(Array.isArray(list), '列表不是数组')
  c.ok(list.length > 0, '新用户未铺设默认学科，前端会出现"无学科可选"')
  c.has(list[0], 'id')
  c.has(list[0], 'name')
})

m.test('创建学科：返回 id 且出现在列表中', async (c) => {
  const id = await c.ident('main')
  const name = `测试学科-${Date.now().toString(36)}`
  const res = await c.api('POST', '/subjects', {
    token: id.token, body: { name, color: 'blue-500', sort_order: 88 },
  })
  c.status(res, 200)
  const sid = c.has(res.json, 'data.id')
  c.eq(res.json.data.name, name, '名称未落库')
  c.eq(res.json.data.color, 'blue-500', '颜色未落库')
  const back = await c.api('GET', '/subjects', { token: id.token })
  c.ok((back.json?.data || []).some((s) => s.id === sid), '新学科未出现在列表（缓存未失效？）')
  c.state.sid = sid
})

m.test('参数校验：空名称 → 400', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('POST', '/subjects', { token: id.token, body: { name: '   ' } })
  c.status(res, 400, '空学科名未被拒绝')
})

m.test('更新学科：改名改色生效', async (c) => {
  const id = await c.ident('main')
  const sid = c.state.sid || (await c.api('POST', '/subjects', { token: id.token, body: { name: '待改名' } })).json.data.id
  const res = await c.api('PUT', `/subjects/${sid}`, {
    token: id.token, body: { name: '已改名', color: 'red-500', sort_order: 7 },
  })
  c.status(res, 200)
  c.eq(res.json.data.name, '已改名')
  c.eq(res.json.data.sort_order, 7)
})

m.test('更新他人学科 → 404（不得泄漏存在性以外的信息）', async (c) => {
  const id = await c.ident('main')
  const foe = await c.foe()
  const created = await c.api('POST', '/subjects', { token: foe.token, body: { name: '他人的学科' } })
  c.status(created, 200)
  const sid = created.json.data.id
  const res = await c.api('PUT', `/subjects/${sid}`, { token: id.token, body: { name: '被篡改' } })
  c.status(res, [404, 403, 400], '改到了别人的学科')
  const back = await c.api('GET', '/subjects', { token: foe.token })
  const still = (back.json?.data || []).find((s) => s.id === sid)
  c.eq(still?.name, '他人的学科', '他人学科内容被改')
  await c.api('DELETE', `/subjects/${sid}`, { token: foe.token })
})

m.test('删除学科：从列表消失', async (c) => {
  const id = await c.ident('main')
  const created = await c.api('POST', '/subjects', { token: id.token, body: { name: '待删除学科' } })
  c.status(created, 200)
  const sid = created.json.data.id
  const del = await c.api('DELETE', `/subjects/${sid}`, { token: id.token })
  c.status(del, 200)
  const back = await c.api('GET', '/subjects', { token: id.token })
  c.ok(!(back.json?.data || []).some((s) => s.id === sid), '删除后仍出现在列表（软删未过滤？）')
})

m.test('删除不存在的 id：返回成功但无副作用（不得 500）', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('DELETE', `/subjects/00000000-0000-0000-0000-000000000000`, { token: id.token })
  c.ok([200, 404].includes(res.status), `期望 200/404，实际 ${res.status} ${res.text.slice(0, 120)}`)
})

export default m
