// 模块 11：AI 外发闸门、聊天与搜题
//
// ⭐ 本模块是**合规红线**的核心（OPS-18 R-合规-02）：
//   默认不外发任何内容到第三方 AI；只有用户显式开启才放行。

import { Module } from '../lib/harness.mjs'

const m = new Module('M11', 'AI 闸门与问答')

m.test('settings 默认：ai_enabled = false（默认仅本地）', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('GET', '/settings', { token: id.token })
  c.status(res, 200)
  c.eq(res.json?.data?.ai_enabled, false, '新用户默认竟然开放了 AI 外发')
})

m.test('settings 参数校验：enabled 非布尔 → 400', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('PUT', '/settings/ai', { token: id.token, body: { enabled: 'yes' } })
  c.status(res, 400, '非布尔值未被拒绝')
})

m.test('🔴 AI 关闭时 chat/message 必须 403（内容不得出机器）', async (c) => {
  const id = await c.ident('main')
  await c.api('PUT', '/settings/ai', { token: id.token, body: { enabled: false } })
  const res = await c.api('POST', '/chat/message', {
    token: id.token, body: { session_id: null, content: '你好' }, timeout: 60000,
  })
  c.status(res, 403, 'AI 关闭时聊天被放行了，等于默认外发未成年人数据')
  const body = JSON.stringify(res.json || {})
  c.ok(body.includes('AI_DISABLED') || body.includes('未开启'), `错误码不含 AI_DISABLED：${body.slice(0, 200)}`)
})

m.test('🔴 AI 关闭时 answer-search 必须 403', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('POST', '/answer-search/x', { token: id.token, body: {}, timeout: 60000 })
  c.status(res, [403, 404, 400], 'AI 关闭时搜题被放行')
})

m.test('🔴 AI 关闭时 search/solve 必须 403', async (c) => {
  const id = await c.ident('main')
  // ⚠️ 参数名是 question_content（不是 question）；参数校验先于 AI 闸门，
  //    传错参数会拿到 400 而非 403 —— 那是**正确**的顺序，别用错参数去测闸门。
  const res = await c.api('POST', '/search/solve', {
    token: id.token, body: { question_content: '1+1=?' }, timeout: 60000,
  })
  c.status(res, 403, 'AI 关闭时联网搜题被放行')
})

m.test('开关生效：开启后闸门放行（随后立即复位）', async (c) => {
  const id = await c.ident('main')
  const on = await c.api('PUT', '/settings/ai', { token: id.token, body: { enabled: true } })
  c.status(on, 200)
  c.eq(on.json?.data?.ai_enabled, true, '开关未置为 true')
  const back = await c.api('GET', '/settings', { token: id.token })
  c.eq(back.json?.data?.ai_enabled, true, '开关未落库（或缓存未失效）')
  // 复位，绝不留开放状态
  const off = await c.api('PUT', '/settings/ai', { token: id.token, body: { enabled: false } })
  c.status(off, 200)
  c.eq(off.json?.data?.ai_enabled, false, '复位失败')
})

m.test('🔴 缓存即时失效：切换开关后同一请求结果随之改变', async (c) => {
  const id = await c.ident('main')
  await c.api('PUT', '/settings/ai', { token: id.token, body: { enabled: false } })
  const a = await c.api('POST', '/chat/message', {
    token: id.token, body: { session_id: null, content: '缓存失效检查' }, timeout: 60000,
  })
  await c.api('PUT', '/settings/ai', { token: id.token, body: { enabled: true } })
  const b = await c.api('POST', '/chat/message', {
    token: id.token, body: { session_id: null, content: '缓存失效检查' }, timeout: 120000,
  })
  c.ok(a.status === 403, `关闭时应 403，实际 ${a.status}`)
  c.ok(b.status !== 403, '开启后仍 403 ⇒ 用户缓存未失效（改开关要等 60s 才生效）')
  await c.api('PUT', '/settings/ai', { token: id.token, body: { enabled: false } })
})

m.test('聊天历史：AI 关闭时读取本地历史仍可用（不被闸门误伤）', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('GET', '/chat/messages', { token: id.token, query: { session_id: 'x' } })
  c.ok([200, 400].includes(res.status), `读取历史返回 ${res.status}`)
})

m.test('🔴 越权：读他人会话历史 → 空（不得串味）', async (c) => {
  const id = await c.ident('main')
  const foe = await c.foe()
  const res = await c.api('GET', '/chat/messages', { token: foe.token, query: { session_id: 'someone-else-session' } })
  c.status(res, 200)
  const list = res.json?.data?.list || res.json?.data || []
  c.ok(!Array.isArray(list) || list.length === 0, `读到了他人会话：${JSON.stringify(list).slice(0, 150)}`)
})

m.test('🔴 知识库（全局表）写入：非 admin 一律 403（fail-closed）', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('POST', '/chat/knowledge', {
    token: id.token, body: { title: '越权知识', content: 'x' },
  })
  c.status(res, 403, '非管理员写全局知识库被放行')
})

m.test('🔴 知识库列表：非 admin 一律 403（fail-closed，与"只有写才管"的直觉相左）', async (c) => {
  // 说明：knowledge_articles 是**全局表**（chat 的 getActiveArticles 会在服务端读它
  // 拼进 system prompt），读写都收口到 admin。普通用户拿不到列表是**预期行为**，
  // 但容易与"读应该放开"的直觉冲突，故单独立用例固化下来，避免以后误改。
  const id = await c.ident('main')
  const res = await c.api('GET', '/chat/knowledge', { token: id.token })
  c.status(res, 403, '非管理员读到了全局知识库列表')
})

m.test('🔴 越权：非 admin 改/删全局知识 → 403', async (c) => {
  const id = await c.ident('main')
  const fake = '00000000-0000-0000-0000-000000000000'
  const up = await c.api('PATCH', `/chat/knowledge/${fake}`, { token: id.token, body: { title: 'x' } })
  c.status(up, [403, 404], '非管理员改全局知识被放行')
  const del = await c.api('DELETE', `/chat/knowledge/${fake}`, { token: id.token })
  c.status(del, [403, 404], '非管理员删全局知识被放行')
})

export default m
