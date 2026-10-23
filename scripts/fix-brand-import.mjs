/**
 * 修复脚本：修正 tokenize-brand-color.mjs 的 import 注入位置错误
 *
 * Bug 成因：注入时只找「最后一个以 `import ` 开头的行」，但多行 import 块
 *   import {
 *     a, b,
 *   } from 'x'
 * 的中间行（a, b,）不以 import 开头，脚本会把 import 行插到 `import {` 之后，
 * 把多行块拦腰截断。
 *
 * 修复：把 BRAND 的 import 行移动到**真正的最后一个 import 语句结束之后**
 * （即匹配到 `} from '...'` / `) from '...'` 这类闭合行之后）。
 *
 * 用法：node scripts/fix-brand-import.mjs [--dry]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const DRY = process.argv.includes('--dry')
const BRAND_LINE = "import { BRAND } from '@/lib/theme'"

const files = execSync('git ls-files "src/**/*.tsx" "src/**/*.ts"', { encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean)

const broken = []
const fixed = []

for (const file of files) {
  const src = readFileSync(file, 'utf8')
  if (!src.includes(BRAND_LINE)) continue

  const lines = src.split('\n')
  const idx = lines.indexOf(BRAND_LINE)
  if (idx === -1) continue

  // 判据：上一行是不完整的 import 开始（以 { 或 ( 结尾）⇒ 被拦腰截断
  const prev = (lines[idx - 1] || '').trimEnd()
  const isBroken = /^import\s*[{(\s]*$/.test(prev) || /[{()]$/.test(prev)

  if (!isBroken) continue
  broken.push(file)

  // 移除错位的 import 行
  lines.splice(idx, 1)

  // 找到最后一个 import 语句的闭合行（} from '...' 或 ) from '...'）
  let closeIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*[}\)]\s*from\s/.test(lines[i])) closeIdx = i
    else if (/^import\s[^\n]*from\s/.test(lines[i]) && !/^\s/.test(lines[i])) closeIdx = i
  }

  // 插到最后一个 import 语句之后；若其后紧邻空行则保持一个空行分隔
  const insertAt = closeIdx + 1
  lines.splice(insertAt, 0, BRAND_LINE)
  fixed.push(`${file}  原第 ${idx + 1} 行 → 移至第 ${insertAt + 1} 行`)

  if (!DRY) writeFileSync(file, lines.join('\n'), 'utf8')
}

console.log(DRY ? '=== DRY RUN ===' : '=== 已修复 ===')
console.log(fixed.join('\n') || '(无受损文件)')
console.log(`\n受损并修复: ${broken.length} 个`)
