import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { DEFAULT_SUBJECTS, type Subject } from './subjects.types'
import { UgcTextGuard } from '../security/ugc-text-guard.service'

const TABLE = 'subjects'
const SELECT_COLS = 'id, user_id, name, color, sort_order, created_at'

@Injectable()
export class SubjectsService {
  constructor(private readonly ugc: UgcTextGuard) {}

  /** 列当前用户的学科；若为空则铺设默认学科（新/匿名用户） */
  async findAll(userId: string): Promise<Subject[]> {
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .select(SELECT_COLS)
      .eq('user_id', userId)
      .order('sort_order', { ascending: true })
    if (error) throw new Error(error.message)

    if (!data || data.length === 0) {
      return this.seedDefaults(userId)
    }
    return data as unknown as Subject[]
  }

  /** 铺设默认学科并返回 */
  private async seedDefaults(userId: string): Promise<Subject[]> {
    const client = getSupabaseClient()
    const rows = DEFAULT_SUBJECTS.map((s) => ({ user_id: userId, ...s }))
    const { data, error } = await client.from(TABLE).insert(rows).select(SELECT_COLS)
    if (error) throw new Error(error.message)
    return (data || []) as unknown as Subject[]
  }

  async create(userId: string, name: string, color?: string, sortOrder?: number): Promise<Subject> {
    if (!name?.trim()) throw new BadRequestException('name 不能为空')
    // D-059：学科名称由用户自填，属 UGC 文本（不送 seedDefaults 的预设名称）
    await this.ugc.assertAllowed(userId, [name], { scene: 1, tag: 'subjects.create' })
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .insert({ user_id: userId, name: name.trim(), color: color || 'gray-500', sort_order: sortOrder ?? 99 })
      .select(SELECT_COLS)
      .single()
    if (error) throw new Error(error.message)
    return data as unknown as Subject
  }

  async update(userId: string, id: string, patch: Partial<Pick<Subject, 'name' | 'color' | 'sort_order'>>): Promise<Subject> {
    // D-059：只改颜色 / 排序时不送检；改名称才送
    if (patch.name !== undefined) {
      await this.ugc.assertAllowed(userId, [patch.name], { scene: 1, tag: 'subjects.update' })
    }
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .update(patch)
      .eq('user_id', userId)
      .eq('id', id)
      .select(SELECT_COLS)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new NotFoundException('学科不存在')
    return data as unknown as Subject
  }

  async remove(userId: string, id: string): Promise<{ id: string }> {
    const client = getSupabaseClient()
    const { error } = await client.from(TABLE).delete().eq('user_id', userId).eq('id', id)
    if (error) throw new Error(error.message)
    return { id }
  }
}
