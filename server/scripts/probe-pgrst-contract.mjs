/**
 * 穿刺验证 #4：PostgREST + supabase-js 兼容性 —— 协议层实测
 *
 * 目标：不靠推测，直接把本仓库真实使用的 supabase-js 调用模式跑一遍，
 *      抓出它落到 HTTP 上的**确切方法/路径/查询串/请求头**。
 *      这份清单就是"PostgREST 必须支持什么"的唯一判据。
 *
 * 做法：本地起一个回声服务冒充 PostgREST，把 createClient 指向它，
 *      逐条执行真实调用模式，记录请求。
 */
import http from 'node:http'
import { createRequire } from 'node:module'

// 从 server/ 解析依赖（supabase-js 装在 server/node_modules）
const require = createRequire(new URL('../package.json', import.meta.url))
const { createClient } = require('@supabase/supabase-js')

const PORT = 54999
const captured = []

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
    // 注意：同名过滤键会出现多次（如 gte+lte 同列），必须用 getAll 保留，
    // 用 Object.fromEntries 会把多值折叠成最后一个，造成"丢失条件"的假象。
    const query = {}
    for (const k of new Set(url.searchParams.keys())) {
      const all = url.searchParams.getAll(k)
      query[k] = all.length > 1 ? all : all[0]
    }
    captured.push({
      method: req.method,
      path: url.pathname,
      query,
      headers: {
        accept: req.headers['accept'],
        prefer: req.headers['prefer'],
        contentType: req.headers['content-type'],
        apikey: req.headers['apikey'] ? `<${String(req.headers['apikey']).length} chars>` : undefined,
        authorization: req.headers['authorization'] ? 'Bearer <token>' : undefined,
        range: req.headers['range'],
        rangeUnit: req.headers['range-unit'],
      },
      body: body || undefined,
    })
    // 模拟 PostgREST 成功响应
    const wantObject = String(req.headers['accept'] || '').includes('pgrst.object')
    const isWrite = req.method !== 'GET' && req.method !== 'HEAD'
    const payload = wantObject ? {} : []
    res.writeHead(isWrite ? 201 : 200, {
      'Content-Type': 'application/json',
      'Content-Range': '0-0/0',
    })
    res.end(JSON.stringify(payload))
  })
})

await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const supa = createClient(`http://127.0.0.1:${PORT}`, 'probe-anon-key-0123456789', {
  auth: { persistSession: false, autoRefreshToken: false },
})

const cases = []
const run = async (name, fn) => {
  const before = captured.length
  try { await fn() } catch (e) { /* 回声服务不校验语义，忽略 */ }
  cases.push({ name, reqs: captured.slice(before) })
}

const UID = 'u-1'

// 1) 列表：select + eq + order + range + count exact（对应 timeline 列表）
await run('列表(select+eq+order+range+count)', () =>
  supa.from('timeline_items').select('*', { count: 'exact' })
    .eq('user_id', UID).order('created_at', { ascending: false }).range(0, 9))

// 2) maybeSingle（40 处）
await run('maybeSingle', () =>
  supa.from('users').select('id,role').eq('id', UID).maybeSingle())

// 3) single（17 处）
await run('single', () =>
  supa.from('timeline_items').select('*').eq('id', 'x').single())

// 4) insert().select()（22 处）
await run('insert+select', () =>
  supa.from('subjects').insert({ user_id: UID, name: '数学' }).select())

// 5) upsert（3 处）
await run('upsert(onConflict)', () =>
  supa.from('review_schedule').upsert({ id: 'r1', stage: 2 }, { onConflict: 'id' }).select())

// 6) update().eq().select('id')（56 处，删/改都要回行数）
await run('update+select', () =>
  supa.from('timeline_items').update({ title: 't' }).eq('id', 'x').eq('user_id', UID).select('id'))

// 7) delete().eq().select('id')（26 处）
await run('delete+select', () =>
  supa.from('timeline_items').delete().eq('id', 'x').eq('user_id', UID).select('id'))

// 8) 过滤算子全家桶
await run('in/is/neq/gte/lte', () =>
  supa.from('timeline_items').select('id')
    .in('subject_id', ['a', 'b']).is('deleted_at', null).neq('type', 'x')
    .gte('created_at', '2026-01-01').lte('created_at', '2026-12-31'))

// 9) contains('tags',[tag])（数组包含，2 处）
await run('contains(array)', () =>
  supa.from('memory_items').select('*').contains('tags', ['错题']))

// 10) or + ilike + jsonb 路径（timeline 搜索，最"非标准"的一条）
await run('or+ilike+jsonb路径', () =>
  supa.from('timeline_items').select('*')
    .or('title.ilike.%分式%,content->>question.ilike.%分式%'))

// 11) not('x','is',null)（孤儿扫描）
await run('not(is,null)', () =>
  supa.from('timeline_items').select('file_hash').not('deleted_at', 'is', null).not('file_hash', 'is', null))

// 12) head:true + count（7 处只取计数）
await run('head+count', () =>
  supa.from('timeline_items').select('id', { count: 'exact', head: true }).eq('user_id', UID))

// 13) rpc('exec_sql')（provider 占位，确认它会打到 /rest/v1/rpc/<name>）
await run('rpc(exec_sql)', () =>
  supa.rpc('exec_sql', { sql: 'select 1', params: [] }))

// 14) limit（11 处）
await run('limit', () =>
  supa.from('ocr_results').select('*').limit(5))

server.close()

console.log('\n================ 实测抓到的 PostgREST 契约 ================\n')
for (const c of cases) {
  console.log(`【${c.name}】`)
  if (!c.reqs.length) { console.log('  (无请求)\n'); continue }
  for (const r of c.reqs) {
    console.log(`  ${r.method} ${r.path}`)
    if (Object.keys(r.query).length) console.log(`    query: ${JSON.stringify(r.query)}`)
    const h = {}
    for (const [k, v] of Object.entries(r.headers)) if (v) h[k] = v
    console.log(`    headers: ${JSON.stringify(h)}`)
    if (r.body) console.log(`    body: ${r.body.slice(0, 160)}`)
  }
  console.log('')
}

// 汇总：去重后的 (方法, 路径前缀, 关键查询键)
const keys = new Set()
for (const c of cases) for (const r of c.reqs) {
  for (const k of Object.keys(r.query)) keys.add(k)
}
console.log('---- 用到的全部查询串键 ----')
console.log([...keys].sort().join(', '))
console.log('')
console.log('---- 用到的请求头 ----')
const hs = new Set()
for (const c of cases) for (const r of c.reqs) for (const [k, v] of Object.entries(r.headers)) if (v) hs.add(k)
console.log([...hs].sort().join(', '))
