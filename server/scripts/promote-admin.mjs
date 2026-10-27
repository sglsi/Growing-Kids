#!/usr/bin/env node
/**
 * 管理员提权 / 降权（OPS-18 R-技术-08 的运维入口）
 * ------------------------------------------------------------------
 * `users.role` 是唯一的授权事实源（0017 迁移）。本脚本是**唯一**的合法提权途径——
 * 刻意不提供任何 HTTP 接口，避免「自己给自己升管理员」这条越权路径。
 *
 * 用法：
 *   node server/scripts/promote-admin.mjs --list                 # 列出当前管理员
 *   node server/scripts/promote-admin.mjs --device-id dev_xxx    # 按设备提权（推荐，真机上最易拿）
 *   node server/scripts/promote-admin.mjs --open-id oXXXX        # 按微信 openid 提权
 *   node server/scripts/promote-admin.mjs --id <user id>         # 按 user id 提权
 *   node server/scripts/promote-admin.mjs --device-id dev_xxx --demote   # 降权回 user
 *
 * 生效时间：≤60s（user-context 有 60s 用户缓存），无需重启后端。
 *
 * ⚠️ 安全：
 *   - 只允许把 role 在 ('user','admin') 之间改；不接受任意值；
 *   - 不打印任何密钥；连接串只打印主机名；
 *   - 默认只操作 is_anonymous = false 的行（匿名号不该有管理员）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = path.resolve(__dirname, '..')
const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

function loadEnv() {
  for (const file of [
    path.join(SERVER_ROOT, '.env'),
    path.join(SERVER_ROOT, '.env.migrate'),
    path.join(PROJECT_ROOT, '.env'),
  ]) {
    if (!fs.existsSync(file)) continue
    for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      let val = line.slice(eq + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      if (process.env[key] === undefined) process.env[key] = val
    }
  }
}

function normalizeConn(raw) {
  let s = String(raw || '').trim()
  s = s.replace(/@\/\/+/g, '@')
  s = s.replace(/\/(\:\d{2,5})(?=\/|$)/, '$1')
  return s.replace(/\s+/g, '')
}

function resolveConn() {
  const direct = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL
  if (direct) return normalizeConn(direct)
  const base = process.env.SUPABASE_URL || process.env.COZE_SUPABASE_URL
  const pwd = process.env.SUPABASE_DB_PASSWORD
  const ref = process.env.SUPABASE_PROJECT_REF
  if (base && pwd && ref) {
    return `postgresql://postgres.${ref}:${encodeURIComponent(pwd)}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`
  }
  return ''
}

const DEMOTE = flag('--demote')
const LIST = flag('--list')
const byId = value('--id')
const byOpenId = value('--open-id')
const byDeviceId = value('--device-id')

async function main() {
  loadEnv()
  const conn = resolveConn()
  if (!conn) {
    console.error('❌ 找不到数据库连接串（DATABASE_URL / SUPABASE_DB_URL / server/.env.migrate）')
    process.exit(1)
  }
  let host = '(unknown)'
  try {
    host = new URL(conn).hostname
  } catch {
    console.error('❌ 连接串无法解析，请检查 server/.env.migrate')
    process.exit(1)
  }
  console.log(`[promote-admin] 连接 ${host}`)

  const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } })
  await client.connect()
  try {
    if (LIST) {
      const { rows } = await client.query(
        `select id, open_id, device_id, nickname, role from public.users where role = 'admin' order by created_at`,
      )
      if (!rows.length) console.log('[promote-admin] 当前没有任何管理员（建议立刻指定一个，否则知识库无法维护）')
      else for (const r of rows) console.log(`  admin: id=${r.id} open_id=${r.open_id || '-'} device=${r.device_id || '-'} name=${r.nickname || '-'}`)
      return
    }

    if (!byId && !byOpenId && !byDeviceId) {
      console.error('用法：--list | --id <id> | --open-id <openid> | --device-id <devId>（可加 --demote）')
      process.exit(2)
    }

    const where = []
    const params = []
    if (byId) { params.push(byId); where.push(`id = $${params.length}`) }
    if (byOpenId) { params.push(byOpenId); where.push(`open_id = $${params.length}`) }
    if (byDeviceId) { params.push(byDeviceId); where.push(`device_id = $${params.length}`) }
    // 匿名号不支持提权：匿名身份 30 天就过期，把它设成管理员等于给系统留一个会自动消失的后门
    const sqlWhere = where.join(' and ') + ' and is_anonymous = false'

    const target = DEMOTE ? 'user' : 'admin'
    const { rows: found } = await client.query(
      `select id, open_id, device_id, nickname, role, is_anonymous from public.users where ${sqlWhere}`,
      params,
    )
    if (!found.length) {
      console.error('❌ 没找到匹配的**非匿名**用户。确认参数，或用 --list 先看现有管理员。')
      process.exit(1)
    }
    if (found.length > 1) {
      console.error(`❌ 匹配到 ${found.length} 个用户，拒绝批量改角色（请用 --id 精确指定）：`)
      for (const r of found) console.error(`   id=${r.id} open_id=${r.open_id || '-'} device=${r.device_id || '-'}`)
      process.exit(1)
    }

    const u = found[0]
    const { rows: updated } = await client.query(
      `update public.users set role = $1 where id = $2 returning id, role`,
      [target, u.id],
    )
    console.log(`✅ ${u.id}（open_id=${u.open_id || '-'}, device=${u.device_id || '-'}）→ role=${updated[0].role}`)
    console.log('   生效时间 ≤60s（用户缓存）。无需重启后端。')
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error('❌ 执行失败：', e?.message || e)
  process.exit(1)
})
