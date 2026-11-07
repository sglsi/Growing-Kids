#!/usr/bin/env node
// 上游题干质量诊断（P-014 证据脚本，2026-11-07）
//
// 用途：回答「真实录入题为什么拿不到 exact，切题后能不能拿到」，且不写任何生产数据。
//   ① 拉当前登录账号 timeline 的真实录入题原文，做结构画像（长度 / 多小问 / 整页 / 错字）
//   ② 用纯规则 splitRealWorldStems() 把整页/多小问切成单题（该函数即生产侧候选实现原型）
//   ③ 同一条题分别用「原样」与「切出的单题」打 GET /api/netdisk/search，对照 exact 数
//
// 🔴 只读：只打 GET /api/netdisk/search 与 GET /api/timeline，不写 answer_cache、不写库。
// 🔴 令牌：默认从开发者工具模拟器逻辑层 wx.getStorageSync('gk_auth_token') 取；
//    也可用 --token 或 GK_AUTH_TOKEN 传入。禁止把令牌写进仓库文件。
//
// 用法：
//   node server/scripts/kb-upstream-diagnose.mjs --text-only          # 只做结构画像，不检索
//   node server/scripts/kb-upstream-diagnose.mjs --limit 8            # 完整前后对照
//   node server/scripts/kb-upstream-diagnose.mjs --limit 8 --stems 2  # 每条最多测 2 个单题
//
// 代理环境：NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost node ...

const BASE = process.env.GK_API_BASE || 'https://deep-root.cn/api'
const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
}
const limit = Number(flag('--limit') || 8)
const stemsPerCase = Number(flag('--stems') || 3)
const textOnly = argv.includes('--text-only')

// ---------------------------------------------------------------------------
// 纯规则切题原型：零依赖、可原样移植到 server/src/shared/。
// 设计约束（写进 P-014 ④ 算子）：
//   · 绝不删改用户原文中的字符，只做「选哪一段送检索」
//   · 保住设问句（判定层 extractAsk 只看末尾 80 字），单题不跨下一题号
//   · 不为英文/中文各自造规则，只用题号 + 设问特征
//   · 切不出来就返回 []，调用方回退到原样题干（fail-open 到现状，绝不静默换题）
// ---------------------------------------------------------------------------
// 覆盖真实 OCR 里出现的四种题号：`1）` / `（2）` / `( )1.` / `3.` / `16、`
const ITEM_START = /(?:^|\n)[ \t]*(?:[（(]\s*[）)]\s*)?(?:(?:[（(]\s*)?\d{1,3}\s*[）)]|\d{1,3}\s*[．.、]|\d{1,3}\s*[)）])[ \t]*/g
const ASK_HINT = /[?？]|下列|以下|正确的是|错误的是|不正确|是否|能否|求|证明|说明|多少|最小值|最大值|取值范围|周长|面积|填空|选择|选项|正确的是/
const HEADER_HINT = /^(?:[一二三四五六七八九十]+[、．.]|第[一二三四五六七八九十\d]+[章节部分]|要求[:：]|时间[:：]|满分[:：])/

/** 把真实录入文本切成候选单题；返回按「像一道题」排序的若干段 */
export function splitRealWorldStems(raw, { maxStems = 3, maxChars = 900, minChars = 12 } = {}) {
  const src = String(raw || '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '')
  if (!src.trim()) return []

  ITEM_START.lastIndex = 0
  const marks = []
  let mo
  while ((mo = ITEM_START.exec(src)) !== null) {
    marks.push({ at: mo.index, after: ITEM_START.lastIndex, label: mo[0].trim() })
    if (marks.length >= 400) break
  }

  // 起点：有题号就从第一个题号开始（跳过试卷抬头）；无题号则整段当一个对象
  const chunks = marks.length
    ? marks.map((m, i) => ({
        text: src.slice(m.after, i + 1 < marks.length ? marks[i + 1].at : src.length),
        label: m.label,
      }))
    : [{ text: src, label: '(整段无题号)' }]

  const out = []
  for (const c of chunks) {
    let t = c.text.trim()
    // 去掉段内【答案】/【解析】之后的内容：真实录入题偶尔会连解析一起 OCR 进来
    const sol = t.search(/【\s*(?:答案|解析|解答)\s*】|^\s*(?:答案|解析)[:：]/m)
    if (sol > 0) t = t.slice(0, sol).trim()
    // 去掉段内嵌套的「问题解决」等小标题行（不删字符，只压空行）
    t = t.replace(/\n{2,}/g, '\n').trim()
    if (t.length < minChars) continue
    if (HEADER_HINT.test(t) && !ASK_HINT.test(t)) continue
    // 过长：取开头 + 末尾，保住设问句；中间用换行分隔避免造出假连续文本
    if (t.length > maxChars) {
      const headN = Math.floor(maxChars * 0.35)
      const tailN = maxChars - headN - 1
      const head = t.slice(0, headN).replace(/\s+$/, '')
      const tail = t.slice(-tailN).replace(/^\s+/, '')
      // 末尾必须落在完整句：从 tail 开头截到第一个句读之后
      const cut = tail.search(/[。；;！!\n]/)
      t = head + '\n' + (cut > 0 && cut < 60 ? tail.slice(cut + 1) : tail)
    }
    const hasAsk = ASK_HINT.test(t)
    const hasSymbol = /[=＝°△∠√∥∥\d]|[\u4e00-\u9fa5]{2}/.test(t)
    const score =
      (hasAsk ? 6 : 0) +
      (t.length >= 25 && t.length <= 600 ? 3 : 0) +
      (hasSymbol ? 1 : 0) +
      (/[?？]/.test(t.slice(-40)) ? 2 : 0) -
      (t.length > 800 ? 2 : 0)
    out.push({ text: t, label: c.label, len: t.length, hasAsk, score })
  }
  out.sort((a, b) => b.score - a.score || a.len - b.len)
  return out.slice(0, maxStems).map(({ text, label, len, hasAsk, score }) => ({ text, label, len, hasAsk, score }))
}

/** 结构画像：不依赖网络，可离线跑 */
export function profileQuestion(raw) {
  const q = String(raw || '')
  const flags = []
  if (q.length > 6000) flags.push('超长(>6000字,检索会截断)')
  else if (q.length > 1200) flags.push('整页嫌疑')
  ITEM_START.lastIndex = 0
  const n = (q.match(ITEM_START) || []).length
  if (n >= 2) flags.push(`多小问连排(${n}个题号)`)
  if (/时间[:：]\s*\d+\s*分钟|满分[:：]/.test(q)) flags.push('试卷抬头')
  if (/[a-z]{4,}\s*[&]\s*[a-z]{3,}/i.test(q) || /[o0][so0]|\bthrqugh\b|\bwih\b|\bforess\b/i.test(q)) {
    flags.push('OCR错字嫌疑')
  }
  if (/要求[:：]|词数不少于/.test(q)) flags.push('非题目文本(作文要求)')
  return { len: q.length, itemMarks: n, flags }
}

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
  try {
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
      levels,
      exact: exact.length,
      withLocation: exact.filter((h) => h.sourceLocation).length,
      keys: d.keys || [],
      reject: hits[0]?.rejectReason || '',
      note: String(d.note || ''),
    }
  } catch (e) {
    return { status: 0, tookMs: Date.now() - t0, levels: {}, exact: 0, withLocation: 0, keys: [], reject: String(e), note: '' }
  }
}

async function main() {
  const token = await getToken()
  if (!token) {
    console.log('❌ 拿不到登录令牌：请确认开发者工具模拟器已打开项目，或用 --token / GK_AUTH_TOKEN')
    process.exit(2)
  }
  console.log(`API=${BASE}  token=${token.slice(0, 3)}… len=${token.length}  mode=${textOnly ? '仅结构画像(不检索)' : '前后对照(只读)'}\n`)

  const lr = await fetch(`${BASE}/timeline?scope=recent&page=1&page_size=${limit}`, {
    headers: { 'X-Auth-Token': token },
    signal: AbortSignal.timeout(20_000),
  })
  const lj = await lr.json()
  const rows = lj?.data?.items || lj?.data?.list || lj?.data?.rows || []
  console.log(`题目列表 HTTP ${lr.status}，取到 ${rows.length} 条\n`)

  const summary = []
  for (const [i, it] of rows.entries()) {
    const c = it.content || {}
    const q = String(c.question || c.stem || it.title || '').trim()
    if (!q) continue
    const pf = profileQuestion(q)
    const stems = splitRealWorldStems(q, { maxStems: stemsPerCase })
    console.log(`==== [真实${i + 1}] id=${it.id} len=${pf.len} 题号=${pf.itemMarks}  ⚠ ${pf.flags.join(' / ') || '无'} ====`)
    console.log(`  原文头: ${q.slice(0, 150).replace(/\n/g, '\\n')}`)
    console.log(`  切出 ${stems.length} 个候选单题:`)
    for (const [k, s] of stems.entries()) {
      console.log(`    [${k + 1}] ${s.label} len=${s.len} ask=${s.hasAsk} score=${s.score} | ${s.text.slice(0, 110).replace(/\n/g, '\\n')}`)
    }
    if (textOnly) { console.log(''); continue }

    const rawProbe = await probe(token, q.slice(0, 6000))
    console.log(`  ▶ 原样   : HTTP ${rawProbe.status} ${rawProbe.tookMs}ms exact=${rawProbe.exact} 定位=${rawProbe.withLocation} ${JSON.stringify(rawProbe.levels)}`)
    if (rawProbe.reject) console.log(`    reject: ${String(rawProbe.reject).slice(0, 140)}`)

    let best = { exact: 0, withLocation: 0, label: '', tookMs: 0 }
    for (const [k, s] of stems.entries()) {
      const p = await probe(token, s.text)
      console.log(`  ▶ 单题${k + 1}: HTTP ${p.status} ${p.tookMs}ms exact=${p.exact} 定位=${p.withLocation} ${JSON.stringify(p.levels)} | ${s.text.slice(0, 60).replace(/\n/g, '\\n')}`)
      if (p.reject) console.log(`    reject: ${String(p.reject).slice(0, 140)}`)
      if (p.exact > best.exact) best = { exact: p.exact, withLocation: p.withLocation, label: s.label, tookMs: p.tookMs }
    }
    summary.push({ id: it.id, len: pf.len, flags: pf.flags, stems: stems.length, rawExact: rawProbe.exact, best })
    console.log('')
  }

  if (!textOnly) {
    console.log('==== 汇总（因果证据：切题前后 exact） ====')
    const rawTotal = summary.reduce((a, s) => a + s.rawExact, 0)
    const splitTotal = summary.reduce((a, s) => a + (s.best.exact > 0 ? 1 : 0), 0)
    for (const s of summary) {
      console.log(`  ${s.id.slice(0, 8)} len=${String(s.len).padStart(5)} 题=${s.stems} 原样exact=${s.rawExact} 切题后best=${s.best.exact} 定位=${s.best.withLocation} ${s.flags.join('/')}`)
    }
    console.log(`  ⇒ 原样有 exact 的题数：${rawTotal}/${summary.length}；切题后有 exact 的题数：${splitTotal}/${summary.length}`)
    console.log('  ⚠ 样本量小，只作方向性因果证据，不得据此计算召回率；唯一够格指标仍是 0021 review_events 到期首次作答正确率（当前 0 行）。')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
