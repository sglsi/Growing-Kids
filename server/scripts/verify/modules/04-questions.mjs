// 模块 04：题目库旧表（questions）
//
// ⚠️ 定位说明：按 OPS-18 表分类，`questions` 属**空转表**——现行数据面走
//    `timeline_items`（kind=question），本表由早期版本遗留。保留接口是为了
//    兼容与将来可能的迁移，不是当前主链路。因此本模块的判据是「不崩、隔离正确」，
//    而非「功能完备」。

import { Module } from '../lib/harness.mjs'

const m = new Module('M04', '题目库旧表 questions')

async function ensureSubject(c) {
  const id = await c.ident('main')
  const res = await c.api('GET', '/subjects', { token: id.token })
  return res.json.data[0].id
}

m.test('列表返回 200 且结构为分页对象', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('GET', '/questions', { token: id.token })
  c.status(res, 200)
  c.ok(res.json.data !== null && res.json.data !== undefined, 'data 为空')
})

m.test('overview 统计返回 200', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('GET', '/questions/overview', { token: id.token })
  c.status(res, 200)
})

m.test('创建题目（含必填 subject_id）', async (c) => {
  const id = await c.ident('main')
  const sid = await ensureSubject(c)
  const res = await c.api('POST', '/questions', {
    token: id.token,
    body: {
      subject_id: sid,
      question_content: '旧表题目：求圆的面积',
      answer_content: 'S = πr²',
      status: 'answered',
    },
  })
  c.status(res, 200, `创建失败：${res.text.slice(0, 200)}`)
  c.has(res.json, 'data.id')
  c.state.qid = res.json.data.id
})

m.test('更新与查询单条', async (c) => {
  const id = await c.ident('main')
  const sid = await ensureSubject(c)
  const created = await c.api('POST', '/questions', {
    token: id.token,
    body: { subject_id: sid, question_content: '待更新题目' },
  })
  c.status(created, 200)
  const qid = created.json.data.id
  const upd = await c.api('PUT', `/questions/${qid}`, {
    token: id.token, body: { answer_content: '更新后的答案', mastered: true },
  })
  c.status(upd, 200)
  c.eq(upd.json.data.answer_content, '更新后的答案', '更新未生效')
  const one = await c.api('GET', `/questions/${qid}`, { token: id.token })
  c.status(one, 200)
  c.eq(one.json.data.id, qid)
})

m.test('🔴 越权：读他人题目 → 不得返回数据', async (c) => {
  const id = await c.ident('main')
  const foe = await c.foe()
  const sid = await ensureSubject(c)
  const created = await c.api('POST', '/questions', {
    token: id.token, body: { subject_id: sid, question_content: '越权读取检查' },
  })
  c.status(created, 200)
  const qid = created.json.data.id
  const stolen = await c.api('GET', `/questions/${qid}`, { token: foe.token })
  if (stolen.status === 200) {
    c.ok(!stolen.json?.data?.id, '他人读到了题目内容')
  } else {
    c.ok([403, 404].includes(stolen.status), `意外状态码 ${stolen.status}`)
  }
})

m.test('删除', async (c) => {
  const id = await c.ident('main')
  const sid = await ensureSubject(c)
  const created = await c.api('POST', '/questions', {
    token: id.token, body: { subject_id: sid, question_content: '待删除旧表题目' },
  })
  c.status(created, 200)
  const del = await c.api('DELETE', `/questions/${created.json.data.id}`, { token: id.token })
  c.status(del, [200, 404])
})

m.test('参数健壮性：mastered 非法值不 500', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('GET', '/questions', { token: id.token, query: { mastered: 'maybe' } })
  c.ok([200, 400].includes(res.status), `mastered=maybe 导致 ${res.status}`)
})

export default m
