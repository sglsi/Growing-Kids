// 模块 08：素材（materials，空转表）与文档（documents）

import sharp from 'sharp'
import { Module } from '../lib/harness.mjs'

const m = new Module('M08', '素材与文档')

let pdfSeed = 0

async function uploadPdf(c, name = '测试卷.pdf') {
  const id = await c.ident('main')
  // ⚠️ 每次内容必须不同，否则命中 #121 同文件去重 ⇒ 复用旧条目、名字不更新
  const stamp = `${Date.now()}-${++pdfSeed}`
  const pdf = Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n% seed ${stamp}\ntrailer<</Root 1 0 R>>\n%%EOF\n`, 'utf8')
  const form = new FormData()
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'd.pdf')
  form.append('purpose', 'save')
  form.append('original_name', encodeURIComponent(name))
  return c.api('POST', '/upload', { token: id.token, form, timeout: 90000 })
}

m.test('documents 列表返回 200', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('GET', '/documents', { token: id.token })
  c.status(res, 200, `列表失败：${res.text.slice(0, 200)}`)
})

/**
 * documents 表的语义澄清（首轮验证踩到的认知偏差）：
 *   **上传的 PDF 不进 `documents` 表** —— 上传分流是「图片 → 收件箱 / 文档 → 资料库
 *   library_docs」。`documents` 表承载的是**导出产物**（document/export 生成的 Word、
 *   pdf/combine 生成的合卷），由服务端在创建时写入。
 *   因此本模块的数据准备一律走 `POST /document/export`。
 */
async function ensureExportedDoc(c, title = '单元测试文档') {
  const id = await c.ident('main')
  const res = await c.api('POST', '/document/export', {
    token: id.token, body: { title, include_answers: false }, timeout: 120000,
  })
  c.status(res, 200, `导出失败：${res.text.slice(0, 200)}`)
  const list = await c.api('GET', '/documents', { token: id.token, query: { keyword: title } })
  c.status(list, 200)
  const rows = list.json?.data?.list || list.json?.data || []
  c.ok(rows.length > 0, `导出后 documents 列表查不到「${title}」`)
  return rows[0]
}

m.test('上传 PDF → 进资料库 library（文档分流语义）', async (c) => {
  const id = await c.ident('main')
  const name = `文档-${Date.now().toString(36)}.pdf`
  const up = await uploadPdf(c, name)
  c.status(up, 200, `上传失败：${up.text.slice(0, 200)}`)
  c.ok(!!up.json?.data?.library_id, `PDF 未建资料库条目：${JSON.stringify(up.json?.data).slice(0, 200)}`)
  const res = await c.api('GET', '/library', { token: id.token, query: { keyword: name } })
  c.status(res, 200)
  const list = res.json?.data?.list || res.json?.data || []
  c.ok(list.length > 0, `资料库查不到刚上传的 ${name}`)
})

m.test('documents 重命名：空标题 → 4xx（不得静默清空）', async (c) => {
  const id = await c.ident('main')
  const doc = await ensureExportedDoc(c, `待改名-${Date.now().toString(36)}`)
  const bad = await c.api('PATCH', `/documents/${doc.id}`, { token: id.token, body: { title: '' } })
  c.ok(bad.status >= 400 && bad.status < 500, `空标题被接受（${bad.status}），会把文件名改成空`)
  const good = await c.api('PATCH', `/documents/${doc.id}`, { token: id.token, body: { title: '改名后的文档' } })
  c.status(good, 200)
  c.eq(good.json?.data?.title, '改名后的文档', '改名未生效')
})

m.test('🔴 文档错误信息必须带真实原因（历史坑：msg 被吞成 Http Exception）', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('PATCH', `/documents/00000000-0000-0000-0000-000000000000`, {
    token: id.token, body: { title: 'x' },
  })
  if (res.status >= 400) {
    const msg = res.json?.msg || res.json?.message || ''
    c.ok(msg && msg !== 'Http Exception' && msg !== 'Internal Server Error',
      `错误信息被吞：${JSON.stringify(res.json).slice(0, 200)}`)
  }
})

m.test('documents 删除与批量删除', async (c) => {
  const id = await c.ident('main')
  const doc = await ensureExportedDoc(c, `待删除-${Date.now().toString(36)}`)
  const del = await c.api('DELETE', `/documents/${doc.id}`, { token: id.token })
  c.status(del, [200, 404])
  const batch = await c.api('POST', '/documents/batch-delete', { token: id.token, body: { ids: [] } })
  c.status(batch, 200, '空 ids 批量删除应幂等返回 200')
})

m.test('🔴 越权：B 删 A 的文档 → A 的文档仍在', async (c) => {
  const foe = await c.foe()
  const doc = await ensureExportedDoc(c, `越权文档-${Date.now().toString(36)}`)
  await c.api('DELETE', `/documents/${doc.id}`, { token: foe.token })
  const id = await c.ident('main')
  const back = await c.api('GET', '/documents', { token: id.token, query: { keyword: doc.title } })
  const still = (back.json?.data?.list || back.json?.data || []).some((x) => x.id === doc.id)
  c.ok(still, 'A 的文档被 B 删掉了')
})

m.test('materials 列表（空转表）返回 200', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('GET', '/materials', { token: id.token })
  c.status(res, 200)
  const d = res.json?.data
  c.ok(d !== undefined && d !== null, 'data 为空')
})

m.test('materials 批量删除：非数组 ids → 400', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('POST', '/materials/batch-delete', { token: id.token, body: { ids: 'not-array' } })
  c.status(res, 400, '非法 ids 未被拒绝')
})

m.test('materials 删除不存在的 id：不 500', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('DELETE', '/materials/00000000-0000-0000-0000-000000000000', { token: id.token })
  c.ok([200, 404].includes(res.status), `删除不存在 id 返回 ${res.status}`)
})

export default m
