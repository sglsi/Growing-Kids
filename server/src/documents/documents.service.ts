import { Injectable, NotFoundException } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { StorageService } from '../storage/storage.service'
import { BlobService } from '../storage/blob.service'
import type { Document, CreateDocumentInput, DocumentQuery } from './documents.types'

const TABLE = 'documents'

@Injectable()
export class DocumentsService {
  constructor(
    private readonly storageService: StorageService,
    private readonly blobService: BlobService,
  ) {}

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

    // 先查 hash（软删前），再软删，最后释放引用 —— 归零的 blob 才进待回收队列
    const { data: pending } = await client
      .from(TABLE)
      .select('id, file_hash')
      .eq('user_id', userId)
      .in('id', ids)
      .is('deleted_at', null)
    const hashes = Array.from(
      new Set(((pending || []) as { file_hash: string | null }[]).map((r) => r.file_hash).filter(Boolean) as string[]),
    )

    const { data, error } = await client
      .from(TABLE)
      .update({ deleted_at: new Date().toISOString() })
      .eq('user_id', userId)
      .in('id', ids)
      .is('deleted_at', null)
      .select('id')
    if (error) throw new Error(error.message)

    for (const h of hashes) {
      await this.blobService.release(h).catch((e) =>
        console.warn('[documents] 释放 blob 引用失败', h, e),
      )
    }
    return { removed: (data || []).length }
  }
}
