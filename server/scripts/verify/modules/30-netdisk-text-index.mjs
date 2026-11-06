// 模块 30：资料库正文离线预抽（P-008 / D-011 · 方案 A）
//
// 为什么单独一个模块：这个脚本是**唯一会批量写 netdisk_files 正文**的东西，
// 一旦偏了，最坏的三种后果都是静默的：
//   ① dry-run 误写库 —— 没批准的动作被执行，且当场没人看得出来；
//   ② 环境类失败被记成 `none` —— `none` 的语义是「确认这份文档没有文字层」，
//      记错了这份文档就**永久判死**，环境修好后也再不会重试（2026-11-03 踩过）；
//   ③ 写库顺手改了元数据（name/path/size_bytes）—— 索引与网盘真实状态错位。
// 所以三层各钉一遍：
//   ① 静态源码层：默认 dry-run、只写三列、环境失败不写库、范围边界、user_id 限定
//   ② 口径一致层：与服务端 `ensureText()` 的 textOnly / maxPages / 50 字阈值逐字对齐
//   ③ 文档层：P-008 提案单、D-011 台账、dry-run 实测记录
//
// ⚠️ 本模块守的是**行为契约**，不是「文档里写了」。断言失败要么是实现偏了，
//    要么是提案单改了 —— 两种都必须先改 P-008 / D-011 再改这里。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M30', '资料库正文离线预抽与正文召回（P-008 / D-011）')

const ROOT = path.resolve(process.cwd(), '..')
const SCRIPT = 'server/scripts/netdisk-extract-text.mjs'
const SERVICE = 'server/src/netdisk/netdisk-search.service.ts'
const PROPOSAL = 'docs/design/method/proposals/P-008-资料库正文离线预抽与正文召回.md'
const DECISION = 'docs/design/method/decision-log.md'
const REPORT = 'docs/reports/资料库正文索引-B方案可行性与成本测算.md'

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ============================================================
// 一、静态源码层：默认 dry-run，写库只在 --apply 分支
// ============================================================

m.test('🔴 默认 dry-run：`--apply` 是唯一写库入口，且 dryRun 在 applyRun 之前', (c) => {
  const s = read(SCRIPT)
  c.ok(
    s.includes("const APPLY = process.argv.includes('--apply')"),
    '缺少 `--apply` 开关（默认必须是 dry-run）',
  )
  c.ok(!/const APPLY = true/.test(s), 'APPLY 被写死为 true —— dry-run 契约被破坏')

  const iDry = s.indexOf('await dryRun(client)')
  const iApply = s.indexOf('await applyRun(client)')
  c.ok(iDry > 0, '找不到 dryRun 调用')
  c.ok(iApply > iDry, 'applyRun 必须在 dryRun 之后，否则先写库再打印 dry-run')

  // dry-run 分支必须 `return`，不许顺流落到 applyRun
  const branch = s.slice(s.indexOf('if (!APPLY) {'), s.indexOf('await applyRun(client)'))
  c.ok(branch.includes('return'), 'dry-run 分支没有 return —— 会继续往下写库')
})

m.test('🔴 dry-run 函数体内不得出现任何下载或写库调用', (c) => {
  const s = read(SCRIPT)
  const iStart = s.indexOf('async function dryRun')
  const iEnd = s.indexOf('async function applyRun')
  c.ok(iStart > 0 && iEnd > iStart, '找不到 dryRun / applyRun 函数边界')
  const body = s.slice(iStart, iEnd)
  c.ok(!body.includes('downloadByFsId'), 'dryRun 里出现了 downloadByFsId —— 已经不是只读了')
  c.ok(!body.includes('writeRow('), 'dryRun 里出现了 writeRow —— 已经在写库了')
  c.ok(!body.includes('extractDocContent'), 'dryRun 里出现了抽取调用 —— 已经不是只读了')
})

m.test('🔴 只写三列：text_content / text_status / text_updated_at，且只有一条 update 语句', (c) => {
  const s = read(SCRIPT)
  const updates = s.split('update netdisk_files').length - 1
  c.ok(updates === 1, `update netdisk_files 出现 ${updates} 次，只允许 1 处（集中受控）`)
  c.ok(
    s.includes('set text_content = $1, text_status = $2, text_updated_at = now()'),
    '写库列清单不是「恰好三列」—— 多写一列就会污染元数据',
  )
  // 反向：不得出现对元数据的 set
  c.ok(
    !/set [^;]*\b(name|path|dir_path|size_bytes|mtime|synced_at|fs_id)\s*=/.test(s),
    '写库语句里出现了元数据列 —— 索引会与网盘真实状态错位',
  )
})

m.test('🔴 正文落库前剥离 NUL：PostgreSQL 的 text 不接受 U+0000', (c) => {
  // 2026-11-06 实测：`string.txt` / `eula.txt` 正文里带 NUL 字节，
  // 整条 update 抛 `invalid byte sequence for encoding "UTF8": 0x00`，
  // 两份文档永远停在 pending。这不是「抽不出来」，是写不进去 —— 必须洗掉。
  const s = read(SCRIPT)
  c.ok(
    /function stripNul\(text\)/.test(s),
    '缺 stripNul()：带 NUL 的正文写不进 PostgreSQL，文件会永远 pending',
  )
  c.ok(
    s.includes('stripNul(text)'),
    'writeRow 没过 stripNul —— txt / pdf / docx 三条路径都会漏（docx 的 XML 也夹 NUL）',
  )
  c.ok(
    s.includes("stripNul(buf.toString('utf8'))"),
    'txt 分支没有先剥 NUL 再判字数 —— NUL 不在 \\s 里会被算成有效字符，误判为 ok',
  )
})

m.test('🔴 环境类失败保持 pending：`no-python` / `no-script` / `timeout` 分支不得写库', (c) => {
  const s = read(SCRIPT)
  c.ok(
    s.includes("const ENV_FAIL_REASONS = new Set(['no-python', 'no-script', 'timeout'])"),
    '环境类失败的 reason 白名单不是这三项',
  )
  const iEnv = s.indexOf('ENV_FAIL_REASONS.has(out.reason)')
  c.ok(iEnv > 0, '抽取失败时没有区分「环境类失败」')
  const iNone = s.indexOf('stat.none++', iEnv)
  c.ok(iNone > iEnv, '环境失败分支后面找不到内容类失败分支（结构变了）')
  const block = s.slice(iEnv, iNone)
  c.ok(
    !block.includes('writeRow('),
    '环境类失败分支里写了库 —— 会把好文档永久记成 none，环境修好后也不再重试',
  )
  // 异常分支同样不许写 none
  const iCatch = s.indexOf('} catch (e) {', s.indexOf('async function applyRun'))
  const catchBlock = s.slice(iCatch, s.indexOf('// 简单 worker pool', iCatch))
  c.ok(iCatch > 0, '找不到 applyRun 内的异常分支')
  c.ok(
    !catchBlock.includes("'none'"),
    '异常分支把状态记成了 none —— 异常多半是环境问题，必须保持 pending',
  )
})

m.test('🔴 范围边界：docx + txt + pdf<1MB，且**不含** .doc', (c) => {
  const s = read(SCRIPT)
  c.ok(s.includes('const PDF_MAX_BYTES = 1 * 1024 * 1024'), 'pdf 体积上限不是 1MB')
  c.ok(
    s.includes("ext = 'docx' or ext = 'txt' or (ext = 'pdf' and coalesce(size_bytes, 0) < ${PDF_MAX_BYTES})"),
    'SCOPE_SQL 的三类范围与 P-008 §④② 不一致',
  )
  c.ok(!/ext\s*=\s*'doc'\b/.test(s), '范围里出现了 .doc —— P-008 明确不做（转换工具未装）')
  c.ok(
    s.includes('coalesce(size_bytes, 0) > 0'),
    '缺少 size_bytes > 0 过滤 —— 无体积的文件无法判断是否超大，不该下载',
  )
  c.ok(s.includes('const MAX_TEXT_BYTES = 40 * 1024 * 1024'), '抽取上限不是 40MB')
})

m.test('数据隔离：写库带 user_id 双重限定，行数不符立即抛错', (c) => {
  const s = read(SCRIPT)
  c.ok(s.includes('where id = $3 and user_id = $4'), 'update 没有带 user_id 限定')
  c.ok(s.includes('rowCount !== 1'), '写库后没有校验行数')
  c.ok(s.includes("throw new Error(`写库行数不符"), '行数不符时没有抛错（会静默漏写）')
})

m.test('幂等与断点续跑：默认只碰 pending，游标按 id 推进', (c) => {
  const s = read(SCRIPT)
  c.ok(
    s.includes("const statusFilter = FORCE ? '' : ` and coalesce(text_status, 'pending') = 'pending'`"),
    '默认没有限定只处理 pending —— 会覆盖已有 ok/none',
  )
  c.ok(s.includes('and id > $1'), '缺少 id 游标 —— 环境失败的行会被反复取到，可能死循环')
  c.ok(s.includes('cursor = rows[rows.length - 1].id'), '游标没有推进')
})

m.test('限速与并发上限（网盘 QPS 约束）', (c) => {
  const s = read(SCRIPT)
  c.ok(s.includes('Math.min(2,'), '并发上限没压到 2')
  c.ok(s.includes('Math.max(300,'), '请求间隔没兜底到 ≥300ms')
})

// ============================================================
// 二、口径一致层：必须与服务端 ensureText() 逐字对齐
// ============================================================

m.test('🔴 抽取口径与服务端 ensureText() 一致（textOnly / maxPages / 50 字阈值）', (c) => {
  const s = read(SCRIPT)
  const svc = read(SERVICE)
  c.ok(s.includes('textOnly: true'), '脚本没有 textOnly: true —— 会走 OCR，本提案明确不做')
  c.ok(svc.includes('textOnly: true'), '服务端 ensureText 不再是 textOnly（口径已漂移）')
  c.ok(s.includes('const MAX_PAGES = 200'), 'maxPages 不是 200')
  c.ok(svc.includes('maxPages: 200'), '服务端 maxPages 不再是 200（口径已漂移）')
  c.ok(s.includes('const MIN_MEANINGFUL_CHARS = 50'), '阈值不是 50 字')
  c.ok(svc.includes('length < 50'), '服务端阈值不再是 50（口径已漂移）')
  c.ok(s.includes('MAX_TEXT_CHARS'), '缺少正文字数截断（会写出超 200k 字的行）')
  c.ok(svc.includes('MAX_TEXT_CHARS'), '服务端没有截断常量（口径已漂移）')
})

// ============================================================
// 三、文档层：提案单 / 台账 / 实测记录
// ============================================================

m.test('P-008 提案单存在，且阶段边界（dry-run → 1000 → 追加 4000 → 收尾）记录完整', (c) => {
  const s = read(PROPOSAL)
  c.ok(s.includes('提案号：P-008'), '提案单编号不对')
  c.ok(s.includes('dry-run'), '提案单里没有 dry-run 边界')
  c.ok(s.includes('未批准'), '提案单没有写清哪些动作未获批准')
  // 2026-11-06 思傅批准试抽 1000 份并已执行：阶段记录必须跟着拍板走，
  // 否则后来人会照旧版读到「只批准到 dry-run」而不敢用已抽好的正文。
  c.ok(s.includes('试抽 1000 份'), '提案单缺 2026-11-06 「试抽 1000 份」的拍板与落地记录')
  c.ok(s.includes('1000'), '提案单缺 1000 份试抽的执行数字')
  // 2026-11-06 追加 4000 份：这一段必须留档，尤其是「SSH 断连杀进程」「必须 sudo -u gk」
  // 两条运维口径——不写下来，下一个人会原样再踩一遍。
  c.ok(s.includes('续抽 4000 份'), '提案单缺 2026-11-06 「续抽 4000 份」的落地记录')
  c.ok(s.includes('4,043'), '提案单缺续抽的写入行数（4,043）')
  c.ok(s.includes('2026-11-05 16:15:09+00'), '提案单缺续抽阶段的回滚锚点')
  // 2026-11-06 收尾：方案 A 抽完了。这一段的重点不是数字好看，而是
  // ① 候选池 pending 归零（否则「抽完了」是句空话）；② NUL 缺陷与治法必须留档
  // （它伪装成「环境失败」，不写下来下一个人会当成环境问题去查 python）。
  c.ok(s.includes('收尾 6,123 份'), '提案单缺 2026-11-06 收尾阶段的落地记录')
  c.ok(s.includes('归零'), '提案单没写「候选池 pending 归零」')
  c.ok(s.includes('stripNul'), '提案单缺 NUL 缺陷的治法（stripNul）')
  c.ok(s.includes('2026-11-06 04:00:15+00'), '提案单缺收尾阶段的回滚锚点')
  for (const sec of ['① 判据', '② 归因', '③ 证据', '④ 算子', '⑤ falsifier', '⑥ 验收断言']) {
    c.ok(s.includes(sec), `六栏缺 ${sec}`)
  }
})

m.test('D-011 台账存在，落地记录含 dry-run 与 1000 份试抽实测数字', (c) => {
  const s = read(DECISION)
  c.ok(s.includes('### D-011 资料库正文离线预抽与正文召回'), '台账缺 D-011 条目')
  const i = s.indexOf('### D-011')
  const block = s.slice(i, s.indexOf('## 2.5', i))
  c.ok(block.includes('11,184'), '台账落地记录缺 dry-run 实测候选份数')
  c.ok(block.includes('零写入'), '台账没有写「零写入已证」')
  c.ok(block.includes('P-008'), '台账没有关联提案单')
  // 2026-11-06 试抽 1000 份已执行：台账必须留下数字与回滚锚点，
  // 否则下一次要回滚时没人知道该按哪个时间点切。
  c.ok(block.includes('试抽 1000 份'), '台账缺 2026-11-06 试抽 1000 份的落地记录')
  c.ok(block.includes('927'), '台账缺试抽的 ok 份数（927）')
  c.ok(block.includes('2026-11-05 15:42:47+00'), '台账缺回滚锚点时间戳')
  // 续抽 4000 份（累计 5,047 份）同样要留数字与锚点，且必须写清「哪些还没批准」——
  // 台账是唯一能回答「这批正文现在能不能用」的地方。
  c.ok(block.includes('4,043'), '台账缺续抽 4000 份的写入行数（4,043）')
  c.ok(block.includes('4,747'), '台账缺续抽后的 ok 总量（4,747）')
  c.ok(block.includes('2026-11-05 16:15:09+00'), '台账缺续抽阶段的回滚锚点')
  c.ok(block.includes('nohup'), '台账漏记「长任务须远端 nohup」这条运维口径')
  // 收尾阶段（方案 A 完成）：必须留「抽完了」的判据与被抽出的缺陷。
  c.ok(block.includes('10,454'), '台账缺方案 A 完成后的 ok 总量（10,454）')
  c.ok(block.includes('归零'), '台账没写「候选池 pending 归零」——「抽完了」必须有判据')
  c.ok(block.includes('0x00') || block.includes('U+0000'), '台账漏记 NUL 字节缺陷（会伪装成环境失败）')
  c.ok(block.includes('2026-11-06 04:00:15+00'), '台账缺收尾阶段的回滚锚点')
})

m.test('测算报告已把估算升级为实测校验（§13 dry-run + §14 试抽 + §15 续抽）', (c) => {
  const s = read(REPORT)
  c.ok(s.includes('## 13. dry-run 实测校验'), '报告缺 §13 实测校验一节')
  c.ok(s.includes('11,184'), '报告 §13 缺实测候选份数')
  c.ok(s.includes('size_bytes = 0'), '报告没有解释 size_bytes=0 的 2 份差异')
  c.ok(s.includes('> 40MB'), '报告没有解释 >40MB 的 4 份差异')
  // 试抽实测把模型的两处偏差暴露出来（耗时偏乐观、pdf<1MB 可抽率偏高），
  // 全量预估必须按实测口径修正，不能让旧数字继续被引用。
  c.ok(s.includes('## 14. 试抽实测'), '报告缺 §14 试抽实测一节')
  c.ok(s.includes('28m59s'), '报告 §14 缺实测耗时')
  c.ok(s.includes('80.6%'), '报告 §14 缺 pdf<1MB 实测可抽率（修正 §4 的 90%）')
  c.ok(s.includes('5.5 小时') || s.includes('5.4 小时'), '报告未按实测口径修正全量耗时预估')
  // §15 是全案最硬的一节：把「仅文件名命中 vs 正文命中」摆成对照，
  // 其中 AB=6 这类题干片段文件名命中 0 —— 这是「正文参与召回」不可反驳的理由。
  c.ok(s.includes('## 15. 续抽实测'), '报告缺 §15 续抽实测一节')
  c.ok(s.includes('AB=6'), '报告 §15 缺题干片段的召回对照（AB=6）')
  c.ok(s.includes('4,747'), '报告 §15 缺续抽后的 ok 总量')
  // §16 是方案 A 的收尾账：可抽量预估偏了多少、耗时模型偏了多少、
  // 以及那个伪装成「环境失败」的 NUL 缺陷。三个都必须留在报告里。
  c.ok(s.includes('## 16. 方案 A 收尾实测'), '报告缺 §16 收尾实测一节')
  c.ok(s.includes('10,454'), '报告 §16 缺最终 ok 总量（10,454）')
  c.ok(s.includes('93.5%'), '报告 §16 缺最终可抽率（93.5%）')
  c.ok(s.includes('NUL'), '报告 §16 漏记 NUL 字节缺陷')
  c.ok(s.includes('慢 46%'), '报告 §16 没有量化耗时模型偏差（实测比 dry-run 慢 46%）')
})

m.test('M30 已登记进验证套件（自检：本模块被自动发现）', (c) => {
  const runSrc = read('server/scripts/verify/run.mjs')
  c.ok(runSrc.includes('readdirSync'), 'run.mjs 不再是自动发现模式')
  c.ok(fs.existsSync(path.join(ROOT, 'server/scripts/verify/modules/30-netdisk-text-index.mjs')),
    '模块文件路径不对，自动发现会漏掉它')
})

export default m
