// 模块 32：结构化题目对象入库验收集（P-010 / D-013 · P1）
//
// 为什么单独一个模块：M31 守的是 P0「运行时现场切分」的行为契约，本模块守的是
// P1「入库时预切分 + 稳定指纹 + 可定点排除」的工程管控能力。两者测的不是一回事：
//   · M31 问「判得对不对」；
//   · M32 问「对象是不是稳定、可复算、可审计、错了能不能定点修」。
//
// ⚠️ 本模块**真跑** `scripts/question-objects-build.mjs --from-fixture`，
//    不是拿 fixture 手工拼几行假数据。构建脚本改了任何字段口径都会当场红。
// ⚠️ 最重要的两条「防洗白」断言在最后：
//    ① 重算指纹后的「题干 A + 别人的解析」**仍会 exact** —— P1 没消除 §8.4 的残余风险；
//    ② P2/P3 仍未批准、不写生产数据 —— 不许因为 P1 落地就顺手放宽召回。
//
// 零依赖单文件契约不变：question-match.ts 仍由 tsc 单编后 require。

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { Module } from '../lib/harness.mjs'

const require = createRequire(import.meta.url)
const m = new Module('M32', '结构化题目对象入库验收集（P-010 / D-013）')

const ROOT = path.resolve(process.cwd(), '..')
const TMP = path.join(ROOT, '.tmp', 'verify-question-objects-store')
const FIXTURE = 'server/scripts/verify/fixtures/question-object-cases.json'
const BUILD = 'server/scripts/question-objects-build.mjs'
const MATCH = 'server/src/shared/question-match.ts'
const STORE = 'server/src/shared/question-object-store.ts'
const MIGRATION = 'migrations/0026_question_objects.sql'
const SERVICE_ND = 'server/src/netdisk/netdisk-search.service.ts'
const SERVICE_AS = 'server/src/answer-search/answer-search.service.ts'
const REPORT = 'docs/reports/资料库正文召回-检索侧四步方案评审.md'
const PROPOSAL = 'docs/design/method/proposals/P-010-题目级结构化切分入库.md'
const DECISION = 'docs/design/method/decision-log.md'
const BACKUP = 'server/scripts/db-backup.mjs'

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const stripNul = (s) => (s || '').replace(/\u0000/g, '')

// ---------- 单编判定核心（与 M27 / M31 同一套做法）----------
fs.mkdirSync(TMP, { recursive: true })
execFileSync(
  process.execPath,
  [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/shared/question-match.ts',
    '--outDir', TMP,
    '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck', '--lib', 'es2019',
  ],
  { cwd: process.cwd(), stdio: 'pipe', encoding: 'utf8' },
)
const COMPILED = path.join(TMP, 'question-match.js')
const Q = require(COMPILED)

// ---------- 真跑构建脚本，产出结构化对象 ----------
const OUT = path.join(TMP, 'objects.json')
const buildOut = () => execFileSync(
  process.execPath,
  [
    path.join(ROOT, BUILD),
    '--from-fixture', path.join(ROOT, FIXTURE),
    '--output', OUT,
    '--compiled', COMPILED,
  ],
  { cwd: path.join(ROOT, 'server'), stdio: 'pipe', encoding: 'utf8' },
)
buildOut()
const built = JSON.parse(fs.readFileSync(OUT, 'utf8'))
const fixture = JSON.parse(read(FIXTURE))
const rows = built.rows
const docById = new Map(fixture.documents.map((d) => [d.id, d]))
const bySource = new Map()
for (const r of rows) {
  if (!bySource.has(r.source_id)) bySource.set(r.source_id, [])
  bySource.get(r.source_id).push(r)
}
const revisionOf = (sid) => sha256(stripNul(docById.get(sid).text))
const run = (q, rs, rev, strict = true) =>
  Q.judgeStoredObjects(q, rs, { hash: sha256, expectedRevision: rev, strict })

const FIELDS = [
  'user_id', 'source_type', 'source_id', 'source_name', 'object_index', 'label',
  'char_start', 'char_end', 'stem_start', 'stem_end', 'stem_text', 'solution_text',
  'has_solution', 'object_fingerprint', 'source_revision', 'link_status',
  'link_reason', 'engine_version',
]

// ============================================================
// 一、构建产物：稳定、可复算、幂等
// ============================================================

m.test('构建脚本真跑：4 份真实语料切出对象，字段与迁移逐字对齐', (c) => {
  c.eq(bySource.size, 4, '来源数不是 4（fixture 没读全）')
  c.ok(rows.length >= 28, `对象数 ${rows.length} 太少，切分规则可能失效`)
  for (const r of rows) {
    for (const f of FIELDS) c.ok(Object.prototype.hasOwnProperty.call(r, f), `对象缺字段 ${f}`)
  }
  const mig = read(MIGRATION)
  for (const f of FIELDS) c.ok(mig.includes(f), `0026 迁移缺列 ${f}`)
})

m.test('🔴 内容指纹可复算 + source_revision = sha256(原文)', (c) => {
  for (const r of rows) {
    c.eq(sha256(Q.objectFingerprintInput(r)), r.object_fingerprint, `#${r.object_index} 指纹不一致`)
    c.eq(r.source_revision, revisionOf(r.source_id), `${r.source_id} 正文版本算错`)
    c.eq(r.engine_version, Q.OBJECT_ENGINE_VERSION, '规则版本没落库')
  }
})

m.test('结构区间合法、link_status 取值受控、标签可追溯', (c) => {
  for (const r of rows) {
    c.ok(r.char_start >= 0 && r.char_end > r.char_start, `#${r.object_index} 对象区间非法`)
    c.ok(r.stem_end >= r.stem_start && r.stem_end <= r.char_end, `#${r.object_index} 题干区间非法`)
    c.ok(['ok', 'rejected'].includes(r.link_status), `#${r.object_index} link_status 越界`)
    c.ok(r.stem_text.trim().length > 0, `#${r.object_index} 题干为空`)
  }
})

m.test('幂等：同一份正文重跑，rows 逐字节相同（built_at 不参与）', (c) => {
  const first = JSON.stringify(rows)
  buildOut()
  const second = JSON.stringify(JSON.parse(fs.readFileSync(OUT, 'utf8')).rows)
  c.eq(second, first, '重跑产生了不同的对象行 —— upsert 会把每行都判成新增')
})

// ============================================================
// 二、判定行为：与 P0 共用闸门，没有数据源豁免
// ============================================================

m.test('🔴 负例误判归零：几何原题 vs 4 份结构化对象，假 exact = 0', (c) => {
  const gq = fixture.meta.geometryQuestion
  for (const [sid, rs] of bySource) {
    const j = run(gq, rs, revisionOf(sid))
    c.eq(j.exact, false, `${sid} 判出了假 exact`)
    c.eq(j.store.usable, rs.length, `${sid} 有对象被无故拒掉，可能影响召回`)
  }
})

m.test('🔴 正例召回 ≥90% + 来源定位 100%（实测 28/28）', (c) => {
  let ok = 0, miss = 0, locOk = 0, total = 0
  for (const [sid, rs] of bySource) {
    for (const r of rs) {
      if (!r.has_solution || r.stem_text.replace(/\s/g, '').length < 30) continue
      total++
      const j = run(r.stem_text.replace(/\n/g, ' '), rs, revisionOf(sid))
      if (j.exact) {
        ok++
        if (j.sourceLocation && j.sourceLocation.objectIndex === r.object_index) locOk++
      } else miss++
    }
  }
  c.ok(total >= 20, `正例样本只有 ${total} 个，验收集失去意义`)
  c.eq(miss, 0, `${miss} 个真实题目被降级`)
  c.eq(ok, total, '正例召回不是 100%')
  c.eq(locOk, total, '来源定位错对象')
})

m.test('P0 / P1 共用六条硬闸与唯一定位选择器，行为不得漂移', (c) => {
  const src = read(MATCH)
  c.ok(/return selectUnique\(scored\)/.test(src), 'judgeObjects 没有改用共用选择器')
  c.ok(/judgeStoredObjects[\s\S]{0,2000}selectUnique\(scored\)/.test(src), '结构化链路没有共用选择器')
  c.ok(/judgeQuestionObject\(question, o, longAnchors/.test(src), '硬闸函数没被复用')
  const sid = [...bySource.keys()][0]
  const doc = docById.get(sid)
  const rs = bySource.get(sid)
  const q = rs[0].stem_text.replace(/\n/g, ' ')
  const p0 = Q.judgeObjects(q, stripNul(doc.text), { sourceId: sid, sourceName: doc.name })
  const p1 = run(q, rs, revisionOf(sid))
  c.eq(p1.exact, p0.exact, '同一题干在 P0 / P1 得到不同结论')
})

m.test('多对象并列达标 ⇒ 唯一性闸门仍降级', (c) => {
  const sid = [...bySource.keys()].find((k) => bySource.get(k).length >= 2)
  const rs = bySource.get(sid)
  const a = rs[0]
  const dup = [{ ...a, object_index: rs.length }, { ...a, object_index: rs.length + 1 }]
  const j = run(a.stem_text.replace(/\n/g, ' '), dup, revisionOf(sid))
  c.eq(j.exact, false, '重复对象并列时没有按「宁可判不出」降级')
  c.eq(j.sourceLocation, undefined, '无法唯一定位却给了来源位置')
})

// ============================================================
// 三、P1 新增的可复算校验与定点排除（P0 做不到的事）
// ============================================================

m.test('🔴 六类入库校验逐条可触发，且 rejected 有留痕', (c) => {
  const sid = [...bySource.keys()].find((k) => bySource.get(k).some((r) => r.has_solution && r.stem_text.replace(/\s/g, '').length >= 30))
  const rs = bySource.get(sid)
  const pos = rs.find((r) => r.has_solution && r.stem_text.replace(/\s/g, '').length >= 30)
  const q = pos.stem_text.replace(/\n/g, ' ')
  const rev = revisionOf(sid)
  const mutate = (patch) => rs.map((r) => r.object_index === pos.object_index ? { ...r, ...patch } : r)
  const cases = [
    ['内容指纹被篡改', mutate({ solution_text: '【解析】由勾股定理得 AB=5，故选 C。' })],
    ['切分规则版本不一致', rs.map((r) => ({ ...r, engine_version: 'qobj-0' }))],
    ['正文版本过期', rs],
    ['link_status 定点排除', mutate({ link_status: 'rejected' })],
    ['结构区间非法', mutate({ char_end: -1 })],
    ['题干为空', mutate({ stem_text: '' })],
  ]
  const stale = run(q, cases[2][1], 'deadbeef')
  c.eq(stale.store.usable, 0, '正文换了版本，旧对象仍被复用')
  for (const [name, patched] of cases) {
    if (name === '正文版本过期') continue
    const j = run(q, patched, rev)
    c.ok(j.store.rejected.some((s) => s.startsWith(`#${pos.object_index}:`)), `${name} 没有留下拒绝原因`)
  }
  c.ok(run(q, rs, rev).exact, '基线正例本身没通过，本用例失去对照意义')
})

m.test('🔴 定点排除：坏对象永不 exact，同文档其它题不受牵连', (c) => {
  const sid = [...bySource.keys()].find((k) => bySource.get(k).filter((r) => r.has_solution && r.stem_text.replace(/\s/g, '').length >= 30).length >= 2)
  const rs = bySource.get(sid)
  const good = rs.filter((r) => r.has_solution && r.stem_text.replace(/\s/g, '').length >= 30)
  const target = good[0], other = good[1]
  const excluded = rs.map((r) => r.object_index === target.object_index ? { ...r, link_status: 'rejected' } : r)
  const rev = revisionOf(sid)
  c.eq(run(target.stem_text.replace(/\n/g, ' '), excluded, rev).exact, false, '被排除对象仍能 exact')
  c.eq(run(other.stem_text.replace(/\n/g, ' '), excluded, rev).exact, true, '定点排除误伤了同文档其它题 —— 这是 P1 的核心价值')
})

// ============================================================
// 四、strict 开关：铺量期不倒退，准启用时不回退
// ============================================================

m.test('strict 语义：无对象时 false=回退 P0 / true=结构化链路负责地不放行', (c) => {
  const q = fixture.meta.geometryQuestion
  const loose = run(q, [], revisionOf('lecture'), false)
  c.eq(loose.structured, false, '非 strict 没有给出回退标记')
  c.eq(loose.exact, false, '回退标记不该自带 exact')
  const strict = run(q, [], revisionOf('lecture'), true)
  c.eq(strict.structured, true, 'strict 时调用方若再回退 P0 就等于闸门失效')
  c.eq(strict.exact, false, 'strict 无对象却放行了 exact')
  const store = read(STORE)
  c.ok(/process\.env\.QUESTION_OBJECTS_STRICT === '1'/.test(store), 'strict 默认不是关（会一上线就清空 exact）')
  c.ok(/if \(!j\.structured\) return fallback\(\)/.test(store), '没有按 structured 决定是否回退')
})

// ============================================================
// 五、静态红线：脚本 / 迁移 / 取数口 / 缓存
// ============================================================

m.test('🔴 构建脚本红线：dry-run 默认、只写目标表、编译产物防漂移、NUL、防误删', (c) => {
  const s = read(BUILD)
  c.ok(/const APPLY = argv\.includes\('--apply'\)/.test(s), '找不到 --apply 开关')
  c.ok(/console\.log\(`模式：\$\{FROM_FIXTURE/.test(s), '没有显式打印 dry-run / APPLY 模式')
  c.ok(/insert into question_objects/.test(s), '没有 upsert 到 question_objects')
  c.ok(!/update netdisk_files|update library_docs|delete from netdisk_files|delete from library_docs/.test(s), '脚本碰了源表')
  c.ok(/编译产物比源码旧，拒绝运行/.test(s), '缺编译产物陈旧检查（改了源码忘 build 会静默漂移）')
  c.ok(/stripNul/.test(s), '没剥 U+0000（P-008 踩过：PG text 不接受 NUL）')
  c.ok(/本轮零对象，按护栏不清库/.test(s), '缺「零对象不清库」护栏')
  c.ok(/超半数，需 --force-clean/.test(s), '缺「待删超半数」护栏')
  c.ok(/const LIBRARY_TEXT_MAX_CHARS = 60_000/.test(s), 'library 正文截断口径变了')
  c.ok(/--from-fixture --apply 必须给 --user/.test(s), 'fixture 真实入库没强制真实 user_id（user_id 有外键会直接失败）')
  c.ok(/await bulkUpsert\(client, all\)/.test(s), 'fixture --apply 没有走与 DB 模式相同的 upsert')
  const sv = read(SERVICE_AS)
  c.ok(sv.includes('.slice(0, 60_000)'), 'service 端截断口径与构建脚本不一致 ⇒ 对象会被永远判过期')
})

m.test('🔴 迁移红线：user_id varchar(36)、唯一键、link_status 受控、诚实边界', (c) => {
  const s = read(MIGRATION)
  c.ok(/user_id\s+varchar\(36\)\s+not null references users\(id\)/.test(s), 'user_id 类型或外键不对')
  c.ok(/unique index[\s\S]{0,200}question_objects \(user_id, source_type, source_id, object_index\)/.test(s), '缺幂等唯一键')
  c.ok(/check \(link_status in \('ok', 'rejected'\)\)/.test(s), 'link_status 没有取值约束')
  c.ok(/不宣称|不是「算法证明|纯文本没有版面坐标/.test(s), '迁移注释没有登记「P1 不证明解析归属」的诚实边界')
})

m.test('🔴 取数红线：无 RLS 必须带 user_id，两处数据源都走同一入口', (c) => {
  const st = read(STORE)
  c.ok(/\.eq\('user_id', userId\)/.test(st), 'question_objects 查询没带 user_id')
  c.ok(/\.eq\('source_type', sourceType\)/.test(st) && /\.eq\('source_id', sourceId\)/.test(st), '没按来源收敛查询')
  c.ok(/if \(error\)[\s\S]{0,120}console\.warn/.test(st), '查询失败被静默吞掉')
  for (const f of ['object_fingerprint', 'source_revision', 'link_status', 'engine_version', 'stem_text', 'solution_text']) {
    c.ok(st.includes(f), `QUESTION_OBJECT_COLUMNS 漏列 ${f}（校验会静默失效）`)
  }
  const nd = read(SERVICE_ND), as = read(SERVICE_AS)
  c.ok(nd.includes('judgeWithStore(question, text, rows,'), '网盘深挖没接结构化入口')
  c.ok(as.includes('judgeWithStore(question, text, rows,'), 'library_docs 没接结构化入口')
  c.ok(nd.includes('loadQuestionObjects(') && as.includes('loadQuestionObjects('), '取数口没有共用')
  c.ok(nd.includes('judgeObjects(question, text,') && as.includes('judgeObjects(question, text,'), 'P0 回退路径被删掉')
  c.ok(/const CACHE_VERSION = 'v10'/.test(as), 'CACHE_VERSION 没 bump 到 v10，老缓存会绕过人工修复')
})

// ============================================================
// 六、防洗白：残余风险仍在 + 后续阶段仍锁
// ============================================================

m.test('🔴 实证：重算指纹后的「题干 A + 别人的解析」仍会 exact —— P1 未消除 §8.4 风险', (c) => {
  const sid = [...bySource.keys()].find((k) => bySource.get(k).some((r) => r.has_solution && r.stem_text.replace(/\s/g, '').length >= 30))
  const rs = bySource.get(sid)
  const pos = rs.find((r) => r.has_solution && r.stem_text.replace(/\s/g, '').length >= 30)
  const fakeSolution = '【答案】C\n【解析】由勾股定理得 AB=5，故选 C。本题解析完全讲的是另一道题的内容，用于验证纯文本边界。'
  const fake = rs.map((r) => {
    if (r.object_index !== pos.object_index) return r
    const patched = { ...r, solution_text: fakeSolution }
    return { ...patched, object_fingerprint: sha256(Q.objectFingerprintInput(patched)) }
  })
  const j = run(pos.stem_text.replace(/\n/g, ' '), fake, revisionOf(sid))
  // 这条断言的存在本身就是「不许假装修好」：哪天有人真用版面坐标解决了，
  // 必须同时改 P-010 / D-013 / 报告 §9，而不是偷偷把这条断言删掉。
  c.eq(j.exact, true, '结构化链路竟能证明解析段归属 —— 与 §8.4 ROC 结论冲突，需重新评估并更新文档')
})

m.test('🔴 文档防篡改：§9 / P-010 / D-013 登记残余风险，P2/P3 仍锁、不写生产', (c) => {
  const report = read(REPORT)
  c.ok(/^## 9\./m.test(report), '报告缺 §9（P1 落地结论）')
  c.ok(/P1 未消除|未证明解析段归属|没有版面坐标/.test(report), '§9 没如实写 P1 的能力边界')
  c.ok(/P2 \/ P3/.test(report) && /未批准|不放行/.test(report), '§9 没写 P2/P3 仍锁')
  c.ok(/不写生产|须思傅单独拍板/.test(report), '§9 没写「L3 全量铺量须单独批准」')
  c.ok(/已真实入库/.test(report), '§9 没记录「开发库真实入库」的验证事实')
  c.ok(/未连 L3/.test(report), '§9 没写明本轮是否碰了生产库')
  const p = read(PROPOSAL)
  c.ok(/状态：已实施/.test(p), 'P-010 提案单状态不对')
  c.ok(/^### [①-⑥]/m.test(p), 'P-010 缺六栏结构')
  c.ok(/P2 \/ P3/.test(p), 'P-010 没写后续阶段未批准')
  const d = read(DECISION)
  c.ok(/### D-013/.test(d), '台账缺 D-013')
  c.ok(/D-012/.test(d), 'D-013 没有交代与 D-012 的关系')
})

m.test('🔴 L3 全量铺量（2026-11-07）：派生表不进备份 + 铺量≠部署 的防篡改登记', (c) => {
  // 铺量后第一次备份实测 FATAL: heap out of memory（326,680 行 / 275MB 文本把
  // 「整表 lines[] + join」撑爆 Node 默认 2GB 堆），且失败时不产出任何文件，
  // 每日 03:17 的备份会静默失效。修法是排除可重建的派生表 + 恢复后重建。
  const bk = read(BACKUP)
  c.ok(/const DERIVED_TABLES = \['question_objects'\]/.test(bk), 'db-backup 没显式排除 question_objects，每日备份会 OOM')
  c.ok(/for \(const name of backupTables\)/.test(bk), '导出循环仍遍历全表，排除规则形同虚设')
  c.ok(/excludedTables/.test(bk) && /rebuild:[\s\S]{0,220}question-objects-build\.mjs --apply/.test(bk), 'manifest 缺重建命令，恢复后会漏掉派生表')
  const report = read(REPORT)
  c.ok(/326,680/.test(report) && /铺量 ≠ 生效/.test(report), '§9.6 没登记 L3 铺量实况或「铺量≠生效」边界')
  const p = read(PROPOSAL)
  c.ok(/已批准并执行（2026-11-07）/.test(p), 'P-010 第 10 项没改判为已执行')
  const d = read(DECISION)
  c.ok(/D-013 追加记录（2026-11-07/.test(d), 'D-013 没有追加式记录生产铺量')
})

m.test('🔴 netdisk 运行时 source_id 必须是 netdisk_files.id（用 fsId 会让铺量数据永远读不到）', (c) => {
  // 2026-11-07 部署前实测踩到：构建脚本按 netdisk_files.id（varchar36）入库，
  // 而深挖块传的是百度网盘数字 fsId ⇒ loadQuestionObjects 恒返回 [] ⇒ 整条网盘
  // 链路静默回退 P0，326,680 行结构化对象「备而不用」且**没有任何报错**。
  // 这类口径错配不会让接口失败，只能靠静态断言钉死。
  const nd = read('server/src/netdisk/netdisk-search.service.ts')
  const build = read(BUILD)
  c.ok(/sourceId: String\(r\.id\)/.test(build), '入库脚本的 source_id 口径变了，不再是 netdisk_files.id')
  c.ok(/select\('id, text_content, text_status'\)/.test(nd), 'ensureText 没查出 netdisk_files.id')
  c.ok(/sourceId: String\(row\.id \|\| ''\)/.test(nd), 'ensureText 没把 id 带出去')
  c.ok(/const \{ text, sourceId \} = await this\.ensureText/.test(nd), '深挖块没接住 sourceId')
  // P-011 / D-014：owner 从登录 userId 换成固定公共 owner，但「sourceId 必须来自
  // netdisk_files.id」这条口径不变。断言放宽 owner 参数，不动 source_id 检查。
  c.ok(/loadQuestionObjects\(getSupabaseClient\(\), (?:userId|publicLibraryOwner\(\)), 'netdisk', sourceId\)/.test(nd),
    '取数口没用 netdisk_files.id')
  c.ok(/loadQuestionObjects\(getSupabaseClient\(\), publicLibraryOwner\(\), 'netdisk', sourceId\)/.test(nd),
    'P-011 后 netdisk 结构化对象取数必须走公共 owner，否则新账号零命中')
  c.ok(!/loadQuestionObjects\([^)]*String\(cand\.fsId\)/.test(nd), '又把 cand.fsId 当成 source_id 了')
  c.ok(/const source = \{ sourceId: sourceId \|\| String\(cand\.fsId\)/.test(nd), '未铺量来源缺 P0 回退所需的 sourceId')
})

m.test('🔴 部署新 dist（2026-11-07）：口径修复已登记且 strict 仍锁', (c) => {
  const report = read(REPORT)
  c.ok(/source_id 口径错配|netdisk_files\.id/.test(report), '报告没登记 fsId / id 口径错配这一部署前缺陷')
  const p = read(PROPOSAL)
  c.ok(/部署新 dist|判定链路/.test(p), 'P-010 没登记部署决策')
  const s = read('server/src/answer-search/answer-search.service.ts')
  c.ok(/const CACHE_VERSION = 'v10'/.test(s), '部署后 result 结构变了但缓存版本没 bump')
})

export default m
