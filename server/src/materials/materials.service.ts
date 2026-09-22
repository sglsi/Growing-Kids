import { Injectable, BadRequestException } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
import type {
  Material, CreateMaterialInput, MaterialQuery,
} from './materials.types'

@Injectable()
export class MaterialsService {
  async createMaterial(input: CreateMaterialInput): Promise<Material> {
    if (!input.file_key) throw new BadRequestException('素材缺少 file_key')
    const client = getSupabaseClient()
    const payload = {
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

  async list(query: MaterialQuery): Promise<{ list: Material[]; total: number }> {
    const client = getSupabaseClient()
    const page = Math.max(1, query.page || 1)
    const pageSize = Math.min(100, query.page_size || 20)
    const from = (page - 1) * pageSize
    const to = from + pageSize - 1

    let q = client
      .from('materials')
      .select('*', { count: 'exact' })

    if (query.type) q = q.eq('type', query.type)
    if (query.subject_id) q = q.eq('subject_id', query.subject_id)
    if (query.keyword) q = q.ilike('name', `%${query.keyword}%`)
    q = q.order('created_at', { ascending: false }).range(from, to)

    const { data, error, count } = await q
    if (error) throw new Error(error.message)
    return { list: (data || []) as Material[], total: count || 0 }
  }

  async markUsed(id: string): Promise<void> {
    const client = getSupabaseClient()
    const { error } = await client.from('materials').update({ used: true }).eq('id', id)
    if (error) throw new Error(error.message)
  }

  async remove(id: string): Promise<{ id: string }> {
    const client = getSupabaseClient()
    const { error } = await client.from('materials').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { id }
  }
}
