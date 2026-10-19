import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { cleanStr } from '../shared/query-param'
import type {
  Material, CreateMaterialInput, MaterialQuery,
} from './materials.types'

/**
 * ⚠️ service_role 绕过 RLS ⇒ 每个查询都必须 .eq('user_id', userId)
 * 2026-10-19 补齐：此前本服务完全没有用户隔离，注册进 app.module 前必须先补上。
 */
@Injectable()
export class MaterialsService {
  async createMaterial(userId: string, input: CreateMaterialInput): Promise<Material> {
    if (!input.file_key) throw new BadRequestException('素材缺少 file_key')
    const client = getSupabaseClient()
    const payload = {
      user_id: userId,
      name: input.name || '未命名素材',
      type: input.type,
      file_key: input.file_key,
      url: input.url,
      mime_type: input.mime_type || '',
      size_bytes: input.size_bytes || 0,
      subject_id: input.subject_id || null,
      used: input.used ?? false,
    }
    const { data, error } = await client
      .from('materials')
      .insert(payload)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data as Material
  }

  async list(userId: string, query: MaterialQuery): Promise<{ list: Material[]; total: number }> {
    const client = getSupabaseClient()
    const page = Math.max(1, query.page || 1)
    const pageSize = Math.min(100, query.page_size || 20)
    const from = (page - 1) * pageSize
    const to = from + pageSize - 1

    let q = client
      .from('materials')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)

    if (query.type) q = q.eq('type', query.type)
    const subjectId = cleanStr(query.subject_id)
    if (subjectId) q = q.eq('subject_id', subjectId)
    const keyword = cleanStr(query.keyword)
    if (keyword) q = q.ilike('name', `%${keyword}%`)
    q = q.order('created_at', { ascending: false }).range(from, to)

    const { data, error, count } = await q
    if (error) throw new Error(error.message)
    return { list: (data || []) as Material[], total: count || 0 }
  }

  async markUsed(userId: string, id: string): Promise<void> {
    const client = getSupabaseClient()
    const { error } = await client
      .from('materials')
      .update({ used: true })
      .eq('id', id)
      .eq('user_id', userId)
    if (error) throw new Error(error.message)
  }

  async remove(userId: string, id: string): Promise<{ id: string }> {
    const client = getSupabaseClient()
    // 带 .select() 才能拿到实际删除行数：越权删除时返回空，必须报 404 而不是假装成功
    const { data, error } = await client
      .from('materials')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)
      .select('id')
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) throw new NotFoundException('素材不存在')
    return { id }
  }

  async removeMany(userId: string, ids: string[]): Promise<{ removed: number }> {
    const client = getSupabaseClient()
    if (!ids.length) return { removed: 0 }
    const { data, error } = await client
      .from('materials')
      .delete()
      .in('id', ids)
      .eq('user_id', userId)
      .select('id')
    if (error) throw new Error(error.message)
    return { removed: (data || []).length }
  }

  async listByIds(userId: string, ids: string[]): Promise<Material[]> {
    const client = getSupabaseClient()
    if (!ids.length) return []
    const { data, error } = await client
      .from('materials')
      .select('*')
      .in('id', ids)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return (data || []) as Material[]
  }
}
