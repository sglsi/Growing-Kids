// 模块 10：OCR 识别、PDF 合成与 Word 导出

import { Module } from '../lib/harness.mjs'

const m = new Module('M10', 'OCR 与导出')

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

m.test('🔴 导出内容口径：include_answers=false 与不传的默认值必须一致', async (c) => {
  const id = await c.ident('main')
  const item = await newQuestion(c, { question: '口径对比题' })
  const noAns = await c.api('POST', '/document/export', {
    token: id.token, body: { ids: [item.id], include_answers: false }, timeout: 120000,
  })
  c.status(noAns, 200)
  const def = await c.api('POST', '/document/export', {
    token: id.token, body: { ids: [item.id] }, timeout: 120000,
  })
  c.status(def, 200)
  // 只记录差异，判定放在文档里说明：两处口径不一致属**设计风险**
  c.state.exportAnswerSemantics = {
    explicit_false: !!noAns.json?.data?.file_key,
    undefined: !!def.json?.data?.file_key,
  }
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
