// 模块 33：公共资料库归属 + P2 正文召回验收集（P-011 / D-014）
//
// 为什么单独一个模块：M27/M31 守判定硬闸、M32 守结构化对象，本模块守的是
// 「这些正确的数据**到底有没有被看见**」——两件最容易静默失效的事：
//   ① 公共题库被 `.eq('user_id', userId)` 隔离 ⇒ 新账号零命中，且接口/health 全绿；
//   ② 正文铺了 9,450 万字但检索只查文件名 ⇒ 题干词不在文件名里的原题永远不进候选池。
//
// 🔴 本模块还守「私有绝对私有」：公共化只能改公共表链路，用户自己的
//    library_docs / 错题 / answer_cache 必须仍按登录 userId 隔离。
// 🔴 以及「改判不涂改」：D-012 §8.5「P1/P2/P3 一律不启动」是历史拍板，
//    P-011 只能**追加**改判，不许回头把历史结论删掉（M31 也有断言钉住）。
//
// 零依赖单文件契约不变：public-library.ts / question-match.ts 由 tsc 单编后 require。

import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { Module } from '../lib/harness.mjs'

const require = createRequire(import.meta.url)
const m = new Module('M33', '公共资料库归属与 P2 正文召回验收集（P-011 / D-014）')

const ROOT = path.resolve(process.cwd(), '..')
const TMP = path.join(ROOT, '.tmp', 'verify-public-library')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const PUBLIC_LIB = 'server/src/shared/public-library.ts'
const MATCH = 'server/src/shared/question-match.ts'
const SERVICE_ND = 'server/src/netdisk/netdisk-search.service.ts'
const SERVICE_AS = 'server/src/answer-search/answer-search.service.ts'
const CONTROLLER_ND = 'server/src/netdisk/netdisk.controller.ts'
const STORE = 'server/src/shared/question-object-store.ts'
const MIGRATION = 'migrations/0027_netdisk_text_flat.sql'
const BUILD = 'server/scripts/netdisk-text-flat-build.mjs'
const PP = 'src/constants/privacy-policy.ts'
const PPDOC = 'docs/legal/隐私政策.md'
const PROPOSAL = 'docs/design/method/proposals/P-011-公共题库与正文召回.md'
const DECISION = 'docs/design/method/decision-log.md'
const REPORT = 'docs/reports/资料库正文召回-检索侧四步方案评审.md'

// ---------- 单编：public-library.ts 依赖 question-match.ts，两个一起编 ----------
fs.mkdirSync(TMP, { recursive: true })
execFileSync(
  process.execPath,
  [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/shared/public-library.ts',
    'src/shared/question-match.ts',
    '--outDir', TMP,
    '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck', '--lib', 'es2019',
  ],
  { cwd: process.cwd(), stdio: 'pipe', encoding: 'utf8' },
)
const P = require(path.join(TMP, 'public-library.js'))
const Q = require(path.join(TMP, 'question-match.js'))

// ============================================================
// 一、公共 owner 是常量，绝不随登录用户变（A1）
// ============================================================

m.test('🔴 A1 publicLibraryOwner 是零参数常量函数，不接受 userId', (c) => {
  const src = read(PUBLIC_LIB)
  c.eq(typeof P.publicLibraryOwner, 'function', 'publicLibraryOwner 未导出')
  c.eq(P.publicLibraryOwner.length, 0, 'publicLibraryOwner 竟然接收参数（可能被塞了 userId）')
  c.ok(/export function publicLibraryOwner\(\): string/.test(src), '签名没标成零参 string')
  c.ok(/DEFAULT_PUBLIC_LIBRARY_OWNER_ID/.test(src), '缺默认公共 owner 常量')
  c.eq(P.publicLibraryOwner(), P.DEFAULT_PUBLIC_LIBRARY_OWNER_ID, '默认 owner 不对')
  // 只查函数体：文件头注释里出现 userId 是在解释「绝不接收 userId」，不算污染
  const fnBody = src.slice(src.indexOf('export function publicLibraryOwner'), src.indexOf('export function flatText'))
  c.ok(!/userId|req\.|RequestWithUser/.test(fnBody), 'publicLibraryOwner 函数体里出现了用户上下文，公共 owner 会被污染')
})

m.test('🔴 A1 env 只用于本地/灾备覆盖，且空串回落默认 owner', (c) => {
  const saved = process.env.PUBLIC_LIBRARY_OWNER_ID
  try {
    process.env.PUBLIC_LIBRARY_OWNER_ID = '  '
    c.eq(P.publicLibraryOwner(), P.DEFAULT_PUBLIC_LIBRARY_OWNER_ID, '空 env 没回落默认 owner')
    process.env.PUBLIC_LIBRARY_OWNER_ID = 'local-dev-owner'
    c.eq(P.publicLibraryOwner(), 'local-dev-owner', 'env 覆盖失效')
  } finally {
    if (saved === undefined) delete process.env.PUBLIC_LIBRARY_OWNER_ID
    else process.env.PUBLIC_LIBRARY_OWNER_ID = saved
  }
})

m.test('🔴 A1 公共链路全部走公共 owner，netdisk service 不出现按登录用户过滤', (c) => {
  const svc = read(SERVICE_ND)
  c.ok(!/\.eq\(\s*['"`]user_id['"`]\s*,\s*userId\s*\)/.test(svc),
    'netdisk-search.service.ts 又出现 .eq(user_id, userId) ⇒ 新账号公共题库零命中')
  c.ok(!/async search\(\s*userId/.test(svc), 'search() 签名又带回了 userId')
  const ownerCalls = (svc.match(/publicLibraryOwner\(\)/g) || []).length
  c.ok(ownerCalls >= 5, `公共 owner 调用点只有 ${ownerCalls} 处，疑似漏改（应覆盖 searchLocal / count / ensureText / saveCache / upsertMeta / stats）`)
  c.ok(/loadQuestionObjects\(getSupabaseClient\(\), publicLibraryOwner\(\), 'netdisk'/.test(svc),
    '结构化对象取数没用公共 owner ⇒ rows 恒空、静默回退 P0（L30 教训）')
  const ctrl = read(CONTROLLER_ND)
  c.ok(/requireUserId\(req\)/.test(ctrl), '直连端点丢了登录鉴权')
  c.ok(/\.search\(question,/.test(ctrl), 'controller 还在把 userId 传进 search()')
  // 私有链路仍隔离：这条与下一条一起构成「公共无条件开放 + 私有绝对私有」
  const as = read(SERVICE_AS)
  c.ok(/\.eq\('user_id', userId\)/.test(as), 'answer-search 私有链路丢了用户隔离')
  const store = read(STORE)
  c.ok(/\.eq\('user_id', userId\)/.test(store),
    'question-object-store 唯一取数口丢了 user_id 过滤（library 来源仍是私有）')
})

// ============================================================
// 二、P2 正文召回：归一化口径 / 双通道 / 长锚点 / 排序 / 去闸门（A3–A6）
// ============================================================

m.test('🔴 A3 flatText 与 normalizeForMatch 逐字同口径，且先剥 NUL', (c) => {
  const src = read(PUBLIC_LIB)
  c.ok(/normalizeForMatch/.test(src), 'flatText 没有复用 normalizeForMatch，口径会漂移')
  c.ok(/replace\(\/\\u0000\/g, ''\)/.test(src), '没剥 NUL（PG text 会整条 update 抛 0x00）')
  const sample = 'AB=6，平行四边形 ABCD！\u0000\n第 3 题'
  c.eq(P.flatText(sample), Q.normalizeForMatch(sample.replace(/\u0000/g, '')),
    'flatText 与 normalizeForMatch 结果不一致')
  c.eq(P.flatText(sample), 'AB6平行四边形ABCD第3题', '标点/空白/NUL 没清干净')
  c.ok(!P.flatText(sample).includes('\u0000'), 'NUL 残留')
})

m.test('🔴 A4 searchLocal 是双通道：正文独立查询、只用 ≥4 字长锚点、转义 % , ( )', (c) => {
  const svc = read(SERVICE_ND)
  c.ok(/text_flat\.ilike\.%\$\{k\}%/.test(svc), '正文通道没有独立的 text_flat ilike 查询')
  c.ok(/\.eq\('text_status', 'ok'\)/.test(svc), '正文通道没过滤 text_status=ok')
  c.ok(/filter\(\(k\) => k\.length >= 4\)/.test(svc), '正文通道没有 ≥4 字长锚点硬过滤（短词进 ilike 会拖垮 9,450 万字）')
  c.ok(/textAnchors\.map\(\(k\) => k\.replace\(\/\[%,\(\)\]\/g, ''\)\)/.test(svc),
    '正文通道漏了 PostgREST or 表达式的 % , ( ) 转义')
  c.ok(/from\(TABLE\)[\s\S]{0,600}text_flat/.test(svc), '正文通道没有走本地索引表')
  c.ok(/textRows/.test(svc) && /merged/.test(svc), '两通道结果没有合并去重')
  c.ok(/textHitsByFs/.test(svc), '没有按 fs_id 累计正文长锚点共现数')
})

m.test('🔴 A5 正文共现数前置排序，且删掉 bigram coverage<0.2 闸门', (c) => {
  const svc = read(SERVICE_ND)
  c.ok(/\(b\.textHits \|\| 0\) - \(a\.textHits \|\| 0\)/.test(svc),
    '正文命中数没有排在文件名命中词数之前（MAX_DEEP_FILES=3 时多召回的文档轮不到判定）')
  c.ok(/keyHits\s*[:=]\s*nameHits \+ tHits \* 2/.test(svc), '综合信号没有给正文长锚点更高权重')
  c.ok(!/score < 0\.2/.test(svc), 'bigram coverage<0.2 闸门还在 ⇒ 正文召回的最后一步被误杀')
  c.ok(/六条硬闸/.test(svc), '删闸门的理由没有写进源码注释（必须写明「交给判定层」）')
})

m.test('🔴 A6 P3 深挖上限按 D-015 定为 8、strict 仍锁、一键回退开关在', (c) => {
  const svc = read(SERVICE_ND)
  // D-015（2026-11-07 16:15）追加式改判：P3 放行到保守档 8 份；
  // 原先钉 3 的断言同步改为钉 8 —— 再放宽须另立台账，不许顺手改数字。
  c.ok(/NETDISK_DEEP_FILES \?\? 8/.test(svc), 'MAX_DEEP_FILES 默认值不是拍板的 8（P3 改动须另立台账）')
  c.ok(/NETDISK_TEXT_RECALL=0/.test(svc), '源码没写一键回退开关')
  c.eq(typeof P.textRecallEnabled, 'function', 'textRecallEnabled 未导出')
  const saved = process.env.NETDISK_TEXT_RECALL
  try {
    delete process.env.NETDISK_TEXT_RECALL
    c.eq(P.textRecallEnabled(), true, '正文召回默认应为开启')
    process.env.NETDISK_TEXT_RECALL = '0'
    c.eq(P.textRecallEnabled(), false, 'NETDISK_TEXT_RECALL=0 没生效')
  } finally {
    if (saved === undefined) delete process.env.NETDISK_TEXT_RECALL
    else process.env.NETDISK_TEXT_RECALL = saved
  }
  const store = read(STORE)
  c.ok(/QUESTION_OBJECTS_STRICT === '1'/.test(store), 'strict 默认值被改（第二层上线准入未全绿）')
  c.ok(/textAnchors = textRecallEnabled\(\)/.test(svc), '召回开关没有真正控制正文通道')
})

m.test('🔴 A3 0027 只加列 + 索引；回填脚本默认 dry-run、只写 text_flat、可幂等重跑', (c) => {
  const mig = read(MIGRATION)
  c.ok(/add column if not exists text_flat text/.test(mig), '0027 没加 text_flat 列')
  c.ok(/create extension if not exists pg_trgm/.test(mig), '0027 没幂等声明 pg_trgm（--only 单跑会缺扩展）')
  c.ok(/gin \(text_flat gin_trgm_ops\)/.test(mig), '正文 ilike 没有 GIN 索引')
  c.ok(/where is_dir = false and text_status = 'ok'/.test(mig), '索引不是 partial，会索引 78,430 行未抽文件')
  c.ok(!/update netdisk_files/.test(mig), '迁移里出现了写数据语句（迁移只能改结构）')
  const b = read(BUILD)
  c.ok(/const APPLY = process\.argv\.includes\('--apply'\)/.test(b), '回填脚本默认不是 dry-run')
  c.ok(/update netdisk_files set text_flat = \$1/.test(b), '回填脚本没在写 text_flat')
  c.ok(!/set text_content|text_status = \$/.test(b), '回填脚本碰了 text_content / text_status（只允许写一列）')
  c.ok(/text_flat is null/.test(b), '默认模式不是「只补空」⇒ 重跑不幂等')
  c.ok(/rowCount !== 1/.test(b), '写回没校行数')
  c.ok(/编译产物比/.test(b), '没有编译产物陈旧检查（会拿旧口径回填）')
  c.ok(/loadFlatText|flatText\(/.test(b), '没有复用 flatText 唯一口径')
})

// ============================================================
// 三、缓存版本与合规文案（A7 / A8）
// ============================================================

m.test('🔴 A7 CACHE_VERSION = v13 且参与 qHash（P-017：result 增 figureUrl / figurePage）', (c) => {
  const as = read(SERVICE_AS)
  c.ok(/const CACHE_VERSION = 'v13'/.test(as), 'CACHE_VERSION 没 bump 到 v13')
  c.ok(as.includes('${CACHE_VERSION}:${question}'), '版本没参与 qHash，bump 无效')
  c.ok(/公共资料库里找到了这道题的答案/.test(as), '面客 note 还写着「你自己的题库」')
  const nd = read(SERVICE_ND)
  c.ok(/双通道检索/.test(nd), '双通道没有体现在 note 里（改了文案就必须 bump）')
})

m.test('🔴 A8 隐私政策 r8、两处口径一致、面客不再说「你自己的网盘」', (c) => {
  const pp = read(PP)
  const doc = read(PPDOC)
  c.ok(/PRIVACY_POLICY_VERSION = '2026-11-07-r8'/.test(pp), '应用内政策没升 r8')
  c.ok(doc.includes('2026-11-07-r8'), 'docs/legal 镜像没升 r8')
  c.ok(/运营者提供的公共资料库/.test(pp) && /运营者提供的公共资料库/.test(doc), '两处都没写公共资料库')
  c.ok(/不含任何用户的个人信息/.test(pp) && /不带用户属性|不含任何用户的个人信息/.test(doc),
    '没写「公共题库不带用户信息」')
  c.ok(!/你自己百度网盘里的资料/.test(pp) && !/你自己百度网盘里的资料/.test(doc),
    '还在说「你自己百度网盘里的资料」')
  c.ok(/腾讯 ima 知识库/.test(doc), '法定第三方清单 ima 条目被删了')
  c.ok(/百度网盘（公共资料索引）|百度网盘（资料归档）/.test(doc), '法定第三方清单网盘条目被删/没改口径')
  const editor = read('src/components/answer-editor.tsx')
  c.ok(/guardPolicy\('检索公共资料库'\)/.test(editor), '前端 guardPolicy action 还是「我的资料库」')
  const profile = read('src/pages/profile/index.tsx')
  c.ok(/检索运营者提供的公共资料库/.test(profile), 'profile 面客文案没改')
})

// ============================================================
// 四、文档：追加式改判、不涂改历史（流程红线）
// ============================================================

m.test('🔴 P-011 / D-014 / 报告 §10 齐备，且 D-012 §8.5 历史拍板原样保留', (c) => {
  const p = read(PROPOSAL)
  const d = read(DECISION)
  const r = read(REPORT)
  c.ok(/提案号：P-011/.test(p), 'P-011 提案单缺编号')
  c.ok(/^### [①-⑥]/m.test(p), 'P-011 缺六栏结构')
  c.ok(/私有绝对私有/.test(p) && /用户贡献通道本期不做|本期彻底不做/.test(p), 'P-011 没写定稿范围')
  c.ok(/^## D-014/m.test(d), '台账缺 D-014')
  c.ok(/P-011/.test(d), 'D-014 没关联提案单')
  c.ok(/^## 10\./m.test(r), '报告缺 §10 落地结论')
  // 🔴 追加式：M31 也钉着同一句，绝不能因为 P2 批准就回头删历史结论
  c.ok(/P1 \/ P2 \/ P3 一律不启动/.test(r), 'D-012 §8.5 历史拍板被涂改（应追加改判，不回溯）')
  c.ok(/P1 \/ P2 \/ P3 全部未批准/.test(read('docs/design/method/proposals/P-009-长文档原题判定口径与题目级切分.md')),
    'P-009 历史「未批准」被涂改')
  c.ok(/追加.*改判|不回溯涂改/.test(p), 'P-011 没有写明「追加式改判」')
  c.ok(/须单独拍板|不覆盖这两项/.test(p), 'P-011 没写明生产写数据/部署仍须单独拍板')
})

m.test('🔴 明确不做：用户贡献 / 共享换权限 / 私有资料公共化不得进入本期代码', (c) => {
  const p = read(PROPOSAL)
  c.ok(/用户贡献通道/.test(p) && /本期不做|本期彻底不做/.test(p), 'P-011 没把贡献通道列为不做')
  c.ok(/PIPL §16/.test(p), 'P-011 没登记 PIPL §16 强制同意禁令')
  const svc = read(SERVICE_ND)
  c.ok(!/\.from\(['"`]library_docs['"`]\)/.test(svc),
    'netdisk service 查了私有 library_docs（只允许在注释里提到这条边界）')
  const as = read(SERVICE_AS)
  c.ok(/\.eq\('user_id', userId\)/.test(as), '私有链路隔离断言应仍然成立')
})

export default m
