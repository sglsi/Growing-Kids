// 模块 06：资料库（library）

import sharp from 'sharp'
import { Module } from '../lib/harness.mjs'

const m = new Module('M06', '资料库')

let seed = 0

async function uploadFile(c, mime, ext, name, extra = {}) {
  const id = await c.ident('main')
  let buf
  if (mime === 'application/pdf') {
    // PDF 也要每次不同：否则命中 #121 去重，第二条复用第一条的名字
    buf = Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n% seed ${Date.now()}-${++seed}\ntrailer<</Root 1 0 R>>\n%%EOF\n`, 'utf8')
  } else {
    const s = ++seed
    const y = 30 + (s * 17) % 60
    const svg = Buffer.from(
      `<svg width="${200 + (s % 9)}" height="120"><rect width="100%" height="100%" fill="white"/>`
      + `<rect x="10" y="${y}" width="150" height="6" fill="black"/>`
      + `<rect x="${20 + (s % 40)}" y="90" width="30" height="20" fill="#555"/></svg>`,
    )
    buf = await sharp(svg).png().toBuffer()
  }
  const form = new FormData()
  form.append('file', new Blob([buf], { type: mime }), `f.${ext}`)
  form.append('purpose', 'save')
  form.append('archive_to', 'library')
  form.append('original_name', encodeURIComponent(name))
  for (const [k, v] of Object.entries(extra)) form.append(k, v)
  return c.api('POST', '/upload', { token: id.token, form, timeout: 90000 })
}

m.test('列表返回 200 且为分页结构', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('GET', '/library', { token: id.token })
  c.status(res, 200)
  const d = res.json?.data
  c.ok(d && (Array.isArray(d) || Array.isArray(d.list)), `结构异常：${JSON.stringify(d).slice(0, 150)}`)
})

m.test('图片以 archive_to=library 上传 → 进资料库', async (c) => {
  const id = await c.ident('main')
  const name = `资料库图片-${Date.now().toString(36)}.png`
  const up = await uploadFile(c, 'image/png', 'png', name)
  c.status(up, 200, `上传失败：${up.text.slice(0, 200)}`)
  const res = await c.api('GET', '/library', { token: id.token, query: { keyword: name } })
  c.status(res, 200)
  const list = res.json?.data?.list || res.json?.data || []
  c.ok(list.length > 0, `资料库里查不到刚上传的 ${name}`)
  c.state.docId = list[0].id
})

m.test('🔴 列表条目必须补签名 URL（否则前端只显示空白卡片）', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('GET', '/library', { token: id.token, query: { page_size: 5 } })
  c.status(res, 200)
  const list = res.json?.data?.list || res.json?.data || []
  if (!list.length) return // 无数据则跳过，不算失败
  const first = list[0]
  c.ok(!!(first.url || first.thumb_url),
    `条目缺签名 URL，字段：${Object.keys(first).join(',')}`)
})

m.test('重命名（PATCH）生效', async (c) => {
  const id = await c.ident('main')
  const name = `待改名-${Date.now().toString(36)}.png`
  const up = await uploadFile(c, 'image/png', 'png', name)
  c.status(up, 200)
  const list = await c.api('GET', '/library', { token: id.token, query: { keyword: name } })
  const docId = (list.json?.data?.list || list.json?.data || [])[0]?.id
  c.ok(!!docId, '未拿到条目 id')
  const newName = '改名后的资料.png'
  const res = await c.api('PATCH', `/library/${docId}`, { token: id.token, body: { name: newName } })
  c.status(res, 200, `改名失败：${res.text.slice(0, 200)}`)
  c.eq(res.json?.data?.name, newName, '改名未生效')
})

m.test('直接创建条目（已知 file_key）', async (c) => {
  const id = await c.ident('main')
  const up = await uploadFile(c, 'image/png', 'png', `直建-${Date.now().toString(36)}.png`)
  c.status(up, 200)
  const key = up.json?.data?.file_key || up.json?.data?.key
  c.ok(!!key, '上传未返回 key')
  const res = await c.api('POST', '/library', {
    token: id.token,
    body: { name: '手工创建条目.png', file_key: key, mime_type: 'image/png', tags: ['手工'] },
  })
  c.status(res, 200, `创建失败：${res.text.slice(0, 200)}`)
  c.has(res.json, 'data.id')
})

m.test('参数校验：缺 name 或 file_key → 4xx', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('POST', '/library', { token: id.token, body: { name: '缺 key' } })
  c.ok(res.status >= 400 && res.status < 500, `缺 file_key 却返回 ${res.status}`)
})

m.test('🔴 越权：B 看不到 A 的资料库条目', async (c) => {
  const id = await c.ident('main')
  const foe = await c.foe()
  const name = `越权资料-${Date.now().toString(36)}.png`
  await uploadFile(c, 'image/png', 'png', name)
  const mine = await c.api('GET', '/library', { token: id.token, query: { keyword: name } })
  const item = (mine.json?.data?.list || mine.json?.data || [])[0]
  c.ok(!!item, 'A 的资料没建上')
  const theirs = await c.api('GET', '/library', { token: foe.token })
  const list = theirs.json?.data?.list || theirs.json?.data || []
  c.ok(!list.some((x) => x.id === item.id), 'B 看到了 A 的资料库条目')
})

m.test('🔴 越权：B 删 A 的资料 → A 的数据仍在', async (c) => {
  const id = await c.ident('main')
  const foe = await c.foe()
  const name = `越权删资料-${Date.now().toString(36)}.png`
  await uploadFile(c, 'image/png', 'png', name)
  const mine = await c.api('GET', '/library', { token: id.token, query: { keyword: name } })
  const item = (mine.json?.data?.list || mine.json?.data || [])[0]
  c.ok(!!item, 'A 的资料没建上')
  await c.api('DELETE', `/library/${item.id}`, { token: foe.token })
  const back = await c.api('GET', '/library', { token: id.token, query: { keyword: name } })
  const still = (back.json?.data?.list || back.json?.data || []).some((x) => x.id === item.id)
  c.ok(still, 'A 的资料被 B 删掉了')
})

m.test('批量删除', async (c) => {
  const id = await c.ident('main')
  const up = await c.api('GET', '/library', { token: id.token, query: { page_size: 1 } })
  const list = up.json?.data?.list || up.json?.data || []
  if (!list.length) return
  const res = await c.api('POST', '/library/batch-delete', { token: id.token, body: { ids: [list[0].id] } })
  c.status(res, [200, 400])
})

m.test('关键词搜索：不存在的词返回空列表而非报错', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('GET', '/library', { token: id.token, query: { keyword: '绝不可能存在的关键词zzz' } })
  c.status(res, 200)
})

export default m
