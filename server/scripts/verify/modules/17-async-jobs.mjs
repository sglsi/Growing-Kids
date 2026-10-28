// 模块 17：异步任务（`async_jobs`）
//
// 存在理由（OPS-18 `R-上线-01`）：
//   微信 `wx.request` / `wx.uploadFile` 超时**默认与最大都是 60s**，而本项目三条
//   链路实测必然超过：精准 OCR ≈ 67s、联网搜答案 ≈ 110~135s、AI 解题 ≈ 60~90s
//   ⇒ 小程序端与网络好坏无关地被掐断。解法是「提交回 ticket + 短请求轮询」。
//
// 这里守的不是「接口能不能用」，而是**异步化引入的三类新风险**：
//   ① 身份：任务里带着用户的图片 URL 与题目内容 ⇒ 越权读必须 404（不区分存在与否）
//   ② 闸门：任务在后台执行时**没有 req** ⇒ AI 外发闸门必须在提交阶段拦，
//      否则异步化等于给 AI 开关开了一道后门（本模块最要紧的一条）
//   ③ 收敛：失败/超时必须写库并给出可读文案，否则客户端会永远轮询下去
//
// ⚠️ 本模块需 OCR 侧车，与 M09–M11 同属「不进 CI」一档。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M17', '异步任务（绕开 60s 超时天花板）')

const GT_DIR = path.resolve(process.cwd(), 'scripts/ocr-gt/cases')
const GT_IMAGE = path.join(GT_DIR, 'arith-clean.png')

/** 提交任务；返回 { res, id } */
async function submit(c, type, params, opts = {}) {
  const res = await c.api('POST', '/jobs', { body: { type, params }, ...opts })
  return { res, id: res.json?.data?.id }
}

/** 轮询到终态（⚠️ 必须带 token：任务接口一律要登录） */
async function waitDone(c, id, token, maxMs = 90000) {
  const deadline = Date.now() + maxMs
  let last = null
  while (Date.now() < deadline) {
    const r = await c.api('GET', `/jobs/${id}`, { token })
    last = r.json?.data
    if (!last) break
    if (last.status === 'done' || last.status === 'failed') return last
    await new Promise((r2) => setTimeout(r2, 600))
  }
  return last
}

/** 上传一张图，返回公网 URL（attach = 只持久化，不建业务条目） */
async function uploadImage(c, absPath, token) {
  const buf = fs.readFileSync(absPath)
  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'image/png' }), path.basename(absPath))
  form.append('purpose', 'attach')
  form.append('original_name', encodeURIComponent(`m17-${Date.now()}-${path.basename(absPath)}`))
  const r = await c.api('POST', '/upload', { form, token })
  const key = r.json?.data?.file_key || r.json?.data?.key
  const url = r.json?.data?.url || ''
  if (!key) throw new Error(`上传未返回 file_key：${r.text?.slice(0, 200)}`)
  if (/^https?:\/\//i.test(url)) return url
  return `${process.env.GK_ORIGIN || 'http://127.0.0.1:3001'}/api/storage/files/${key}`
}

// ---------------------------------------------------------------- 基本契约

m.test('提交任务立即返回 ticket（202，不等待执行结果）', async (c) => {
  const id = await c.ident('main')
  const { res } = await submit(c, 'ocr-page', { image_url: 'https://invalid.example.com/none.png' }, { token: id.token })
  c.status(res, 202, '提交任务应返回 202 Accepted（而非 200 —— 语义是「已受理未完成」）')
  c.ok(!!res.json?.data?.id, '未返回任务 id')
  c.ok(['pending', 'running'].includes(res.json?.data?.status), `初始状态异常：${res.json?.data?.status}`)
})

m.test('不支持的任务类型 → 400（不得静默建一条没人执行的任务）', async (c) => {
  const id = await c.ident('main')
  const { res } = await submit(c, 'not-a-job', {}, { token: id.token })
  c.status(res, 400)
})

m.test('未登录提交任务 → 401（任务带用户内容，不得匿名）', async (c) => {
  const res = await c.api('POST', '/jobs', { body: { type: 'ocr-page', params: { image_url: 'x' } } })
  c.status(res, [401, 403], '匿名提交被放行了 —— 等于任何人可借任务读别人的图')
})

// ---------------------------------------------------------------- 身份隔离

m.test('🔴 他人任务不可见（越权 → 404，且不区分「不存在」与「无权」）', async (c) => {
  const id = await c.ident('main')
  const { id: jobId } = await submit(
    c, 'ocr-page', { image_url: 'https://invalid.example.com/iso.png' }, { token: id.token },
  )
  const foe = await c.foe()
  const res = await c.api('GET', `/jobs/${jobId}`, { token: foe.token })
  c.status(res, 404, '别人的任务被读到了 —— 任务里存着图片 URL 与题目内容')
})

m.test('任务列表只返回自己的未完成任务', async (c) => {
  // ⚠️ 这里必须提交一个**确定还在跑**的任务：用无效 URL 的任务会在毫秒级失败，
  //    等查列表时它已经是 failed，列表为空 ⇒ 后面「两个列表不相交」的断言
  //    在两边都为空时恒真（假绿）。故用真实图 + precise（实测 60s+）保证它在跑。
  //    用例本身不等它跑完——提交后立刻查，只多花几十毫秒。
  if (!fs.existsSync(GT_IMAGE)) {
    c.ok(false, `缺少真值图 ${GT_IMAGE}`)
    return
  }
  const id = await c.ident('main')
  const foe = await c.foe()
  const url = await uploadImage(c, GT_IMAGE, id.token)
  const { id: jobId } = await submit(
    c, 'ocr-page',
    { image_url: url, mode: 'precise', rectify: true, force: true },
    { token: id.token },
  )
  const mine = await c.api('GET', '/jobs', { token: id.token })
  c.status(mine, 200)
  const list = mine.json?.data || []
  c.ok(list.length >= 1, '自己的未完成任务没出现在列表里')
  c.ok(
    list.every((j) => j.type && j.status),
    '列表项缺少 type/status，前端无法判断该怎么处理',
  )
  // 反向：敌人视角不应看到上面那条
  const foeList = await c.api('GET', '/jobs', { token: foe.token })
  const foeIds = new Set((foeList.json?.data || []).map((j) => j.id))
  const mineIds = new Set(list.map((j) => j.id))
  c.ok(
    [...mineIds].every((x) => !foeIds.has(x)),
    '两个用户的任务列表出现了交集 —— 隔离没生效',
  )
  // 收尾：等这条 precise 任务跑完（60~90s），别把并发闸门占住。
  // 否则后续用例提交会撞上 429「你这个账号已有任务在进行中」，
  // 而报错出现在**别人的用例**里，排查时会误判成那个用例的接口坏了。
  // 这里不断言 done/failed —— 本用例只验隔离，OCR 质量由 ocr-gt 负责。
  if (jobId) await waitDone(c, jobId, id.token, 120000)
})

// ---------------------------------------------------------------- 合规闸门

m.test('🔴 AI 关闭时提交 answer-search → 403（异步化不得绕过 AI 外发闸门）', async (c) => {
  // 这条是本模块最要紧的用例。
  // 任务在后台执行时**没有 req**，若把 `requireAiEnabled` 放进执行器就等于没拦：
  // 用户关了 AI 外发开关，只要还能提交任务，内容照样外发（R-合规-02）。
  //
  // ⚠️ 必须**显式关闭**再验：不能写「403 或 202 都算过」——那种断言恒真，
  //    闸门真被绕过时它照样是绿的。
  const id = await c.ident('main')
  const off = await c.api('PUT', '/settings/ai', { token: id.token, body: { enabled: false } })
  c.status(off, 200, '无法把 AI 开关置为关闭，本用例失去意义')
  const res = await c.api('POST', '/jobs', {
    token: id.token,
    body: { type: 'answer-search', params: { item_id: 'whatever', mode: 'search' } },
  })
  c.status(res, [401, 403], `AI 关闭时提交被放行了（HTTP ${res.status}）—— 异步化开了闸门后门`)
})

m.test('🔴 AI 关闭时提交 search-solve → 403（同上，另一条通道）', async (c) => {
  const id = await c.ident('main')
  const off = await c.api('PUT', '/settings/ai', { token: id.token, body: { enabled: false } })
  c.status(off, 200, '无法把 AI 开关置为关闭，本用例失去意义')
  const res = await c.api('POST', '/jobs', {
    token: id.token,
    body: { type: 'search-solve', params: { question_content: '1+1=?' } },
  })
  c.status(res, [401, 403], `AI 关闭时提交被放行了（HTTP ${res.status}）`)
})

// ---------------------------------------------------------------- 收敛与可读

m.test('任务失败必须落到 failed 并给出可读原因（不得让客户端永远轮询）', async (c) => {
  const id = await c.ident('main')
  const { id: jobId } = await submit(
    c, 'ocr-page', { image_url: 'https://invalid.example.com/fail.png' }, { token: id.token },
  )
  const last = await waitDone(c, jobId, id.token, 60000)
  c.eq(last?.status, 'failed', `任务未收敛到终态（当前 ${last?.status}）`)
  c.ok(!!last?.error, '失败却没有 error —— 前端只能显示「失败，请重试」，无从排查')
  c.ok(
    !/Internal server error|unknown|undefined/i.test(String(last?.error)),
    `error 不可读：「${last?.error}」—— 历史上这类文案让排障只能靠猜`,
  )
})

m.test('轮询不存在的任务 → 404（不暴露「有没有这条记录」）', async (c) => {
  const id = await c.ident('main')
  const res = await c.api('GET', `/jobs/${'0'.repeat(8)}-not-exist`, { token: id.token })
  c.status(res, 404)
})

// ---------------------------------------------------------------- 成功路径

m.test('成功链路：上传图 → 提交 → 轮询得到结果（fast 模式）', async (c) => {
  if (!fs.existsSync(GT_IMAGE)) {
    c.ok(false, `缺少真值图 ${GT_IMAGE}（先跑 scripts/ocr-gt/gen.mjs 生成）`)
    return
  }
  const id = await c.ident('main')
  const url = await uploadImage(c, GT_IMAGE, id.token)
  const { id: jobId } = await submit(c, 'ocr-page', { image_url: url, mode: 'fast', rectify: false }, { token: id.token })
  const last = await waitDone(c, jobId, id.token, 90000)
  c.eq(last?.status, 'done', `任务未成功（status=${last?.status}，error=${last?.error}）`)
  c.ok(Array.isArray(last?.result?.page_text), 'result.page_text 不是数组 —— 前端拿到的结构与同步接口不一致')
  c.ok(!!last?.result?.image_url, 'result 缺 image_url —— 前端展示与裁剪基准会丢')
})

m.test('同参数重复提交命中幂等（deduped），不重复烧算力', async (c) => {
  if (!fs.existsSync(GT_IMAGE)) {
    c.ok(false, `缺少真值图 ${GT_IMAGE}`)
    return
  }
  const id = await c.ident('main')
  const url = await uploadImage(c, GT_IMAGE, id.token)
  const params = { image_url: url, mode: 'fast', rectify: false }
  const a = await submit(c, 'ocr-page', params, { token: id.token })
  // 立刻再提一次：fast 模式 1~3s，此刻前一个必然还在 pending/running
  const b = await submit(c, 'ocr-page', params, { token: id.token })
  c.ok(
    b.res.json?.data?.deduped === true || b.id === a.id,
    `重复提交没命中幂等（deduped=${b.res.json?.data?.deduped}）—— 精准 OCR 是 CPU 密集、搜答案要花钱`,
  )
})

m.test('删除任务记录（清理入口可用）', async (c) => {
  const id = await c.ident('main')
  const { res: subRes, id: jobId } = await submit(
    c, 'ocr-page', { image_url: 'https://invalid.example.com/del.png' }, { token: id.token },
  )
  // ⚠️ 先确认提交成功：并发闸门（全局 3 / 单用户 2）会返回 429，此时 id 为空，
  //    后面「删除未生效」的真实原因就被埋掉了，排查会误判成删除接口坏了。
  c.ok(!!jobId, `提交未返回任务 id（HTTP ${subRes.status}：${String(subRes.json?.message || subRes.text || '').slice(0, 120)}）`)
  if (!jobId) return
  const del = await c.api('DELETE', `/jobs/${jobId}`, { token: id.token })
  c.status(del, 200)
  c.eq(del.json?.data?.deleted, true, '删除未生效')
})

export default m
