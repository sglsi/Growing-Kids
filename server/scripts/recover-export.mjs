#!/usr/bin/env node
/**
 * 由加密备份文件导出为「可读归档 / 可回灌 SQL」（只读，不动数据库）
 * ------------------------------------------------------------------
 * 用途：
 *   1. 验证一份备份到底能不能打开、里面有多少东西（不连库）
 *   2. 把老备份的内容落成人能看的文件留档，避免只有 .gkbk 黑盒
 *   3. 生成 INSERT 语句，日后真要回灌时不必依赖原脚本
 *
 * 为什么需要它（2026-10-31 事故教训）：
 *   口令被换掉后，5 份备份被误判为「文件损坏」而搁置。事后用桌面留存的旧口令
 *   发现其中 3 份完好无损（payload sha256 与备份日志逐字节一致）。
 *   如果当时有个「不看口令对不对、先把能解的导出来」的动作，就不至于空转一周。
 *
 * 用法：
 *   node scripts/recover-export.mjs --file backups/x.gkbk                 # 导出 JSON + manifest
 *   node scripts/recover-export.mjs --file backups/x.gkbk --sql           # 额外出 restore.sql
 *   node scripts/recover-export.mjs --all --from-desktop                  # 批量试 backups/ 下全部
 *   BACKUP_PASSPHRASE=<旧口令> node scripts/recover-export.mjs ...        # 用别的代次口令
 *
 * 输出目录：backups/recovered/<备份文件名去后缀>/
 * 退出码：0 至少一份成功 ｜ 1 全部失败
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { BACKUP_DIR, ensurePassphrase, open, passphraseFingerprint, recordFingerprint } from './lib/backup-format.mjs'

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(`--${n}`)
const opt = (n) => {
  const i = argv.indexOf(`--${n}`)
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]
  const inline = argv.find((a) => a.startsWith(`--${n}=`))
  return inline ? inline.slice(n.length + 3) : ''
}

const FILE = opt('file')
const ALL = flag('all')
const WANT_SQL = flag('sql')
const FROM_DESKTOP = flag('from-desktop')
const DESKTOP_ESCROW = 'C:/Users/sglsi/Desktop/KEY-ESCROW.txt'

/** 收集候选口令：桌面副本（若要求）+ 环境变量/.env.secrets（当前代次） */
function candidatePassphrases() {
  const out = []
  const push = (p, label) => {
    if (p && p.length >= 16 && !out.some((x) => x.passphrase === p)) out.push({ passphrase: p, label })
  }
  if (FROM_DESKTOP && fs.existsSync(DESKTOP_ESCROW)) {
    const lines = fs.readFileSync(DESKTOP_ESCROW, 'utf8').split(/\r?\n/)
    push(lines.map((l) => l.trim()).find((l) => l.length >= 40 && /^[\x21-\x7e]+$/.test(l)), '桌面 KEY-ESCROW.txt')
  }
  try {
    push(ensurePassphrase(false).passphrase, '.env.secrets 当前口令')
  } catch {
    /* 没有当前口令不影响：可能纯用桌面旧口令 */
  }
  return out
}

/** SQL 值字面量 */
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (v instanceof Date) return `'${v.toISOString()}'`
  if (Array.isArray(v)) return `'${JSON.stringify(v).replace(/'/g, "''")}'`
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`
  return `'${String(v).replace(/'/g, "''")}'`
}

function exportOne(fileName, passphrase, label) {
  const abs = path.join(BACKUP_DIR, fileName)
  const raw = fs.readFileSync(abs)
  const plainGz = open(raw, passphrase)
  const sha = crypto.createHash('sha256').update(plainGz).digest('hex')
  const ndjson = zlib.gunzipSync(plainGz).toString('utf8')

  const byTable = new Map()
  let manifest = null
  for (const ln of ndjson.split('\n')) {
    if (!ln) continue
    const row = JSON.parse(ln)
    if (row.__manifest) {
      manifest = row.__manifest
      continue
    }
    if (!row.t) continue
    if (!byTable.has(row.t)) byTable.set(row.t, [])
    byTable.get(row.t).push(row.r)
  }

  const outDir = path.join(BACKUP_DIR, 'recovered', fileName.replace(/\.gkbk$/, ''))
  fs.mkdirSync(outDir, { recursive: true })

  // 解开了就说明这代口令是对的 —— 立刻补登指纹，下次恢复不再靠猜（对无指纹的历史备份尤其重要）
  recordFingerprint(fileName, passphrase)

  // 每表一个 json
  const stats = []
  for (const [t, rows] of [...byTable.entries()].sort()) {
    fs.writeFileSync(path.join(outDir, `${t}.json`), JSON.stringify(rows, null, 2) + '\n', 'utf8')
    stats.push({ table: t, rows: rows.length })
  }

  // SQL（可回灌）
  if (WANT_SQL) {
    const parts = [
      '-- 由 recover-export.mjs 生成，勿手改',
      `-- 来源备份：${fileName}`,
      `-- 口令代次指纹：${passphraseFingerprint(passphrase)}`,
      '-- 警告：本脚本只做 TRUNCATE + INSERT，不含外键顺序调整；真要回灌请优先用 db-restore.mjs --apply',
      'BEGIN;',
    ]
    for (const [t, rows] of [...byTable.entries()].sort()) {
      if (!rows.length) continue
      parts.push(`-- ${t}: ${rows.length} 行`)
      parts.push(`TRUNCATE TABLE "${t}" CASCADE;`)
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))]
      const colList = cols.map((c) => `"${c}"`).join(', ')
      for (const r of rows) {
        parts.push(`INSERT INTO "${t}" (${colList}) VALUES (${cols.map((c) => sqlLiteral(r[c])).join(', ')});`)
      }
      parts.push('')
    }
    parts.push('COMMIT;')
    fs.writeFileSync(path.join(outDir, 'restore.sql'), parts.join('\n'), 'utf8')
  }

  const summary = {
    source: fileName,
    sourceBytes: raw.length,
    passphraseGeneration: passphraseFingerprint(passphrase),
    passphraseLabel: label,
    payloadSha256: sha,
    exportedAt: new Date().toISOString(),
    tables: stats.length,
    rows: stats.reduce((a, b) => a + b.rows, 0),
    manifest: manifest || null,
    perTable: stats,
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8')
  return summary
}

const targets = ALL
  ? fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.gkbk')).sort()
  : FILE
    ? [FILE]
    : []
if (!targets.length) {
  console.error('用法：node scripts/recover-export.mjs --file backups/x.gkbk [--sql] [--from-desktop]')
  console.error('      node scripts/recover-export.mjs --all --from-desktop [--sql]')
  process.exit(1)
}

const cands = candidatePassphrases()
if (!cands.length) {
  console.error('❌ 没有任何可用口令（--from-desktop 找不到文件，且 .env.secrets 也没有）')
  process.exit(1)
}
console.log(`候选口令 ${cands.length} 个：${cands.map((c) => `${c.label}(${passphraseFingerprint(c.passphrase)})`).join(' / ')}`)
console.log('')

let okCount = 0
for (const f of targets) {
  let done = false
  for (const c of cands) {
    try {
      const s = exportOne(f, c.passphrase, c.label)
      console.log(`✅ ${f}  →  ${s.tables} 表 / ${s.rows} 行  [口令：${c.label}]`)
      console.log(`   导出到 backups/recovered/${f.replace(/\.gkbk$/, '')}/${WANT_SQL ? ' （含 restore.sql）' : ''}`)
      okCount++
      done = true
      break
    } catch {
      /* 换下一个口令 */
    }
  }
  if (!done) console.log(`❌ ${f}  →  所有候选口令均无法解密`)
}

console.log('')
console.log(`小结：${okCount}/${targets.length} 份已导出`)
process.exit(okCount > 0 ? 0 : 1)
