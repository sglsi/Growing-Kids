import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { UsersService } from '../users/users.service'
import type { User } from '../users/users.types'
import { code2Session } from './wechat-session'
import type { LoginResult, WechatSession } from './auth.types'

const TABLES_WITH_USER = ['subjects', 'timeline_items', 'library_docs', 'documents'] as const

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

    let session: WechatSession
    try {
      session = await code2Session(code)
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : '微信登录失败')
    }
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

  /** 调微信 code2session 已提取至 wechat-session.ts（扫码登录共用同一 openid 口径） */

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
