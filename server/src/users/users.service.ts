import { Injectable } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { ANONYMOUS_TTL_MS, type User } from './users.types'

const TABLE = 'users'
const SELECT_COLS = 'id, open_id, nickname, avatar_url, is_anonymous, expire_at, created_at'

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

  /** 用 openid 找用户；不存在则创建（已注册用户） */
  async findOrCreateByOpenId(openId: string): Promise<User> {
    const client = getSupabaseClient()
    const { data: existing, error: findErr } = await client
      .from(TABLE)
      .select(SELECT_COLS)
      .eq('open_id', openId)
      .maybeSingle()
    if (findErr) throw new Error(findErr.message)
    if (existing) return existing as unknown as User

    const { data, error } = await client
      .from(TABLE)
      .insert({ open_id: openId, is_anonymous: false })
      .select(SELECT_COLS)
      .single()
    if (error) throw new Error(error.message)
    return data as unknown as User
  }

  /** 创建一个匿名用户（1 天后过期，由 maintenance 清理） */
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
