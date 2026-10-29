#!/usr/bin/env node
// ============================================================
// 小程序发布前置校验（2026-10-28）
// ═══════════════════════════════════════════════════════════
// QA-16 第 7 章的发布清单写得全，但**靠人逐条看**就等于没有清单——
// 提版本那天赶时间，最容易跳过的恰恰是「urlCheck 忘了开」这类
// 一步错全盘错、且**开发期完全无感**的项。本脚本把能自动验的部分验掉。
//
// 用法：
//   node scripts/release-check.mjs            只读校验（可反复跑）
//   node scripts/release-check.mjs --prepare   切到发布态后再校验
//   node scripts/release-check.mjs --revert    切回开发态（urlCheck/minified=false）
//   node scripts/release-check.mjs --dev       以开发态标准校验（不要求 urlCheck/minified/https 域名）
//
// 退出码：0 通过｜1 有阻断项｜2 环境异常（dist 不在等，先构建）
//
// 刻意**不**自动做的事：不替你轮换 WX_SECRET、不替你勾 mp 后台的隐私指引、
// 不替你上传。那几步必须在 mp 后台人工完成，脚本只能提醒。
// ============================================================
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const SRC = path.join(ROOT, 'src')
const PCONFIG = path.join(ROOT, 'project.config.json')
const BACKUP = path.join(ROOT, '.tmp', 'project.config.dev.json')

const argv = process.argv.slice(2)
const MODE_PREPARE = argv.includes('--prepare')
const MODE_REVERT = argv.includes('--revert')
const MODE_DEV = argv.includes('--dev')

const MAIN_PACK_LIMIT = 2 * 1024 * 1024 // 微信小程序主包 2MB（硬限制，超限无法上传）
const MAIN_PACK_WARN = 1.5 * 1024 * 1024

const results = []
const block = (name, detail, how) => results.push({ level: 'block', name, detail, how })
const warn = (name, detail, how) => results.push({ level: 'warn', name, detail, how })
const ok = (name, detail = '') => results.push({ level: 'ok', name, detail })

// ── 工具 ────────────────────────────────────────────────────
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

function maxMtime(dir) {
  let m = 0
  for (const f of walk(dir)) {
    try {
      const t = fs.statSync(f).mtimeMs
      if (t > m) m = t
    } catch {
      /* 忽略读不到的文件 */
    }
  }
  return m
}

function dirSize(dir) {
  let n = 0
  for (const f of walk(dir)) {
    try {
      n += fs.statSync(f).size
    } catch {
      /* 忽略 */
    }
  }
  return n
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

const fmtKB = (b) => `${(b / 1024).toFixed(0)} KB`
const fmtTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

// ── 0. 发布态切换（--prepare / --revert）────────────────────
function readPConfig() {
  return readJson(PCONFIG)
}

function writePConfig(obj) {
  fs.writeFileSync(PCONFIG, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

if (MODE_REVERT) {
  if (fs.existsSync(BACKUP)) {
    fs.copyFileSync(BACKUP, PCONFIG)
    console.log('✅ 已恢复开发态 project.config.json（来自 .tmp 备份）')
  } else {
    const c = readPConfig()
    if (c?.setting) {
      c.setting.urlCheck = false
      c.setting.minified = false
      writePConfig(c)
      console.log('✅ 已恢复开发态（无备份文件，按默认值写回）')
    }
  }
  process.exit(0)
}

if (MODE_PREPARE) {
  const c = readPConfig()
  if (!c?.setting) {
    console.error('❌ project.config.json 缺少 setting 段')
    process.exit(2)
  }
  fs.mkdirSync(path.dirname(BACKUP), { recursive: true })
  fs.copyFileSync(PCONFIG, BACKUP)
  c.setting.urlCheck = true
  c.setting.minified = true
  if (c.description === 'test' || !c.description) c.description = '成长学童 · 学习记录与复习'
  writePConfig(c)
  console.log('✅ 已切换到发布态：urlCheck=true, minified=true（开发态备份在 .tmp/）')
}

// ── 1. 构建产物 ─────────────────────────────────────────────
const appJson = readJson(path.join(DIST, 'app.json'))
if (!appJson) {
  console.error('❌ 找不到 dist/app.json —— 先跑 `pnpm build:weapp`')
  process.exit(2)
}

// 1.1 dist 新鲜度（改了代码没重新构建 = 上线旧包，最难自查的一类事故）
const distM = maxMtime(DIST)
const srcM = maxMtime(SRC)
if (distM >= srcM) {
  ok('dist 新鲜度', `dist ${fmtTime(distM)} ≥ src ${fmtTime(srcM)}`)
} else {
  block(
    'dist 新鲜度',
    `dist ${fmtTime(distM)} 早于 src ${fmtTime(srcM)}`,
    '源码比产物新 ⇒ 你上传的是旧包。重跑 `pnpm build:weapp`',
  )
}

// 1.2 页面产物齐全
const missingPages = []
for (const p of appJson.pages || []) {
  const candidates = [path.join(DIST, `${p}.js`), path.join(DIST, p, 'index.js')]
  if (!candidates.some((f) => fs.existsSync(f))) missingPages.push(p)
}
if (missingPages.length === 0) ok('页面产物齐全', `${(appJson.pages || []).length} 个页面`)
else block('页面产物齐全', `缺 ${missingPages.join(', ')}`, '构建未完整，重新构建后再验')

// 1.3 TabBar 图标必须进包（QA-16 §4.2 第 1 条）
const missingIcons = []
for (const item of appJson.tabBar?.list || []) {
  for (const key of ['iconPath', 'selectedIconPath']) {
    const rel = item[key]
    if (!rel) continue
    const f = path.join(DIST, rel.replace(/^\.?\//, ''))
    if (!fs.existsSync(f)) missingIcons.push(rel)
  }
}
if (missingIcons.length === 0) ok('TabBar 图标已进包', `${(appJson.tabBar?.list || []).length * 2} 个 PNG`)
else block('TabBar 图标已进包', `缺 ${missingIcons.join(', ')}`, '检查 project.config.json 的 packOptions.ignore 是否命中 ./assets')

// 1.4 体积
const total = dirSize(DIST)
if (total > MAIN_PACK_LIMIT) {
  block('主包体积', `${fmtKB(total)} > 2 MB`, '微信小程序主包硬上限 2MB，超限无法上传；需分包或压缩资源')
} else if (total > MAIN_PACK_WARN) {
  warn('主包体积', `${fmtKB(total)}（余量 ${fmtKB(MAIN_PACK_LIMIT - total)}）`, '接近上限，新功能优先放分包')
} else {
  ok('主包体积', `${fmtKB(total)}（余量 ${fmtKB(MAIN_PACK_LIMIT - total)}）`)
}

const big = walk(DIST)
  .map((f) => ({ f, s: fs.statSync(f).size }))
  .filter((x) => x.s > 500 * 1024)
  .sort((a, b) => b.s - a.s)
  .slice(0, 5)
if (big.length) warn('大文件明细', big.map((x) => `${path.relative(DIST, x.f)} ${fmtKB(x.s)}`).join('；'), '按需拆包')

// ── 2. 隐私与合规 ───────────────────────────────────────────
// ⚠️ 2026-10-29 修订：原规则「必须 true」会把当前状态判成阻断，但与事实相反——
// 托管方尚未代配《用户隐私保护指引》时，true 会让**所有隐私接口被基础库挂起**
// （拍照/相册/录音全部「点了没反应」）。故此处只做**记录**，真正的门禁在 4.1：
// 开发态允许关闭（warn），发布态必须开启（block）。

// ── 3. 包内安全 ─────────────────────────────────────────────
const SECRET_PATTERNS = [
  { re: /sk-[A-Za-z0-9]{16,}/g, name: 'OpenAI/大模型 Key' },
  { re: /SUPABASE_SERVICE[_A-Z]*["'=:\s]{1,4}[A-Za-z0-9._-]{20,}/g, name: 'Supabase service role' },
  { re: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g, name: '私钥 PEM' },
  { re: /WX_SECRET["'=:\s]{1,4}[0-9a-fA-F]{32}/g, name: '微信 AppSecret' },
]
const textExt = /\.(js|json|wxml|wxss|html|css)$/i
const secretHits = []
for (const f of walk(DIST)) {
  if (!textExt.test(f)) continue
  let s
  try {
    s = fs.readFileSync(f, 'utf8')
  } catch {
    continue
  }
  for (const { re, name } of SECRET_PATTERNS) {
    re.lastIndex = 0
    if (re.test(s)) secretHits.push(`${path.relative(DIST, f)} → ${name}`)
  }
}
if (secretHits.length === 0) ok('包内无明文密钥', `${SECRET_PATTERNS.length} 类模式全扫`)
else block('包内无明文密钥', secretHits.slice(0, 6).join('；'), '密钥只应存在于后端 .env.secrets，前端不得打包')

// 3.2 中文乱码（U+FFFD 进包 = 编码链路断了，界面上一片问号）
const fffdHits = []
for (const f of walk(DIST)) {
  if (!textExt.test(f)) continue
  let s
  try {
    s = fs.readFileSync(f, 'utf8')
  } catch {
    continue
  }
  if (s.includes('\uFFFD')) fffdHits.push(path.relative(DIST, f))
}
if (fffdHits.length === 0) ok('无 U+FFFD 乱码', '全包扫描')
else block('无 U+FFFD 乱码', fffdHits.slice(0, 6).join('；'), '检查文件写盘编码（Windows 需显式 utf8）')

// ── 4. 发布态配置（根 project.config.json）──────────────────
const pconfig = readPConfig()
if (!pconfig?.setting) {
  block('project.config.json', '读不到 setting 段', '文件损坏或被改坏')
} else {
  const { urlCheck, minified } = pconfig.setting
  if (MODE_DEV) {
    ok('发布态配置', `开发态校验（urlCheck=${urlCheck}, minified=${minified}）`)
  } else if (urlCheck === true && minified === true) {
    ok('发布态配置', 'urlCheck=true, minified=true')
  } else {
    const miss = [urlCheck !== true ? 'urlCheck' : '', minified !== true ? 'minified' : ''].filter(Boolean)
    block(
      '发布态配置',
      `${miss.join(' / ')} 未开启`,
      '跑 `node scripts/release-check.mjs --prepare`；上传后记得 --revert 回开发态',
    )
  }
  if (pconfig.description === 'test' || !pconfig.description) {
    warn('项目描述', `description="${pconfig.description ?? ''}"`, '--prepare 会改成正式描述')
  }
}

// ── 4.1 隐私保护校验开关（__usePrivacyCheck__）─────────────────
// 背景：`__usePrivacyCheck__: true` 会让基础库拦截/挂起所有隐私接口，直到平台侧
// 《用户隐私保护指引》配好且用户已同意。本项目托管状态下指引尚未代配，故当前
// **关闭**以保证功能可用（否则拍照/相册/录音全部「点了没反应」）。
// 但开启是合规要求 ⇒ 发布前必须重新打开，这里做门禁防止忘记。
let usePrivacyCheck = null
try {
  const appJson = JSON.parse(fs.readFileSync(path.join(DIST, 'app.json'), 'utf8'))
  usePrivacyCheck = appJson.__usePrivacyCheck__
} catch {
  /* 读不到交给下面的 block 处理 */
}
if (usePrivacyCheck === true) {
  ok('隐私保护校验', '__usePrivacyCheck__ = true')
} else if (MODE_DEV) {
  warn(
    '隐私保护校验',
    `当前关闭（__usePrivacyCheck__=${String(usePrivacyCheck)}）`,
    '开发/体验阶段可接受：托管方代配隐私指引后，用 GK_PRIVACY_CHECK=1 重新 build',
  )
} else {
  block(
    '隐私保护校验',
    `发布态仍为 __usePrivacyCheck__=${String(usePrivacyCheck)}`,
    '隐私指引已配好后，必须 `GK_PRIVACY_CHECK=1 pnpm build:weapp` 重新构建再上传；否则「告知并取得同意」这一步缺平台侧留痕',
  )
}

// ── 5. 后端域名（上线硬门槛）────────────────────────────────
let domain = ''
try {
  const envText = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8')
  domain = (envText.match(/^PROJECT_DOMAIN\s*=\s*(\S+)/m) || [])[1] || ''
} catch {
  /* 无 .env.local */
}
if (MODE_DEV) {
  ok('后端域名', `开发态跳过（当前 ${domain || '未配置'}）`)
} else if (!domain) {
  block('后端域名', '.env.local 未配置 PROJECT_DOMAIN', '小程序端没有相对路径概念，不打绝对地址直接 request:fail')
} else if (/^http:\/\//.test(domain) || /(192\.168\.|10\.|127\.0\.0\.1|localhost)/.test(domain)) {
  block(
    '后端域名',
    `当前 ${domain}`,
    '正式版 request 合法域名必须是 **https + ICP 备案域名**，局域网 IP/内网地址一律进不了白名单（见 OPS-19）',
  )
} else if (!/^https:\/\//.test(domain)) {
  block('后端域名', `当前 ${domain}`, '必须以 https:// 开头')
} else {
  ok('后端域名', domain)
  warn(
    '域名白名单（人工）',
    'mp 后台需配三类：request / uploadFile / downloadFile',
    'downloadFile 最常漏——导出文件走 Taro.downloadFile + openDocument，漏配会「下载成功但打不开」',
  )
}

// ── 6. 版本角标 ─────────────────────────────────────────────
let head = ''
try {
  head = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()
} catch {
  head = ''
}
const metaText = (() => {
  try {
    return fs.readFileSync(path.join(SRC, 'build-meta.ts'), 'utf8')
  } catch {
    return ''
  }
})()
const metaCommit = (metaText.match(/commit:\s*'([^']+)'/) || [])[1] || ''
if (head && metaCommit === head) {
  ok('版本角标', `包内 ${metaCommit} = HEAD ${head}`)
} else if (head) {
  block('版本角标', `包内 ${metaCommit || '?'} ≠ HEAD ${head}`, '重跑 `pnpm build:weapp`（gen-build-meta 会刷新角标）')
} else {
  warn('版本角标', '非 git 环境，跳过比对', '')
}

// ── 7. 备份时效（警告级）────────────────────────────────────
const backupDir = path.join(ROOT, 'server', 'backups')
if (fs.existsSync(backupDir)) {
  const files = walk(backupDir)
    .filter((f) => f.endsWith('.gkbk'))
    .map((f) => ({ f, t: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  if (files.length === 0) {
    warn('备份', 'backups 目录存在但没有 .gkbk 文件', '至少跑一次备份演练')
  } else {
    const ageH = (Date.now() - files[0].t) / 3600_000
    if (ageH > 48) warn('备份时效', `最新备份 ${ageH.toFixed(0)} 小时前（要求 <48h）`, '跑一次备份')
    else ok('备份时效', `最新备份 ${ageH.toFixed(1)} 小时前`)
  }
} else {
  warn('备份', '未找到 server/backups', '上线前至少完成一次备份 + 恢复演练')
}

// ── 输出 ────────────────────────────────────────────────────
console.log('\n发布前置校验' + (MODE_DEV ? '（开发态）' : '（发布态）') + ' — ' + new Date().toISOString().slice(0, 19).replace('T', ' '))
console.log('─'.repeat(72))
for (const r of results) {
  const icon = r.level === 'ok' ? '✅' : r.level === 'warn' ? '⚠️ ' : '❌'
  console.log(`${icon} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
  if (r.how) console.log(`     └ ${r.how}`)
}
const blocks = results.filter((r) => r.level === 'block')
const warns = results.filter((r) => r.level === 'warn')
console.log('─'.repeat(72))
console.log(`通过 ${results.filter((r) => r.level === 'ok').length}｜警告 ${warns.length}｜阻断 ${blocks.length}`)
if (blocks.length) {
  console.log('\n⛔ 存在阻断项，禁止上传。修完重跑；临时放行请用 --dev（仅本地自检）。')
  process.exit(1)
}
if (warns.length) console.log('\n⚠️  无阻断项，但警告项建议在提审前处理掉。')
process.exit(0)
