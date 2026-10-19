import { Injectable, NotFoundException } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { StorageService } from '../storage/storage.service'
import type {
  Memory, MemoryMedia, MemoryListQuery,
  CreateMemoryDto, UpdateMemoryDto, CreateMemoryMediaDto,
  MemoryCategory, MemoryKind,
} from './memory.types'

const TABLE = 'memories'
const MEDIA_TABLE = 'memory_media'
const SELECT_COLS = '*, subjects:subject_id(id, name, color)'
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100
const VALID_CATEGORIES: ReadonlyArray<MemoryCategory> = ['study', 'life', 'hobby', 'feel', 'other']
const VALID_KINDS: ReadonlyArray<MemoryKind> = ['image', 'audio', 'video']

/**
 * 成长记忆服务
 * ⚠️ service_role 绕过 RLS ⇒ 每个查询都必须 .eq('user_id', userId)
 */
@Injectable()
export class MemoryService {
  constructor(private readonly storageService: StorageService) {}

  // ---------- 列表 ----------
  async list(
    userId: string,
    query: MemoryListQuery,
  ): Promise<{ list: Memory[]; total: number; page: number; page_size: number }> {
    const client = getSupabaseClient()
    const page = Math.max(1, query.page || 1)
    const pageSize = Math.min(MAX_PAGE_SIZE, query.page_size || DEFAULT_PAGE_SIZE)
    const from = (page - 1) * pageSize
    const to = from + pageSize - 1

    let q = client
      .from(TABLE)
      .select(SELECT_COLS, { count: 'exact' })
      .eq('user_id', userId)
      .is('deleted_at', null)

    if (query.category && VALID_CATEGORIES.includes(query.category as MemoryCategory)) {
      q = q.eq('category', query.category)
    }
    if (query.subject_id) q = q.eq('subject_id', query.subject_id)
    if (query.tag) q = q.contains('tags', [query.tag])
    if (query.keyword) {
      const kw = `%${query.keyword}%`
      q = q.or(`title.ilike.${kw},content.ilike.${kw}`)
    }
    if (query.since) q = q.gte('occurred_at', query.since)

    const { data, error, count } = await q
      .order('occurred_at', { ascending: false })
      .range(from, to)
    if (error) throw new Error(error.message)

    return {
      list: (data || []) as unknown as Memory[],
      total: count || 0,
      page,
      page_size: pageSize,
    }
  }

  // ---------- 详情（包含 media 列表） ----------
  async findOne(userId: string, id: string): Promise<{ memory: Memory; media: MemoryMedia[] }> {
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .select(SELECT_COLS)
      .eq('user_id', userId)
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new NotFoundException('记忆不存在')
    const memory = data as unknown as Memory

    const { data: mediaData, error: mediaErr } = await client
      .from(MEDIA_TABLE)
      .select('*')
      .eq('user_id', userId)
      .eq('memory_id', id)
      .order('sort_order', { ascending: true })
    if (mediaErr) throw new Error(mediaErr.message)

    return {
      memory,
      media: (mediaData || []) as unknown as MemoryMedia[],
    }
  }

  // ---------- 创建 ----------
  async create(userId: string, dto: CreateMemoryDto): Promise<Memory> {
    const client = getSupabaseClient()
    const payload: Record<string, unknown> = {
      user_id: userId,
      title: dto.title ?? null,
      content: dto.content ?? null,
      category: dto.category ?? 'life',
      mood: dto.mood ?? null,
      subject_id: dto.subject_id ?? null,
      tags: dto.tags ?? [],
      media_count: 0,
    }
    if (dto.occurred_at) payload.occurred_at = dto.occurred_at

    const { data, error } = await client
      .from(TABLE)
      .insert(payload)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data as unknown as Memory
  }

  // ---------- 修改 ----------
  async update(userId: string, id: string, dto: UpdateMemoryDto): Promise<Memory> {
    const client = getSupabaseClient()
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (dto.title !== undefined) update.title = dto.title
    if (dto.content !== undefined) update.content = dto.content
    if (dto.category !== undefined) update.category = dto.category
    if (dto.mood !== undefined) update.mood = dto.mood
    if (dto.subject_id !== undefined) update.subject_id = dto.subject_id
    if (dto.tags !== undefined) update.tags = dto.tags
    if (dto.occurred_at !== undefined) update.occurred_at = dto.occurred_at

    const { data, error } = await client
      .from(TABLE)
      .update(update)
      .eq('user_id', userId)
      .eq('id', id)
      .is('deleted_at', null)
      .select()
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new NotFoundException('记忆不存在或已删除')
    return data as unknown as Memory
  }

  // ---------- 删除（软删） ----------
  async remove(userId: string, id: string): Promise<{ id: string }> {
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('id', id)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new NotFoundException('记忆不存在或已删除')
    return { id }
  }

  // ---------- 批量软删 ----------
  async removeMany(userId: string, ids: string[]): Promise<{ count: number }> {
    if (!Array.isArray(ids) || ids.length === 0) return { count: 0 }
    const client = getSupabaseClient()
    const now = new Date().toISOString()
    const { data, error } = await client
      .from(TABLE)
      .update({ deleted_at: now, updated_at: now })
      .eq('user_id', userId)
      .in('id', ids)
      .is('deleted_at', null)
      .select('id')
    if (error) throw new Error(error.message)
    return { count: (data || []).length }
  }

  // ---------- 追加媒体 ----------
  async addMedia(userId: string, memoryId: string, dto: CreateMemoryMediaDto): Promise<MemoryMedia> {
    if (!VALID_KINDS.includes(dto.kind)) {
      throw new Error('kind 仅支持 image / audio / video')
    }
    const client = getSupabaseClient()

    // 校验记忆归属
    const { data: mem, error: memErr } = await client
      .from(TABLE)
      .select('id')
      .eq('user_id', userId)
      .eq('id', memoryId)
      .is('deleted_at', null)
      .maybeSingle()
    if (memErr) throw new Error(memErr.message)
    if (!mem) throw new NotFoundException('记忆不存在或已删除')

    const sortOrder = dto.sort_order ?? 0
    const payload = {
      memory_id: memoryId,
      user_id: userId,
      file_key: dto.file_key,
      thumb_key: dto.thumb_key ?? null,
      mime_type: dto.mime_type,
      width: dto.width ?? null,
      height: dto.height ?? null,
      size_bytes: dto.size_bytes ?? null,
      duration_sec: dto.duration_sec ?? null,
      kind: dto.kind,
      sort_order: sortOrder,
    }
    const { data, error } = await client
      .from(MEDIA_TABLE)
      .insert(payload)
      .select()
      .single()
    if (error) throw new Error(error.message)

    // 更新记忆的 media_count / cover_key / audio_duration
    await this.recalculateSummary(userId, memoryId)
    return data as unknown as MemoryMedia
  }

  // ---------- 删除单个媒体 ----------
  async removeMedia(userId: string, memoryId: string, mediaId: string): Promise<{ id: string }> {
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(MEDIA_TABLE)
      .delete()
      .eq('user_id', userId)
      .eq('memory_id', memoryId)
      .eq('id', mediaId)
      .select('id')
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new NotFoundException('媒体不存在')
    await this.recalculateSummary(userId, memoryId)
    return { id: mediaId }
  }

  // ---------- 媒体 URL 解析 ----------
  async withMediaUrls(media: MemoryMedia[]): Promise<MemoryMedia[]> {
    return Promise.all(
      media.map(async (m) => {
        const enriched: MemoryMedia & { url?: string; thumb_url?: string } = { ...m }
          enriched.url = await this.storageService.getPublicUrl(m.file_key)
          if (m.thumb_key) enriched.thumb_url = await this.storageService.getPublicUrl(m.thumb_key)
          return enriched as MemoryMedia
      }),
    )
  }

  // ---------- 内部：根据 media 重新计算 count / cover / audio_duration ----------
  private async recalculateSummary(userId: string, memoryId: string): Promise<void> {
    const client = getSupabaseClient()
    const { data: media, error } = await client
      .from(MEDIA_TABLE)
      .select('file_key, mime_type, kind, duration_sec, sort_order')
      .eq('user_id', userId)
      .eq('memory_id', memoryId)
      .order('sort_order', { ascending: true })
    if (error) return

    const list = (media || []) as Array<{ file_key: string; mime_type: string; kind: string; duration_sec: number | null; sort_order: number }>
    const mediaCount = list.length
    const firstImage = list.find((m) => m.kind === 'image')
    const audioDuration = list.reduce((sum, m) => sum + (m.kind === 'audio' ? (m.duration_sec || 0) : 0), 0)

    await client
      .from(TABLE)
      .update({
        media_count: mediaCount,
        cover_key: firstImage?.file_key ?? null,
        cover_mime: firstImage?.mime_type ?? null,
        audio_duration: audioDuration > 0 ? audioDuration : null,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('id', memoryId)
  }
}