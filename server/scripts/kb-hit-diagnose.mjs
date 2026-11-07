#!/usr/bin/env node
// 资料库检索命中诊断（P-013 基线，2026-11-07）
//
// 用途：回答「一道真实录入题，为什么在资料库里拿不到 exact」，把断点分层定位：
//   ① 题干是否合格（长度 / 是否整页 / 是否多题连排）
//   ② 召回侧关键词提取了什么（keys）——是不是全是题干开头的非判别性碎片
//   ③ 正文通道召回几份、深挖几份、判定层为什么拒绝（rejectReason / matchFactors）
//   ④ 库里到底有没有这道原题（需 ssh 上 L3 跑 --db，见文件末尾说明）
//
// 🔴 只读：默认只打 GET /api/netdisk/search，**不写生产数据**。
//    `--full` 会额外打 POST /api/answer-search/:id，该端点会写 answer_cache，
//    仅在需要核对「用户实际看到什么」时才加，且必须知悉它会留痕。
// 🔴 令牌：默认从开发者工具模拟器逻辑层 wx.getStorageSync('gk_auth_token') 取；
//    也可用 --token 或 GK_AUTH_TOKEN 传入。禁止把令牌写进仓库文件。
//
// 用法：
//   node server/scripts/kb-hit-diagnose.mjs
//   node server/scripts/kb-hit-diagnose.mjs --limit 6 --full
//   node server/scripts/kb-hit-diagnose.mjs --token <v1.xxx>
//   NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost node ...（curl 代理环境下）

const BASE = process.env.GK_API_BASE || 'https://deep-root.cn/api'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
}
const limit = Number(flag('--limit') || 6)
const full = argv.includes('--full')
const casesOnly = argv.includes('--cases-only')

// 手工切好的单题对照集：用来把「题干质量」和「召回能力」两个变量拆开。
// 来源＝2026-11-07 当前登录账号的 6 条真实录入题，人工切出其中一小题。
const CASES = [
  {
    tag: '几何-单小问',
    q: '如图1，ABCD，∠ABC=60°，AB=3，BC=5，M、N分别为AD、DC上的点，DM+DN=4，则四边形BMDN的面积最大值是多少？',
    dbProbe: 'BMDN',
  },
  {
    tag: '几何-单小问-修错字',
    q: '如图1，在平行四边形ABCD中，∠ABC=60°，AB=3，BC=5，M、N分别为AD、DC上的点，DM+DN=4，则四边形BMDN的面积最大值是多少？',
    dbProbe: 'BMDN',
  },
  {
    tag: '英语-整页首题',
    q: 'With the of modern technology, scientists got a photo of a black hole. A. result B. support C. advice D. description',
    dbProbe: 'black hole',
  },
  {
    tag: '英语-整页首题-修错字',
    q: 'With the development of modern technology, scientists got a photo of a black hole. A. result B. support C. advice D. description',
    dbProbe: 'black hole',
  },
  {
    tag: '英语-填空单题-修错字',
    q: 'The tsunami swept through the village and destroyed many houses.',
    dbProbe: 'tsunami',
  },
]

async function getToken() {
  const explicit = flag('--token') || process.env.GK_AUTH_TOKEN
  if (explicit) return explicit
  try {
    const { connectApp } = await import('./ide-cdp.mjs')
    const { cdp } = await connectApp()
    const raw = await cdp.eval(
      `(() => { try { return String(wx.getStorageSync("gk_auth_token")||"") } catch(e) { return "" } })()`,
    )
    cdp.close()
    return String(raw || '').replace(/^"|"$/g, '')
  } catch (e) {
    return ''
  }
}

async function probe(token, q) {
  const t0 = Date.now()
  const r = await fetch(`${BASE}/netdisk/search?q=${encodeURIComponent(q)}`, {
    headers: { 'X-Auth-Token': token },
    signal: AbortSignal.timeout(90_000),
  })
  const d = (await r.json())?.data || {}
  const hits = d.hits || []
  const levels = hits.reduce((m, h) => {
    const k = h.matchLevel || '?'
    m[k] = (m[k] || 0) + 1
    return m
  }, {})
  const exact = hits.filter((h) => h.matchLevel === 'exact')
  return {
    status: r.status,
    tookMs: Date.now() - t0,
    keys: d.keys || [],
    levels,
    exact: exact.length,
    withLocation: exact.filter((h) => h.sourceLocation).length,
    note: String(d.note || ''),
    top: hits[0] || null,
  }
}

function show(tag, q, p) {
  const flags = []
  if (q.length > 6000) flags.push('超长(>6000字)')
  else if (q.length > 1200) flags.push('整页嫌疑')
  if (/\d{1,3}\s*[.、．)）]/.test(q) && /[。；;]\s*\d{1,3}\s*[.、．)）]/.test(q)) flags.push('多题连排')
  const head = `${String(p.status)} ${String(p.tookMs).padStart(5)}ms q=${String(q.length).padStart(5)}字`
  const dist = `hits=${Object.values(p.levels).reduce((a, b) => a + b, 0)} ${JSON.stringify(p.levels)} exact=${p.exact} 定位=${p.withLocation}`
  console.log(`${tag.padEnd(22)} | ${head} | ${dist}${flags.length ? ` | ⚠ ${flags.join('/')}` : ''}`)
  console.log(`  keys: ${JSON.stringify(p.keys)}`)
  if (p.top?.rejectReason) console.log(`  reject: ${p.top.rejectReason}`)
  if (p.top?.matchFactors?.store) {
    const s = p.top.matchFactors.store
    console.log(`  store: total=${s.total} usable=${s.usable} structured=${s.structured ?? '?'}`)
  }
  if (p.note) console.log(`  note: ${p.note.slice(0, 150)}`)
}

async function main() {
  const token = await getToken()
  if (!token) {
    console.log('❌ 拿不到登录令牌：请确认开发者工具模拟器已打开项目，或用 --token / GK_AUTH_TOKEN')
    process.exit(2)
  }
  console.log(`API=${BASE}  token=${token.slice(0, 3)}… len=${token.length}  mode=${full ? 'full(会写缓存)' : '只读'}\n`)

  let totalExact = 0
  let totalCases = 0

  if (!casesOnly) {
    console.log('==== ① 真实录入题（原样题干） ====')
    const lr = await fetch(`${BASE}/timeline?scope=recent&page=1&page_size=${limit}`, {
      headers: { 'X-Auth-Token': token },
      signal: AbortSignal.timeout(20_000),
    })
    const lj = await lr.json()
    const rows = lj?.data?.items || lj?.data?.list || lj?.data?.rows || []
    console.log(`题目列表 HTTP ${lr.status}，取到 ${rows.length} 条\n`)
    for (const [i, it] of rows.entries()) {
      const c = it.content || {}
      const q = String(c.question || c.stem || it.title || '').trim()
      if (!q) continue
      const p = await probe(token, q.slice(0, 6000))
      show(`[真实${i + 1}]`, q, p)
      totalExact += p.exact
      totalCases += 1
      if (full) {
        const r = await fetch(`${BASE}/answer-search/${it.id}`, {
          method: 'POST',
          headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'kb' }),
          signal: AbortSignal.timeout(90_000),
        })
        const d = (await r.json())?.data || {}
        console.log(`  answer-search: ${r.status} source=${d.source} verified=${d.verified} ans=${(d.answer || '').length}字`)
      }
    }
  }

  console.log('\n==== ② 手工切好的单题对照（把题干质量变量去掉） ====')
  for (const c of CASES) {
    const p = await probe(token, c.q)
    show(c.tag, c.q, p)
    totalExact += p.exact
    totalCases += 1
  }

  console.log(`\n==== 汇总 ====`)
  console.log(`  ${totalCases} 次检索，exact=${totalExact}`)
  console.log(`  库内原题存在性需另跑（只读，L3）：`)
  console.log(`    ssh ubuntu@42.192.36.120 "sudo -n -u postgres psql -d gk -Atc \\"select count(*) from question_objects where stem_text like '%BMDN%'\\""`)
  console.log(`  2026-11-07 基线：question_objects 含 BMDN=4 行、∠ABC=60 类=33 行、`)
  console.log(`    text_flat 含 BMDN=47 份；但 6 条真实题 + 5 个手工单题 exact 全为 0。`)
  console.log(`  ⇒ 断点不在「题库没有原题」，也不在判定层（store.usable 正常、rejectReason 合理），`)
  console.log(`    而在召回侧：粗筛 textAnchors 取的是 extractDistinctive().keys 前 4 个，`)
  console.log(`    全是题干开头的 6 字滑窗碎片（如 DABC60/C60AB3），原题文件进不了深挖池。`)
}

main().catch((e) => {
  console.error('❌ 诊断失败：', e.message)
  process.exit(1)
})
