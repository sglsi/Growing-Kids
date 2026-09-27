import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { StorageService } from '../storage/storage.service'
import { BlobService } from '../storage/blob.service'
import type { LibraryDoc, CreateLibraryDocDto, LibraryQuery } from './library.types'

const TABLE = 'library_docs'

/** 资料库：外部文档（上传的 PDF/Word/TXT 等） */
@Injectable()
export class LibraryService {
  constructor(
    private readonly storageService: StorageService,
    private readonly blobService: BlobService,
  ) {}

  async list(userId: string, query: LibraryQuery): Promise<{ list: LibraryDoc[]; total: number; page: number; page_size: number }> {
    const client = getSupabaseClient()
    const page = Math.max(1, query.page || 1)
    const pageSize = Math.min(100, query.page_size || 20)
    const from = (page - 1) * pageSize
    const to = from + pageSize - 1

    let q = client
      .from(TABLE)
      .select('*, subjects:subject_id(id, name, color)', { count: 'exact' })
      .eq('user_id', userId)
      .is('deleted_at', null)

    if (query.subject_id) q = q.eq('subject_id', query.subject_id)
    if (query.keyword) q = q.ilike('name', `%${query.keyword}%`)
    q = q.order('created_at', { ascending: false }).range(from, to)

    const { data, error, count } = await q
    if (error) throw new Error(error.message)
    return { list: (data || []) as unknown as LibraryDoc[], total: count || 0, page, page_size: pageSize }
  }

  async create(userId: string, dto: CreateLibraryDocDto): Promise<LibraryDoc> {
    if (!dto.file_key) throw new BadRequestException('文档缺少 file_key')
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .insert({
        user_id: userId,
        name: dto.name || '未命名文档',
        file_key: dto.file_key,
        thumb_key: dto.thumb_key ?? null,
        subject_id: dto.subject_id ?? null,
        mime_type: dto.mime_type ?? '',
        width: dto.width ?? null,
        height: dto.height ?? null,
        size_bytes: dto.size_bytes ?? 0,
        file_hash: dto.file_hash ?? null,
        source: dto.source ?? 'upload',
        tags: dto.tags ?? [],
      })
      .select('*, subjects:subject_id(id, name, color)')
      .single()
    if (error) throw new Error(error.message)
    return data as unknown as LibraryDoc
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

  /** 批量软删 + 释放 blob 引用（策略 4/5；先查 hash 再软删，最后释放） */
  async removeMany(userId: string, ids: string[]): Promise<{ removed: number }> {
    if (!ids.length) return { removed: 0 }
    const client = getSupabaseClient()

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
        console.warn('[library] 释放 blob 引用失败', h, e),
      )
    }
    return { removed: (data || []).length }
  }

  /** 给资料库条目补签名 URL（列表用）；缩略图优先，无则回落原图 */
  async withUrls(docs: LibraryDoc[]): Promise<LibraryDoc[]> {
    return Promise.all(
      docs.map(async (d) => {
        const enriched: LibraryDoc = { ...d }
        if (d.file_key) enriched.url = await this.storageService.getPublicUrl(d.file_key)
        if (d.thumb_key) enriched.thumb_url = await this.storageService.getPublicUrl(d.thumb_key)
        return enriched
      }),
    )
  }
}
