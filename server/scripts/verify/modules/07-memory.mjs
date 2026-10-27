// 模块 07：成长记忆（memory）

import sharp from 'sharp'
import { Module } from '../lib/harness.mjs'

const m = new Module('M07', '成长记忆')

async function newMemory(c, extra = {}) {
  const id = await c.ident('main')
  const res = await c.api('POST', '/memories', {
    token: id.token,
    body: {
      title: extra.title || '第一次独立完成作业',
      content: extra.content || '今天自己把数学卷子做完了，没有催。',
      category: extra.category || 'study',
      mood: extra.mood || 'proud',
      tags: extra.tags || ['成长'],
      occurred_at: extra.occurred_at || new Date().toISOString(),
    },
  })
  c.status(res, 200, `创建记忆失败：${res.text.slice(0, 200)}`)
  return res.json.data
}

m.test('创建记忆：返回 id 且字段落库', async (c) => {
  const item = await newMemory(c, { title: '创建检查' })
  c.has(item, 'id')
  c.eq(item.title, '创建检查')
  c.eq(item.category, 'study')
  c.eq(item.mood, 'proud')
  c.state.mid = item.id
})

m.test('列表：包含刚创建的记忆', async (c) => {
  const id = await c.ident('main')
  const title = `列表检查-${Date.now().toString(36)}`
  await newMemory(c, { title })
  const res = await c.api('GET', '/memories', { token: id.token, query: { keyword: title } })
  c.status(res, 200)
  const list = res.json?.data?.list || res.json?.data || []
  c.ok(list.some((x) => x.title === title), '写后立刻读不到（缓存未失效？）')
})

m.test('分类过滤：category=life 只返回生活类', async (c) => {
  const id = await c.ident('main')
  await newMemory(c, { title: '生活类记忆', category: 'life' })
  const res = await c.api('GET', '/memories', { token: id.token, query: { category: 'life', page_size: 50 } })
  c.status(res, 200)
  const list = res.json?.data?.list || res.json?.data || []
  c.ok(list.every((x) => x.category === 'life'), `分类过滤串味：${list.map((x) => x.category).join(',')}`)
})

m.test('非法 category 被拒绝或忽略（不得 500）', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('POST', '/memories', {
    token: id.token, body: { title: '非法分类', category: 'not-a-category' },
  })
  c.ok([200, 400].includes(res.status), `非法 category 导致 ${res.status}`)
})

m.test('详情查询一致（返回 { memory, media } 两段结构）', async (c) => {
  const id = await c.ident('main')
  const item = await newMemory(c, { title: '详情一致性' })
  const res = await c.api('GET', `/memories/${item.id}`, { token: id.token })
  c.status(res, 200)
  const d = res.json?.data || {}
  c.ok(!!d.memory, `详情未返回 memory 段：${Object.keys(d).join(',')}`)
  c.ok(Array.isArray(d.media), `详情 media 不是数组：${Object.keys(d).join(',')}`)
  c.eq(d.memory.title, '详情一致性')
})

m.test('更新记忆（含 mood 置空）', async (c) => {
  const id = await c.ident('main')
  const item = await newMemory(c, { title: '待更新', mood: 'calm' })
  const res = await c.api('PATCH', `/memories/${item.id}`, {
    token: id.token, body: { content: '更新后的正文', mood: null },
  })
  c.status(res, 200)
  c.eq(res.json.data.content, '更新后的正文')
  c.ok(res.json.data.mood === null || res.json.data.mood === undefined, 'mood 未置空')
})

m.test('媒体：上传并挂载到记忆，media_count 递增', async (c) => {
  const id = await c.ident('main')
  const item = await newMemory(c, { title: '带图记忆' })
  const svg = Buffer.from('<svg width="160" height="100"><rect width="100%" height="100%" fill="white"/><circle cx="80" cy="50" r="20" fill="black"/></svg>')
  const buf = await sharp(svg).png().toBuffer()
  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'image/png' }), 'm.png')
  form.append('purpose', 'memory')
  const up = await c.api('POST', '/upload', { token: id.token, form, timeout: 90000 })
  c.status(up, 200, `媒体上传失败：${up.text.slice(0, 200)}`)
  const key = up.json?.data?.file_key || up.json?.data?.key
  c.ok(!!key, '未返回 key')
  const add = await c.api('POST', `/memories/${item.id}/media`, {
    token: id.token,
    body: { file_key: key, mime_type: 'image/png', kind: 'image', width: 160, height: 100, size_bytes: buf.length },
  })
  c.status(add, 200, `挂载媒体失败：${add.text.slice(0, 200)}`)
  const one = await c.api('GET', `/memories/${item.id}`, { token: id.token })
  c.status(one, 200)
  const mem = one.json?.data?.memory || {}
  const media = one.json?.data?.media || []
  c.ok(media.length >= 1, `媒体未挂载上，media 段为空：${JSON.stringify(one.json?.data).slice(0, 200)}`)
  c.ok((mem.media_count || 0) >= 1, `media_count 未递增：${mem.media_count}`)
  c.state.mediaId = add.json?.data?.id || media[0]?.id
  c.state.lastMemory = item
})

m.test('媒体：删除后 media 列表缩短', async (c) => {
  const id = await c.ident('main')
  const item = c.state.lastMemory
  const mediaId = c.state.mediaId
  if (!item || !mediaId) return
  const res = await c.api('DELETE', `/memories/${item.id}/media/${mediaId}`, { token: id.token })
  c.status(res, [200, 404])
  const one = await c.api('GET', `/memories/${item.id}`, { token: id.token })
  c.status(one, 200)
  const left = one.json?.data?.media || []
  c.ok(!left.some((x) => x.id === mediaId), '媒体删除后仍在列表里')
})

m.test('🔴 越权：B 读不到 A 的记忆', async (c) => {
  const id = await c.ident('main')
  const foe = await c.foe()
  const title = `越权记忆-${Date.now().toString(36)}`
  const item = await newMemory(c, { title })
  c.state.lastMemory = item
  const stolen = await c.api('GET', `/memories/${item.id}`, { token: foe.token })
  if (stolen.status === 200) {
    c.ok(!stolen.json?.data?.id, 'B 读到了 A 的记忆')
  } else {
    c.ok([403, 404].includes(stolen.status), `意外状态码 ${stolen.status}`)
  }
})

m.test('🔴 越权：B 删 A 的记忆 → A 的数据仍在', async (c) => {
  const id = await c.ident('main')
  const foe = await c.foe()
  const item = await newMemory(c, { title: '越权删除记忆' })
  await c.api('DELETE', `/memories/${item.id}`, { token: foe.token })
  const back = await c.api('GET', `/memories/${item.id}`, { token: id.token })
  c.status(back, 200, 'A 的记忆被 B 删掉了')
})

m.test('批量删除', async (c) => {
  const id = await c.ident('main')
  const a = await newMemory(c, { title: '批量删记忆 A' })
  const b = await newMemory(c, { title: '批量删记忆 B' })
  const res = await c.api('POST', '/memories/batch-delete', { token: id.token, body: { ids: [a.id, b.id] } })
  c.status(res, 200)
  const list = await c.api('GET', '/memories', { token: id.token, query: { keyword: '批量删记忆' } })
  const remain = list.json?.data?.list || list.json?.data || []
  c.ok(!remain.some((x) => x.id === a.id || x.id === b.id), '批量删除未生效')
})

export default m
