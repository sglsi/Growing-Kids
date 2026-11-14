/* 资料库搜题「按 B」口径离线实证（D-055）
 *
 * 背景：思傅 2026-11-14 拍板按 B（保留入口 + 收敛口径 + 常驻声明），并给出
 * 「用户自己输入的答案是其认为的确定答案，无疑虑」。本轮把服务端 result.note
 * 里「请核对后采纳 / 自行核对」这类话术全部换成中性表述，并 bump CACHE_VERSION
 * v15 → v16（answer_cache 把整个 result 含 note 字符串永久存着，不 bump 会继续吐旧文案）。
 *
 * 项目红线「改 note 判据＝拿新题测」。本脚本直接加载 nest build 的 CommonJS 产物，
 * mock 掉 Supabase / 内存缓存 / 外部检索，对一道 **新题** 调 searchAnswer()，验证：
 *   · 返回的 note 是新口径，不含「核对 / 疑虑 / 存疑」话术
 *   · 本次查询用的 qHash 是 v16 的，且与 v15 的 qHash 不同 ⇒ 旧缓存必然不命中
 *   · 编译产物里同样不含旧话术（本地源码绿 ≠ 发出去的包绿）
 *
 * 不连数据库、不写生产、不依赖网络。跑法（项目根目录）：
 *   node dynamic-tests/run-kb-note-d055.cjs
 */
const { createRequire } = require('node:module')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

const ROOT = path.resolve(__dirname, '..')
const serverReq = createRequire(path.join(ROOT, 'server/package.json'))
const serverDist = (rel) => path.join(ROOT, 'server', 'dist', rel)

const Q = '如图，在三角形 ABC 中，已知边 AB 的长度与角 BAC 的度数，求三角形 ABC 的面积并写出完整推导过程。'
const EXPECT_NOTE = '在你自己录过的题目里找到了这道题的答案'

let failures = 0
function check(ok, label, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!ok) failures++
}

// ---------- 1. 编译产物存在性 ----------
const svcPath = serverDist('answer-search/answer-search.service.js')
const memPath = serverDist('shared/mem-cache.js')
const dbPath = serverDist('storage/database/supabase-client.js')
for (const p of [svcPath, memPath, dbPath]) {
  if (!fs.existsSync(p)) {
    console.error(`缺少编译产物：${p}\n请先在 server/ 跑 npm run build`)
    process.exit(2)
  }
}

// ---------- 2. mock 外部依赖（属性访问 ⇒ 补丁生效） ----------
const supabaseMod = serverReq(dbPath)
let table = ''
const chain = {
  from(t) { table = t; return this },
  select() { return this }, eq() { return this }, is() { return this },
  neq() { return this }, limit() { return this }, order() { return this },
  insert() { return this }, update() { return this }, upsert() { return this },
  single() { return this },
  then(resolve) { resolve({ data: table === 'answer_cache' ? [] : [], error: null }) },
}
supabaseMod.getSupabaseClient = () => chain

const memMod = serverReq(memPath)
const seenKeys = []
memMod.cacheGet = async (key) => { seenKeys.push(String(key)); return null }
memMod.cacheSet = async () => {}

const { AnswerSearchService } = serverReq(svcPath)
const timeline = {
  findOne: async () => ({ id: 'item-1', title: '一道题', content: { question: Q } }),
  withUrls: async (rows) => rows,
}
const ocr = { recognizeBlockText: async () => '' }
const netdisk = { search: async () => ({ hits: [], keys: [], references: [] }) }
const svc = new AnswerSearchService(timeline, ocr, netdisk)

// 私有方法在 CJS 产物里是普通属性：只替换外部依赖，不动判定与组装逻辑
svc.checkQuota = async () => ({ ok: true, used: 0, limit: 20 })
svc.cacheRead = async () => null
svc.cacheWrite = async () => {}
svc.searchOwnAnswers = async () => ({ answer: '12', solution: '', title: '我以前录过的题' })

// ---------- 3. 拿新题实测 ----------
;(async () => {
  const res = await svc.searchAnswer('user-offline', 'item-1', { mode: 'kb' })

  check(res.source === 'netdisk' && res.match_level === 'exact',
    '新题走通自有题库 exact 分支', `source=${res.source} match_level=${res.match_level}`)
  check(res.note === EXPECT_NOTE,
    'note 为新口径（顺带修正旧文案张冠李戴：查的是自有题库，却写「运营者提供的公共资料库」）',
    `note=${JSON.stringify(res.note)}`)
  check(!/核对|疑虑|存疑|采纳/.test(res.note), 'note 不含核对/疑虑/采纳话术')

  const h16 = crypto.createHash('sha256').update(`v16:${Q}`).digest('hex').slice(0, 32)
  const h15 = crypto.createHash('sha256').update(`v15:${Q}`).digest('hex').slice(0, 32)
  check(h16 !== h15, 'v15 与 v16 的 qHash 不同')
  check(seenKeys.some((k) => k.includes(h16)), '本次查询按 v16 取缓存键',
    `keys=${JSON.stringify(seenKeys)}`)
  check(!seenKeys.some((k) => k.includes(h15)), '本次查询不再可能命中 v15 旧缓存')

  const built = fs.readFileSync(svcPath, 'utf8')
  const olds = ['请核对后采纳', '核对后再采纳', '按来源核对后采纳', '自行核对', '找到这道题的参考答案']
  const left = olds.filter((s) => built.includes(s))
  check(left.length === 0, '编译产物不含任何旧话术', left.length ? `残留=${left.join(' / ')}` : '')
  check(built.includes("const CACHE_VERSION = 'v16'"), '编译产物里的 CACHE_VERSION 为 v16')

  console.log(failures === 0
    ? '\n结论：按 B 的新口径已进编译产物，新题实测拿到新 note，旧缓存键必然失效。'
    : `\n结论：${failures} 项未通过。`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  console.error('实证脚本异常：', e)
  process.exit(2)
})
