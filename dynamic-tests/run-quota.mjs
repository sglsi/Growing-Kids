// 策略 3（生命周期分层）+ 策略 6（配额）动态验证
//
// 与 run-storage.mjs 同一套方法论：真实编译 server-v4 源码执行，
// 外部依赖（@nestjs/common、Supabase 客户端）用**替身**替换，
// 于是「档位 / 双阈值 / 灰度 / 缓存 / 分层天数边界 / 成本估算」都能真跑一遍。
//
// 关键原则（L2）：每条正向断言都配一条**反向证伪** ——
// 例如「原图不计入配额」，要同时断言「display 计入了」，否则测试自证无意义。
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const ts = require('/workspace/projects/server/node_modules/typescript')

let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

const OUT = '/tmp/quota-test'
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

// ---------- 1) 替身：@nestjs/common 与 Supabase 客户端 ----------
fs.writeFileSync(path.join(OUT, 'nest-stub.mjs'), `
export const logs = []
export const Injectable = () => (t) => t
export class Logger {
  constructor(name) { this.name = name }
  warn(m) { logs.push(['warn', String(m)]) }
  log(m) { logs.push(['log', String(m)]) }
  error(m) { logs.push(['error', String(m)]) }
}
`)

// 内存版 PostgREST：支持 .select().eq().is().in() 链式 + await + .maybeSingle()
fs.writeFileSync(path.join(OUT, 'supabase-stub.mjs'), `
export const db = {
  user_quota: [], timeline_items: [], library_docs: [], documents: [], blob_objects: [],
}
export const stats = { queries: 0 }

class Q {
  constructor(table) { this.table = table; this.filters = [] }
  select() { return this }
  eq(col, val) { this.filters.push(['eq', col, val]); return this }
  is(col, val) { this.filters.push(['is', col, val]); return this }
  in(col, vals) { this.filters.push(['in', col, vals]); return this }
  async maybeSingle() {
    const { data } = await this.run()
    return { data: data && data.length ? data[0] : null, error: null }
  }
  async run() {
    stats.queries++
    let rows = (db[this.table] || []).slice()
    for (const [op, col, val] of this.filters) {
      if (op === 'eq') rows = rows.filter((r) => r[col] === val)
      else if (op === 'is') rows = rows.filter((r) => (r[col] ?? null) === val)
      else if (op === 'in') rows = rows.filter((r) => val.includes(r[col]))
    }
    return { data: rows, error: null }
  }
  then(res, rej) { return this.run().then(res, rej) }
}

export function getSupabaseClient() {
  return { from: (t) => new Q(t) }
}
`)

// ---------- 2) 编译被测源码 ----------
function compile(relPath, outName) {
  const src = fs.readFileSync(path.join('/workspace/projects/server/src', relPath), 'utf8')
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, isolatedModules: true, experimentalDecorators: true },
  }).outputText
    .replace(/from\s*["']@nestjs\/common["']/g, `from "${path.join(OUT, 'nest-stub.mjs')}"`)
    .replace(/from\s*["']\.\.\/storage\/database\/supabase-client["']/g, `from "${path.join(OUT, 'supabase-stub.mjs')}"`)
    .replace(/from\s*["']\.\/quota-policy["']/g, `from "./quota-policy.mjs"`)
  fs.writeFileSync(path.join(OUT, outName), js)
  return path.join(OUT, outName)
}

compile('quota/quota-policy.ts', 'quota-policy.mjs')
compile('quota/quota.service.ts', 'quota.service.mjs')
compile('storage/tier-stats.ts', 'tier-stats.mjs')

const policy = await import(path.join(OUT, 'quota-policy.mjs'))
const { QuotaService } = await import(path.join(OUT, 'quota.service.mjs'))
const { computeTierReport, TIER_RULES } = await import(path.join(OUT, 'tier-stats.mjs'))
const stub = await import(path.join(OUT, 'supabase-stub.mjs'))
const db = stub.db

const MB = 1024 * 1024
const GB = 1024 * 1024 * 1024
const DAY = 86400000

console.log('=== 一、档位常量（策略 6 §三）===')
{
  const T = policy.QUOTA_TIERS
  check('四档齐备（anonymous/free/member/family）',
    ['anonymous', 'free', 'member', 'family'].every((k) => T[k]))
  check('免费档 500MB / 300 张', T.free.quotaBytes === 500 * MB && T.free.quotaCount === 300,
    `${T.free.quotaBytes}/${T.free.quotaCount}`)
  check('会员档 10GB / 5000 张', T.member.quotaBytes === 10 * GB && T.member.quotaCount === 5000)
  check('家庭档 50GB 且张数不设限', T.family.quotaBytes === 50 * GB && T.family.quotaCount === Number.MAX_SAFE_INTEGER)
  check('档位存储量单调递增', T.anonymous.quotaBytes < T.free.quotaBytes && T.free.quotaBytes < T.member.quotaBytes && T.member.quotaBytes < T.family.quotaBytes)
  check('默认档位 = 免费档', policy.DEFAULT_TIER.tier === 'free')
  check('每档都有月流量兜底（原图不计配额后的安全阀）',
    ['anonymous', 'free', 'member', 'family'].every((k) => T[k].monthlyBytes > 0))
}

console.log('=== 二、双阈值判定（先到先触发）===')
{
  const tier = policy.QUOTA_TIERS.free
  const fit = { usedBytes: 100 * MB, usedCount: 10 }
  check('未超限时放行', policy.decideQuota(fit, tier, 10 * MB).over === false)

  const many = policy.decideQuota({ usedBytes: 1 * MB, usedCount: 300 }, tier, 1 * MB)
  check('张数先到 ⇒ QUOTA_COUNT', many.over === true && many.code === 'QUOTA_COUNT', String(many.code))

  const heavy = policy.decideQuota({ usedBytes: 499 * MB, usedCount: 3 }, tier, 10 * MB)
  check('字节先到 ⇒ QUOTA_BYTES', heavy.over === true && heavy.code === 'QUOTA_BYTES', String(heavy.code))

  const both = policy.decideQuota({ usedBytes: 499 * MB, usedCount: 299 }, tier, 10 * MB)
  check('双超时报字节（先判字节，与文档一致）', both.code === 'QUOTA_BYTES')

  // 边界：判据是「>」而不是「>=」⇒ 刚好用满不算超
  check('边界：字节刚好用满不算超',
    policy.decideQuota({ usedBytes: 400 * MB, usedCount: 1 }, tier, 100 * MB).over === false)
  check('边界：张数刚好用满不算超',
    policy.decideQuota({ usedBytes: 1, usedCount: 299 }, tier, 0).over === false)
  check('【反向】多 1 字节即拦截',
    policy.decideQuota({ usedBytes: 400 * MB, usedCount: 1 }, tier, 100 * MB + 1).over === true)
  check('【反向】多 1 张即拦截',
    policy.decideQuota({ usedBytes: 1, usedCount: 300 }, tier, 0).over === true)
}

console.log('=== 三、灰度开关 QUOTA_MODE（三步上线）===')
{
  const n = policy.normalizeMode
  check('四档原样识别', n('off') === 'off' && n('shadow') === 'shadow' && n('warn') === 'warn' && n('block') === 'block')
  check('大小写与空格容错', n('  BLOCK ') === 'block')
  check('非法值退回 warn（默认不阻断，避免误伤存量用户）', n('boom') === 'warn')
  check('未设置 / 空串也退回 warn', n(undefined) === 'warn' && n('') === 'warn')
  check('【反向】非法值不会退化成 block（误阻断最致命）', n('boom') !== 'block' && n('') !== 'block')
}

console.log('=== 四、用量百分比 ===')
{
  const p = policy.usagePct
  check('一半用量 = 50%', p(250 * MB, 500 * MB) === 50)
  check('超量封顶 100（不出现 120%）', p(900 * MB, 500 * MB) === 100)
  check('负数归零', p(-1, 500 * MB) === 0)
  check('配额为 0 时返回 0（不产生 NaN/Infinity）', Number.isFinite(p(100, 0)) && p(100, 0) === 0)
}

console.log('=== 五、用量统计：逻辑口径（真跑 QuotaService）===')
{
  db.blob_objects.push({ content_hash: 'h1', size_bytes: 1 * MB, thumb_bytes: 20 * 1024, original_bytes: 5 * MB })
  db.timeline_items.push({ user_id: 'uA', file_hash: 'h1', size_bytes: null, deleted_at: null })
  db.timeline_items.push({ user_id: 'uB', file_hash: 'h1', size_bytes: null, deleted_at: null })

  const svc = new QuotaService()
  const a = await svc.usageOf('uA')
  const expect = 1 * MB + 20 * 1024
  check('计入 display + thumb', a.usedBytes === expect, `${a.usedBytes}`)
  check('【反向】原图留档不计入配额（5MB original 被排除）',
    a.usedBytes < 5 * MB && a.usedBytes === expect, `${a.usedBytes}`)
  check('usedCount 按条目计', a.usedCount === 1, `${a.usedCount}`)

  // 跨用户「不摊薄」才是逻辑口径的核心：同一份物理文件，两人都按全量计
  const b = await svc.usageOf('uB')
  check('跨用户引用同一 blob 各计全量（不摊薄）', b.usedBytes === expect && b.usedBytes === a.usedBytes)

  // 同用户内重复引用同一 blob ⇒ 只计一次（否则删一条不释放，用户无法自我管理）
  db.timeline_items.push({ user_id: 'uA', file_hash: 'h1', size_bytes: null, deleted_at: null })
  const a2 = new QuotaService()
  const a2u = await a2.usageOf('uA')
  check('同用户内同 hash 只计一次字节', a2u.usedBytes === expect, `${a2u.usedBytes}`)
  check('但张数按条目累计', a2u.usedCount === 2, `${a2u.usedCount}`)

  // 软删释放
  db.timeline_items.push({ user_id: 'uC', file_hash: 'h1', size_bytes: null, deleted_at: '2026-01-01T00:00:00Z' })
  const c = await new QuotaService().usageOf('uC')
  check('已软删不计入（删了就释放，用户有自我管理路径）', c.usedCount === 0 && c.usedBytes === 0)

  // 无 hash 的旧数据兜底
  db.library_docs.push({ user_id: 'uD', file_hash: null, size_bytes: 3 * MB, deleted_at: null })
  const d = await new QuotaService().usageOf('uD')
  check('无 file_hash 的旧数据用条目 size_bytes 兜底', d.usedBytes === 3 * MB && d.usedCount === 1)
}

console.log('=== 六、档位来源（user_quota 表 / 匿名兜底）===')
{
  db.user_quota.push({ user_id: 'uM', tier: 'member', quota_bytes: 10 * GB, quota_count: 5000, monthly_bytes: 2 * GB })
  const m = await new QuotaService().usageOf('uM')
  check('表内有档位 ⇒ 用表内值', m.tier === 'member' && m.quotaBytes === 10 * GB && m.quotaCount === 5000)

  const f = await new QuotaService().usageOf('noSuchUser')
  check('表内无记录 ⇒ 落到免费档', f.tier === 'free' && f.quotaBytes === 500 * MB)

  const anon = await new QuotaService().usageOf('')
  check('匿名用户走 anonymous 档', anon.tier === 'anonymous' && anon.quotaBytes === 20 * MB)
  check('匿名用户不查库（用量为 0，避免全表扫描）', anon.usedBytes === 0 && anon.usedCount === 0)

  // 表内坏值兜底：quota_bytes 为 0 时不该变成「无限容量」
  db.user_quota.push({ user_id: 'uZ', tier: 'weird', quota_bytes: 0, quota_count: 0, monthly_bytes: 0 })
  const z = await new QuotaService().usageOf('uZ')
  check('表内配额为 0 时退回免费档默认值（不出现 0 配额误判）', z.quotaBytes === 500 * MB, `${z.quotaBytes}`)
}

console.log('=== 七、上传预检与灰度行为 ===')
{
  db.blob_objects.push({ content_hash: 'hBig', size_bytes: 600 * MB, thumb_bytes: 0, original_bytes: 0 })
  db.timeline_items.push({ user_id: 'uBig', file_hash: 'hBig', size_bytes: null, deleted_at: null })

  const run = async (mode) => {
    process.env.QUOTA_MODE = mode
    const s = new QuotaService()
    return s.checkUpload('uBig', 1 * MB)
  }
  const off = await run('off')
  check('mode=off ⇒ 超限也放行（完全不启用）', off.allowed === true && off.mode === 'off')
  const shadow = await run('shadow')
  check('mode=shadow ⇒ 只观察不阻断', shadow.allowed === true && shadow.code === 'QUOTA_BYTES')
  const warn = await run('warn')
  check('mode=warn ⇒ 带 code 但仍放行（默认档）', warn.allowed === true && warn.code === 'QUOTA_BYTES')
  const block = await run('block')
  check('mode=block ⇒ 真正拦截', block.allowed === false && block.code === 'QUOTA_BYTES')
  check('【反向】被拦截时仍回传用量（前端要展示「还差多少」）', block.usage && block.usage.quotaBytes === 500 * MB)

  process.env.QUOTA_MODE = 'block'
  const okUser = await new QuotaService().checkUpload('uM', 1 * MB)
  check('未超限 ⇒ 即使 block 模式也放行', okUser.allowed === true && okUser.code === undefined)

  // 张数维度也要能被 block 拦住（双阈值的另一条腿）
  const many = []
  for (let i = 0; i < 301; i++) many.push({ user_id: 'uMany', file_hash: null, size_bytes: 0, deleted_at: null })
  db.timeline_items.push(...many)
  const cnt = await new QuotaService().checkUpload('uMany', 0)
  check('张数超限在 block 模式被拦截，且 code=QUOTA_COUNT', cnt.allowed === false && cnt.code === 'QUOTA_COUNT', String(cnt.code))

  process.env.QUOTA_MODE = 'warn'
}

console.log('=== 八、用量缓存（60s）与失效 ===')
{
  const before = stub.stats.queries
  const s = new QuotaService()
  const u1 = await s.usageOf('uA')
  const q1 = stub.stats.queries - before
  const u2 = await s.usageOf('uA')
  check('第二次读取命中缓存（不再查库）', stub.stats.queries - before === q1, `${stub.stats.queries - before} vs ${q1}`)
  check('缓存内容一致', u2.usedBytes === u1.usedBytes)

  db.timeline_items.push({ user_id: 'uA', file_hash: null, size_bytes: 7 * MB, deleted_at: null })
  const u3 = await s.usageOf('uA')
  check('未失效前读到的是旧值（证明缓存确实生效）', u3.usedBytes === u1.usedBytes)
  s.invalidate('uA')
  const u4 = await s.usageOf('uA')
  check('invalidate 后立即重算（上传完必须失效，否则配额算不准）', u4.usedBytes === u1.usedBytes + 7 * MB, `${u4.usedBytes}`)
}

console.log('=== 九、分层统计：转档天数边界（策略 3）===')
{
  const now = Date.now()
  const ago = (d) => new Date(now - d * DAY).toISOString()
  check('展示图转低频 = 90 天（与控制台规则一致）', TIER_RULES.displayToInfrequentDays === 90)
  check('原图转低频 = 30 天 / 转归档 = 180 天',
    TIER_RULES.originalToInfrequentDays === 30 && TIER_RULES.originalToArchiveDays === 180)
  check('临时对象 24 小时删除（策略 5②/7）', TIER_RULES.tempDeleteHours === 24)

  // 注意：一行同时带 display / original 两档，而两档的转档天数不同（90 / 30 / 180），
  // 若同一行给两档都赋值，断言就会互相污染 ⇒ 每行只让「被测档位」有字节，其余置 0。
  const rows = [
    // 展示图 90 天边界（±1 小时）
    { kind: 'image', size_bytes: 1000, original_bytes: 0, thumb_bytes: 0, last_ref_at: ago(90 + 1 / 24) },
    { kind: 'image', size_bytes: 1000, original_bytes: 0, thumb_bytes: 0, last_ref_at: ago(90 - 1 / 24) },
    // 原图 30 天边界
    { kind: 'image', size_bytes: 0, original_bytes: 5000, thumb_bytes: 0, last_ref_at: ago(31) },
    { kind: 'image', size_bytes: 0, original_bytes: 5000, thumb_bytes: 0, last_ref_at: ago(29) },
    // 原图 180 天边界
    { kind: 'image', size_bytes: 0, original_bytes: 9000, thumb_bytes: 0, last_ref_at: ago(181) },
    { kind: 'image', size_bytes: 0, original_bytes: 7000, thumb_bytes: 0, last_ref_at: ago(179) },
    // 文档 90 天
    { kind: 'doc', size_bytes: 2000, last_ref_at: ago(91) },
    // 临时对象 24 小时
    { kind: 'temp', size_bytes: 300, last_ref_at: new Date(now - 25 * 3600 * 1000).toISOString() },
    { kind: 'temp', size_bytes: 300, last_ref_at: new Date(now - 23 * 3600 * 1000).toISOString() },
    // 缩略图（哪怕放了 400 天也刻意不转档）
    { kind: 'image', size_bytes: 0, original_bytes: 0, thumb_bytes: 50, last_ref_at: ago(400) },
  ]
  const r = computeTierReport(rows, now)

  check('展示图：≥90 天转低频、<90 天不转', r.lifecycle.displayToInfrequent.bytes === 1000,
    `${r.lifecycle.displayToInfrequent.bytes}`)
  check('原图：≥30 天转低频（31 天命中）', r.lifecycle.originalToInfrequent.bytes === 5000 + 7000,
    `${r.lifecycle.originalToInfrequent.bytes}`)
  check('【反向】29 天的原图不转档（未计入低频）',
    r.lifecycle.originalToInfrequent.bytes === 12000 && r.byTier.find((b) => b.tier === 'original').coldBytes === 21000,
    `${r.byTier.find((b) => b.tier === 'original').coldBytes}`)
  check('原图：≥180 天转归档（181 天命中）', r.lifecycle.originalToArchive.bytes === 9000)
  check('179 天仍只算低频（不重复计入归档）',
    r.lifecycle.originalToArchive.bytes === 9000 && r.lifecycle.originalToInfrequent.bytes === 12000)
  check('文档：≥90 天转低频', r.lifecycle.docToInfrequent.bytes === 2000)
  check('临时对象：>24 小时进删除队列', r.lifecycle.tempToDelete.objects === 1)
  check('【反向】23 小时的临时对象不删', r.lifecycle.tempToDelete.bytes === 300)
  check('缩略图刻意留在标准存储（<64KB 转档不省钱）',
    r.lifecycle.thumbKeptStandard.bytes === 50 && r.lifecycle.thumbKeptStandard.objects === 1)
  check('【反向】缩略图放了 400 天也不进任何转档队列',
    r.lifecycle.displayToInfrequent.bytes + r.lifecycle.originalToInfrequent.bytes +
    r.lifecycle.originalToArchive.bytes + r.lifecycle.docToInfrequent.bytes === 1000 + 12000 + 9000 + 2000)
  check('无时间戳的行视为最冷（保守口径）',
    computeTierReport([{ kind: 'image', size_bytes: 10, original_bytes: 10, thumb_bytes: 0, last_ref_at: null }], now)
      .lifecycle.originalToArchive.objects === 1)
  check('数据缺口被标出（original_bytes 为空的老数据）',
    computeTierReport([{ kind: 'image', size_bytes: 10, thumb_bytes: 0, last_ref_at: ago(1) }], now)
      .missingOriginalBytes === 1)
}

console.log('=== 十、分层成本估算 ===')
{
  const now = Date.now()
  const ago = (d) => new Date(now - d * DAY).toISOString()
  // 冷数据：全部远超 180 天
  const cold = [
    { kind: 'image', size_bytes: 1 * GB, original_bytes: 3 * GB, thumb_bytes: 20 * MB, last_ref_at: ago(400) },
    { kind: 'doc', size_bytes: 500 * MB, last_ref_at: ago(400) },
  ]
  const rc = computeTierReport(cold, now)
  check('冷数据分层后月费下降', rc.cost.monthlyYuanAfter < rc.cost.monthlyYuanNow,
    `${rc.cost.monthlyYuanNow} → ${rc.cost.monthlyYuanAfter}`)
  check('节省比例可量化（savedPct > 0）', rc.cost.savedPct > 0, `${rc.cost.savedPct}%`)
  check('原图是收益主体（归档单价约为标准的 17%）', rc.cost.savedPct > 40, `${rc.cost.savedPct}%`)

  const hot = [
    { kind: 'image', size_bytes: 1 * GB, original_bytes: 3 * GB, thumb_bytes: 20 * MB, last_ref_at: ago(1) },
  ]
  const rh = computeTierReport(hot, now)
  check('【反向】全新数据不产生节省（savedPct = 0）', rh.cost.savedPct === 0, `${rh.cost.savedPct}`)
  check('【反向】全新数据转档前后费用相同', rh.cost.monthlyYuanAfter === rh.cost.monthlyYuanNow)
  check('临时对象不计入当前月费（即将删除）',
    computeTierReport([{ kind: 'temp', size_bytes: 1 * GB, last_ref_at: ago(1) }], now).cost.monthlyYuanNow === 0)
  console.log(`  示例：4.5GB 冷数据 ${rc.cost.monthlyYuanNow} 元/月 → ${rc.cost.monthlyYuanAfter} 元/月（省 ${rc.cost.savedPct}%）`)
}

console.log('=== 十一、源码一致性（防替身与真实实现分叉）===')
{
  const read = (p) => fs.readFileSync(p, 'utf8')
  const S = '/workspace/projects/server/src'
  const upSrc = read(S + '/upload/upload.controller.ts')
  const stSrc = read(S + '/storage/storage.service.ts')
  const qSrc = read(S + '/quota/quota.service.ts')
  const tsSrc = read(S + '/storage/tier-stats.service.ts')
  const appSrc = read(S + '/app.module.ts')
  const upMod = read(S + '/upload/upload.module.ts')
  const stMod = read(S + '/storage/storage.module.ts')

  // —— 配额 ——
  check('迁移 0005 存在', fs.existsSync('/workspace/projects/migrations/0005_quota_and_tiering.sql'))
  const m5 = read('/workspace/projects/migrations/0005_quota_and_tiering.sql')
  check('迁移含 user_quota 表（配额档位）', /create table if not exists\s+user_quota/.test(m5))
  check('迁移含 original_bytes / thumb_bytes（分层验收所需）',
    m5.includes('add column if not exists original_bytes') && m5.includes('add column if not exists thumb_bytes'))
  check('迁移幂等（可反复执行）', m5.includes('if not exists'))

  check('上传控制器注入 QuotaService', upSrc.includes('private readonly quotaService: QuotaService'))
  check('上传前做配额预检', upSrc.includes('await this.quotaService.checkUpload('))
  check('临时上传不做配额预检（不占用户空间）', upSrc.includes('if (purpose !== \'temp\') {'))
  check('超限抛 413 且带 QUOTA_BYTES / QUOTA_COUNT',
    upSrc.includes('HttpStatus.PAYLOAD_TOO_LARGE') && upSrc.includes('QUOTA_COUNT'))
  check('上传成功后让配额缓存失效', upSrc.includes('this.quotaService.invalidate(userId)'))
  check('QuotaService 走纯函数决策（便于单测）', qSrc.includes('decideQuota(') && qSrc.includes("from './quota-policy'"))
  check('默认模式不是 block（不误伤存量用户）', read(S + '/quota/quota-policy.ts').includes("? m : 'warn'"))
  check('app.module 注册 QuotaModule', appSrc.includes('QuotaModule'))
  check('upload.module 引入 QuotaModule', upMod.includes('QuotaModule'))

  // —— 分层 ——
  check('StorageService 有 listKeys（控制台规则之外可核对）', stSrc.includes('async listKeys('))
  check('【修 bug】deleteFile 用对象参数 { fileKey }（此前传字符串 ⇒ 静默失败）',
    /deleteFile\(\{\s*fileKey:\s*key\s*\}\)/.test(stSrc))
  check('删除仍保留字符串签名兜底（SDK 版本差异）', /deleteFile\(key\)/.test(stSrc))
  check('tier-stats.service 调用纯函数统计', tsSrc.includes('computeTierReport('))
  check('storage.module 注册 TierStatsService 与控制器',
    stMod.includes('TierStatsService') && stMod.includes('StorageController'))
  check('分层接口挂在 /api/storage/tier-stats', read(S + '/storage/storage.controller.ts').includes("'tier-stats'"))
  check('分层接口需登录（requireUserId）', read(S + '/storage/storage.controller.ts').includes('requireUserId'))

  // —— 前端联动 ——
  const demoApi = read('/workspace/projects/src/services/api.ts')
  check('前端识别 413 并带出 quotaCode', demoApi.includes('413') && demoApi.includes('quotaCode'))
  check('前端有 fetchStorageUsage', demoApi.includes('export async function fetchStorageUsage'))
  const dp = read('/workspace/projects/src/pages/profile/index.tsx')
  check('个人页展示用量条', dp.includes('fetchStorageUsage') && dp.includes('usage.pct'))
}

console.log(`\n配额与分层动态测试：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
