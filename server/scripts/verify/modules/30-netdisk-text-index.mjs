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

m.test('P-008 提案单存在，且明确「只批准到 dry-run」', (c) => {
  const s = read(PROPOSAL)
  c.ok(s.includes('提案号：P-008'), '提案单编号不对')
  c.ok(s.includes('dry-run'), '提案单里没有 dry-run 边界')
  c.ok(s.includes('未批准'), '提案单没有写清哪些动作未获批准')
  for (const sec of ['① 判据', '② 归因', '③ 证据', '④ 算子', '⑤ falsifier', '⑥ 验收断言']) {
    c.ok(s.includes(sec), `六栏缺 ${sec}`)
  }
})

m.test('D-011 台账存在，且落地记录含 dry-run 实测数字', (c) => {
  const s = read(DECISION)
  c.ok(s.includes('### D-011 资料库正文离线预抽与正文召回'), '台账缺 D-011 条目')
  const i = s.indexOf('### D-011')
  const block = s.slice(i, s.indexOf('## 2.5', i))
  c.ok(block.includes('11,184'), '台账落地记录缺 dry-run 实测候选份数')
  c.ok(block.includes('零写入'), '台账没有写「零写入已证」')
  c.ok(block.includes('P-008'), '台账没有关联提案单')
})

m.test('测算报告已把估算升级为实测校验（§13），且 6 份差异可解释', (c) => {
  const s = read(REPORT)
  c.ok(s.includes('## 13. dry-run 实测校验'), '报告缺 §13 实测校验一节')
  c.ok(s.includes('11,184'), '报告 §13 缺实测候选份数')
  c.ok(s.includes('size_bytes = 0'), '报告没有解释 size_bytes=0 的 2 份差异')
  c.ok(s.includes('> 40MB'), '报告没有解释 >40MB 的 4 份差异')
})

m.test('M30 已登记进验证套件（自检：本模块被自动发现）', (c) => {
  const runSrc = read('server/scripts/verify/run.mjs')
  c.ok(runSrc.includes('readdirSync'), 'run.mjs 不再是自动发现模式')
  c.ok(fs.existsSync(path.join(ROOT, 'server/scripts/verify/modules/30-netdisk-text-index.mjs')),
    '模块文件路径不对，自动发现会漏掉它')
})

export default m
