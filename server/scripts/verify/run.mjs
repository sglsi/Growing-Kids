#!/usr/bin/env node
// ============================================================
// 分模块验证套件 —— 总入口
//
//   node scripts/verify/run.mjs                    # 全量
//   node scripts/verify/run.mjs M01 M03            # 只跑指定模块
//   GK_API_BASE=http://192.168.3.242:3001/api node scripts/verify/run.mjs
// ============================================================

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { Runner, BASE } from './lib/harness.mjs'
import { printSummary, writeReports } from './lib/reporter.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MOD_DIR = path.join(HERE, 'modules')

const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'))

const files = fs.readdirSync(MOD_DIR).filter((f) => f.endsWith('.mjs')).sort()
const runner = new Runner()

for (const f of files) {
  const mod = (await import(pathToFileURL(path.join(MOD_DIR, f)).href)).default
  runner.register(mod)
}

const rep = await runner.run(filter)
printSummary(rep)
const { jsonPath, mdPath } = writeReports(rep, { base: BASE })

console.log(`报告已写出：`)
console.log(`  · ${path.relative(process.cwd(), mdPath)}`)
console.log(`  · ${path.relative(process.cwd(), jsonPath)}`)

process.exit(rep.failed > 0 ? 1 : 0)
