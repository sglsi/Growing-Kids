#!/usr/bin/env node
/**
 * WX_SECRET 轮换助手（rotate-wx-secret.mjs）
 * ------------------------------------------------------------------
 * 为什么要有这个脚本：
 *   轮换本身只能在 mp 后台点「重置」，但**真正的事故点在重置之后**——
 *   改了 `.env.secrets` 却忘了重跑 `encrypt-env.mjs`，线上还在用旧密文；
 *   或者改了密文但忘了重启后端。表现形式是"换了密钥以后登录突然全挂"，
 *   而且排查时看到的是 code2session 报错，很容易往微信侧找原因。
 *   把这个流程固定成一条命令，就不依赖"记得"。
 *
 * 完整顺序（本脚本负责 ②③，①④⑤必须人工）：
 *   ① mp 后台「开发管理 → 开发设置 → 小程序密钥 → 重置」——**只能人工点**
 *   ② 把新密钥写进 server/.env.secrets            ← 本脚本 --secret
 *   ③ 重跑 encrypt-env.mjs + 自检解密             ← 本脚本自动
 *   ④ 重启后端（node dist/main 或保活服务 wake）
 *   ⑤ 真机点一次登录，确认 wx.login 链路正常
 *
 * 用法：
 *   node scripts/rotate-wx-secret.mjs --check              只看当前状态，不改任何东西
 *   node scripts/rotate-wx-secret.mjs --secret <32位新密钥>   执行 ②③
 *
 * ⚠️ 新密钥只从命令行读取，**不写进日志、不打印**（打印的是前 4 位 + 长度）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { SCRIPTS_DIR, SERVER_ROOT } from './lib/gk-env.mjs'

const SECRETS = path.join(SERVER_ROOT, '.env.secrets')
const ENC = path.join(SERVER_ROOT, '.env.secrets.enc')
const argv = process.argv.slice(2)

/** 与 encrypt-env.mjs / decrypt-env.mjs 保持一致 */
const APPID = process.env.ENV_APPID || 'wx48bf5ba9bae0bf39'
const KDF_INFO = 'growing-kids/.env.secrets/v1'
const KEY_LEN = 32

function opt(name) {
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]
  const inline = argv.find((a) => a.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : ''
}

function mask(v) {
  if (!v) return '<空>'
  return `${v.slice(0, 4)}…（共 ${v.length} 字符）`
}

function run(script, args = []) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, script), ...args], {
    cwd: SERVER_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  })
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), status: r.status }
}

function readSecrets() {
  return fs.existsSync(SECRETS) ? fs.readFileSync(SECRETS, 'utf8') : ''
}

function pickSecret(text) {
  const m = text.match(/^WX_SECRET=(.*)$/m)
  return m ? m[1].trim() : ''
}

function currentSecret() {
  return pickSecret(readSecrets())
}

/**
 * 从 .env.secrets.enc 解出 WX_SECRET。
 *
 * 为什么不比 mtime：任何"非部署项"改动（例如本地加了 BACKUP_PASSPHRASE）都会让明文变新，
 * mtime 比较会天天误报"密文过期"，最后没人看这个检查了。
 * 只比 WX_SECRET 这一个真正会导致线上登录挂掉的值，报出来的才是真问题。
 */
function encSecret() {
  if (!fs.existsSync(ENC)) return { ok: false, reason: '密文文件不存在' }
  try {
    const p = JSON.parse(fs.readFileSync(ENC, 'utf8'))
    const key = crypto.scryptSync(Buffer.from(`${APPID}|${KDF_INFO}`, 'utf8'), Buffer.from(p.salt, 'base64'), KEY_LEN, {
      N: p.kdfParams?.N ?? 32768,
      r: p.kdfParams?.r ?? 8,
      p: p.kdfParams?.p ?? 1,
      maxmem: 128 * 1024 * 1024,
    })
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(p.iv, 'base64'))
    d.setAuthTag(Buffer.from(p.tag, 'base64'))
    const plain = Buffer.concat([d.update(Buffer.from(p.ct, 'base64')), d.final()]).toString('utf8')
    return { ok: true, value: pickSecret(plain) }
  } catch (e) {
    return { ok: false, reason: `解密失败：${e.message}` }
  }
}

// ---------------- --check ----------------
if (argv.includes('--check') || !opt('secret')) {
  const cur = currentSecret()
  const enc = encSecret()
  console.log('[rotate] 当前状态')
  console.log(`  .env.secrets        ${fs.existsSync(SECRETS) ? '存在' : '❌ 缺失'}`)
  console.log(`  .env.secrets.enc    ${fs.existsSync(ENC) ? '存在' : '❌ 缺失（部署会读不到密钥）'}`)
  console.log(`  明文中 WX_SECRET     ${mask(cur)}`)
  if (enc.ok) {
    const same = cur && cur === enc.value
    console.log(`  密文中 WX_SECRET     ${mask(enc.value)}  ${same ? '✅ 与明文一致' : '❌ 与明文不一致'}`)
    if (!same) {
      console.log('      → 改了 .env.secrets 但没重跑 encrypt-env.mjs。部署时容器会解出旧密钥。')
      console.log('      → 修：node scripts/encrypt-env.mjs')
    }
  } else {
    console.log(`  密文中 WX_SECRET     ❌ ${enc.reason}`)
  }
  if (!opt('secret')) {
    console.log('\n用法：node scripts/rotate-wx-secret.mjs --secret <新密钥>')
  }
  process.exit(0)
}

// ---------------- 实际轮换 ----------------
const next = opt('secret').trim()
if (!/^[0-9a-zA-Z]{32}$/.test(next)) {
  console.error(`[rotate] ❌ 新密钥格式不对：微信 AppSecret 是 32 位字母数字，当前 ${next.length} 位`)
  process.exit(1)
}
const cur = currentSecret()
if (cur === next) {
  console.error('[rotate] ❌ 新密钥与当前完全相同，无需轮换（也可能你复制错了）')
  process.exit(1)
}
if (!fs.existsSync(SECRETS)) {
  console.error(`[rotate] ❌ 找不到 ${SECRETS}`)
  process.exit(1)
}

// ① 备份明文（轮换失手时还能退回去）
const backup = `${SECRETS}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
fs.copyFileSync(SECRETS, backup)
console.log(`[rotate] 已备份 ${path.basename(backup)}`)

// ② 替换 WX_SECRET（只替换该行，保留注释与其它键的顺序）
let text = readSecrets()
if (/^WX_SECRET=/m.test(text)) {
  text = text.replace(/^WX_SECRET=.*$/m, `WX_SECRET=${next}`)
} else {
  text = text.replace(/\s*$/, '') + `\nWX_SECRET=${next}\n`
}
fs.writeFileSync(SECRETS, text, 'utf8')
console.log(`[rotate] 已写入新 WX_SECRET ${mask(next)}`)

// ③ 重跑加密（漏这步 = 线上仍是旧密文，本项目真实踩过）
const enc = run('encrypt-env.mjs')
if (!enc.ok) {
  console.error(`[rotate] ❌ encrypt-env.mjs 失败：${enc.out.slice(0, 400)}`)
  console.error(`[rotate]    明文已改、密文未改 ⇒ 部署会用旧密钥。可回滚：copy "${backup}" "${SECRETS}"`)
  process.exit(1)
}
console.log('[rotate] 已重跑 encrypt-env.mjs')

// ④ 自检：密文里的 WX_SECRET 必须等于新值（这才是"部署真的拿到新密钥"的判据）
const encCheck = encSecret()
if (!encCheck.ok) {
  console.error(`[rotate] ❌ 密文自检失败：${encCheck.reason}`)
  process.exit(1)
}
if (encCheck.value !== next) {
  console.error('[rotate] ❌ 密文里的 WX_SECRET 与新值不一致——加密没有真正生效')
  process.exit(1)
}
console.log(`[rotate] 密文自检通过（解密出的 WX_SECRET = ${mask(encCheck.value)}，与新值一致）`)

console.log('')
console.log('[rotate] ✅ 本地已完成 ②③。还剩两步必须人工：')
console.log('  ④ 重启后端：')
console.log('       PowerShell: Get-Process node | Where-Object { $_.Id -ne $PID } | Stop-Process -Force')
console.log('                   或调用保活服务  Invoke-RestMethod -Method Post http://127.0.0.1:3002/wake')
console.log('  ⑤ 真机点一次「登录」，确认 wx.login → code2session 正常（失败会报 40163/invalid code 以外的错误）')
console.log('')
console.log('  验证：node scripts/health-probe.mjs')
