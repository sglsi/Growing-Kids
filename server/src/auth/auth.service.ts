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
   * @param deviceId      当前设备标识（X-Device-Id，可选）——① 正式账号绑定设备，
   *                      本地 gk_user_id 丢失后凭设备找回微信账号；② 该设备历史上
   *                      的其它匿名号也一并迁移（丢过身份会留下多个匿名号）
   */
  async login(
    code: string,
    anonymousId?: string,
    profile?: { nickname?: string; avatar_url?: string },
    deviceId?: string,
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

    // 1) 找/建正式用户（带设备绑定：设备以后能直接找回该微信账号）
    const user = await this.usersService.findOrCreateByOpenId(session.openid, deviceId)

    // 2) 补资料（首次有值才写）
    let finalUser = user
    if (profile && (profile.nickname || profile.avatar_url)) {
      finalUser = await this.updateProfile(user.id, profile)
    }

    // 3) 匿名数据迁移（当前号 + 该设备历史遗留的全部匿名号）
    const migrated = await this.migrateAnonymousData(user.id, anonymousId, deviceId)

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
   *
   * 迁移范围：① 前端显式传来的 anonymous_id；② 该 device_id 名下所有
   * 匿名号（真机重连/重编译丢过 gk_user_id 时会留下多个，只迁一个会漏）。
   */
  private async migrateAnonymousData(
    targetUserId: string,
    anonymousId?: string,
    deviceId?: string,
  ): Promise<LoginResult['migrated']> {
    const empty = { subjects: 0, timeline_items: 0, library_docs: 0, documents: 0 }

    const anonIds = new Set<string>()
    if (anonymousId) anonIds.add(anonymousId)
    if (deviceId) {
      try {
        const devAnons = await this.usersService.listAnonymousByDeviceId(deviceId)
        for (const u of devAnons) anonIds.add(u.id)
      } catch (e) {
        this.logger.warn(`[auth] 查设备匿名号失败（不影响主迁移）: ${(e as Error).message}`)
      }
    }
    anonIds.delete(targetUserId)
    if (!anonIds.size) return empty

    const migrated = { ...empty }
    const client = getSupabaseClient()
    for (const anonId of anonIds) {
      const anon = await this.usersService.findById(anonId)
      if (!anon || !anon.is_anonymous) continue

      for (const table of TABLES_WITH_USER) {
        const { data, error } = await client
          .from(table)
          .update({ user_id: targetUserId })
          .eq('user_id', anonId)
          .select('id')
        if (error) {
          this.logger.error(`[auth] 迁移 ${table}（${anonId}）失败`, error.message)
          continue
        }
        migrated[table] += (data || []).length
      }
    }

    // 学科可能撞唯一约束（user_id, name）；撞了就删掉匿名那份重复的
    if (migrated.subjects) {
      await this.dedupeSubjects(targetUserId)
    }

    // 匿名账号本身已空壳，删除（其 expire_at 也无意义了）
    await this.usersService.removeByIds([...anonIds])

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
      // check-isolation-ignore: dupIds 取自上方同一 user_id 的学科查询结果（去重残留），
      // 按 id 删除不会越权；若将来改成跨用户清理，必须先加 user_id 条件。
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
    // GK-23-23：前端要按角色收起「管理」入口。role 不并进 SELECT_COLS（未跑 0017 的
    // 环境会整条查询报错），这里单独取、单独降级，取不到按 `user`（fail-closed）。
    // 这只是**体验层**收敛，真正的权限判定仍在服务端 requireAdmin。
    const role = await this.usersService.findRole(userId)
    return { ...user, role }
  }

  /** 退出：仅返回成功（身份由前端清除本地存储即可，无需服务端状态） */
  async logout(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
}
