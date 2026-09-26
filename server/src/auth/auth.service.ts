import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { getSupabaseClient, loadEnv } from '../storage/database/supabase-client'
import { UsersService } from '../users/users.service'
import type { User } from '../users/users.types'
import type { LoginResult, WechatSession } from './auth.types'

const WX_CODE2SESSION = 'https://api.weixin.qq.com/sns/jscode2session'
const TABLES_WITH_USER = ['subjects', 'timeline_items', 'library_docs', 'documents'] as const

/** 读取微信配置：兼容多种变量命名，避免因命名差异导致「未配置」。 */
function readWxConfig(): { appid: string; secret: string } {
  const appid =
    process.env.WX_APPID ||
    process.env.WX_MINIPROGRAM_APPID ||
    process.env.WECHAT_APPID ||
    process.env.MP_APPID ||
    ''
  const secret =
    process.env.WX_SECRET ||
    process.env.WX_APPSECRET ||
    process.env.WX_MINIPROGRAM_SECRET ||
    process.env.WECHAT_SECRET ||
    process.env.MP_SECRET ||
    ''
  return { appid: appid.trim(), secret: secret.trim() }
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name)

  constructor(private readonly usersService: UsersService) {}

  /**
   * 微信登录：code → openid → 找/建正式用户 → 迁移匿名数据 → 返回身份
   *
   * @param code          wx.login() 拿到的临时凭证（5 分钟有效，一次性）
   * @param anonymousId   当前设备上的匿名 user_id（可选）；有则把它的数据改挂到正式账号
   * @param profile       昵称 / 头像（可选，来自 wx.getUserProfile 或用户手动填）
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
   * 调微信 code2session（服务端调用，AppSecret 不上前端）
   *
   * 关键修复：在读取 process.env 之前先 loadEnv()。
   * 平台（Coze）注入的环境变量可能只存在于工作负载变量中，需要 loadEnv()
   * 才会被写入 process.env。此前直接读 process.env 会在部分部署环境下拿不到，
   * 从而误报「服务端未配置 WX_APPID / WX_SECRET」。
   */
  private async code2Session(code: string): Promise<WechatSession> {
    // 先把平台/本地的环境变量加载进 process.env（幂等，已加载则跳过）
    try {
      loadEnv()
    } catch {
      /* loadEnv 内部已吞异常，这里仅兜底 */
    }

    const { appid, secret } = readWxConfig()
    if (!appid || !secret) {
      this.logger.error(
        '[auth] 缺少微信小程序配置：请在后端环境变量中配置 WX_APPID / WX_SECRET（或 WX_MINIPROGRAM_APPID / WX_APPSECRET）',
      )
      throw new BadRequestException(
        '服务端未配置微信小程序的 AppID / AppSecret。请在部署环境添加 WX_APPID 与 WX_SECRET 后重试。',
      )
    }

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

    // 微信返回业务错误时，把 errcode/errmsg 透传出来，便于排查（如 40013 appid 非法、40125 secret 错误）
    if (json.errcode) {
      this.logger.warn(`[auth] code2session 返回错误 ${json.errcode}: ${json.errmsg}`)
      const hint =
        json.errcode === 40013
          ? '（AppID 不正确，请核对 WX_APPID）'
          : json.errcode === 40125
            ? '（AppSecret 不正确，请核对 WX_SECRET）'
            : json.errcode === 40029
              ? '（code 无效或已使用，请重试）'
              : ''
      throw new BadRequestException(
        `微信登录失败：${json.errmsg || ''}${hint}（errcode=${json.errcode}）`,
      )
    }

    return json
  }

  /**
   * 把匿名用户的数据整体迁移到正式账号。
   * 策略：直接 update user_id（保留原 id，数据不丢、外键不破）。
   *       迁移后删除匿名用户记录（其数据已全部改挂）。
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

    // 匿名账号本身已空壳，删除（其 expire_at 也无意义了）
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

  /** 退出：仅返回成功（身份由前端清除本地存储即可，无需服务端状态） */
  async logout(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
}
