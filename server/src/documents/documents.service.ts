import { Injectable, NotFoundException } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { StorageService } from '../storage/storage.service'
import type { Document, CreateDocumentInput, DocumentQuery } from './documents.types'

const TABLE = 'documents'

@Injectable()
export class DocumentsService {
  constructor(private readonly storageService: StorageService) {}

  async create(userId: string, input: CreateDocumentInput): Promise<Document> {
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .insert({
        user_id: userId,
        title: input.title,
        type: input.type,
        file_key: input.file_key,
        mime_type: input.mime_type || '',
        size_bytes: input.size_bytes || 0,
        meta: input.meta || {},
      })
      .select('*')
      .single()
    if (error) throw new Error(error.message)
    return data as unknown as Document
  }

  async list(userId: string, query: DocumentQuery = {}): Promise<{ total: number; list: Document[] }> {
    const client = getSupabaseClient()
    const page = query.page || 1
    const pageSize = query.page_size || 30
    const from = (page - 1) * pageSize
    const to = from + pageSize - 1

    let q = client
      .from(TABLE)
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .is('deleted_at', null)
    if (query.type) q = q.eq('type', query.type)
    if (query.keyword) q = q.ilike('title', `%${query.keyword}%`)
    q = q.order('created_at', { ascending: false }).range(from, to)

    const { data, count, error } = await q
    if (error) throw new Error(error.message)
    const list = await Promise.all(
      ((data || []) as unknown as Document[]).map(async (d) => ({
        ...d,
        url: await this.storageService.getPublicUrl(d.file_key),
      })),
    )
    return { total: count || 0, list }
  }

  async remove(userId: string, id: string): Promise<{ id: string }> {
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .update({ deleted_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('id', id)
      .select('id')
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new NotFoundException('文档不存在')
    return { id }
  }

  async removeMany(userId: string, ids: string[]): Promise<{ removed: number }> {
    if (!ids.length) return { removed: 0 }
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .update({ deleted_at: new Date().toISOString() })
      .eq('user_id', userId)
      .in('id', ids)
      .select('id')
    if (error) throw new Error(error.message)
    return { removed: (data || []).length }
  }
}
