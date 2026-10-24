/**
 * 数据隔离静态门禁（替代「启用 RLS」的第二道防线，2026-10-24）。
 *
 * 背景：Supabase RLS 未启用（后端 service_role 绕过；登录体系无 Supabase JWT，
 * `auth.uid()` 取不到值 ⇒ 策略写不出来，详见 ADD-07 第 3 章「RLS 重新评估」）。
 * 隔离 100% 依赖代码层 `.eq('user_id', userId)`，新增查询一旦漏写就是越权读。
 *
 * 本脚本扫描 server/src 下所有 supabase `.from()` 调用点，检查其后若干行内
 * 是否出现 `.eq('user_id'`；未出现且不在豁免范围内 → 报错并 exit 1。
 *
 * 豁免规则（有意设计，逐条有据）：
 *  - 表级白名单：全局表 / 内容寻址表 / 身份表 / 运维表（见 TABLE_ALLOWLIST）；
 *  - 文件级白名单：cron 全表扫描、容量统计（见 FILE_ALLOWLIST）；
 *  - insert 链：隔离靠 payload 里的 user_id（后端强制写入、禁止信任前端），
 *    由 code review 与 Create*Dto 不含 user_id 字段共同保证；
 *  - 通用出口 supabase-db.provider.ts：where 全由调用方传入，无法静态判定。
 *
 * ⚠️ 启发式检查（向后看 12 行 + 常量表名还原），只能当「告警门禁」用：
 * 报出来的点需要人工确认，确认是有意设计就加白名单，别为了过检删检查。
 *
 * 用法：node server/scripts/check-isolation.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** 有意不带 user_id 过滤的表 */
const TABLE_ALLOWLIST = new Set([
  'knowledge_articles', // 全局表：所有用户共享的客服知识库，写操作走 requireAdmin
  'blob_objects', // 内容寻址：按 content_hash 查，本身不属任何用户
  'health_check', // 运维探针
  'users', // 身份表：按 id / open_id / device_id 限定，不是按 user_id
])

/** 有意不带 user_id 过滤的文件（cron / 监控 / GC 全表扫描、通用出口） */
const FILE_ALLOWLIST = [
  /maintenance[\\/]maintenance\.service\.ts$/, // 每日 3AM 软删回收
  /storage[\\/]tier-stats\.service\.ts$/, // 容量统计
  /storage[\\/]database[\\/]supabase-db\.provider\.ts$/, // 通用出口：where 由调用方给
]

const LOOKAHEAD_LINES = 12

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else if (entry.name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** 还原文件内的 `const NAME = 'table'`，让 .from(NAME) 也能定位到真实表名 */
function collectConstants(src) {
  const map = new Map()
  const re = /const\s+([A-Za-z_$][\w$]*)\s*=\s*['"`]([\w.]+)['"`]/g
  let m
  while ((m = re.exec(src))) map.set(m[1], m[2])
  return map
}

/**
 * 只认 supabase 的 `.from(`：
 *  - 参数是字符串字面量；或
 *  - 参数是文件内常量且值形如表名（小写 + 下划线）。
 * 这样可排除 `Array.from()` / `TypedArray.from()` / `mask.from(buf)` 等矩阵运算噪音。
 */
function resolveTable(lines, i, consts) {
  const lit = lines[i].match(/\.from\(\s*['"`]([\w.]+)['"`]\s*\)/)
  if (lit) return lit[1]
  const ident = lines[i].match(/\.from\(\s*([A-Za-z_$][\w$]*)\s*\)/)
  if (!ident) return null
  const value = consts.get(ident[1])
  if (value && /^[a-z][a-z0-9_]*$/.test(value)) return value
  return null
}

const violations = []
let checked = 0

for (const file of walk(ROOT)) {
  if (FILE_ALLOWLIST.some((re) => re.test(file))) continue
  const src = fs.readFileSync(file, 'utf8')
  const consts = collectConstants(src)
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const table = resolveTable(lines, i, consts)
    if (!table) continue
    // 源码级豁免：上一行起 3 行内有 `// check-isolation-ignore: 理由`
    const above = lines.slice(Math.max(0, i - 3), i).join('\n')
    if (/check-isolation-ignore/.test(above)) continue
    checked++
    if (TABLE_ALLOWLIST.has(table)) continue
    // 窗口含**当前行**：单行链式写法（.delete().eq('user_id',…).eq('id',…)）很常见
    const window = lines.slice(i, i + 1 + LOOKAHEAD_LINES).join('\n')
    if (/\.eq\(\s*['"`]user_id['"`]/.test(window)) continue
    // insert 链：隔离靠 payload.user_id（后端强制写入），不走 .eq
    if (/\.insert\(/.test(window)) continue
    // 窗口内出现新的 .from( 说明这是另一条查询，不算漏
    if (/\.from\(/.test(window)) {
      violations.push({
        file: path.relative(process.cwd(), file),
        line: i + 1,
        table,
        reason: '疑似独立查询链（窗口内出现新的 .from），请人工确认',
      })
      continue
    }
    violations.push({
      file: path.relative(process.cwd(), file),
      line: i + 1,
      table,
      reason: `查询链后 ${LOOKAHEAD_LINES} 行内未出现 .eq('user_id', …)`,
    })
  }
}

console.log(`[check-isolation] 扫描 ${checked} 处 supabase .from() 调用点`)
if (!violations.length) {
  console.log('[check-isolation] 通过：未发现缺少用户隔离的查询')
  process.exit(0)
}
console.error(`[check-isolation] 发现 ${violations.length} 处疑似缺口：`)
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  表=${v.table}  ${v.reason}`)
}
console.error('\n确认是有意设计（cron/全局表/内容寻址）就加进 TABLE_ALLOWLIST 或 FILE_ALLOWLIST；')
console.error('确认是漏洞就补 .eq(\'user_id\', userId)。')
process.exit(1)
