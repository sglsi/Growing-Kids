#!/usr/bin/env node
// ============================================================
// 分模块验证套件 —— 总入口
//
//   node scripts/verify/run.mjs                    # 全量
//   node scripts/verify/run.mjs M01 M03            # 只跑指定模块
//   node scripts/verify/run.mjs --list             # 只列出用例清单（Markdown，不连后端）
//   GK_API_BASE=http://192.168.3.242:3001/api node scripts/verify/run.mjs
// ============================================================

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { Runner, BASE } from './lib/harness.mjs'
import { printSummary, writeReports } from './lib/reporter.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MOD_DIR = path.join(HERE, 'modules')

const argv = process.argv.slice(2)
/**
 * `--list`：把「有哪些用例、断言什么」输出成 Markdown 表格。
 *
 * 存在意义：GK-QA-15 的接口用例清单如果手写，第一次改代码就会与套件脱节。
 * 让它由套件自述生成，文档才可能长期是真的（生成命令写进文档）。
 */
const LIST_ONLY = argv.includes('--list')
const filter = argv.filter((a) => !a.startsWith('-'))

const files = fs.readdirSync(MOD_DIR).filter((f) => f.endsWith('.mjs')).sort()
const runner = new Runner()

for (const f of files) {
  const mod = (await import(pathToFileURL(path.join(MOD_DIR, f)).href)).default
  runner.register(mod)
}

if (LIST_ONLY) {
  // 输出给文档用（GK-QA-15 §4.5 直接贴）：按模块分节，一条用例一行。
  // 表格形式会把 177 条挤进一列，人没法读，也没法在 PR 里 diff。
  let total = 0
  const lines = []
  for (const mod of runner.modules) {
    total += mod.cases.length
    lines.push(`#### ${mod.id} ${mod.title}（${mod.cases.length} 条）`, '')
    for (const c of mod.cases) lines.push(`- ${c.name}`)
    lines.push('')
  }
  lines.push(`合计 **${runner.modules.length} 个模块 / ${total} 条用例**。`)
  console.log(lines.join('\n'))
  process.exit(0)
}

const rep = await runner.run(filter)
printSummary(rep)
const { jsonPath, mdPath } = writeReports(rep, { base: BASE })

console.log(`报告已写出：`)
console.log(`  · ${path.relative(process.cwd(), mdPath)}`)
console.log(`  · ${path.relative(process.cwd(), jsonPath)}`)

process.exit(rep.failed > 0 ? 1 : 0)
