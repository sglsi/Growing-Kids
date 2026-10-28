#!/usr/bin/env node
// ============================================================
// 方法论治理的三条硬门（GK-OPS-22 §4）
//
//   H1 归因门：提案单六栏齐备 + 引用的准则号/文献号真实存在
//   H2 口径门：用户可见面不含禁用宣称词（M10 / 20b §5.3）
//   H3 同步门：镜像参数逐字一致（文档 ↔ 代码 ↔ 断言）
//
// 设计原则（重要，别改成"全家桶"）：
//   · 只验**机器能判定**的部分。语义（归因是否成立、边界写得对不对）留给人，
//     机器硬凑只会逼人写假证据。见 OPS-22 §4 开头那句。
//   · 每条门失败必须能指出**具体文件:行**或**具体两处不一致的值**，
//     否则使用者只会学会忽略它。
//   · 退出码 0/1/2：2 = 环境异常（文档/源码找不到），与"内容不合格"分开——
//     混在一起会让人去改本来没坏的文档。
//
// 用法：
//   node server/scripts/method-gates.mjs                 全部
//   node server/scripts/method-gates.mjs --only=h2       只跑一条
//   node server/scripts/method-gates.mjs --json          机器可读
// ============================================================

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const DESIGN = path.join(ROOT, 'docs', 'design')
const PROPOSALS = path.join(DESIGN, 'method', 'proposals')

const A_NAME = 'GK-SRS-20a-科学学习方法论指引.md'
const B_NAME = 'GK-SRS-20b-学习科学方法论指引.md'

// ---------- 通用 ----------

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-web', '.git', '.tmp', 'logs', 'backups', '.swc', '.cache-paddlex', '.cache-pip', 'espcn-weights'])

function walk(dir, exts, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { walk(p, exts, out); continue }
    if (exts.some((x) => e.name.endsWith(x))) out.push(p)
  }
  return out
}

function read(p) {
  try { return fs.readFileSync(p, 'utf8') } catch { return null }
}

function lineOf(text, index) {
  return text.slice(0, index).split(/\r?\n/).length
}

// 占位内容不算"填了"——表单空转比不填更糟（OPS-22 §8 第一条）
const PLACEHOLDER = /^(待填|待定|待补|TODO|TBD|——|-{2,}|…+|\.{3,})$/

function hasRealContent(body) {
  const lines = body.split(/\r?\n/).map((s) => s.trim())
  for (const ln of lines) {
    if (!ln) continue
    if (/^\|?[\s:|-]+\|?$/.test(ln)) continue            // 表格分隔行
    if (/^>/.test(ln) && ln.length < 4) continue
    const plain = ln.replace(/^[-*>\d.\s|]+/, '').replace(/\|/g, '').trim()
    if (plain.length >= 4 && !PLACEHOLDER.test(plain) && !/^<.*>$/.test(plain)) return true
  }
  return false
}

// ---------- H1 归因门 ----------

const SIX = [
  ['①', '判据（L1 / L2 / L3）'],
  ['②', '归因（不变量 / 约束 / 准则）'],
  ['③', '证据（20b 条目 + 级别）'],
  ['④', '算子（T / D / X）'],
  ['⑤', 'falsifier'],
  ['⑥', '验收断言'],
]

function collectGuidelineIds(aText, bText) {
  const mIds = new Set()
  const eIds = new Set()
  for (const m of aText.matchAll(/^####\s*M(\d+)/gm)) mIds.add(Number(m[1]))
  for (const m of aText.matchAll(/^\|\s*\*\*E(\d)\*\*/gm)) eIds.add(Number(m[1]))
  // 20b 参考文献编号（只取第 7 章，避免别的有序列表把上界抬高）
  let refMax = 0
  const start = bText.search(/^##\s*7\.\s*参考文献/m)
  if (start >= 0) {
    const rest = bText.slice(start)
    const next = rest.slice(3).search(/^##\s/m)
    const sec = next >= 0 ? rest.slice(0, next + 3) : rest
    for (const m of sec.matchAll(/^(\d+)\.\s/gm)) refMax = Math.max(refMax, Number(m[1]))
  }
  return { mIds, eIds, refMax }
}

function checkProposals(ctx) {
  const errors = []
  const warnings = []
  let checked = 0
  if (!fs.existsSync(PROPOSALS)) {
    return { errors: [`提案目录不存在：${path.relative(ROOT, PROPOSALS)}`], warnings, checked, missing: true }
  }
  const files = fs.readdirSync(PROPOSALS).filter((f) => f.endsWith('.md'))
  if (!files.length) {
    return { errors: [], warnings: ['提案目录为空（首个提案单应为 P-003）'], checked, missing: false }
  }
  for (const f of files) {
    const p = path.join(PROPOSALS, f)
    const text = read(p) || ''
    const rel = path.relative(ROOT, p)
    checked++
    if (!/提案号：\s*P-\d{3}/.test(text)) errors.push(`${rel}：缺少「提案号：P-NNN」`)
    if (!/状态：\s*(草稿|待批准|已批准|已否决|已实施)/.test(text)) errors.push(`${rel}：状态必须是 草稿/待批准/已批准/已否决/已实施 之一`)
    if (!/日期：\s*\d{4}-\d{2}-\d{2}/.test(text)) errors.push(`${rel}：缺少日期`)
    if (!/关联决策：\s*D-\d{3}/.test(text)) errors.push(`${rel}：缺少「关联决策：D-NNN」`)
    if (!/关联缺口：/.test(text)) errors.push(`${rel}：缺少「关联缺口」（没有就写"无"）`)

    // 六栏：标题存在 + 正文非占位
    const lines = text.split(/\r?\n/)
    for (const [mark, label] of SIX) {
      const idx = lines.findIndex((ln) => new RegExp(`^###\\s*${mark}`).test(ln))
      if (idx < 0) { errors.push(`${rel}：缺少 ${mark} ${label}`); continue }
      let end = lines.length
      for (let i = idx + 1; i < lines.length; i++) {
        if (/^#{1,3}\s/.test(lines[i])) { end = i; break }
      }
      const body = lines.slice(idx + 1, end).join('\n')
      if (!hasRealContent(body)) errors.push(`${rel}：${mark} ${label} 正文为空或仍是占位（${mark} 栏是硬门，缺一栏退回）`)
    }

    // 引用可解析（拆卷后写错编号是高频错误）
    for (const m of text.matchAll(/GK-SRS-20a\s*(M|E)(\d+)/g)) {
      const set = m[1] === 'M' ? ctx.mIds : ctx.eIds
      if (!set.size) continue
      if (!set.has(Number(m[2]))) errors.push(`${rel}:${lineOf(text, m.index)} 引用了不存在的准则 ${m[1]}${m[2]}（20a 现有 M${[...ctx.mIds].sort((a, b) => a - b).join('/')}）`)
    }
    if (ctx.refMax > 0) {
      for (const m of text.matchAll(/文献\s*(\d+)(?:\s*[–—~-]\s*(\d+))?/g)) {
        const from = Number(m[1])
        const to = m[2] ? Number(m[2]) : from
        if (from < 1 || to > ctx.refMax) errors.push(`${rel}:${lineOf(text, m.index)} 引用了不存在的文献 ${from}${m[2] ? `–${to}` : ''}（20b 共 ${ctx.refMax} 条）`)
      }
    }
  }
  return { errors, warnings, checked }
}

// ---------- H2 口径门 ----------

// 禁用：依据 M10（不得宣称能测量 ZPD/智能水平）与 20b §5.3（明确不做）
const BANNED = ['ZPD', '最近发展区', '智能水平', '智商', '天赋', '学习风格', '左右脑', '提分', '过目不忘']
// 观察：不是禁词，但出现在用户可见文案里就要人确认一次（游戏化语言的滑坡）
const WATCH = ['打卡', '排行榜', '勋章', '段位']

function checkClaims() {
  const errors = []
  const warnings = []
  const targets = [
    ...walk(path.join(ROOT, 'src'), ['.ts', '.tsx', '.js', '.jsx']),
    ...walk(DESIGN, ['SRS-03-用户使用手册.md']),
    ...(fs.existsSync(path.join(ROOT, 'README.md')) ? [path.join(ROOT, 'README.md')] : []),
    ...(fs.existsSync(path.join(ROOT, 'docs', 'README.md')) ? [path.join(ROOT, 'docs', 'README.md')] : []),
  ]
  for (const p of targets) {
    const text = read(p)
    if (!text) continue
    const rel = path.relative(ROOT, p)
    text.split(/\r?\n/).forEach((ln, i) => {
      for (const w of BANNED) {
        if (ln.includes(w)) errors.push(`${rel}:${i + 1} 含禁用宣称「${w}」——依据 M10 / 20b §5.3，改文案或降级宣称`)
      }
      for (const w of WATCH) {
        if (ln.includes(w)) warnings.push(`${rel}:${i + 1} 含「${w}」（观察词，需人工确认不是游戏化激励）`)
      }
    })
  }
  return { errors, warnings, checked: targets.length }
}

// ---------- H3 同步门 ----------

function nums(s) { return s.split(/[^\d]+/).filter(Boolean).map(Number) }

function checkMirrors() {
  const errors = []
  const warnings = []
  let checked = 0

  const aText = read(path.join(DESIGN, A_NAME))
  const bText = read(path.join(DESIGN, B_NAME))
  const reviewTs = read(path.join(ROOT, 'server', 'src', 'timeline', 'review.ts'))
  const m15 = read(path.join(ROOT, 'server', 'scripts', 'verify', 'modules', '15-review-schedule.mjs'))
  const docSvc = read(path.join(ROOT, 'server', 'src', 'document', 'document.service.ts'))
  const m10 = read(path.join(ROOT, 'server', 'scripts', 'verify', 'modules', '10-ocr-pdf-export.mjs'))

  const missing = []
  if (!aText) missing.push(A_NAME)
  if (!bText) missing.push(B_NAME)
  if (!reviewTs) missing.push('server/src/timeline/review.ts')
  if (!m15) missing.push('verify/modules/15-review-schedule.mjs')
  if (missing.length) return { errors: [], warnings: [], checked, missing, missingList: missing }

  // 镜像 1：复习间隔表（20a / 20b / review.ts / M15 四处）
  checked++
  const codeM = reviewTs.match(/REVIEW_INTERVALS\s*=\s*\[([^\]]+)\]/)
  const codeVals = codeM ? nums(codeM[1]) : []
  if (!codeVals.length) errors.push('review.ts：解析不到 REVIEW_INTERVALS —— 常量被改名或改写，H3 已失效，请同步更新本门')
  const assertM = m15.match(/REVIEW_INTERVALS\.join\(','\)\s*,\s*'([\d,]+)'/)
  const assertVals = assertM ? nums(assertM[1]) : []
  if (!assertVals.length) errors.push('M15：解析不到间隔表断言 —— 断言被删或改写，H3 已失效（间隔表从此无人守）')
  const docVals = {}
  for (const [name, text] of [['20a', aText], ['20b', bText]]) {
    const m = text.match(/(\d+(?:\s*→\s*\d+){2,})\s*天/)
    docVals[name] = m ? nums(m[1]) : []
    if (!docVals[name].length) errors.push(`${name}：找不到「N→N→… 天」形式的间隔表（文档是镜像的一环，删掉即三处不同步）`)
  }
  if (codeVals.length && assertVals.length && codeVals.join(',') !== assertVals.join(',')) {
    errors.push(`间隔表漂移：review.ts = [${codeVals.join(',')}]，M15 断言 = [${assertVals.join(',')}] —— 改表必须同时改断言（20a §5.6 落地三关）`)
  }
  for (const [name, vals] of Object.entries(docVals)) {
    if (vals.length && codeVals.length && vals.join(',') !== codeVals.join(',')) {
      errors.push(`间隔表漂移：${name} 写的是 [${vals.join(',')}]，代码是 [${codeVals.join(',')}] —— 先改 20a/20b 再改代码（变更程序 OPS-22 §7）`)
    }
  }

  // 镜像 2：导出默认口径（代码判据 / 断言 / 旧写法残留）
  if (docSvc) {
    checked++
    if (!/params\.include_answers\s*===\s*true/.test(docSvc)) {
      errors.push('document.service.ts：导出默认口径不是 `include_answers === true`（不传=不含答案）。改口径必须同步 20b/SRS-01 与 M10 三条用例')
    }
    if (/include_answers\s*!==\s*false/.test(docSvc)) {
      errors.push('document.service.ts：出现旧写法 `include_answers !== false`（R-技术-13 已关闭，回退会再次造成两接口语义相反）')
    }
    if (m10) {
      if (!/include_answers:\s*true/.test(m10)) errors.push('M10：缺少「include_answers=true 才输出答案」的用例')
      if (!/不传\s*include_answers/.test(m10)) errors.push('M10：缺少「不传即不含答案」的用例')
    } else {
      warnings.push('找不到 M10 模块，跳过导出口径断言检查')
    }
  } else {
    warnings.push('找不到 document.service.ts，跳过导出口径镜像')
  }

  return { errors, warnings, checked }
}

// ---------- 入口 ----------

export function runGates(only = 'all') {
  const aText = read(path.join(DESIGN, A_NAME)) || ''
  const bText = read(path.join(DESIGN, B_NAME)) || ''
  const ctx = collectGuidelineIds(aText, bText)
  const out = { h1: null, h2: null, h3: null, missing: false }

  if (only === 'all' || only === 'h1') {
    if (!aText || !bText) { out.missing = true; out.h1 = { errors: ['找不到 20a / 20b，无法校验引用'], warnings: [], checked: 0, missing: true } } else out.h1 = checkProposals(ctx)
  }
  if (only === 'all' || only === 'h2') out.h2 = checkClaims()
  if (only === 'all' || only === 'h3') {
    const r = checkMirrors()
    if (r.missing) { out.missing = true; out.h3 = { errors: [`缺少镜像源文件：${r.missingList.join('、')}`], warnings: [], checked: 0, missing: true } } else out.h3 = r
  }
  return out
}

function main() {
  const args = process.argv.slice(2)
  const onlyArg = args.find((a) => a.startsWith('--only='))
  const only = onlyArg ? onlyArg.split('=')[1] : 'all'
  const json = args.includes('--json')

  if (!['all', 'h1', 'h2', 'h3'].includes(only)) {
    console.error(`未知的 --only 值：${only}（可用 all / h1 / h2 / h3）`)
    process.exit(2)
  }

  const res = runGates(only)
  const labels = { h1: 'H1 归因门（提案单结构 + 引用可解析）', h2: 'H2 口径门（用户可见面禁用宣称词）', h3: 'H3 同步门（镜像参数逐字一致）' }
  const keys = ['h1', 'h2', 'h3'].filter((k) => res[k])
  const total = keys.reduce((n, k) => n + res[k].errors.length, 0)
  const warns = keys.flatMap((k) => res[k].warnings)

  if (json) {
    console.log(JSON.stringify({ ok: total === 0, checks: res, warnings: warns }, null, 2))
  } else {
    for (const k of keys) {
      const r = res[k]
      const mark = r.errors.length ? '✗' : '✓'
      console.log(`${mark} ${labels[k]}（检查 ${r.checked} 处）`)
      for (const e of r.errors) console.log(`    · ${e}`)
    }
    for (const w of warns) console.log(`  ⚠ ${w}`)
    console.log(total === 0 ? '\n三条硬门全部通过' : `\n共 ${total} 条不合格`)
  }

  if (res.missing) process.exit(2)
  process.exit(total === 0 ? 0 : 1)
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) main()
