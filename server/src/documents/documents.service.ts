import { Injectable } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
import type { Document, CreateDocumentInput, DocumentQuery } from './documents.types'

@Injectable()
export class DocumentsService {
  async create(input: CreateDocumentInput): Promise<Document> {
    const client = getSupabaseClient()
    const { data, error } = await client
      .from('documents')
      .insert({
        title: input.title,
        type: input.type,
        file_key: input.file_key,
        url: input.url,
        mime_type: input.mime_type || '',
        size_bytes: input.size_bytes || 0,
      })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data as unknown as Document
  }

  async list(query: DocumentQuery = {}): Promise<{ total: number; list: Document[] }> {
    const client = getSupabaseClient()
    const page = query.page || 1
    const pageSize = query.page_size || 30
    const from = (page - 1) * pageSize
    const to = from + pageSize - 1

    let q = client.from('documents').select('*', { count: 'exact' })
    if (query.type) q = q.eq('type', query.type)
    if (query.keyword) q = q.ilike('title', `%${query.keyword}%`)
    q = q.order('created_at', { ascending: false }).range(from, to)

    const { data, count, error } = await q
    if (error) throw new Error(error.message)
    return { total: count || 0, list: (data || []) as unknown as Document[] }
  }

  async remove(id: string): Promise<{ id: string }> {
    const client = getSupabaseClient()
    const { error } = await client.from('documents').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { id }
  }

  async removeMany(ids: string[]): Promise<{ removed: number }> {
    if (!ids.length) return { removed: 0 }
    const client = getSupabaseClient()
    const { data, error } = await client.from('documents').delete().in('id', ids).select('id')
    if (error) throw new Error(error.message)
    return { removed: (data || []).length }
  }
}