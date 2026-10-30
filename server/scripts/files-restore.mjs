#!/usr/bin/env node
/**
 * 文件恢复（files-restore.mjs）—— 解开 files-backup.mjs 产出的 gk-files-*.gkbk
 * ------------------------------------------------------------------
 * 为什么单独写一个：备份如果只是"能写不能读"，等于没备份。
 *   db-restore.mjs 处理 NDJSON；这一归档里装的是 **tar.gz 流**，
 *   所以这里解密后直接喂给 tar 解包，不再自己解析。
 *
 * 用法：
 *   node scripts/files-restore.mjs <备份文件> [目标目录]       解到目标目录
 *   node scripts/files-restore.mjs <备份文件> --list          只看清单，不落盘（体检用）
 *   node scripts/files-restore.mjs <备份文件> --dest /tmp/r   显式指定目录
 *
 * ⚠️ 默认**不覆盖**已有同名文件？不——恢复的语义就是"覆盖回去"，
 *    但目标目录必须是空的或明确指定的，脚本会先拒绝往非空系统目录解压，防止手滑。
 *
 * 退出码：0 成功 ｜ 1 失败
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ensurePassphrase, open } from './lib/backup-format.mjs'

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const pos = argv.filter((a) => !a.startsWith('--'))

function opt(name, fallback) {
  const inline = argv.find((a) => a.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]
  return fallback
}

const LIST_ONLY = flags.has('--list')
const file = pos[0]
const dest = path.resolve(opt('dest', pos[1] || ''))

if (!file) {
  console.error(
    '用法：node scripts/files-restore.mjs <备份文件.gkbk> [目标目录]\n' +
      '      node scripts/files-restore.mjs <备份文件.gkbk> --list',
  )
  process.exit(1)
}
if (!fs.existsSync(file)) {
  console.error(`找不到备份文件：${file}`)
  process.exit(1)
}

// ① 解密（口令不对会在这里被 GCM 拦下，不会解出半个假归档）
const { passphrase } = ensurePassphrase(false)
const sealed = fs.readFileSync(file)
let payload
try {
  payload = open(sealed, passphrase)
} catch (e) {
  console.error(`❌ 解密失败：${e?.message || e}\n   口令不对，或文件被改过（GCM 完整性校验未通过）。`)
  process.exit(1)
}
console.log(`[files-restore] 解密成功，归档 ${(payload.length / 1024 / 1024).toFixed(1)} MB`)

// ② 先看清单（这一步就能确认归档内部结构是否正常）
const listed = spawnSync('tar', ['-tzf', '-'], { input: payload, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
if (listed.status !== 0) {
  console.error(`❌ 归档无法列出（不是有效的 tar.gz）：${String(listed.stderr || '').slice(0, 300)}`)
  process.exit(1)
}
const entries = String(listed.stdout).split('\n').filter(Boolean)
const files = entries.filter((l) => !l.endsWith('/'))
console.log(`[files-restore] 清单：${files.length} 个文件 / ${entries.length} 项`)

if (LIST_ONLY) {
  for (const f of files.slice(0, 20)) console.log(`   ${f}`)
  if (files.length > 20) console.log(`   … 其余 ${files.length - 20} 项`)
  console.log('[files-restore] --list 模式，未落盘')
  process.exit(0)
}

if (!dest) {
  console.error('请指定目标目录：node scripts/files-restore.mjs <文件> <目标目录>')
  process.exit(1)
}

// ③ 目标目录保护：已存在且非空时必须显式确认，避免误解压到错误的根
if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0 && !flags.has('--force')) {
  console.error(
    `目标目录非空：${dest}\n` +
      `  若确认要覆盖，请追加 --force（会与已有同名文件合并覆盖）。`,
  )
  process.exit(1)
}
fs.mkdirSync(dest, { recursive: true })

// ⚠️ --no-overwrite-dir 不是可选项：目标目录若已存在且属主不是当前用户（典型的
//    「root 建的目录 + gk 用户解包」），tar 会去改它的 mode/utime 而被拒，
//    报 `Cannot utime: Operation not permitted` 并以失败退出——
//    文件内容其实已经写出来了，却因为"改不了目录属性"整包判失败，这种假失败最容易误判成备份损坏。
const untar = spawnSync('tar', ['-xzf', '-', '--no-overwrite-dir', '-C', dest], {
  input: payload,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
if (untar.status !== 0) {
  console.error(`❌ 解包失败（exit=${untar.status}）：${String(untar.stderr || '').slice(0, 300)}`)
  process.exit(1)
}

// ④ 落盘后自检：数一遍实际文件数，必须和清单一致
let n = 0
const stack = [dest]
while (stack.length) {
  const cur = stack.pop()
  for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
    if (e.isDirectory()) stack.push(path.join(cur, e.name))
    else n += 1
  }
}
if (n !== files.length) {
  console.error(`❌ 落盘文件数 ${n} ≠ 清单 ${files.length}，恢复结果不可信，请检查`)
  process.exit(1)
}
console.log(`[files-restore] ✅ 已恢复到 ${dest}（${n} 个文件，数量与清单一致）`)
