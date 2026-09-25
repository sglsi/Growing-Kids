import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { StorageService } from '../storage/storage.service'
import type { LibraryDoc, CreateLibraryDocDto, LibraryQuery } from './library.types'

const TABLE = 'library_docs'

/** 资料库：外部文档（上传的 PDF/Word/TXT 等） */
@Injectable()
export class LibraryService {
  constructor(private readonly storageService: StorageService) {}

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
        subject_id: dto.subject_id ?? null,
        mime_type: dto.mime_type ?? '',
        size_bytes: dto.size_bytes ?? 0,
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

  /** 给资料库条目补签名 URL（列表用） */
  async withUrls(docs: LibraryDoc[]): Promise<LibraryDoc[]> {
    return Promise.all(
      docs.map(async (d) => ({ ...d, url: await this.storageService.getPublicUrl(d.file_key) })),
    )
  }
}
