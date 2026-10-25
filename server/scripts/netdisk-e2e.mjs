#!/usr/bin/env node
/**
 * 百度网盘资料库归档 —— 全链路联调脚本（一次性，跑完可删）
 * ------------------------------------------------------------------
 * 覆盖：enabled 检查 → ensureDir → upload → list 验证 → download 回读校验
 *       → remove → list 确认删除。任何一步失败即退出码 1 并打全错。
 *
 * 用法：node scripts/netdisk-e2e.mjs
 * 前提：server/.env.secrets 已配 BAIDU_APP_KEY/SECRET_KEY/REFRESH_TOKEN
 *       （baidu-oauth.mjs 三步授权完成后自动满足）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BaiduNetdiskService } from '../dist/storage/baidu-netdisk.service.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = path.resolve(__dirname, '..')

// 与 baidu-oauth.mjs 相同的极简 env 加载（.env + .env.secrets，不覆盖已有环境变量）
for (const file of [path.join(SERVER_ROOT, '.env'), path.join(SERVER_ROOT, '.env.secrets')]) {
  if (!fs.existsSync(file)) continue
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i <= 0) continue
    const k = t.slice(0, i).trim()
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    if (k && !(k in process.env)) process.env[k] = v
  }
}

const log = (...a) => console.log('[e2e]', ...a)
const fail = (msg) => {
  console.error('[e2e][FAIL]', msg)
  process.exit(1)
}

const svc = new BaiduNetdiskService()

// 1) 凭证检查
if (!svc.enabled()) fail(`凭证不完整，缺：${svc.missingKeys().join(' / ')}`)
log('✓ 凭证齐全')

const root = svc.root()
log(`· 归档根目录：${root}`)

// 2) 建目录（幂等）
try {
  await svc.ensureDir(root)
  log('✓ ensureDir 完成')
} catch (e) {
  fail(`ensureDir 失败：${e?.message || e}`)
}

// 3) 上传测试文件（中文名 + 二进制内容）
const testName = `联调测试-${new Date().toISOString().slice(0, 10)}.txt`
const content = Buffer.from(`GrowingKids 资料库网盘归档联调\n时间：${new Date().toISOString()}\nuid-check\n`, 'utf8')
let uploadedPath = ''
try {
  uploadedPath = await svc.upload(testName, content)
  log(`✓ 上传成功 → ${uploadedPath}`)
} catch (e) {
  fail(`upload 失败：${e?.message || e}`)
}

// 4) list 验证文件在列
try {
  const list = await svc.list(root)
  const hit = list.find((f) => f.server_filename === testName)
  if (!hit) fail(`list 中找不到刚上传的文件 ${testName}（目录含 ${list.length} 项）`)
  log(`✓ list 命中：${hit.server_filename}（${hit.size}B, fs_id=${hit.fs_id}）`)
} catch (e) {
  fail(`list 失败：${e?.message || e}`)
}

// 5) download 回读校验内容一致
try {
  const back = await svc.download(uploadedPath)
  if (!back) fail('download 返回 null')
  if (!back.equals(content)) fail('download 内容与上传不一致')
  log(`✓ download 回读一致（${back.length}B）`)
} catch (e) {
  fail(`download 失败：${e?.message || e}`)
}

// 6) 删除并确认
try {
  const ok = await svc.remove(uploadedPath)
  if (!ok) fail('remove 返回 false')
  const list2 = await svc.list(root)
  if (list2.some((f) => f.server_filename === testName)) fail('remove 后文件仍在列表中')
  log('✓ remove 成功且列表已确认')
} catch (e) {
  fail(`remove 失败：${e?.message || e}`)
}

log('\n=== 全链路联调通过 ===')
