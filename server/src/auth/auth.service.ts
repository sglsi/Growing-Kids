import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { getSupabaseClient, loadEnv } from '../storage/database/supabase-client'
import { UsersService } from '../users/users.service'
import type { User } from '../users/users.types'
import type { LoginResult, WechatSession } from './auth.types'
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const WX_CODE2SESSION = 'https://api.weixin.qq.com/sns/jscode2session'
const TABLES_WITH_USER = ['subjects', 'timeline_items', 'library_docs', 'documents'] as const

/**
 * 微信小程序配置的候选变量名（大小写/命名差异都覆盖）。
 * 按顺序取第一个非空值。
 */
const APPID_KEYS = [
  'WX_APPID',
  'WX_MINIPROGRAM_APPID',
  'WX_MINI_APPID',
  'WECHAT_APPID',
  'WECHAT_MINIPROGRAM_APPID',
  'MP_APPID',
  'MINIPROGRAM_APPID',
  'APPID',
  'COZE_WX_APPID',
  'COZE_WECHAT_APPID',
] as const

const SECRET_KEYS = [
  'WX_SECRET',
  'WX_APPSECRET',
  'WX_APP_SECRET',
  'WX_MINIPROGRAM_SECRET',
  'WECHAT_SECRET',
  'WECHAT_APPSECRET',
  'MP_SECRET',
  'MINIPROGRAM_SECRET',
  'APPSECRET',
  'SECRET',
  'COZE_WX_SECRET',
  'COZE_WECHAT_SECRET',
] as const

/**
 * 二次兜底：直接从 Coze 工作负载身份 / .env 文件里再捞一遍变量。
 *
 * 为什么需要它：`loadEnv()`（supabase-client 里）只在「首次」执行，
 * 且仅当 COZE_SUPABASE_URL 等 Supabase 变量缺失时才会真的去读平台变量。
 * 本函数与它相互独立，确保微信配置无论如何都能被读到。
 */
function readEnvFromPlatform(): Record<string, string> {
  const out: Record<string, string> = {}

  // 1) .env 文件（本地/容器内）
  for (const f of ['.env', '.env.local', '.env.production', 'server/.env']) {
    try {
      const p = path.isAbsolute(f) ? f : path.join(process.cwd(), f)
      if (!fs.existsSync(p)) continue
      const text = fs.readFileSync(p, 'utf-8')
      for (const rawLine of text.split('\n')) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        const eq = line.indexOf('=')
        if (eq <= 0) continue
        const k = line.slice(0, eq).trim()
        let v = line.slice(eq + 1).trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1)
        }
        if (k && v && !out[k]) out[k] = v
      }
    } catch {
      /* ignore */
    }
  }

  // 2) Coze 平台项目环境变量（python coze_workload_identity）
  try {
    const pythonCode = `
import sys
try:
    from coze_workload_identity import Client
    client = Client()
    env_vars = client.get_project_env_vars()
    client.close()
    for ev in env_vars:
        print(f"{ev.key}={ev.value}")
except Exception as e:
    print(f"# Error: {e}", file=sys.stderr)
`
    const output = execSync(`python3 -c '${pythonCode.replace(/'/g, "'\"'\"'")}'`, {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    for (const line of output.split('\n')) {
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const k = line.slice(0, eq).trim()
      let v = line.slice(eq + 1)
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      if (k && v && !out[k]) out[k] = v
    }
  } catch {
    /* ignore */
  }

  return out
}

/** 从多个来源合并后的「可用配置表」里按候选名取值 */
function pickFromTable(table: Record<string, string>, keys: readonly string[]): string {
  for (const k of keys) {
    const v = (process.env[k] ?? table[k] ?? '').toString().trim()
    if (v) return v
  }
  return ''
}

/**
 * 读取微信配置：兼容多种变量命名，并叠加 .env / 平台变量兜底。
 */
function readWxConfig(): { appid: string; secret: string; source: string; availableKeys: string[] } {
  // 先触发一次平台加载（幂等）
  try {
    loadEnv()
  } catch {
    /* ignore */
  }
  const table = readEnvFromPlatform()

  const appid = pickFromTable(table, APPID_KEYS)
  const secret = pickFromTable(table, SECRET_KEYS)

  // 汇总当前可见的 env key 名单（只给 key，不给 value，避免泄露密钥）
  const availableKeys = Array.from(new Set([
    ...Object.keys(process.env),
    ...Object.keys(table),
  ])).sort()

  let source = 'none'
  if (appid) {
    if (APPID_KEYS.some((k) => (process.env[k] || '').trim())) source = 'process.env'
    else source = '.env/platform'
  }

  return { appid, secret, source, availableKeys }
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name)

  constructor(private readonly usersService: UsersService) {}

  /**
   * 微信登录：code → openid → 找/建正式用户 → 迁移匿名数据 → 返回身份
   */
  async login(
    code: string,
    anonymousId?: string,
    profile?: { nickname?: string; avatar_url?: string },
  ): Promise<LoginResult> {
    if (!code) throw new BadRequestException('code 不能为空')

    const session = await this.code2Session(code)
    if (!session.openid) {
      throw new BadRequestException(`微信登录失败：${session.errmsg || '未返回 openid'}`)
    }

    // 1) 找/建正式用户
    const user = await this.usersService.findOrCreateByOpenId(session.openid)

    // 2) 补资料（首次有值才写）
    let finalUser = user
    if (profile && (profile.nickname || profile.avatar_url)) {
      finalUser = await this.updateProfile(user.id, profile)
    }

    // 3) 匿名数据迁移
    const migrated = await this.migrateAnonymousData(user.id, anonymousId)

    this.logger.log(
      `[auth] 登录成功 userId=${user.id} 迁移=${JSON.stringify(migrated)}`,
    )

    return { user: finalUser, migrated }
  }

  /**
   * 调微信 code2session。
   *
   * 关键修复（「服务端未配置微信小程序的 AppID」）：
   *  - 在读取配置前调用 loadEnv()，并叠加 .env / Coze 平台变量兜底；
   *  - 变量名做兼容（WX_APPID / WX_MINIPROGRAM_APPID / WECHAT_APPID …）；
   *  - 若确实取不到，把「当前可见的 env key 名单」打进日志，方便一眼看出到底配了什么，
   *    彻底避免此前「报未配置但看不到原因」的反复拉扯。
   */
  private async code2Session(code: string): Promise<WechatSession> {
    const { appid, secret, source, availableKeys } = readWxConfig()

    if (!appid || !secret) {
      const hasAppid = appid ? '✔' : '✘'
      const hasSecret = secret ? '✔' : '✘'
      this.logger.error(
        `[auth] 微信配置缺失：APPID=${hasAppid} SECRET=${hasSecret}。` +
        `当前可见的环境变量 key：${availableKeys.join(', ') || '(空)'}。` +
        `请在部署环境配置 WX_APPID 与 WX_SECRET（或 WX_MINIPROGRAM_APPID / WX_APPSECRET）。`,
      )
      // 给出「到底缺哪个」的更精确提示，前端能直接看到
      const missing = !appid && !secret
        ? 'AppID 与 AppSecret'
        : (!appid ? 'AppID' : 'AppSecret')
      throw new BadRequestException(
        `服务端未配置微信小程序的 ${missing}。请在部署环境添加 WX_APPID 与 WX_SECRET 后重试。` +
        `（当前可见环境变量：${availableKeys.slice(0, 30).join(', ') || '无'}）`,
      )
    }

    this.logger.log(`[auth] 使用微信配置来源=${source} appid=${appid.slice(0, 6)}***`)

    const url =
      `${WX_CODE2SESSION}?appid=${encodeURIComponent(appid)}` +
      `&secret=${encodeURIComponent(secret)}` +
      `&js_code=${encodeURIComponent(code)}` +
      `&grant_type=authorization_code`

    let json: WechatSession
    try {
      const res = await fetch(url)
      json = (await res.json()) as WechatSession
    } catch (e) {
      this.logger.error('[auth] code2session 请求失败', e as Error)
      throw new BadRequestException('微信服务暂时不可用，请稍后重试')
    }

    // 微信返回业务错误时，把 errcode/errmsg 透传出来，便于排查
    if (json.errcode) {
      this.logger.warn(`[auth] code2session 返回错误 ${json.errcode}: ${json.errmsg}`)
      const hint =
        json.errcode === 40013
          ? '（AppID 不正确，请核对 WX_APPID）'
          : json.errcode === 40125
            ? '（AppSecret 不正确，请核对 WX_SECRET）'
            : json.errcode === 40029
              ? '（code 无效或已使用，请重试）'
              : json.errcode === 40226
                ? '（触发频率限制，请稍后重试）'
                : ''
      throw new BadRequestException(
        `微信登录失败：${json.errmsg || ''}${hint}（errcode=${json.errcode}）`,
      )
    }

    return json
  }

  /**
   * 把匿名用户的数据整体迁移到正式账号。
   */
  private async migrateAnonymousData(
    targetUserId: string,
    anonymousId?: string,
  ): Promise<LoginResult['migrated']> {
    const empty = { subjects: 0, timeline_items: 0, library_docs: 0, documents: 0 }
    if (!anonymousId || anonymousId === targetUserId) return empty

    const client = getSupabaseClient()
    const anon = await this.usersService.findById(anonymousId)
    if (!anon || !anon.is_anonymous) return empty

    const migrated = { ...empty }
    for (const table of TABLES_WITH_USER) {
      const { data, error } = await client
        .from(table)
        .update({ user_id: targetUserId })
        .eq('user_id', anonymousId)
        .select('id')
      if (error) {
        this.logger.error(`[auth] 迁移 ${table} 失败`, error.message)
        continue
      }
      migrated[table] = (data || []).length
    }

    // 学科可能撞唯一约束（user_id, name）；撞了就删掉匿名那份重复的
    if (migrated.subjects) {
      await this.dedupeSubjects(targetUserId)
    }

    await this.usersService.removeByIds([anonymousId])

    return migrated
  }

  /** 迁移后：同名学科只留一条（保留最早创建的） */
  private async dedupeSubjects(userId: string) {
    const client = getSupabaseClient()
    const { data, error } = await client
      .from('subjects')
      .select('id, name, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
    if (error) return

    const seen = new Set<string>()
    const dupIds: string[] = []
    for (const row of (data || []) as { id: string; name: string }[]) {
      if (seen.has(row.name)) dupIds.push(row.id)
      else seen.add(row.name)
    }
    if (dupIds.length) {
      await client.from('subjects').delete().in('id', dupIds)
      this.logger.log(`[auth] 清理重复学科 ${dupIds.length} 条`)
    }
  }

  /** 更新昵称 / 头像 */
  async updateProfile(
    userId: string,
    patch: { nickname?: string; avatar_url?: string },
  ): Promise<User> {
    return this.usersService.updateProfile(userId, patch)
  }

  /** 当前登录用户信息 */
  async me(userId: string): Promise<User> {
    const user = await this.usersService.findById(userId)
    if (!user) throw new BadRequestException('用户不存在')
    return user
  }

  /** 退出：仅返回成功 */
  async logout(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
}
