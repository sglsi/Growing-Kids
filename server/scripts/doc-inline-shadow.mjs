#!/usr/bin/env node
/**
 * P-020 阶段 1「影子链路」驱动：在生产 28 份 .doc 样本上跑 F0/F1/F2/F3。
 *
 * 🔴 授权边界（思傅 2026-11-10 逐题拍板）：
 *   Q1 ① 用重转产物 + F0 同源硬闸；Q2 ① char_start 唯一最近消歧；
 *   Q3 ① OLE（w:object）未定性全跳过；Q4 ① 授权阶段 1 影子脚本实现 F0/F1/F2；
 *   Q5 **未授权** --apply ⇒ 本脚本遇到 --apply 直接拒绝，且源码里没有任何
 *      INSERT / UPDATE / DELETE、`question_inline_figures` 写入、storage 写入或产图调用。
 *   F4 候选 SQL 扩展 **未实现**（`netdisk-inline-build.mjs` 仍只认 ext='docx'）。
 *
 * 只读纪律：
 *   · DB 只有 SELECT；网盘只下载；docx 只在 /tmp 转换且用完即删；
 *   · 真相源 `netdisk-inline-crop.py` / `ocr-engine/pdf_tool.py` 只被 import，mtime/sha 不变；
 *   · 不写 `question_inline_figures` / `question_inline_done` / 任何表，不落图片。
 *
 * 用法（在 L3 生产，由 systemd-run 起，见 docs/reports/P-020-阶段1-影子链路闸门验证报告.md）：
 *   NODE_PATH=/opt/gk/server/node_modules OCR_PYTHON=/opt/gk/.venv-py/bin/python \
 *     node /tmp/gk-p020-shadow/doc-inline-shadow.mjs --selftest
 *   NODE_PATH=/opt/gk/server/node_modules OCR_PYTHON=/opt/gk/.venv-py/bin/python \
 *     node /tmp/gk-p020-shadow/doc-inline-shadow.mjs --out /tmp/gk-p020-shadow-summary.json
 * 可选：--limit N / --source <id> / --work <dir> / --crop-py <path> / --pdf-py <path>
 */
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const argv = process.argv.slice(2)
if (argv.includes('--apply')) {
  console.error('[p020-shadow] 拒绝执行：Q5 未授权 --apply（阶段 2 写入未放行）')
  process.exit(3)
}
const has = (f) => argv.includes(f)
const val = (f, d) => {
  const i = argv.indexOf(f)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const ROOT = process.env.GK_SHADOW_ROOT || '/opt/gk/server'
const WORK = val('--work', process.env.GK_SHADOW_WORK || '/tmp/gk-p020-shadow')
const OUT = val('--out', '/tmp/gk-p020-shadow-summary.json')
const CROP_PY = val('--crop-py', process.env.GK_CROP_PY || path.join(ROOT, 'scripts/netdisk-inline-crop.py'))
const PDF_PY = val('--pdf-py', process.env.GK_PDF_PY || path.join(ROOT, '../ocr-engine/pdf_tool.py'))
const SHADOW_PY = val('--shadow-py', process.env.GK_SHADOW_PY ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'doc-inline-shadow.py'))
const PY = process.env.OCR_PYTHON || 'python3'
const LIMIT = Number(val('--limit', 0))
const SOURCE = val('--source', '')
const SELFTEST = has('--selftest')
const MIN_FREE_KB = 700_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shaFile = (p) => crypto.createHash('sha256').update(fsSync.readFileSync(p)).digest('hex').slice(0, 16)

const require = createRequire(path.join(ROOT, 'package.json'))
const pg = require('pg')
try {
  require('dotenv').config({ path: path.join(ROOT, '.env') })
  require('dotenv').config({ path: path.join(ROOT, '.env.secrets') })
} catch { /* systemd-run 的 unit 已 source env，这里只是本机兜底 */ }

const { BaiduNetdiskService } = await import(
  pathToFileURL(path.join(ROOT, 'dist/storage/baidu-netdisk.service.js')).href)

function convert(src, outDir, profile) {
  return new Promise((resolve, reject) => {
    const child = spawn('nice', [
      '-n', '19', 'ionice', '-c3', 'soffice',
      `-env:UserInstallation=file://${profile}`, '--headless', '--norestore',
      '--convert-to', 'docx', '--outdir', outDir, src,
    ], { detached: true, stdio: 'ignore' })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* 已退出 */ }
      reject(new Error('convert_timeout'))
    }, 180_000)
    child.on('error', (e) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(e) }
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      code === 0 ? resolve() : reject(new Error(`convert_exit_${code}`))
    })
  })
}

async function memAvailableKb() {
  const txt = await fs.readFile('/proc/meminfo', 'utf8')
  return Number((txt.match(/MemAvailable:\s+(\d+)/) || [0, 0])[1])
}

async function selftest() {
  const out = execFileSync(PY, [SHADOW_PY, '--selftest'], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GK_CROP_PY: CROP_PY, GK_PDF_PY: PDF_PY },
  })
  const r = JSON.parse(out.trim().split('\n').pop())
  console.log('P020_SELFTEST ' + JSON.stringify(r))
  return r.pass ? 0 : 2
}

async function main() {
  await fs.mkdir(WORK, { recursive: true })
  await fs.mkdir(path.join(WORK, 'out'), { recursive: true })
  const truthBefore = { crop: shaFile(CROP_PY), pdfTool: shaFile(PDF_PY) }

  if (SELFTEST) return selftest()

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  let docs, objRows
  try {
    // 🔴 只读：全脚本唯一的 DB 交互就是下面两条 SELECT。
    ;({ rows: docs } = await client.query(`
      select n.id::text as id, n.user_id::text as user_id, n.fs_id::text as fsid,
             n.name, n.size_bytes::bigint::text as size_bytes, n.text_content,
             d.text_sha256,
             coalesce(d.drawing_count, 0) + coalesce(d.object_count, 0) as marks_expected
        from netdisk_files n
        join doc_convert_done d on d.source_id = n.id and d.user_id = n.user_id
       where n.ext = 'doc' and n.text_status = 'ok' and d.status = 'ok'
         and d.text_sha256 is not null
         and exists (select 1 from question_objects q
                      where q.source_id = n.id and q.user_id = n.user_id)
       order by n.id`))
    ;({ rows: objRows } = await client.query(`
      select q.source_id::text as source_id, q.object_index as index,
             coalesce(q.char_start, 0)::int as start, q.stem_text as stem
        from question_objects q
        join netdisk_files n on n.id = q.source_id and n.user_id = q.user_id
       where n.ext = 'doc' and n.text_status = 'ok'
       order by q.source_id, q.object_index`))
  } finally {
    await client.end()
  }
  const objMap = new Map()
  for (const r of objRows) {
    if (!objMap.has(r.source_id)) objMap.set(r.source_id, [])
    objMap.get(r.source_id).push({ index: Number(r.index), start: Number(r.start), stem: r.stem })
  }
  let target = SOURCE ? docs.filter((d) => d.id === SOURCE) : docs
  if (LIMIT > 0) target = target.slice(0, LIMIT)
  console.log(`P020_START docs=${target.length} objects=${[...objMap.values()].reduce((s, a) => s + a.length, 0)} ` +
    `netdisk=${new BaiduNetdiskService().enabled()} py=${PY}`)

  const nd = new BaiduNetdiskService()
  const results = []
  for (const [i, s] of target.entries()) {
    const r = { i, id: s.id, name: String(s.name).slice(0, 40), bytes: Number(s.size_bytes) }
    let src = '', docx = '', mfPath = ''
    try {
      const mem = await memAvailableKb()
      if (mem < MIN_FREE_KB) {
        console.log(`P020_MEMWAIT ${i} mem=${mem}kB`)
        for (let k = 0; k < 12 && (await memAvailableKb()) < MIN_FREE_KB; k++) await sleep(10_000)
      }
      const buf = await nd.downloadByFsId(s.fsid)
      r.magic = buf.subarray(0, 8).toString('hex')
      if (r.magic !== 'd0cf11e0a1b11ae1') {
        r.status = 'not_ole'
        results.push(r)
        console.log('P020 ' + JSON.stringify(r))
        continue
      }
      src = path.join(WORK, `${s.fsid}.doc`)
      await fs.writeFile(src, buf)
      const profile = path.join(WORK, `p-${i}`)
      await fs.rm(profile, { recursive: true, force: true })
      await fs.mkdir(profile, { recursive: true })
      const t0 = Date.now()
      await convert(src, path.join(WORK, 'out'), profile)
      r.convert_ms = Date.now() - t0
      docx = path.join(WORK, 'out', `${s.fsid}.docx`)
      if (!fsSync.existsSync(docx) || fsSync.statSync(docx).size === 0) throw new Error('no_docx')
      const mf = {
        id: s.id, name: s.name, docx, cropPath: CROP_PY, pdfToolPath: PDF_PY,
        textContent: s.text_content || '', textSha256: s.text_sha256,
        marksExpected: Number(s.marks_expected),
        objects: objMap.get(s.id) || [],
      }
      mfPath = path.join(WORK, `mf-${i}.json`)
      await fs.writeFile(mfPath, JSON.stringify(mf))
      const out = JSON.parse(execFileSync(PY, [SHADOW_PY, mfPath], {
        encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024,
      }))
      r.status = out.status
      r.f0 = out.f0
      r.f1 = out.f1
      r.stat = out.f2_f3
      r.candidates = out.candidates?.length || 0
      r.non_figure = (out.candidates || []).filter((c) => c.kind !== 'figure').length
      r.samples = (out.candidates || []).slice(0, 3)
      r.reason = out.reason
    } catch (e) {
      r.status = 'error'
      r.error = String(e.message || e).slice(0, 220)
    } finally {
      for (const p of [src, docx, mfPath]) {
        if (p) await fs.rm(p, { force: true }).catch(() => {})
      }
    }
    results.push(r)
    console.log('P020 ' + JSON.stringify({
      i, id: r.id, status: r.status, ms: r.convert_ms,
      f0: r.f0?.ok, f1: r.f1?.ok, marks: r.f1?.marks, marks_exp: r.f1?.marks_expected,
      objs: r.stat?.objects, multi: r.stat?.multi, corrected: r.stat?.corrected,
      ambiguous: r.stat?.ambiguous, ole: r.stat?.ole_skipped,
      cand: r.candidates, oob: r.stat?.offset_oob, err: r.error || null,
    }))
  }

  const ok = results.filter((r) => r.status === 'ok')
  const sum = (f) => ok.reduce((s, r) => s + (f(r) || 0), 0)
  const rejected = results.filter((r) => r.status === 'f0_reject')
  const g = {
    docs: results.length,
    ok: ok.length,
    errors: results.filter((r) => r.status === 'error' || r.status === 'not_ole').length,
    f0_reject: rejected.length,
    f0_reject_ids: rejected.map((r) => r.id),
    f1_reject: results.filter((r) => r.status === 'f1_reject').length,
    no_marks: results.filter((r) => r.status === 'no_marks').length,
    non_figure_candidates: results.reduce((s, r) => s + (r.non_figure || 0), 0),
    stems: sum((r) => r.stat?.objects),
    short: sum((r) => r.stat?.short),
    miss: sum((r) => r.stat?.miss),
    multi: sum((r) => r.stat?.multi),
    ambiguous_drops: sum((r) => r.stat?.ambiguous),
    no_exact_drops: sum((r) => r.stat?.no_exact),
    exp_mismatch_drops: sum((r) => r.stat?.exp_mismatch),
    beyond_body_drops: sum((r) => r.stat?.beyond_body),
    corrected: sum((r) => r.stat?.corrected),
    chosen_not_expected: sum((r) => r.stat?.chosen_not_expected),
    ole_skipped: sum((r) => r.stat?.ole_skipped),
    in_stem_marks: sum((r) => r.stat?.in_stem_marks),
    figure_candidates: sum((r) => r.candidates),
    offset_oob: sum((r) => r.stat?.offset_oob),
    offset_zero: sum((r) => r.stat?.offset_zero),
    marks_match_all: ok.every((r) => r.f1?.marks_match),
    f0_all_ok: ok.every((r) => r.f0?.ok),
    f1_all_ok: ok.every((r) => r.f1?.ok),
  }
  const accept = {
    zero_write: true,
    offset_oob_0: g.offset_oob === 0,
    cross_question_0: g.chosen_not_expected === 0 && g.exp_mismatch_drops === 0
      && g.beyond_body_drops === 0,
    f0_catches_anomaly: g.f0_reject >= 1,
    f3_no_formula_output: g.non_figure_candidates === 0 && g.ole_skipped >= 0,
    cgroup_ok: g.errors === 0,
  }
  accept.all = Object.values(accept).every(Boolean)
  const summary = {
    at: new Date().toISOString(), engine: 'p020-shadow-stage1',
    q: { Q1: '①重转产物+F0', Q2: '①char_start唯一最近', Q3: '①OLE未定性全跳过',
         Q4: '①授权阶段1影子脚本', Q5: '未授权 --apply' },
    f4_implemented: false, apply_authorized: false,
    truth_before: truthBefore, truth_after: { crop: shaFile(CROP_PY), pdfTool: shaFile(PDF_PY) },
    gates: g, accept, results,
  }
  await fs.writeFile(OUT, JSON.stringify(summary, null, 2))
  console.log('P020_SUMMARY ' + JSON.stringify({ gates: g, accept }))
  console.log('P020_DONE ' + OUT)
  return accept.all ? 0 : 2
}

process.exitCode = await main()
