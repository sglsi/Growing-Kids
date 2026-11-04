#!/usr/bin/env node
/**
 * 切换小程序编译期的后端地址（PROJECT_DOMAIN）。
 *
 * 为什么需要这个脚本：`PROJECT_DOMAIN` 是**编译期常量**（config/index.ts 的 defineConstants），
 * 改完必须重新 `build:weapp` 才生效，而且 .env.local 在 .gitignore 里、
 * 只有一行值，很容易「改了忘了重建」或「重建了还是旧域名」。
 *
 * 用法：
 *   node scripts/switch-api.mjs status          # 看当前指向
 *   node scripts/switch-api.mjs lan             # 切回局域网（本机后端，日常开发）
 *   node scripts/switch-api.mjs cloud           # 切到腾讯云 IP（42.192.36.120，仅调试）
 *   node scripts/switch-api.mjs prod            # 切到 https://deep-root.cn（体验版/正式版唯一可用）
 *   node scripts/switch-api.mjs https://xxx.cn  # 任意地址
 *
 * ⚠️ 切完必须重新构建，且微信开发者工具要勾「详情 → 本地设置 → 不校验合法域名」。
 *
 * 三条地址的性质不同，别混用：
 *   lan   = 局域网 http://IP:端口，只有同一 Wi-Fi 的手机能连
 *   cloud = 公网 http://IP，**IP 永远填不进微信服务器域名白名单** ⇒ 体验版/正式版必然被拦
 *   prod  = https://deep-root.cn，已备案 + 有效证书 ⇒ **唯一能进白名单的形态**
 *
 * 🔴 配白名单（mp 后台 / 第三方平台）与切这里是**两件事，必须都做**：
 *    白名单放的是域名，包里写的是域名，两边一致才通；只做一边的表现都是「请求全失败」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENV_LOCAL = path.join(ROOT, '.env.local')

/** 预设地址。新增环境在这里加一行即可。 */
const PRESETS = {
  lan: {
    url: 'http://192.168.3.242:3001',
    note: '局域网：电脑上的本机后端（server 目录，SERVER_PORT=3001，连 Supabase 时代的老库）',
  },
  cloud: {
    url: 'http://42.192.36.120',
    note: '腾讯云轻量 L3（PG + PostgREST + Node 全在同一台），HTTP + IP，仅调试可用',
  },
  prod: {
    url: 'https://deep-root.cn',
    note: '生产：https 自有域名（已 ICP 备案 -2 + Let\'s Encrypt 证书）。体验版/正式版只能用这个',
  },
}

const HEADER = `# 小程序编译期的后端地址（由 config/index.ts 注入为 PROJECT_DOMAIN）
# ⚠️ 这是**编译期常量**：改完必须重新 build:weapp，否则打出来的还是旧地址。
# ⚠️ 别直接改本文件——用脚本切，避免忘重建/手滑写错：
#      node scripts/switch-api.mjs status | lan | cloud | https://xxx.cn
# 注意：H5 端不使用本变量（devServer 已把 /api 代理到本机 SERVER_PORT）。
#
# lan   = 局域网，本机后端（日常开发）
# cloud = 腾讯云 42.192.36.120（HTTP + IP，仅调试；IP 填不进微信白名单）
# prod  = https://deep-root.cn（生产，体验版/正式版必须用这个）
`

function readEnv() {
  if (!fs.existsSync(ENV_LOCAL)) return ''
  return fs.readFileSync(ENV_LOCAL, 'utf8')
}

function currentDomain() {
  const m = readEnv().match(/^PROJECT_DOMAIN=(.*)$/m)
  return m ? m[1].trim() : ''
}

function writeDomain(url, note) {
  // 保留文件里除注释与 PROJECT_DOMAIN 之外的键（.env.local 目前只有这一项，
  // 但将来若有人加了别的编译期变量，不能被这个脚本洗掉）
  const others = readEnv()
    .split(/\r?\n/)
    .filter((ln) => ln.trim() && !ln.trim().startsWith('#') && !/^PROJECT_DOMAIN=/.test(ln))

  const parts = [HEADER.trimEnd(), '']
  if (note) parts.push(`# 当前：${note}`)
  parts.push(`PROJECT_DOMAIN=${url}`, '')
  if (others.length) parts.push('# ---- 其他编译期变量（脚本原样保留）----', ...others, '')

  fs.writeFileSync(ENV_LOCAL, parts.join('\n'), 'utf8')
}

function report(url, action) {
  console.log(`${action}`)
  console.log(`  .env.local → PROJECT_DOMAIN=${url}`)
  console.log('')
  console.log('下一步（必须做，否则打出来的包还是旧地址）：')
  console.log('  pnpm build:weapp          然后微信开发者工具「重新编译」')
  console.log('  真机：重新扫码')
  if (url.startsWith('http://') && !/^https:\/\//.test(url)) {
    console.log('')
    console.log('⚠️ 当前是 HTTP + IP：微信域名白名单只收 HTTPS 域名，IP 填不进去。')
    console.log('   开发者工具请在「详情 → 本地设置」勾选「不校验合法域名」；')
    console.log('   真机请在「···→ 开发调试」里放开。体验版/正式版用不了这条链路。')
  }
}

const arg = (process.argv[2] || '').trim()

if (!arg || arg === 'status') {
  const cur = currentDomain()
  if (!cur) {
    console.log('.env.local 里没有 PROJECT_DOMAIN（构建会兜底成 http://127.0.0.1:3001，真机必失败）')
    process.exit(0)
  }
  const hit = Object.entries(PRESETS).find(([, v]) => v.url === cur)
  console.log(`当前后端地址：${cur}`)
  if (hit) console.log(`预设：${hit[0]} — ${hit[1].note}`)
  else console.log('预设：自定义地址')
  process.exit(0)
}

if (PRESETS[arg]) {
  writeDomain(PRESETS[arg].url, PRESETS[arg].note)
  report(PRESETS[arg].url, `已切到「${arg}」`)
  process.exit(0)
}

if (/^https?:\/\//.test(arg)) {
  writeDomain(arg, '')
  report(arg, '已切到自定义地址')
  process.exit(0)
}

console.error(`无法识别的参数：${arg}`)
console.error('可用：status | lan | cloud | prod | https://your-domain.cn')
process.exit(1)
