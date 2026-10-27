import { Injectable } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { ANONYMOUS_TTL_MS, type User } from './users.types'

const TABLE = 'users'
const SELECT_COLS = 'id, open_id, device_id, nickname, avatar_url, is_anonymous, expire_at, created_at'

@Injectable()
export class UsersService {
  async findById(id: string): Promise<User | null> {
    if (!id) return null
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .select(SELECT_COLS)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new Error(error.message)
    return (data as unknown as User) || null
  }

  /**
   * 用 openid 找用户；不存在则创建（已注册用户）。
   * deviceId 传入时：新账号直接绑定该设备；老账号若未绑设备则补绑
   * （0011 唯一索引保证一个设备只绑一个正式号）——「设备找回微信账号」
   * 的关键：本地 gk_user_id 丢失后，凭 X-Device-Id 也能回到同一账号，
   * 不再掉回匿名身份造成数据分家。
   */
  async findOrCreateByOpenId(openId: string, deviceId?: string): Promise<User> {
    const client = getSupabaseClient()
    const { data: existing, error: findErr } = await client
      .from(TABLE)
      .select(SELECT_COLS)
      .eq('open_id', openId)
      .maybeSingle()
    if (findErr) throw new Error(findErr.message)
    if (existing) {
      const u = existing as unknown as User
      if (deviceId && !u.device_id) {
        const { data: bound, error: bindErr } = await client
          .from(TABLE)
          .update({ device_id: deviceId })
          .eq('id', u.id)
          .is('device_id', null)
          .select(SELECT_COLS)
          .maybeSingle()
        if (!bindErr && bound) return bound as unknown as User
      }
      return u
    }

    const { data, error } = await client
      .from(TABLE)
      .insert({ open_id: openId, is_anonymous: false, device_id: deviceId ?? null })
      .select(SELECT_COLS)
      .single()
    if (error) throw new Error(error.message)
    return data as unknown as User
  }

  /**
   * 用 device_id 找匿名用户；不存在则创建，找到则滑动续期。
   * 「同一设备 = 同一身份」的核心（0011 migration + 思傅 2026-10-20 拍板方案 A）：
   * 前端一次生成 deviceId 永存 storage，此后请求都带 X-Device-Id，
   * 即使本地 gk_user_id 丢失/后端匿名 id 失效，也能找回同一身份，数据不漂移。
   */
  async findOrCreateByDeviceId(deviceId: string): Promise<User> {
    const client = getSupabaseClient()
    const { data: existing, error: findErr } = await client
      .from(TABLE)
      .select(SELECT_COLS)
      .eq('device_id', deviceId)
      .maybeSingle()
    if (findErr) throw new Error(findErr.message)
    if (existing) {
      const u = existing as unknown as User
      // 匿名身份滑动续期：仍在用就顺延 30 天，避免「放着几天没用数据就被清」
      if (u.is_anonymous) {
        const expireAt = new Date(Date.now() + ANONYMOUS_TTL_MS).toISOString()
        if (!u.expire_at || new Date(u.expire_at) < new Date(expireAt)) {
          const { data: renewed, error: upErr } = await client
            .from(TABLE)
            .update({ expire_at: expireAt })
            .eq('id', u.id)
            .select(SELECT_COLS)
            .maybeSingle()
          if (!upErr && renewed) return renewed as unknown as User
        }
      }
      return u
    }

    const expireAt = new Date(Date.now() + ANONYMOUS_TTL_MS).toISOString()
    const { data, error } = await client
      .from(TABLE)
      .insert({ is_anonymous: true, expire_at: expireAt, device_id: deviceId })
      .select(SELECT_COLS)
      .single()
    if (error) throw new Error(error.message)
    return data as unknown as User
  }

  /** 创建一个匿名用户（30 天后过期，由 maintenance 清理） */
  async createAnonymous(): Promise<User> {
    const client = getSupabaseClient()
    const expireAt = new Date(Date.now() + ANONYMOUS_TTL_MS).toISOString()
    const { data, error } = await client
      .from(TABLE)
      .insert({ is_anonymous: true, expire_at: expireAt })
      .select(SELECT_COLS)
      .single()
    if (error) throw new Error(error.message)
    return data as unknown as User
  }

  /**
   * 列出某设备名下的所有匿名用户。
   * 登录迁移用：设备历史上丢过 gk_user_id（真机重连/重编译）会留下多个
   * 匿名号，只迁当前一个会漏数据——这里一次性找出全部，保证旧数据都
   * 并到正式账号。
   */
  async listAnonymousByDeviceId(deviceId: string): Promise<User[]> {
    if (!deviceId) return []
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .select(SELECT_COLS)
      .eq('device_id', deviceId)
      .eq('is_anonymous', true)
    if (error) throw new Error(error.message)
    return (data || []) as unknown as User[]
  }

  /** 列出所有已过期的匿名用户（供清理任务用） */
  async listExpiredAnonymous(): Promise<User[]> {
    const client = getSupabaseClient()
    const nowIso = new Date().toISOString()
    const { data, error } = await client
      .from(TABLE)
      .select(SELECT_COLS)
      .eq('is_anonymous', true)
      .lt('expire_at', nowIso)
    if (error) throw new Error(error.message)
    return (data || []) as unknown as User[]
  }

  /**
   * 读取角色（0017 `users.role`）。
   *
   * 为什么不并进 `SELECT_COLS`：没跑 0017 的环境里 select role 会整条查询报错，
   * 那会把「所有接口」一起打死。这里单独取、单独失败：取不到（列不存在）就
   * 一律按 `user` 处理（fail-closed，管理员最多暂时写不了知识库，不会越权）。
   */
  async findRole(id: string): Promise<'user' | 'admin'> {
    if (!id) return 'user'
    try {
      const client = getSupabaseClient()
      const { data, error } = await client.from(TABLE).select('role').eq('id', id).maybeSingle()
      if (error) {
        console.warn('[users] 读取 role 失败（0017 迁移可能未执行），按 user 处理：', error.message)
        return 'user'
      }
      return (data as { role?: string } | null)?.role === 'admin' ? 'admin' : 'user'
    } catch (e) {
      console.warn('[users] 读取 role 异常，按 user 处理：', e)
      return 'user'
    }
  }

  /** 更新昵称 / 头像 */
  async updateProfile(
    userId: string,
    patch: { nickname?: string; avatar_url?: string },
  ): Promise<User> {
    const client = getSupabaseClient()
    const payload: Record<string, unknown> = {}
    if (patch.nickname !== undefined) payload.nickname = patch.nickname
    if (patch.avatar_url !== undefined) payload.avatar_url = patch.avatar_url
    if (!Object.keys(payload).length) {
      const current = await this.findById(userId)
      if (!current) throw new Error('用户不存在')
      return current
    }
    const { data, error } = await client
      .from(TABLE)
      .update(payload)
      .eq('id', userId)
      .select(SELECT_COLS)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new Error('用户不存在')
    return data as unknown as User
  }

  /** 删除若干用户（级联清 subjects/timeline_items/library_docs/documents） */
  async removeByIds(ids: string[]): Promise<number> {
    if (!ids.length) return 0
    const client = getSupabaseClient()
    const { data, error } = await client.from(TABLE).delete().in('id', ids).select('id')
    if (error) throw new Error(error.message)
    return (data || []).length
  }
}
