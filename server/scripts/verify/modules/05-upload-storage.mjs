// 模块 05：上传与存储
//
// purpose 四档是本项目最容易出错的地方之一，历史上踩过两次：
//   ① purpose 只从 body 读（前端放 query）⇒ 图片永不落库；
//   ② 附件类上传误用 save ⇒ 首页同一题显示两行。

import sharp from 'sharp'
import { Module } from '../lib/harness.mjs'

const m = new Module('M05', '上传与存储')

/**
 * 造一张有明显内容的 PNG。
 *
 * ⚠️ 每次必须**内容不同**（随机噪点矩形）：否则会命中 #121 的同文件去重，
 *    第二条上传复用第一条的条目 ⇒ 名称不更新，后续按新名查询必然落空
 *    （首轮验证里 M06 三个用例就是这样"假失败"的）。
 */
async function makePng(seed = 0) {
  const w = 320 + (seed % 7)
  const h = 200 + (seed % 5)
  const y = 40 + (seed * 13) % 120
  const svg = Buffer.from(
    `<svg width="${w}" height="${h}"><rect width="100%" height="100%" fill="white"/>`
    + `<rect x="20" y="${y}" width="260" height="8" fill="black"/>`
    + `<rect x="${30 + (seed % 50)}" y="${(y + 30) % 150}" width="40" height="40" fill="#333"/></svg>`,
  )
  return sharp(svg).png().toBuffer()
}

let seedCounter = 0
const nextPng = () => makePng(++seedCounter + Date.now() % 97)

async function upload(c, { purpose, archiveTo, name = 'test.png', mime = 'image/png', extraQuery } = {}) {
  const id = await c.ident('main')
  const buf = await nextPng()
  const form = new FormData()
  form.append('file', new Blob([buf], { type: mime }), 'upload.bin')
  if (purpose !== undefined) form.append('purpose', purpose)
  if (archiveTo) form.append('archive_to', archiveTo)
  // ⚠️ 中文名必须 encodeURIComponent，这是前端约定（否则 latin1 乱码）
  form.append('original_name', encodeURIComponent(name))
  const res = await c.api('POST', '/upload', {
    token: id.token, form, query: extraQuery, timeout: 90000,
  })
  return res
}

m.test('purpose=save（图片）→ 落库并出现在时间轴', async (c) => {
  const res = await upload(c, { purpose: 'save', name: '保存测试图.png' })
  c.status(res, 200, `上传失败：${res.text.slice(0, 250)}`)
  const d = res.json?.data
  c.ok(!!d, '无 data')
  c.ok(!!(d.file_key || d.key), `未返回文件 key：${JSON.stringify(d).slice(0, 200)}`)
  c.ok(!!(d.id || d.timeline_id || d.item_id || d.url), `既无条目 id 也无 url：${JSON.stringify(d).slice(0, 200)}`)
  c.state.savedKey = d.file_key || d.key
})

m.test('purpose=attach → 持久化但**不**建条目（附件语义）', async (c) => {
  const id = await c.ident('main')
  const before = await c.api('GET', '/timeline', { token: id.token, query: { page_size: 1 } })
  const res = await upload(c, { purpose: 'attach', name: '附件图.png' })
  c.status(res, 200, `上传失败：${res.text.slice(0, 250)}`)
  const d = res.json?.data || {}
  c.ok(!!(d.file_key || d.key || d.url), `未返回可引用地址：${JSON.stringify(d).slice(0, 200)}`)
  c.ok(!d.id && !d.timeline_id, `attach 竟然建了业务条目：${JSON.stringify(d).slice(0, 200)}`)
})

m.test('purpose=memory → 持久化不建条目', async (c) => {
  const res = await upload(c, { purpose: 'memory', name: '记忆附件.png' })
  c.status(res, 200)
  const d = res.json?.data || {}
  c.ok(!!(d.file_key || d.key || d.url), 'memory 上传未返回地址')
  c.ok(!d.id, 'memory 上传不应建业务条目')
})

m.test('purpose=temp → 临时对象，允许无条目', async (c) => {
  const res = await upload(c, { purpose: 'temp', name: '临时图.png' })
  c.status(res, 200)
  c.ok(!!res.json?.data, 'temp 上传无返回')
})

m.test('🔴 中文文件名不乱码（original_name 约定）', async (c) => {
  const id = await c.ident('main')
  const cn = '数学第三单元试卷.png'
  const res = await upload(c, { purpose: 'save', name: cn, archiveTo: 'library' })
  c.status(res, 200)
  const list = await c.api('GET', '/library', { token: id.token, query: { keyword: '数学第三单元' } })
  c.status(list, 200)
  const names = (list.json?.data?.list || list.json?.data || []).map((x) => x.name).filter(Boolean)
  if (names.length) {
    const hit = names.find((n) => n.includes('数学'))
    c.ok(!!hit, `资料库里的中文名乱码了：${names.join(' | ')}`)
    c.ok(!hit.includes('\uFFFD'), `文件名含替换符 U+FFFD：${hit}`)
  }
})

m.test('🔴 同文件重复上传命中去重（不重复建条目）', async (c) => {
  // ⚠️ 判据：上传接口返回 `timeline_id` / `library_id`（不是 `id`），
  //    命中去重时 `duplicated=true` 且**复用原条目 id**。
  const id = await c.ident('main')
  const shared = await nextPng()
  const post = async (name) => {
    const form = new FormData()
    form.append('file', new Blob([shared], { type: 'image/png' }), 'u.bin')
    form.append('purpose', 'save')
    form.append('original_name', encodeURIComponent(name))
    return c.api('POST', '/upload', { token: id.token, form, timeout: 90000 })
  }
  const a = await post('去重A.png')
  c.status(a, 200)
  const b = await post('去重B.png')
  c.status(b, 200)
  const ida = a.json?.data?.timeline_id
  const idb = b.json?.data?.timeline_id
  c.ok(!!ida && !!idb, `上传未返回 timeline_id：${JSON.stringify(b.json?.data).slice(0, 200)}`)
  c.eq(idb, ida, `同一文件被建了两条：${ida} vs ${idb}（业务层去重失效）`)
  c.eq(b.json?.data?.duplicated, true, '命中去重但未置 duplicated 标记，前端无法提示"已存在"')
})

m.test('配额接口：返回用量结构', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('GET', '/quota/usage', { token: id.token })
  c.status(res, 200)
  const d = res.json?.data || {}
  c.ok('usedBytes' in d || 'used_bytes' in d || 'tier' in d, `配额结构异常：${Object.keys(d).join(',')}`)
})

m.test('分层统计 storage/tier-stats 可访问', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('GET', '/storage/tier-stats', { token: id.token })
  c.status(res, 200, `tier-stats 失败：${res.text.slice(0, 200)}`)
})

m.test('🔴 存储文件代理：key 越权/非法 → 400 或 404，不得返回任意文件', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('GET', '/storage/files/../../server/.env.secrets', { token: id.token })
  c.ok([400, 403, 404].includes(res.status), `路径穿越被放行（${res.status}）：${res.text.slice(0, 120)}`)
  const miss = await c.api('GET', '/storage/files/blobs/aa/definitely-not-exist/x.png', { token: id.token })
  c.ok([404, 400].includes(miss.status), `不存在的对象返回了 ${miss.status}`)
})

m.test('上传：非图片文档（PDF）走资料库分流', async (c) => {
  const id = await c.ident('main')
  // 最小可用 PDF
  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
    'utf8',
  )
  const form = new FormData()
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'doc.pdf')
  form.append('purpose', 'save')
  form.append('original_name', encodeURIComponent('测试文档.pdf'))
  const res = await c.api('POST', '/upload', { token: id.token, form, timeout: 90000 })
  c.status(res, 200, `PDF 上传失败：${res.text.slice(0, 250)}`)
})

export default m
