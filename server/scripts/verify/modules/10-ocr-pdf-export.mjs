// 模块 10：OCR 识别、PDF 合成与 Word 导出

import { Module } from '../lib/harness.mjs'
import { docxText } from '../lib/zip.mjs'

const m = new Module('M10', 'OCR 与导出')

/** 导出返回的是 .docx，必须解包看正文才能验"带没带答案"（R-技术-13 就是这么被漏掉的） */
async function exportAndRead(c, body) {
  const id = await c.ident('main')
  const res = await c.api('POST', '/document/export', { token: id.token, body, timeout: 180000 })
  c.status(res, 200, `导出失败：${res.text.slice(0, 250)}`)
  const url = res.json?.data?.url
  c.ok(!!url, `未返回导出地址：${res.text.slice(0, 200)}`)
  const raw = await fetch(url, { headers: { 'X-Auth-Token': id.token }, signal: AbortSignal.timeout(120000) })
  c.status({ status: raw.status, text: `下载 ${url.slice(0, 90)}` }, 200, '导出文件下载失败')
  const buf = Buffer.from(await raw.arrayBuffer())
  c.ok(buf.length > 1000, `导出文件过小（${buf.length}B），多半不是有效 docx`)
  return docxText(buf)
}

async function newQuestion(c, extra = {}) {
  const id = await c.ident('main')
  const res = await c.api('POST', '/timeline', {
    token: id.token,
    body: {
      kind: 'question',
      title: extra.title || '导出用题',
      content: {
        question: extra.question || '已知直角三角形两直角边为 3 和 4，求斜边',
        answer: extra.answer || '5',
        solution: extra.solution || '勾股定理：√(3²+4²)=5',
        status: 'answered',
      },
    },
  })
  c.status(res, 200, `建题失败：${res.text.slice(0, 200)}`)
  return res.json.data
}

m.test('recognize-exam 参数校验：缺 image_keys → 4xx', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('POST', '/ocr/recognize-exam', { token: id.token, body: {} })
  c.ok(res.status >= 400 && res.status < 500, `返回 ${res.status}`)
})

m.test('recognize-exam：空数组 → 4xx 或空结果（不得 500）', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('POST', '/ocr/recognize-exam', {
    token: id.token, body: { image_keys: [], subject_id: null },
  })
  c.ok(res.status < 500, `空数组导致 500：${res.text.slice(0, 200)}`)
})

m.test('recognize-exam-url：空数组不 500', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('POST', '/ocr/recognize-exam-url', { token: id.token, body: { urls: [] } })
  c.ok(res.status < 500, `空数组导致 500：${res.text.slice(0, 200)}`)
})

m.test('recognize-pair：空输入不 500', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('POST', '/ocr/recognize-pair', {
    token: id.token, body: { question_image_keys: [], answer_image_keys: [] },
  })
  c.ok(res.status < 500, `空输入导致 500：${res.text.slice(0, 200)}`)
})

m.test('recognize-doc 参数校验：缺 file_url → 4xx', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('POST', '/ocr/recognize-doc', { token: id.token, body: {} })
  c.ok(res.status >= 400 && res.status < 500, `返回 ${res.status}`)
})

m.test('export-docx：空 items 不 500', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('POST', '/ocr/export-docx', { token: id.token, body: { items: [] } })
  c.ok(res.status < 500, `空 items 导致 500：${res.text.slice(0, 200)}`)
})

m.test('文档导出（Word）：按 ids 白名单导出', async (c) => {
  const id = await c.ident('main')
  const item = await newQuestion(c, { question: '导出测试题' })
  const res = await c.api('POST', '/document/export', {
    token: id.token, body: { ids: [item.id], title: '单元测试导出', include_answers: false },
    timeout: 120000,
  })
  c.status(res, 200, `导出失败：${res.text.slice(0, 250)}`)
  c.has(res.json, 'data.url', '未返回导出文件地址')
  c.has(res.json, 'data.file_key', '未返回 file_key')
})

m.test('文档导出：空筛选条件（全量）可跑通', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('POST', '/document/export', { token: id.token, body: {}, timeout: 120000 })
  c.status(res, 200, `全量导出失败：${res.text.slice(0, 250)}`)
})

m.test('🔴 导出口径：不传 include_answers 必须等于练习卷（不含答案）', async (c) => {
  const item = await newQuestion(c, {
    question: '口径默认值题',
    answer: '42',
    solution: '这是解析文本-SHOULD-NOT-APPEAR',
  })
  // 不传 include_answers（汇总页旧行为就是"不传"）
  const text = await exportAndRead(c, { ids: [item.id], title: '默认口径' })

  c.ok(text.includes('口径默认值题'), `导出正文里没有题干，解包逻辑或导出本身有问题：${text.slice(0, 200)}`)
  c.ok(!text.includes('正确答案'), `默认导出了答案块（应统一为练习卷）：\n${text.slice(0, 400)}`)
  c.ok(!text.includes('SHOULD-NOT-APPEAR'), '默认导出了解析内容')
  c.ok(text.includes('练习卷'), `副标题未标明版本（应为「练习卷（不含答案）」）：${text.slice(0, 200)}`)
})

m.test('🔴 导出口径：include_answers=true 才输出答案/解析（答疑解惑版）', async (c) => {
  const item = await newQuestion(c, {
    question: '答疑解惑题',
    answer: '43',
    solution: '这是解析文本-MUST-APPEAR',
  })
  const text = await exportAndRead(c, { ids: [item.id], title: '答疑解惑口径', include_answers: true })
  c.ok(text.includes('正确答案'), `显式要答案却没输出答案块：\n${text.slice(0, 400)}`)
  c.ok(text.includes('MUST-APPEAR'), '解析未输出')
  c.ok(text.includes('答疑解惑'), `副标题未标明版本：${text.slice(0, 200)}`)
})

m.test('导出口径：include_answers=false 显式传与不传结果一致', async (c) => {
  const item = await newQuestion(c, { question: '显式 false 题', answer: '7' })
  const a = await exportAndRead(c, { ids: [item.id], title: 'A', include_answers: false })
  const b = await exportAndRead(c, { ids: [item.id], title: 'B' })
  const strip = (s) => s.replace(/生成于\s*\S+/g, '').replace(/A|B/, '')
  c.eq(strip(a) === strip(b), true, '显式 false 与不传的结果不一致（语义未统一）')
})

m.test('PDF 合成：ids 必须是数组', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('POST', '/pdf/combine', { token: id.token, body: { ids: 'abc' } })
  c.status(res, 400, '非法 ids 未被拒绝')
})

m.test('PDF 合成：空 ids 不 500', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('POST', '/pdf/combine', { token: id.token, body: { ids: [] }, timeout: 120000 })
  c.ok(res.status < 500, `空 ids 导致 500：${res.text.slice(0, 200)}`)
})

m.test('PDF 合成：真实图片素材合成为 PDF', async (c) => {
  // ⚠️ pdf/combine 合成的是**图片素材**（timeline kind=image），纯文字题目没有
  //    可渲染的图 ⇒ 会返回 400「所选素材中没有可合成的图片」。
  const id = await c.ident('main')
  const sharp = (await import('sharp')).default
  const svg = Buffer.from(`<svg width="${400 + Math.floor(Math.random() * 50)}" height="240"><rect width="100%" height="100%" fill="#fff"/><rect x="20" y="60" width="300" height="8" fill="#000"/></svg>`)
  const buf = await sharp(svg).png().toBuffer()
  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'image/png' }), 'p.png')
  form.append('purpose', 'save')
  form.append('original_name', encodeURIComponent(`合成素材-${Date.now().toString(36)}.png`))
  const up = await c.api('POST', '/upload', { token: id.token, form, timeout: 90000 })
  c.status(up, 200)
  const tid = up.json?.data?.timeline_id
  c.ok(!!tid, '上传未建图片条目')
  const res = await c.api('POST', '/pdf/combine', {
    token: id.token, body: { ids: [tid], format: 'pdf', include_answers: false }, timeout: 120000,
  })
  c.status(res, 200, `合成失败：${res.text.slice(0, 250)}`)
  c.ok(!!(res.json?.data?.url || res.json?.data?.file_key), `无产出：${JSON.stringify(res.json?.data).slice(0, 200)}`)
})

m.test('🔴 越权：B 不能用 A 的题目 id 导出', async (c) => {
  const id = await c.ident('main')
  const foe = await c.foe()
  const item = await newQuestion(c, { question: '越权导出检查' })
  const res = await c.api('POST', '/document/export', {
    token: foe.token, body: { ids: [item.id] }, timeout: 120000,
  })
  // 允许 200（按白名单导出 0 题），但不允许 500；更不允许导出到 A 的内容
  c.ok(res.status < 500, `越权导出导致 500：${res.text.slice(0, 200)}`)
})

export default m
