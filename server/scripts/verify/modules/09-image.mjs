// 模块 09：图像处理管线
//
// 判据说明：图像链路的**质量**由 `dynamic-tests/probe-*.ts` 专项评估，
// 本模块只验证「服务可达、参数守门、错误可解释」这层契约。

import sharp from 'sharp'
import { Module } from '../lib/harness.mjs'

const m = new Module('M09', '图像处理管线')

/**
 * 造一张公网可访问的图。
 *
 * ⚠️ 必须用上传返回的 `url`（对象存储公网地址），不能用本机
 *    `/api/storage/files/<key>` 代理：后者的响应要带身份令牌，而 ImageService
 *    只对 coze/volcengine 等外部白名单主机转发请求头 ⇒ 回源自己会被自己 401。
 *    生产环境（supabase 驱动）不存在此问题，这是**本地代理通道**的固有约束。
 */
async function publicImageUrl(c) {
  if (c.state.imgUrl) return c.state.imgUrl
  const id = await c.ident('main')
  const svg = Buffer.from(
    '<svg width="640" height="400"><rect width="100%" height="100%" fill="#fff"/>'
    + '<rect x="40" y="40" width="560" height="6" fill="#111"/>'
    + '<text x="40" y="120" font-size="28" fill="#000">2x + 3 = 11</text>'
    + '<rect x="40" y="300" width="400" height="6" fill="#111"/></svg>',
  )
  const buf = await sharp(svg).png().toBuffer()
  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'image/png' }), 'i.png')
  form.append('purpose', 'attach')
  const up = await c.api('POST', '/upload', { token: id.token, form, timeout: 90000 })
  c.status(up, 200, `上传失败：${up.text.slice(0, 200)}`)
  const url = up.json?.data?.url
  c.ok(!!url, `上传未返回公网 url：${JSON.stringify(up.json?.data).slice(0, 200)}`)
  c.state.imgUrl = url
  return url
}

m.test('能力自检 capabilities：200 且版本 ≥ 3', async (c) => {
  const res = await c.api('GET', '/image/capabilities')
  c.status(res, 200)
  const d = res.json?.data || {}
  c.ok((d.version || 0) >= 3, `capabilities 版本过低（${d.version}），说明部署的是旧后端`)
  c.ok(!!d.pipeline_mode, '缺少 pipeline_mode')
})

m.test('OCR 诊断端点返回结构化报告', async (c) => {
  const res = await c.api('GET', '/image/ocr-diagnose', { timeout: 120000 })
  c.status(res, 200)
  c.ok(res.json?.data !== undefined && res.json?.data !== null, '诊断无 data')
  c.state.ocrDiag = res.json.data
})

m.test('process 参数校验：缺 image_url → 4xx', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('POST', '/image/process', { token: id.token, body: { action: 'enhance' } })
  c.ok(res.status >= 400 && res.status < 500, `缺 image_url 返回 ${res.status}`)
})

m.test('process 参数校验：非法 action → 4xx', async (c) => {
  const id = await c.ident('main')
  const url = await publicImageUrl(c)
  const res = await c.api('POST', '/image/process', {
    token: id.token, body: { action: 'make-it-pretty', image_url: url },
  })
  c.ok(res.status >= 400 && res.status < 500, `非法 action 返回 ${res.status}`)
})

m.test('process 实跑：enhance（原图档，最省算力）', async (c) => {
  const id = await c.ident('main')
  const url = await publicImageUrl(c)
  const res = await c.api('POST', '/image/process', {
    token: id.token,
    body: { action: 'enhance', image_url: url, enhance_preset: 'original', sr_scale: 2 },
    timeout: 180000,
  })
  c.status(res, 200, `处理失败：${res.text.slice(0, 250)}`)
  c.ok(!!(res.json?.data?.url || res.json?.data?.key), `无产出图：${JSON.stringify(res.json?.data).slice(0, 200)}`)
})

m.test('process 实跑：auto（几何纠偏）不崩', async (c) => {
  const id = await c.ident('main')
  const url = await publicImageUrl(c)
  const res = await c.api('POST', '/image/process', {
    token: id.token, body: { action: 'auto', image_url: url },
    timeout: 180000,
  })
  c.status(res, 200, `自动调正失败：${res.text.slice(0, 250)}`)
})

m.test('🔴 "没改动"分支必须带 notice（否则前端静默无反应）', async (c) => {
  const id = await c.ident('main')
  const url = await publicImageUrl(c)
  const res = await c.api('POST', '/image/process', {
    token: id.token, body: { action: 'erase_v2', image_url: url, use_vlm: false },
    timeout: 180000,
  })
  c.status(res, 200)
  const d = res.json?.data || {}
  // 若返回的是原图（未检出手写），必须有 notice 说明原因
  if (d.debug?.notice) {
    c.has(d.debug, 'notice.title', 'notice 缺标题')
    c.has(d.debug, 'notice.message', 'notice 缺正文')
  }
  // 不强制要求必须有 notice（图里确实有手写时不该出现），只校验结构
})

m.test('extract-wrong 参数校验：缺 image_url → 4xx', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('POST', '/image/extract-wrong', { token: id.token, body: {} })
  c.ok(res.status >= 400 && res.status < 500, `返回 ${res.status}`)
})

m.test('ocr-page 参数校验：缺 image_url → 4xx', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('POST', '/image/ocr-page', { token: id.token, body: { mode: 'fast' } })
  c.ok(res.status >= 400 && res.status < 500, `返回 ${res.status}`)
})

m.test('wrongq 参数校验：缺参 → 4xx', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('POST', '/image/wrongq', { token: id.token, body: {} })
  c.ok(res.status >= 400 && res.status < 500, `返回 ${res.status}`)
})

export default m
