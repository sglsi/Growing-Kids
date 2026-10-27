// 报告生成：控制台汇总 + Markdown + JSON 落盘

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '../../..')
const OUT_DIR = path.join(ROOT, 'docs', 'test')

function pct(n, d) { return d ? `${((n / d) * 100).toFixed(1)}%` : '—' }

export function printSummary(rep) {
  const { total, passed, failed, byModule, sec } = rep
  console.log(`\n${'─'.repeat(64)}`)
  console.log(`\x1b[1m汇总\x1b[0m  用例 ${total}｜通过 \x1b[32m${passed}\x1b[0m｜失败 \x1b[31m${failed}\x1b[0m｜耗时 ${sec.toFixed(1)}s\n`)
  console.log('模块'.padEnd(34) + '用例'.padEnd(8) + '通过'.padEnd(8) + '失败'.padEnd(8))
  for (const [k, m] of byModule) {
    const color = m.failed ? '\x1b[31m' : '\x1b[32m'
    console.log(
      k.padEnd(34) + String(m.total).padEnd(8) + String(m.total - m.failed).padEnd(8) + `${color}${m.failed}\x1b[0m`.padEnd(8),
    )
  }
  if (failed) {
    console.log('\n\x1b[31m失败明细\x1b[0m')
    for (const r of rep.rows.filter((x) => !x.ok)) {
      console.log(`  · [${r.id}] ${r.name}\n    ${r.detail.replace(/\n/g, '\n    ')}`)
    }
  }
  console.log('')
}

export function writeReports(rep, meta = {}) {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const rows = rep.rows

  // ---- JSON（机器可读，便于比对历史） ----
  const jsonPath = path.join(OUT_DIR, `verify-results.json`)
  fs.writeFileSync(jsonPath, JSON.stringify({
    run_at: new Date().toISOString(),
    base: meta.base,
    total: rep.total, passed: rep.passed, failed: rep.failed,
    sec: Number(rep.sec.toFixed(2)),
    rows,
  }, null, 2), 'utf8')

  // ---- Markdown（人读，贴进测试文档） ----
  const lines = []
  lines.push('| 模块 | 用例 | 通过 | 失败 | 通过率 |')
  lines.push('|---|---:|---:|---:|---:|')
  for (const [k, m] of rep.byModule) {
    lines.push(`| ${k} | ${m.total} | ${m.total - m.failed} | ${m.failed} | ${pct(m.total - m.failed, m.total)} |`)
  }
  lines.push(`| **合计** | **${rep.total}** | **${rep.passed}** | **${rep.failed}** | **${pct(rep.passed, rep.total)}** |`)

  const failRows = rows.filter((r) => !r.ok)
  if (failRows.length) {
    lines.push('')
    lines.push('### 失败明细')
    lines.push('')
    lines.push('| 模块 | 用例 | 类型 | 详情 |')
    lines.push('|---|---|---|---|')
    for (const r of failRows) {
      lines.push(`| ${r.id} | ${r.name} | ${r.kind} | ${String(r.detail).replace(/\|/g, '\\|').replace(/\n/g, ' ') || '—'} |`)
    }
  }

  const mdPath = path.join(OUT_DIR, 'verify-summary.md')
  fs.writeFileSync(mdPath, [
    `# 分模块验证结果（自动生成）`,
    '',
    `> 运行时间：${new Date().toISOString()} ｜ 目标：${meta.base} ｜ 耗时 ${rep.sec.toFixed(1)}s`,
    `> 由 \`server/scripts/verify/run.mjs\` 生成，请勿手工编辑。`,
    '',
    ...lines,
    '',
  ].join('\n'), 'utf8')

  return { jsonPath, mdPath }
}
