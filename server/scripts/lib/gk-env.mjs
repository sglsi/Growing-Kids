/**
 * 脚本公用环境加载器（纯 Node，无编译）
 * ------------------------------------------------------------------
 * 为什么单独抽出来：`db-backup.mjs` / `db-restore.mjs` / 未来的巡检脚本
 * 都要读同一批配置，各写一份必然漂移（本项目已因"两处密码不一致"踩过坑）。
 *
 * 读取顺序（后者覆盖前者）：
 *   server/.env  →  server/.env.migrate  →  server/.env.secrets
 * 最后用 process.env 覆盖（真实环境变量优先级最高，便于临时排障）。
 *
 * ⚠️ 刻意 **不** 默认加载 `.env.migrate.bak-postgres`：
 *    那是 postgres 超级用户串，只给「恢复演练建临时库」用。
 *    日常备份用低权的 migrator（只读 SELECT），权限越小越好。
 *    需要时显式调 superUserUrl()。
 *
 * ⚠️ `.gitignore` 已含 `.env.*`（仅 `.env.example` 例外），本文件不会泄露密钥。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCRIPTS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const SERVER_ROOT = path.resolve(SCRIPTS_DIR, '..')
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..')

/** 解析 .env 风格文件；容忍 BOM、CRLF、行内 # 注释与包裹引号 */
export function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {}
  const out = {}
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let val = line.slice(eq + 1).trim()
    // 只剥离成对引号，不剥离行内 # （密码里可能有 #）
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

const DEFAULT_FILES = ['.env', '.env.migrate', '.env.secrets']

let cached = null

export function loadEnv() {
  if (cached) return cached
  const merged = {}
  for (const f of DEFAULT_FILES) Object.assign(merged, parseEnvFile(path.join(SERVER_ROOT, f)))
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) merged[k] = v
  }
  cached = merged
  return cached
}

export function env(key, fallback = '') {
  const v = loadEnv()[key]
  return v === undefined || v === '' ? fallback : v
}

/** 业务库连接串（低权 migrator）：DATABASE_URL > SUPABASE_DB_URL */
export function databaseUrl() {
  const url = env('DATABASE_URL') || env('SUPABASE_DB_URL')
  if (!url) {
    throw new Error(
      '找不到数据库连接串：请在 server/.env.migrate 配置 DATABASE_URL\n' +
        '  Supabase → Project Settings → Database → Connection string → URI（必须含密码）',
    )
  }
  return url
}

/** postgres 超级用户连接串（仅恢复演练建/删临时库用） */
export function superUserUrl() {
  const fromFile = parseEnvFile(path.join(SERVER_ROOT, '.env.migrate.bak-postgres'))
  const url = fromFile.DATABASE_URL || env('SUPERUSER_DATABASE_URL')
  if (!url) {
    throw new Error(
      '找不到超级用户连接串：server/.env.migrate.bak-postgres 缺失或没有 DATABASE_URL。\n' +
        '  恢复演练需要 CREATEDB 权限（postgres 角色），migrator 没有该权限。',
    )
  }
  return url
}

/** 把连接串里的库名换掉（演练建临时库后要连过去） */
export function withDatabase(url, dbName) {
  const u = new URL(url)
  u.pathname = `/${dbName}`
  return u.toString()
}

/** 脱敏展示：只留协议、用户、主机与库名 */
export function maskUrl(url) {
  try {
    const u = new URL(url)
    const user = u.username ? `${u.username}@` : ''
    return `${u.protocol}//${user}${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`
  } catch {
    return '<无法解析的连接串>'
  }
}

/** pg 客户端配置：Supabase 必须开 SSL；连接超时给足（跨境 RTT 高） */
export function pgConfig(url) {
  return {
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
    statement_timeout: 120000,
    application_name: 'gk-backup',
  }
}
