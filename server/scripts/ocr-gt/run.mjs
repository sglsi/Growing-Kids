#!/usr/bin/env node
// ============================================================
// OCR 识别质量评测（跑真后端 + 真引擎，输出 CER / 行命中 / 数字召回）
//
//   cd server
//   node scripts/ocr-gt/gen.mjs                     # 先生成图（缺图时才需要）
//   node scripts/ocr-gt/run.mjs                     # 评测（fast 模式）
//   node scripts/ocr-gt/run.mjs --mode precise      # 精准模式（PP-StructureV3，慢 10 倍）
//   node scripts/ocr-gt/run.mjs --update-baseline   # 认下当前结果为新基线
//   node scripts/ocr-gt/run.mjs --case arith-clean  # 只跑一条
//
// 退出码（刻意区分"质量不合格"与"环境跑不起来"）：
//   0 = 全部达标且未相对基线退步
//   1 = 质量不达标 / 相对基线退步
//   2 = 无法评测（后端不可达、身份建立失败、OCR 侧车缺席）
// 把 2 单独拆出来，是因为"环境没起来"被当成"质量变差"会让人去改本来没坏的代码。
// ============================================================

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { cer, lineRecall, numberRecall, normalize } from './lib/metrics.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CASES_DIR = path.join(HERE, 'cases')
const SPEC = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'))
const BASELINE_PATH = path.join(HERE, 'baseline.json')
const REPORT_MD = path.join(HERE, 'report.md')
const REPORT_JSON = path.join(HERE, 'report.json')

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const has = (name) => argv.includes(`--${name}`)

const API = (process.env.GK_API_BASE || 'http://127.0.0.1:3001/api').replace(/\/+$/, '')
const ORIGIN = API.replace(/\/api$/, '')
const MODE = arg('mode', 'fast')
const UPDATE_BASELINE = has('update-baseline')
const ONLY = arg('case', '')
const TIMEOUT = Number(process.env.GK_OCR_TIMEOUT || 240000)

/** 相对基线允许的劣化幅度：低于它视为"引擎抖动"，高于它就当退步处理 */
const CER_TOLERANCE = 0.05
const LINE_TOLERANCE = 0.15

function log(msg) { console.log(msg) }

async function post(pathname, { token, body, form, timeout = TIMEOUT } = {}) {
  const headers = {}
  if (token) headers['X-Auth-Token'] = token
  let payload
  if (form) payload = form
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(`${API}${pathname}`, {
    method: 'POST', headers, body: payload, signal: AbortSignal.timeout(timeout),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

async function ensureIdentity() {
  const deviceId = `ocr-gt-${Date.now().toString(36)}`
  // ⚠️ 必须走引导路由 + X-Device-Id 换令牌：严格令牌模式下裸 X-User-Id 一律 401
  const res = await fetch(`${API}/auth/anonymous`, {
    method: 'POST', headers: { 'X-Device-Id': deviceId }, signal: AbortSignal.timeout(60000),
  })
  const json = await res.json().catch(() => null)
  const token = json?.data?.auth_token
  if (res.status !== 200 || !token) {
    throw Object.assign(new Error(`建立评测身份失败：HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`), { fatal: true })
  }
  return token
}

/** 上传图 → 拿到存储 URL（后端通过 localFileKey/对象存储两条路都能读回） */
async function uploadImage(token, absPath) {
  const buf = fs.readFileSync(absPath)
  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'image/png' }), path.basename(absPath))
  // attach = 持久化但不建业务条目（评测不该往用户时间轴里塞垃圾）
  form.append('purpose', 'attach')
  form.append('original_name', encodeURIComponent(`gt-${path.basename(absPath)}`))
  const r = await post('/upload', { token, form, timeout: 120000 })
  if (r.status !== 200) throw new Error(`上传失败：HTTP ${r.status} ${r.text.slice(0, 200)}`)
  const key = r.json?.data?.file_key || r.json?.data?.key
  const uploadedUrl = r.json?.data?.url || ''
  if (!key) throw new Error(`上传未返回 file_key：${r.text.slice(0, 200)}`)
  // 优先用后端给的 url（supabase 驱动是签名/公网直链）；
  // 只有拿不到绝对地址时才退回本服务的存储代理（local 驱动形态）
  if (/^https?:\/\//i.test(uploadedUrl)) return uploadedUrl
  return `${ORIGIN}/api/storage/files/${key}`
}

/** 调一次全页 OCR，返回纯文本（段落按阅读序拼） */
async function ocrPage(token, imageUrl) {
  const r = await post('/image/ocr-page', { token, body: { image_url: imageUrl, mode: MODE, force: true } })
  if (r.status !== 200) {
    const msg = r.json?.message || r.text.slice(0, 200)
    // 侧车/引擎缺席时后端会 5xx 或明确报「OCR 不可用」——这属于环境问题，不是质量结论
    const envIssue = /OCR|侧车|sidecar|引擎|engine|不可用|ECONN|timeout/i.test(String(msg))
    throw Object.assign(new Error(`OCR 调用失败 HTTP ${r.status}：${msg}`), { fatal: envIssue })
  }
  const segs = r.json?.data?.page_text || []
  return { text: segs.map((s) => s.text || '').join('\n'), segments: segs.length }
}

/** 收集待评测案例：JSON 里的合成案例 + cases/ 下"有同名 .txt"的真实照片 */
function collectCases() {
  const byId = new Map(SPEC.cases.map((c) => [c.id, c]))
  /** 退化案例用 `of` 指向基础案例：期望文本必须继承，否则等于拿空真值去比（首版就栽在这） */
  const expectOf = (c) => {
    if (c.expect) return c.expect
    const base = c.of ? byId.get(c.of) : null
    if (!base) throw new Error(`案例 ${c.id} 既没有 expect，也没有可用的 of（${c.of}）`)
    return expectOf(base)
  }

  const list = SPEC.cases.map((c) => ({
    id: c.id,
    tier: c.tier,
    desc: c.desc,
    file: path.join(CASES_DIR, `${c.id}.png`),
    expect: expectOf(c),
    maxCer: c.maxCer ?? 0.15,
    minLineRecall: c.minLineRecall ?? 0.8,
    minNumberRecall: c.minNumberRecall ?? 0.85,
    /** 已知缺陷：不判失败，但必须在报告里显形（修好后删掉这个字段） */
    knownIssue: c.knownIssue || null,
  }))

  // 真实照片层：foo.png + foo.txt（真值按行写）即自动收录，无需改 cases.json
  if (fs.existsSync(CASES_DIR)) {
    for (const f of fs.readdirSync(CASES_DIR)) {
      if (!/\.(png|jpe?g|webp)$/i.test(f)) continue
      const id = f.replace(/\.(png|jpe?g|webp)$/i, '')
      if (list.some((c) => c.id === id)) continue
      const txt = path.join(CASES_DIR, `${id}.txt`)
      if (!fs.existsSync(txt)) continue
      list.push({
        id,
        tier: 'real',
        desc: '真实照片（同名 .txt 为真值）',
        file: path.join(CASES_DIR, f),
        expect: fs.readFileSync(txt, 'utf8').replace(/\r\n/g, '\n').trim(),
        // 真实照片本来就更难，阈值放宽；关键是**与自己比**（baseline 回归）
        maxCer: 0.3,
        minLineRecall: 0.7,
        minNumberRecall: 0.8,
      })
    }
  }

  return ONLY ? list.filter((c) => c.id === ONLY) : list
}

function loadBaseline() {
  try { return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) } catch { return null }
}

async function main() {
  const cases = collectCases()
  const missing = cases.filter((c) => !fs.existsSync(c.file))
  if (missing.length) {
    log(`缺少 GT 图片：${missing.map((c) => c.id).join(', ')}`)
    log('先跑：node scripts/ocr-gt/gen.mjs')
    process.exit(2)
  }
  if (!cases.length) {
    log('没有可评测的案例（检查 --case 参数）')
    process.exit(2)
  }

  let token
  try {
    token = await ensureIdentity()
  } catch (e) {
    log(`✗ ${e.message}`)
    log('后端没起来？先启动：cd server && node dist/main -p 3001')
    process.exit(2)
  }

  let baseline = UPDATE_BASELINE ? null : loadBaseline()
  // 基线是"这个引擎 + 这个模式"的指纹：换模式比 CER 没有意义（fast 与 precise 天然差一截）
  if (baseline && baseline.mode !== MODE) {
    log(`注意：基线是 ${baseline.mode} 模式的，本次是 ${MODE}，跳过基线对比（只按阈值判定）`)
    baseline = null
  }
  const rows = []
  let fatal = false

  log(`OCR 质量评测  目标：${API}  模式：${MODE}  案例：${cases.length}`)
  log('─'.repeat(72))

  for (const c of cases) {
    let hyp = ''
    let segCount = 0
    try {
      const url = await uploadImage(token, c.file)
      const out = await ocrPage(token, url)
      hyp = out.text
      segCount = out.segments
    } catch (e) {
      if (e.fatal) {
        log(`✗ ${c.id}：${e.message}`)
        log('  这是环境问题（后端/OCR 侧车），不作为质量结论。')
        fatal = true
        break
      }
      rows.push({ ...c, runError: e.message })
      continue
    }

    const cVal = cer(c.expect, hyp)
    const lr = lineRecall(c.expect, hyp)
    const nr = numberRecall(c.expect, hyp)
    const base = baseline?.cases?.[c.id]

    const problems = []
    if (cVal > c.maxCer) problems.push(`CER ${cVal.toFixed(3)} > 阈值 ${c.maxCer}`)
    if (lr.ratio < c.minLineRecall) problems.push(`行命中 ${(lr.ratio * 100).toFixed(0)}% < 阈值 ${(c.minLineRecall * 100).toFixed(0)}%`)
    if (nr.ratio < c.minNumberRecall) problems.push(`数字召回 ${(nr.ratio * 100).toFixed(0)}% < 阈值 ${(c.minNumberRecall * 100).toFixed(0)}%`)
    if (base) {
      if (cVal > base.cer + CER_TOLERANCE) problems.push(`相对基线退步：CER ${base.cer.toFixed(3)} → ${cVal.toFixed(3)}`)
      if (lr.ratio < base.lineRecall - LINE_TOLERANCE) problems.push(`相对基线退步：行命中 ${(base.lineRecall * 100).toFixed(0)}% → ${(lr.ratio * 100).toFixed(0)}%`)
    }

    // 已知缺陷（xfail）：不判失败，但必须显形。
    // 它现在的作用是"把还没修的问题钉在报告里"，而不是"假装达标"——
    // 所以一旦它不再有问题，反而要提醒把标记删掉（说明修好了）。
    const known = Boolean(c.knownIssue)
    const resolved = known && problems.length === 0

    rows.push({
      id: c.id, tier: c.tier, desc: c.desc,
      knownIssue: c.knownIssue || null,
      resolved,
      cer: Number(cVal.toFixed(4)),
      lineRecall: Number(lr.ratio.toFixed(4)),
      numberRecall: Number(nr.ratio.toFixed(4)),
      segments: segCount,
      charsRef: normalize(c.expect).length,
      charsHyp: normalize(hyp).length,
      missedLines: lr.missed.slice(0, 4),
      missedNumbers: nr.missed.slice(0, 8),
      problems,
      hypPreview: hyp.replace(/\s+/g, ' ').slice(0, 160),
    })

    const flag = known ? (resolved ? 'FIXED' : 'KNOW ') : (problems.length ? 'FAIL' : 'PASS')
    log(
      `${flag}  ${c.id.padEnd(16)} CER ${(cVal * 100).toFixed(1).padStart(5)}%  ` +
      `行 ${(lr.ratio * 100).toFixed(0).padStart(3)}%  数字 ${(nr.ratio * 100).toFixed(0).padStart(3)}%  ` +
      `${c.tier}`,
    )
    if (known && resolved) log(`      · 已知缺陷已不再复现，可以从 cases.json 删掉 knownIssue`)
    for (const p of problems) log(`      · ${p}`)
  }

  if (fatal) {
    log('\n评测未完成（环境问题），未写出基线/报告。')
    process.exit(2)
  }

  const done = rows.filter((r) => !r.runError)
  // 已知缺陷不计入"不达标"：它们是待办，不是回归
  const failed = done.filter((r) => r.problems?.length && !r.knownIssue)
  const avgCer = done.length ? done.reduce((s, r) => s + r.cer, 0) / done.length : 1

  writeReports({ rows, mode: MODE, avgCer, failed: failed.length, knownOpen: done.filter((r) => r.knownIssue && r.problems?.length).length })

  if (UPDATE_BASELINE) {
    const obj = {
      generated_at: new Date().toISOString(),
      mode: MODE,
      engine_note: '基线由 --update-baseline 生成；只在"确认这是当前引擎的真实水平"时才更新',
      cases: Object.fromEntries(
        done.map((r) => [r.id, { cer: r.cer, lineRecall: r.lineRecall, numberRecall: r.numberRecall }]),
      ),
    }
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(obj, null, 2) + '\n')
    log(`\n已更新基线：${path.relative(process.cwd(), BASELINE_PATH)}`)
  }

  log('─'.repeat(72))
  const knownOpen = done.filter((r) => r.knownIssue && r.problems?.length).length
  log(`平均 CER ${(avgCer * 100).toFixed(1)}%   达标 ${done.length - failed.length - knownOpen}/${done.length - knownOpen}   已知缺陷 ${knownOpen}`)
  log(`报告：${path.relative(process.cwd(), REPORT_MD)}`)

  if (rows.some((r) => r.runError)) {
    log(`\n⚠️ 有 ${rows.filter((r) => r.runError).length} 条用例执行异常（非质量结论）：`)
    for (const r of rows.filter((x) => x.runError)) log(`  · ${r.id}: ${r.runError}`)
  }

  process.exit(failed.length ? 1 : 0)
}

/** 表格里的结论列：区分「达标 / 不达标 / 已知缺陷」三种状态 */
function verdictOf(r) {
  if (!r.problems || !r.problems.length) {
    return r.knownIssue ? '✅ 已不再复现（请移除 knownIssue）' : '✅'
  }
  // 表格里只放编号，完整说明放文末「已知缺陷」一节（否则一行能把整张表撑开）
  if (r.knownIssue) return `⚠️ 已知缺陷 ${String(r.knownIssue).split(/[：:]/)[0]}`
  return `❌ ${r.problems.join('；')}`
}

function writeReports({ rows, mode, avgCer, failed, knownOpen = 0 }) {
  const md = []
  md.push('# OCR 识别质量评测报告')
  md.push('')
  md.push(`生成时间：${new Date().toISOString()}　模式：**${mode}**　目标：\`${API}\``)
  md.push('')
  md.push('| 案例 | 层级 | CER | 行命中 | 数字召回 | 段数 | 结论 |')
  md.push('|---|---|---:|---:|---:|---:|---|')
  for (const r of rows) {
    if (r.runError) {
      md.push(`| ${r.id} | ${r.tier} | — | — | — | — | ⚠️ 执行异常 |`)
      continue
    }
    md.push(
      `| ${r.id} | ${r.tier} | ${(r.cer * 100).toFixed(1)}% | ${(r.lineRecall * 100).toFixed(0)}% | ` +
      `${(r.numberRecall * 100).toFixed(0)}% | ${r.segments} | ${verdictOf(r)} |`,
    )
  }
  md.push('')
  md.push(`平均 CER：**${(avgCer * 100).toFixed(1)}%**　不达标：**${failed}**　已知缺陷：**${knownOpen}**`)

  const knownRows = rows.filter((r) => r.knownIssue)
  if (knownRows.length) {
    md.push('')
    md.push('## 已知缺陷（不判失败，但必须显形）')
    md.push('')
    for (const r of knownRows) {
      md.push(`- **${r.id}**：${r.knownIssue}`)
      if (r.problems?.length) md.push(`  - 当前未达标项：${r.problems.join('；')}`)
    }
  }

  md.push('')
  md.push('## 识别原文（前 160 字，便于肉眼核对）')
  md.push('')
  for (const r of rows.filter((x) => !x.runError)) {
    md.push(`- **${r.id}**：\`${r.hypPreview || '(空)'}\``)
    if (r.missedLines?.length) md.push(`  - 未命中行：${r.missedLines.map((x) => `\`${x}\``).join('、')}`)
    if (r.missedNumbers?.length) md.push(`  - 丢失数字：${r.missedNumbers.join('、')}`)
  }
  md.push('')
  md.push('> 指标定义见 `lib/metrics.mjs`：只做无损归一（去空白、全角转半角），不把 ×/x、O/0 当同一个字。')
  fs.writeFileSync(REPORT_MD, md.join('\n') + '\n')
  fs.writeFileSync(REPORT_JSON, JSON.stringify({ generated_at: new Date().toISOString(), mode, api: API, avgCer, rows }, null, 2) + '\n')
}

main().catch((e) => {
  console.error('[ocr-gt] 未预期失败：', e)
  process.exit(2)
})
