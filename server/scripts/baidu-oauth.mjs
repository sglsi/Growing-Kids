#!/usr/bin/env node
/**
 * 百度网盘 OpenAPI 授权助手（纯 Node ESM，无需编译）
 * ------------------------------------------------------------------
 * 为什么需要它：WorkBuddy 的「百度网盘」连接器是**客户端侧**的能力（只能列目录、
 * 搜索、上传文本/URL 转存），后端 NestJS 拿不到它的凭据；而资料库要落网盘，
 * 必须由后端自己持有 access_token。所以走百度开放平台的标准 OAuth。
 *
 * 三条命令覆盖全生命周期：
 *   node server/scripts/baidu-oauth.mjs auth       # ① 生成授权链接（浏览器打开、拿 code）
 *   node server/scripts/baidu-oauth.mjs code <CODE># ② 用 code 换 token 并写入 .env.secrets
 *   node server/scripts/baidu-oauth.mjs check      # ③ 自检：刷新 access_token + 验证网盘根目录
 *
 * ⚠️ 安全纪律（与本项目其它密钥一致）：
 *   - 凭证只写 server/.env.secrets（该文件的敏感项会经 encrypt-env.mjs 加密后部署），
 *     绝不写进 .env（.env 会随仓库走）、绝不打印到日志；
 *   - 改完 .env.secrets 必须重跑 `node server/scripts/encrypt-env.mjs` 再部署；
 *   - 本脚本打印 token 时一律打码。
 *
 * 凭证获取（思傅只需做一次，约 10 分钟）：
 *   1. 打开 https://pan.baidu.com/union/ （百度网盘开放平台）→ 登录 → 「创建应用」
 *      - 应用类型：个人/自用即可；「是否上架」选否（自用不需要审核也能拿到授权）
 *      - 拿到 AppKey（client_id）与 SecretKey（client_secret）
 *   2. 把两者填进 server/.env.secrets：
 *        BAIDU_APP_KEY=xxx
 *        BAIDU_SECRET_KEY=yyy
 *   3. 跑 auth → 浏览器打开链接 → 授权 → 页面显示授权码（或用 redirect_uri=oob 的页面）
 *   4. 跑 code <授权码> → 拿到 refresh_token（10 年有效）与 access_token（30 天）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = path.resolve(__dirname, '..')
const SECRETS = path.join(SERVER_ROOT, '.env.secrets')

const OAUTH_AUTHORIZE = 'https://openapi.baidu.com/oauth/2.0/authorize'
const OAUTH_TOKEN = 'https://openapi.baidu.com/oauth/2.0/token'
/**
 * 资料库在网盘里的根目录。
 * ⚠️ 2026-06-03 之后新建的应用：上传/下载/管理等接口**只能访问 `/apps/{应用名}/` 下**，
 *    所以这里必须是 `/apps/{你在控制台填的应用名}/...`（写 /学生/... 会被接口拒绝）。
 */
const DEFAULT_ROOT = '/apps/GrowingKids/GrowingKids资料库'

/** 极简 .env 解析（不覆盖已有环境变量） */
function loadEnv() {
  for (const file of [path.join(SERVER_ROOT, '.env'), SECRETS]) {
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
}

function mask(v) {
  const s = String(v || '')
  return s.length <= 8 ? s : `${s.slice(0, 4)}****${s.slice(-4)}`
}

/** 把 key=value 写入 .env.secrets（已存在则替换原行，没有则追加） */
function writeSecret(key, value) {
  let text = fs.existsSync(SECRETS) ? fs.readFileSync(SECRETS, 'utf8') : ''
  const re = new RegExp(`^${key}=.*$`, 'm')
  const line = `${key}=${value}`
  if (re.test(text)) text = text.replace(re, line)
  else text += (text && !text.endsWith('\n') ? '\n' : '') + line + '\n'
  fs.writeFileSync(SECRETS, text)
}

function creds() {
  return {
    appKey: (process.env.BAIDU_APP_KEY || '').trim(),
    secretKey: (process.env.BAIDU_SECRET_KEY || '').trim(),
    refreshToken: (process.env.BAIDU_REFRESH_TOKEN || '').trim(),
    accessToken: (process.env.BAIDU_ACCESS_TOKEN || '').trim(),
  }
}

async function cmdAuth() {
  const { appKey } = creds()
  if (!appKey) {
    console.error('✗ 缺 BAIDU_APP_KEY：请先在 server/.env.secrets 填 BAIDU_APP_KEY / BAIDU_SECRET_KEY')
    console.error('  获取：https://pan.baidu.com/union/ → 创建应用')
    process.exit(1)
  }
  const url =
    `${OAUTH_AUTHORIZE}?response_type=code&client_id=${encodeURIComponent(appKey)}` +
    `&redirect_uri=oob&scope=basic+netdisk&display=popup&qrcode=1&force_login=1`
  console.log('请在浏览器打开下面链接并用你的百度账号授权：\n')
  console.log(url + '\n')
  console.log('授权后页面会给出一个「授权码（code）」（有效期 10 分钟），复制它，然后跑：')
  console.log('  node server/scripts/baidu-oauth.mjs code <授权码>')
}

async function cmdCode(code) {
  if (!code) {
    console.error('✗ 用法：node server/scripts/baidu-oauth.mjs code <授权码>')
    process.exit(1)
  }
  const { appKey, secretKey } = creds()
  if (!appKey || !secretKey) {
    console.error('✗ 缺 BAIDU_APP_KEY / BAIDU_SECRET_KEY（写进 server/.env.secrets）')
    process.exit(1)
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: appKey,
    client_secret: secretKey,
    redirect_uri: 'oob',
  })
  const res = await fetch(OAUTH_TOKEN, { method: 'POST', body })
  const json = await res.json().catch(() => ({}))
  if (json.error || !json.access_token) {
    console.error('✗ 换取 token 失败：', JSON.stringify(json))
    process.exit(1)
  }
  writeSecret('BAIDU_ACCESS_TOKEN', json.access_token)
  writeSecret('BAIDU_REFRESH_TOKEN', json.refresh_token)
  console.log('✓ 授权成功，已写入 server/.env.secrets：')
  console.log(`  BAIDU_ACCESS_TOKEN  = ${mask(json.access_token)}  (有效期 ${json.expires_in}s ≈ 30 天)`)
  console.log(`  BAIDU_REFRESH_TOKEN = ${mask(json.refresh_token)}  (有效期 ≈ 10 年)`)
  console.log('\n下一步：')
  console.log('  1) node server/scripts/baidu-oauth.mjs check   # 验证能读到你网盘的 /学生 目录')
  console.log('  2) node server/scripts/encrypt-env.mjs         # 部署前加密 .env.secrets')
}

/** 用 refresh_token 换新的 access_token（access_token 只有 30 天，必须能自动续） */
async function refreshAccessToken() {
  const { appKey, secretKey, refreshToken } = creds()
  if (!appKey || !secretKey || !refreshToken) return null
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: appKey,
    client_secret: secretKey,
  })
  const res = await fetch(OAUTH_TOKEN, { method: 'POST', body })
  const json = await res.json().catch(() => ({}))
  if (json.error || !json.access_token) return null
  writeSecret('BAIDU_ACCESS_TOKEN', json.access_token)
  if (json.refresh_token) writeSecret('BAIDU_REFRESH_TOKEN', json.refresh_token)
  return json.access_token
}

async function cmdCheck() {
  const c = creds()
  if (!c.appKey || !c.secretKey) {
    console.error('✗ 缺 BAIDU_APP_KEY / BAIDU_SECRET_KEY（写进 server/.env.secrets）')
    process.exit(1)
  }
  if (!c.refreshToken) {
    console.error('✗ 缺 BAIDU_REFRESH_TOKEN：先跑 auth → code 两步完成授权')
    process.exit(1)
  }
  const token = await refreshAccessToken()
  if (!token) {
    console.error('✗ access_token 刷新失败（refresh_token 可能已失效，需重新授权）')
    process.exit(1)
  }
  console.log(`✓ access_token 已刷新：${mask(token)}`)

  const root = (process.env.BAIDU_NETDISK_ROOT || DEFAULT_ROOT).trim()

  // 1) 用户信息
  const uinfo = await fetch(`https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo&access_token=${token}`)
  const uj = await uinfo.json().catch(() => ({}))
  if (uj.errno && uj.errno !== 0) {
    console.error('✗ 读取网盘用户信息失败：', JSON.stringify(uj))
    process.exit(1)
  }
  console.log(`✓ 网盘账号：百度 uid=${uj.baidu_id || uj.uk || '?'}，vip_type=${uj.vip_type ?? '?'}`)

  // 2) 配额
  const quota = await fetch(
    `https://pan.baidu.com/rest/2.0/xpan/nas?method=quota&access_token=${token}&checkfree=1&checkexpire=1`,
  )
  const qj = await quota.json().catch(() => ({}))
  if (!qj.errno) {
    const used = Number(qj.used || 0) / 1024 ** 3
    const total = Number(qj.total || 0) / 1024 ** 3
    console.log(`✓ 空间：已用 ${used.toFixed(2)} GB / 共 ${total.toFixed(2)} GB`)
  }

  // 3) 根目录是否存在；不存在则创建（rtype=1 冲突自动重命名，这里用 3 返回冲突）
  const listUrl = `https://pan.baidu.com/rest/2.0/xpan/file?method=list&access_token=${token}&dir=${encodeURIComponent(root)}`
  const lr = await fetch(listUrl)
  const lj = await lr.json().catch(() => ({}))
  if (!lj.errno) {
    console.log(`✓ 目录 ${root} 存在，含 ${lj.list?.length ?? 0} 项：`)
    for (const f of (lj.list || []).slice(0, 10)) console.log(`   · ${f.server_filename}（${f.isdir ? '目录' : `${f.size}B`}）`)
  } else {
    console.log(`· 目录 ${root} 还不存在（errno=${lj.errno}），首次上传时会自动创建`)
  }
  console.log('\n✓ 自检通过。后端设置 STORAGE_DRIVER=baidu 或 LIBRARY_STORAGE_DRIVER=baidu 即可启用。')
}

const argv = process.argv.slice(2)
loadEnv()
const cmd = argv[0] || 'check'
if (cmd === 'auth') cmdAuth()
else if (cmd === 'code') cmdCode(argv[1])
else if (cmd === 'check') cmdCheck()
else {
  console.log('用法：')
  console.log('  node server/scripts/baidu-oauth.mjs auth          # 生成授权链接')
  console.log('  node server/scripts/baidu-oauth.mjs code <授权码>  # 换 token 并写入 .env.secrets')
  console.log('  node server/scripts/baidu-oauth.mjs check         # 自检（刷新 token + 验证目录）')
}
