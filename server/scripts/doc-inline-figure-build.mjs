#!/usr/bin/env node
/**
 * P-020 / D-033：独立 `.doc` 产图链路（F4 的落地形态）。
 *
 * 🔴 为什么是「独立」而不是改 `netdisk-inline-build.mjs`：
 *    docx 侧 7,286 份 / 273,037 张图已全量收口，改它的候选 SQL 会让 docx 真相源
 *    与新 `.doc` 的 F0/F2/F5 判定混在一条链路上，零回归无法证明。本脚本另起一条：
 *    下载 `.doc` → 独立 LO profile 重转 docx → F0 同源 → F1 严格前缀 →
 *    F2 char_start 唯一最近 → F3 OLE 全跳过 → F5/F5b 语义闸 →
 *    `doc-inline-figure-crop.py` 产图到**本地暂存** → 生成「待写清单」JSON。
 *
 * 🔴 本轮授权边界（思傅 2026-11-10「A授权；B/C 均选择2；D给出我进行复核的详细步骤」）：
 *    A 授权实现链路 + M42 v3 + docx 零回归；但 C② 让 Q5 写库**顺延**到
 *    P-023（`m:oMath`/`w:object` 定性）与 40 条人工复核完成。
 *    ⇒ 本脚本**默认只读 + --apply 双硬锁**，本轮零生产写入：
 *       ① 常量 `APPLY_ENABLED = false`；
 *       ② 还需 `DOC_INLINE_APPLY_APPROVED=1`；
 *       ③ 任一不满足 ⇒ `--apply` 直接 exit 3。
 *    解开硬锁须：P-023 定性完成 + 40 条人工复核签核 + M42 升 v4 + 另建 D 号。
 *
 * 只读纪律（与阶段 1 影子脚本同款，事故换来的）：
 *   · DB 只有 SELECT（写库代码在 applyWrites 内，被硬锁挡住）；
 *   · 网盘只下载；`.doc` / 重转 docx / manifest / webp 全在 /tmp 且用完即删；
 *   · 每份独立 LO profile、nice19 + ionice -c3、MemAvailable <700MB 等待、单份超时；
 *   · 真相源 `netdisk-inline-crop.py` 与 `ocr-engine/pdf_tool.py` 只读 import，sha 前后比对。
 *
 * 用法（L3，由 systemd-run 起，默认只读 probe）：
 *   NODE_PATH=/opt/gk/server/node_modules OCR_PYTHON=/opt/gk/.venv-py/bin/python \
 *     node doc-inline-figure-build.mjs --limit 3 --out /tmp/gk-p020-figure-probe.json
 *   可选 --source <id> / --work <dir> / --crop-py <path> / --pdf-py <path> / --shadow-py <path>
 *   --apply 当前硬拒（exit 3），见上方双硬锁。
 */
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const argv = process.argv.slice(2)

// 🔴 硬锁 ①：Q5 --apply 顺延中，本轮不得写库。M42 v3 / B9 静态断言此常量必须为 false。
const APPLY_ENABLED = false

if (argv.includes('--apply') && (!APPLY_ENABLED || process.env.DOC_INLINE_APPLY_APPROVED !== '1')) {
  console.error('[p020-figure] 拒绝执行：Q5 --apply 顺延中（待 P-023 定性 + 40 条人工复核 + M42 v4 + 放行 D 号）')
  process.exit(3)
}

const has = (f) => argv.includes(f)
const val = (f, d) => {
  const i = argv.indexOf(f)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const ROOT = process.env.GK_FIGURE_ROOT || '/opt/gk/server'
const WORK = val('--work', process.env.GK_FIGURE_WORK || '/tmp/gk-p020-figure')
const OUT = val('--out', '/tmp/gk-p020-figure-summary.json')
const CROP_PY = val('--crop-py', process.env.GK_CROP_PY || path.join(ROOT, 'scripts/netdisk-inline-crop.py'))
const PDF_PY = val('--pdf-py', process.env.GK_PDF_PY || path.join(ROOT, '../ocr-engine/pdf_tool.py'))
const SHADOW_PY = val('--shadow-py', process.env.GK_SHADOW_PY ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'doc-inline-shadow.py'))
const FIGURE_PY = val('--figure-py', process.env.GK_FIGURE_PY ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'doc-inline-figure-crop.py'))
const PY = process.env.OCR_PYTHON || 'python3'
const LIMIT = Number(val('--limit', 0))
const SOURCE = val('--source', '')
const APPLY = has('--apply')
const ENGINE = 'p020-doc-figure-v1'
const MIN_FREE_KB = 700_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shaFile = (p) => crypto.createHash('sha256').update(fsSync.readFileSync(p)).digest('hex').slice(0, 16)

const require = createRequire(path.join(ROOT, 'package.json'))
const pg = require('pg')
try {
  require('dotenv').config({ path: path.join(ROOT, '.env') })
  require('dotenv').config({ path: path.join(ROOT, '.env.secrets') })
} catch { /* systemd-run 的 unit 已 source env，这里只是本机兜底 */ }

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

/**
 * 🔴 写库末端（Q5）：被 APPLY_ENABLED 硬锁，本轮不可达。
 * 保留完整实现是为了让链路可评审、可在 Q5 放行时只改门不改代码；
 * 解锁须同时满足 M42 v4 + 放行 D 号 + P-023 定性 + 人工复核签核。
 */
async function applyWrites(s, items, workDir, objs, rev) {
  const sdir = process.env.STORAGE_LOCAL_DIR || path.resolve(ROOT, '.local-storage')
  for (const it of items) {
    const src = path.join(workDir, it.key)
    const dst = path.join(sdir, it.key)
    await fs.mkdir(path.dirname(dst), { recursive: true })
    await fs.copyFile(src, dst)
  }
  // 读库连接在 main 开头已关闭（只读纪律），写库时另开一次性连接。
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  const cols = ['user_id', 'source_type', 'source_id', 'object_index', 'seq',
    'char_offset', 'kind', 'storage_key', 'width', 'height', 'size_bytes',
    'page_index', 'source_revision', 'engine_version']
  for (let k = 0; k < items.length; k += 200) {
    const part = items.slice(k, k + 200)
    const vals = []
    const ph = part.map((it, idx) => {
      const b = idx * cols.length
      vals.push(s.user_id, 'netdisk', s.id, it.index, it.seq, it.char_offset, it.kind,
        it.key, it.w, it.h, it.size || 0, it.page, rev, ENGINE)
      return `(${cols.map((_, j) => `$${b + j + 1}`).join(',')})`
    })
    await client.query(
      `insert into question_inline_figures (${cols.join(',')})
       values ${ph.join(',')}
       on conflict (user_id, source_type, source_id, object_index, seq)
       do update set char_offset = excluded.char_offset, kind = excluded.kind,
         storage_key = excluded.storage_key, width = excluded.width,
         height = excluded.height, size_bytes = excluded.size_bytes,
         page_index = excluded.page_index, engine_version = excluded.engine_version,
         built_at = now()`,
      vals,
    )
  }
  await client.query(
    `insert into question_inline_done
       (user_id, source_id, objects, figures, bytes, status, engine_version)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (user_id, source_id) do update set objects = excluded.objects,
       figures = excluded.figures, bytes = excluded.bytes, status = excluded.status,
       engine_version = excluded.engine_version, scanned_at = now()`,
    [s.user_id, s.id, objs, items.length,
      items.reduce((a, it) => a + (it.size || 0), 0),
      items.length ? 'ok' : 'empty', ENGINE],
  )
  await client.end()
}

async function main() {
  await fs.mkdir(WORK, { recursive: true })
  const truthBefore = { crop: shaFile(CROP_PY), pdfTool: shaFile(PDF_PY), shadow: shaFile(SHADOW_PY) }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  let docs, objRows
  try {
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
             coalesce(q.char_start, 0)::int as start, q.stem_text as stem,
             q.source_revision as source_revision
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
    objMap.get(r.source_id).push({
      index: Number(r.index), start: Number(r.start), stem: r.stem,
      source_revision: r.source_revision || '',
    })
  }
  let target = SOURCE ? docs.filter((d) => d.id === SOURCE) : docs
  if (LIMIT > 0) target = target.slice(0, LIMIT)

  const { BaiduNetdiskService } = await import(
    pathToFileURL(path.join(ROOT, 'dist/storage/baidu-netdisk.service.js')).href)
  const nd = new BaiduNetdiskService()
  console.log(`P020_FIGURE_START docs=${target.length} apply=${APPLY} ` +
    `apply_enabled=${APPLY_ENABLED} netdisk=${nd.enabled()} py=${PY}`)

  const results = []
  let minMemKb = Infinity
  for (const [i, s] of target.entries()) {
    const r = { i, id: s.id, name: String(s.name).slice(0, 40) }
    const dir = path.join(WORK, String(s.id))
    let src = '', docx = '', mfPath = ''
    try {
      const mem = await memAvailableKb()
      minMemKb = Math.min(minMemKb, mem)
      if (mem < MIN_FREE_KB) {
        console.log(`P020_FIGURE_MEMWAIT ${i} mem=${mem}kB`)
        for (let k = 0; k < 12 && (await memAvailableKb()) < MIN_FREE_KB; k++) await sleep(10_000)
      }
      await fs.rm(dir, { recursive: true, force: true })
      await fs.mkdir(path.join(dir, 'out'), { recursive: true })
      const buf = await nd.downloadByFsId(s.fsid)
      r.magic = buf.subarray(0, 8).toString('hex')
      if (r.magic !== 'd0cf11e0a1b11ae1') {
        r.status = 'not_ole'
        results.push(r)
        continue
      }
      src = path.join(dir, `${s.fsid}.doc`)
      await fs.writeFile(src, buf)
      const profile = path.join(dir, 'lo-profile')
      await fs.mkdir(profile, { recursive: true })
      const t0 = Date.now()
      await convert(src, path.join(dir, 'out'), profile)
      r.convert_ms = Date.now() - t0
      docx = path.join(dir, 'out', `${s.fsid}.docx`)
      if (!fsSync.existsSync(docx) || fsSync.statSync(docx).size === 0) throw new Error('no_docx')
      const mf = {
        id: s.id, name: s.name, docx, workDir: dir,
        cropPath: CROP_PY, pdfToolPath: PDF_PY, shadowPy: SHADOW_PY,
        textContent: s.text_content || '', textSha256: s.text_sha256,
        marksExpected: Number(s.marks_expected),
        objects: (objMap.get(s.id) || []).map(({ index, start, stem }) => ({ index, start, stem })),
      }
      r.source_revision = (objMap.get(s.id) || [{}])[0]?.source_revision || ''
      mfPath = path.join(dir, 'manifest.json')
      await fs.writeFile(mfPath, JSON.stringify(mf))
      execFileSync(PY, [FIGURE_PY, mfPath], {
        encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024,
      })
      const res = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'))
      r.status = res.status
      r.reason = res.reason
      r.f0 = res.f0
      r.f1 = res.f1
      r.f5 = res.f5
      r.candidates = res.candidates
      r.semantic_pass = res.semantic_pass
      r.semantic_dropped = res.semantic_dropped
      r.figure_ok = res.figure_ok
      r.figure_fail = res.figure_fail
      r.ole_or_nonfigure_skipped = res.ole_or_nonfigure_skipped
      r.items = res.items || []
      r.bytes = res.bytes
      if (APPLY) {
        await applyWrites(s, r.items, dir, (objMap.get(s.id) || []).length, r.source_revision)
      }
    } catch (e) {
      r.status = 'error'
      r.error = String(e.message || e).slice(0, 220)
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    results.push(r)
    console.log('P020_FIGURE ' + JSON.stringify({
      i, id: r.id, status: r.status, ms: r.convert_ms, f0: r.f0?.ok,
      cand: r.candidates, pass: r.semantic_pass, fig: r.figure_ok,
      fail: r.figure_fail, err: r.error || null,
    }))
  }

  const ok = results.filter((r) => r.status === 'ok')
  const sum = (f) => ok.reduce((a, r) => a + (f(r) || 0), 0)
  const gates = {
    docs: results.length,
    ok: ok.length,
    errors: results.filter((r) => r.status === 'error' || r.status === 'not_ole').length,
    f0_reject: results.filter((r) => r.status === 'f0_reject').length,
    f1_reject: results.filter((r) => r.status === 'f1_reject').length,
    no_marks: results.filter((r) => r.status === 'no_marks').length,
    candidates: sum((r) => r.candidates),
    semantic_pass: sum((r) => r.semantic_pass),
    semantic_dropped: sum((r) => r.semantic_dropped),
    figure_ok: sum((r) => r.figure_ok),
    figure_fail: sum((r) => r.figure_fail),
    ole_skipped: sum((r) => r.ole_or_nonfigure_skipped),
    bytes: sum((r) => r.bytes),
    f0_all_ok: ok.every((r) => r.f0?.ok),
    f1_all_ok: ok.every((r) => r.f1?.ok),
    all_candidates_judged: sum((r) => r.semantic_pass) + sum((r) => r.semantic_dropped)
      === sum((r) => r.candidates),
  }
  const pending = ok.flatMap((r) => (r.items || []).map((it) => ({
    source_id: r.id, ...it,
  })))
  const summary = {
    at: new Date().toISOString(), engine: ENGINE,
    authorization: {
      A: '已授权实现独立 .doc 产图链路 + M42 v3 + docx 零回归',
      B: '② F5b「换行+短数字串」专项规则已生效',
      C: '② Q5 --apply 顺延至 P-023 定性与 40 条人工复核完成',
      D: '40 条人工复核步骤另交付，未签核',
    },
    apply_locked: !APPLY_ENABLED, zero_write: !APPLY,
    truth_before: truthBefore,
    truth_after: { crop: shaFile(CROP_PY), pdfTool: shaFile(PDF_PY), shadow: shaFile(SHADOW_PY) },
    minMemKb: Number.isFinite(minMemKb) ? minMemKb : null,
    gates,
    // 只落在 JSON 里，本轮不写库、不写生产 storage、不下发。
    pending_write_list: pending,
    results: results.map(({ items, ...rest }) => rest),
  }
  await fs.writeFile(OUT, JSON.stringify(summary, null, 2))
  console.log('P020_FIGURE_SUMMARY ' + JSON.stringify({ gates, apply_locked: summary.apply_locked }))
  console.log('P020_FIGURE_DONE ' + OUT)
  return gates.errors === 0 && gates.all_candidates_judged ? 0 : 2
}

process.exitCode = await main()
