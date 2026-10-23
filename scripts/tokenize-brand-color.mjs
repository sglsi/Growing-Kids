/**
 * 一次性脚本：把硬编码的品牌色收敛到 @/lib/theme 常量
 *
 * 背景：`#BE3E2D` 在 src/ 下硬编码 111 处（图标 color 属性、style 对象），
 * 想改品牌色需改 111 个地方。本脚本统一替换为 BRAND 常量并注入 import。
 *
 * 用法：node scripts/tokenize-brand-color.mjs [--dry]
 * 说明：脚本幂等——已替换过（含 @/lib/theme 引用）的文件会自动跳过。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import { execSync } from 'node:child_process'

const DRY = process.argv.includes('--dry')
const IMPORT_LINE = "import { BRAND } from '@/lib/theme'"

// 用 git ls-files 取受控的 tsx/ts 文件，避免扫到 node_modules 与 dist
const files = execSync('git ls-files "src/**/*.tsx" "src/**/*.ts"', { encoding: 'utf8' })
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((f) => !f.endsWith('src/lib/theme.ts'))

let changed = 0
let skipped = 0
const report = []

for (const file of files) {
  const src = readFileSync(file, 'utf8')
  if (!src.includes('#BE3E2D')) continue
  // 幂等：已注入过 theme 引用则跳过
  if (src.includes("@/lib/theme")) { skipped++; continue }

  let out = src
  // 两种引号形式都替换（图标 color="#BE3E2D" 与 style={{ color: '#BE3E2D' }}）
  const before = out
  out = out.replace(/'#BE3E2D'/g, 'BRAND').replace(/"#BE3E2D"/g, 'BRAND')
  if (out === before) { skipped++; continue }

  // 在最后一个 import 语句后注入
  const lines = out.split('\n')
  let lastImport = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^import\s/.test(lines[i])) lastImport = i
  }
  if (lastImport === -1) {
    // 无 import（不太可能），插到文件最前
    lines.unshift(IMPORT_LINE)
  } else {
    lines.splice(lastImport + 1, 0, IMPORT_LINE)
  }
  out = lines.join('\n')

  const count = (before.match(/['"]#BE3E2D['"]/g) || []).length
  report.push(`${file}  (${count} 处)`)
  if (!DRY) writeFileSync(file, out, 'utf8')
  changed++
}

console.log(DRY ? '=== DRY RUN ===' : '=== 已写入 ===')
console.log(report.join('\n'))
console.log(`\n替换文件数: ${changed}　跳过: ${skipped}`)
