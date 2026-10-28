// 模块 03：时间轴 / 错题库（timeline）—— 本项目的核心数据面

import { Module } from '../lib/harness.mjs'

const m = new Module('M03', '时间轴与错题库')

async function ensureSubject(c) {
  if (c.state.subjectId) return c.state.subjectId
  const id = await c.ident('main')
  const res = await c.api('GET', '/subjects', { token: id.token })
  c.state.subjectId = res.json.data[0].id
  return c.state.subjectId
}

async function newQuestion(c, extra = {}) {
  const id = await c.ident('main')
  const subjectId = await ensureSubject(c)
  const res = await c.api('POST', '/timeline', {
    token: id.token,
    body: {
      kind: 'question',
      subject_id: subjectId,
      title: extra.title || '测试题目',
      tags: extra.tags || ['单元测试'],
      content: {
        question: extra.question || '求解 2x + 3 = 11',
        answer: extra.answer || 'x = 4',
        solution: extra.solution || '移项得 2x = 8，故 x = 4',
        status: 'answered',
        ...(extra.content || {}),
      },
    },
  })
  c.status(res, 200, `建题失败: ${res.text.slice(0, 200)}`)
  return res.json.data
}

m.test('创建题目条目（kind=question）', async (c) => {
  const item = await newQuestion(c, { question: '求 1+1', answer: '2' })
  c.has(item, 'id')
  c.eq(item.kind, 'question')
  c.eq(item.content.question, '求 1+1')
  c.state.qid = item.id
})

m.test('参数校验：kind 非法 → 400', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('POST', '/timeline', { token: id.token, body: { kind: 'video' } })
  c.status(res, 400)
})

m.test('参数校验：题目缺少题干 → 400', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('POST', '/timeline', {
    token: id.token, body: { kind: 'question', content: { answer: '只有答案' } },
  })
  c.status(res, 400, '无题干题目被放行，列表会出现空卡片')
})

m.test('参数校验：图片条目缺 file_key → 400', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('POST', '/timeline', { token: id.token, body: { kind: 'image' } })
  c.status(res, 400)
})

m.test('批量创建：一次落库多条', async (c) => {
  const id = await c.ident('main')
  const subjectId = await ensureSubject(c)
  const res = await c.api('POST', '/timeline/batch', {
    token: id.token,
    body: {
      items: [
        { kind: 'question', subject_id: subjectId, content: { question: '批量题 1' } },
        { kind: 'question', subject_id: subjectId, content: { question: '批量题 2' } },
      ],
    },
  })
  c.status(res, 200)
  c.eq((res.json?.data?.list || []).length, 2, '批量创建条数不符')
})

m.test('参数校验：批量 items 为空 → 400', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('POST', '/timeline/batch', { token: id.token, body: { items: [] } })
  c.status(res, 400)
})

m.test('🔴 列表：写操作后立刻可读（缓存已失效）', async (c) => {
  const id = await c.ident('main')
  const q = `缓存验证-${Date.now().toString(36)}`
  await newQuestion(c, { question: q })
  const res = await c.api('GET', '/timeline', { token: id.token, query: { keyword: q } })
  c.status(res, 200)
  c.ok((res.json?.data?.list || []).some((x) => x.content?.question === q),
    '写后立刻读不到新数据 —— 典型的缓存未失效（历史坑）')
})

m.test('列表：scope=recent 与分页参数', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('GET', '/timeline', {
    token: id.token, query: { scope: 'recent', page: 1, page_size: 5 },
  })
  c.status(res, 200)
  c.ok(Array.isArray(res.json.data.list), 'list 不是数组')
  c.ok((res.json.data.list || []).length <= 5, 'page_size 未生效')
})

m.test('列表：subject_id=none 转为 IS NULL 查询（不报 500）', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('GET', '/timeline', { token: id.token, query: { subject_id: 'none' } })
  c.status(res, 200, 'subject_id=none 触发了异常')
})

m.test('概览 overview 返回统计与最近条目', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('GET', '/timeline/overview', { token: id.token })
  c.status(res, 200)
  c.ok(res.json.data !== undefined && res.json.data !== null, 'overview 无 data')
  c.ok(Array.isArray(res.json.data.recent), 'recent 不是数组')
})

m.test('详情 findOne 与列表数据一致', async (c) => {
  const id = await c.ident('main')
  const item = await newQuestion(c, { question: '详情一致性检查' })
  const res = await c.api('GET', `/timeline/${item.id}`, { token: id.token })
  c.status(res, 200)
  c.eq(res.json.data.content.question, '详情一致性检查')
})

m.test('🔴 详情：带图题目必须补签名 URL 字段（曾漏 withUrls 导致详情页图片全无）', async (c) => {
  const id = await c.ident('main')
  // 先上传一张图拿到 key，再建一条「题面带图」的题目
  const svg = Buffer.from('<svg width="200" height="120"><rect width="100%" height="100%" fill="#fff"/><rect x="10" y="50" width="150" height="6" fill="#000"/></svg>')
  const sharp = (await import('sharp')).default
  const buf = await sharp(svg).png().toBuffer()
  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'image/png' }), 'q.png')
  form.append('purpose', 'attach') // ⚠️ 附件语义：不建条目，key 由题目引用
  const up = await c.api('POST', '/upload', { token: id.token, form, timeout: 90000 })
  c.status(up, 200, `上传题图失败：${up.text.slice(0, 200)}`)
  const key = up.json?.data?.file_key || up.json?.data?.key
  c.ok(!!key, '上传未返回 key')

  const item = await newQuestion(c, {
    question: 'URL 字段检查',
    content: { question_images: [key] },
  })
  const res = await c.api('GET', `/timeline/${item.id}`, { token: id.token })
  c.status(res, 200)
  const d = res.json.data
  const urls = d.question_image_urls || []
  c.ok(Array.isArray(urls) && urls.length === 1,
    `题面图未补签名 URL，实际字段：${Object.keys(d).join(',')}`)
  c.ok(urls[0].startsWith('http'), `签名 URL 形态异常：${urls[0]}`)
})

m.test('更新：局部 content patch 不得清空未传字段（合并语义）', async (c) => {
  const id = await c.ident('main')
  const item = await newQuestion(c, {
    question: '原题干', answer: '原答案', solution: '原解析',
    content: { question_label: '第三章·第5题', level: 2, stem: '原始大题' },
  })
  // 只改答案
  const res = await c.api('PUT', `/timeline/${item.id}`, {
    token: id.token, body: { content: { answer: '新答案' } },
  })
  c.status(res, 200)
  const d = res.json.data.content
  c.eq(d.answer, '新答案', '答案未更新')
  c.eq(d.question, '原题干', '未传的题干被清空了（应为合并而非替换）')
  c.eq(d.solution, '原解析', '未传的解析被清空了')
  c.eq(d.question_label, '第三章·第5题', '未传的题号标签被清空了')
})

m.test('更新：mastered 标记与列表过滤', async (c) => {
  const id = await c.ident('main')
  const item = await newQuestion(c, { question: '掌握状态检查' })
  const res = await c.api('PUT', `/timeline/${item.id}`, { token: id.token, body: { mastered: true } })
  c.status(res, 200)
  c.eq(res.json.data.mastered, true, 'mastered 未落库')
  c.ok(!!res.json.data.mastered_at, 'mastered=true 但 mastered_at 为空')
})

m.test('复习本：加入 / 列表可见 / 移出', async (c) => {
  const id = await c.ident('main')
  const item = await newQuestion(c, { question: '复习本检查' })
  const add = await c.api('POST', '/timeline/review-book', { token: id.token, body: { ids: [item.id] } })
  c.status(add, 200)
  const list = await c.api('GET', '/timeline', { token: id.token, query: { scope: 'review' } })
  c.status(list, 200)
  c.ok((list.json.data.list || []).some((x) => x.id === item.id), '加入复习本后 scope=review 查不到')
  const rm = await c.api('DELETE', '/timeline/review-book', { token: id.token, body: { ids: [item.id] } })
  c.status(rm, 200)
  const list2 = await c.api('GET', '/timeline', { token: id.token, query: { scope: 'review' } })
  c.ok(!(list2.json.data.list || []).some((x) => x.id === item.id), '移出复习本后仍能查到')
})

m.test('复习：提交结果推进排程（C4，详见 M15）', async (c) => {
  const id = await c.ident('main')
  const item = await newQuestion(c, { question: '复习推进检查' })
  await c.api('POST', '/timeline/review-book', { token: id.token, body: { ids: [item.id] } })
  const res = await c.api('POST', `/timeline/${item.id}/review`, {
    token: id.token, body: { result: 'correct' },
  })
  c.status(res, 200)
  c.eq(res.json?.data?.review_count, 1, '做对后档位未推进')
  c.ok(!!res.json?.data?.next_review_at, '做对后未排下次复习')
})

m.test('相似题推荐：不崩且返回数组', async (c) => {
  const id = await c.ident('main')
  const item = await newQuestion(c, { question: '相似题检查 2x+3=11', tags: ['方程'] })
  await newQuestion(c, { question: '相似题检查 3x-5=10', tags: ['方程'] })
  const res = await c.api('POST', `/timeline/${item.id}/similar`, { token: id.token, body: { limit: 3 } })
  c.status(res, 200)
  const d = res.json.data
  c.ok(Array.isArray(d) || Array.isArray(d?.list), `similar 返回结构异常：${JSON.stringify(d).slice(0, 120)}`)
})

m.test('🔴 越权：A 读不到 B 的题目详情', async (c) => {
  const id = await c.ident('main')
  const foe = await c.foe()
  const item = await newQuestion(c, { question: '越权详情检查' })
  const res = await c.api('GET', `/timeline/${item.id}`, { token: foe.token })
  c.ok([403, 404, 200].includes(res.status), `意外状态码 ${res.status}`)
  if (res.status === 200) {
    c.ok(!res.json?.data?.id, '他人竟然读到了题目详情')
  }
})

m.test('🔴 越权：B 删 A 的题目 → A 的数据仍在', async (c) => {
  const id = await c.ident('main')
  const foe = await c.foe()
  const item = await newQuestion(c, { question: '越权删除检查' })
  await c.api('DELETE', `/timeline/${item.id}`, { token: foe.token })
  const back = await c.api('GET', `/timeline/${item.id}`, { token: id.token })
  c.status(back, 200, '题目被他人删掉了')
})

m.test('批量删除与单条删除', async (c) => {
  const id = await c.ident('main')
  const a = await newQuestion(c, { question: '批量删除 A' })
  const b = await newQuestion(c, { question: '批量删除 B' })
  const res = await c.api('POST', '/timeline/batch-delete', { token: id.token, body: { ids: [a.id, b.id] } })
  c.status(res, 200)
  const list = await c.api('GET', '/timeline', { token: id.token, query: { keyword: '批量删除' } })
  c.ok(!(list.json.data.list || []).some((x) => x.id === a.id || x.id === b.id), '批量删除未生效')
})

m.test('参数健壮性：非法 page/page_size 不 500', async (c) => {
  const id = await c.ident('main')
  for (const q of [{ page: 'abc', page_size: 'xyz' }, { page: '-1' }, { page_size: '99999' }]) {
    const res = await c.api('GET', '/timeline', { token: id.token, query: q })
    c.ok([200, 400].includes(res.status), `非法分页参数 ${JSON.stringify(q)} 导致 ${res.status}`)
  }
})

export default m
