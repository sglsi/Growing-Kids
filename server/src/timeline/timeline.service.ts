import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { StorageService } from '../storage/storage.service'
import type {
  TimelineItem, TimelineListQuery, CreateTimelineDto, UpdateTimelineDto,
} from './timeline.types'

const TABLE = 'timeline_items'
const SELECT_COLS = '*, subjects:subject_id(id, name, color)'
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

/**
 * 统一收件箱服务（最近题目 / 复习本）
 * ⚠️ service_role 绕过 RLS ⇒ 每个查询都必须 .eq('user_id', userId)
 */
@Injectable()
export class TimelineService {
  constructor(private readonly storageService: StorageService) {}

  /** 给条目补签名 URL（图片 file_key / 题目内 images） */
  async withUrls(items: TimelineItem[]): Promise<TimelineItem[]> {
    return Promise.all(
      items.map(async (it) => {
        const enriched: TimelineItem & { url?: string; thumb_url?: string; image_urls?: string[] } = { ...it }
        if (it.file_key) enriched.url = await this.storageService.getPublicUrl(it.file_key)
        if (it.thumb_key) enriched.thumb_url = await this.storageService.getPublicUrl(it.thumb_key)
        const imgs = it.content?.images
        if (Array.isArray(imgs) && imgs.length) {
          enriched.image_urls = await Promise.all(imgs.map((k) => this.storageService.getPublicUrl(k)))
        }
        return enriched as TimelineItem
      }),
    )
  }

  // ---------- 列表：recent / review，按时间倒序，页大小 20 ----------
  async list(
    userId: string,
    query: TimelineListQuery,
  ): Promise<{ list: TimelineItem[]; total: number; page: number; page_size: number }> {
    const client = getSupabaseClient()
    const page = Math.max(1, query.page || 1)
    const pageSize = Math.min(MAX_PAGE_SIZE, query.page_size || DEFAULT_PAGE_SIZE)
    const from = (page - 1) * pageSize
    const to = from + pageSize - 1

    let q = client
      .from(TABLE)
      .select(SELECT_COLS, { count: 'exact' })
      .eq('user_id', userId)          // 强制用户隔离
      .is('deleted_at', null)         // 软删过滤

    const scope = query.scope || 'recent'
    if (scope === 'review') {
      q = q.eq('in_review_book', true)
    }

    if (query.subject_id) q = q.eq('subject_id', query.subject_id)
    if (query.tag) q = q.contains('tags', [query.tag])
    if (query.keyword) {
      const kw = `%${query.keyword}%`
      // 题目按题干/答案搜；图片按 title 搜（content->>question / title）
      q = q.or(`title.ilike.${kw},content->>question.ilike.${kw},content->>answer.ilike.${kw}`)
    }

    const orderField = scope === 'review' ? 'added_to_review_at' : 'created_at'
    q = q.order(orderField, { ascending: false }).range(from, to)

    const { data, error, count } = await q
    if (error) throw new Error(error.message)

    return {
      list: (data || []) as unknown as TimelineItem[],
      total: count || 0,
      page,
      page_size: pageSize,
    }
  }

  // ---------- 单条 ----------
  async findOne(userId: string, id: string): Promise<TimelineItem> {
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .select(SELECT_COLS)
      .eq('user_id', userId)
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new NotFoundException('内容不存在')
    return data as unknown as TimelineItem
  }

  // ---------- 新增（图片归档 / 题目） ----------
  async create(userId: string, dto: CreateTimelineDto): Promise<TimelineItem> {
    if (dto.kind !== 'image' && dto.kind !== 'question') {
      throw new BadRequestException('kind 仅支持 image / question')
    }
    if (dto.kind === 'image' && !dto.file_key) {
      throw new BadRequestException('图片条目缺少 file_key')
    }
    if (dto.kind === 'question' && !dto.content?.question) {
      throw new BadRequestException('题目条目缺少 content.question')
    }

    const client = getSupabaseClient()
    const payload: Record<string, unknown> = {
      user_id: userId,               // 强制写入，禁止信任前端
      kind: dto.kind,
      subject_id: dto.subject_id ?? null,
      title: dto.title ?? (dto.kind === 'image' ? '图片素材' : (dto.content?.question || '').slice(0, 40)),
      source: dto.source ?? '',
      tags: dto.tags ?? [],
    }
    if (dto.kind === 'image') {
      payload.file_key = dto.file_key
      payload.thumb_key = dto.thumb_key ?? null
      payload.mime_type = dto.mime_type ?? ''
      payload.width = dto.width ?? null
      payload.height = dto.height ?? null
      payload.size_bytes = dto.size_bytes ?? 0
      payload.file_hash = dto.file_hash ?? null
      payload.content = {}
    } else {
      const c = dto.content || {}
      payload.content = {
        question: c.question || '',
        answer: c.answer || '',
        solution: c.solution || '',
        wrong_answer: c.wrong_answer || '',
        images: c.images || [],
        status: c.status || (c.answer ? 'answered' : 'pending'),
      }
    }

    const { data, error } = await client.from(TABLE).insert(payload).select(SELECT_COLS).single()
    if (error) throw new Error(error.message)
    return data as unknown as TimelineItem
  }

  // ---------- 更新 ----------
  /**
   * 更新条目。
   *
   * ⚠️ 根因修复（「更新失败，请重试」）：
   * 之前写成 `.update(payload).select('*, subjects:subject_id(...)').maybeSingle()`。
   * PostgREST 在 **UPDATE + 嵌入关联资源** 时，返回体经常会丢掉嵌入对象，
   * 导致 `.maybeSingle()` 拿不到行（data=null）→ 这里误抛 NotFoundException('内容不存在')，
   * 前端就显示「更新失败，请重试」；而由于写入其实已发生/或部分发生的语义不一致，
   * 用户刷新后看到的又可能是旧值，体验为「改了没生效」。
   *
   * 修复策略：先把更新写下去（**不带** select，只看是否报错、是否命中行），
   * 再用带嵌入的 findOne 单独查一遍返回完整记录。两次都是最朴素、最稳的调用。
   */
  async update(userId: string, id: string, dto: UpdateTimelineDto): Promise<TimelineItem> {
    const client = getSupabaseClient()
    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (dto.title !== undefined) payload.title = dto.title
    if (dto.subject_id !== undefined) payload.subject_id = dto.subject_id
    if (dto.tags !== undefined) payload.tags = dto.tags
    if (dto.content !== undefined) payload.content = dto.content
    if (dto.mastered !== undefined) {
      payload.mastered = dto.mastered
      payload.mastered_at = dto.mastered ? new Date().toISOString() : null
    }

    // 1) 执行更新（只 select id，不带任何嵌入，避免关联解析失败导致 0 行）
    const { data: updated, error } = await client
      .from(TABLE)
      .update(payload)
      .eq('user_id', userId)
      .eq('id', id)
      .select('id')
    if (error) throw new Error(error.message)
    // 更新命中 0 行 = 该 id 不属于当前用户 / 已软删 / 不存在
    if (!updated || updated.length === 0) {
      throw new NotFoundException('内容不存在或无权修改')
    }

    // 2) 单独查询返回完整记录（此时嵌入 subjects 走的是普通 SELECT，稳定返回）
    return this.findOne(userId, id)
  }

  // ---------- 删除（软删） ----------
  async remove(userId: string, id: string): Promise<{ id: string }> {
    await this.removeMany(userId, [id])
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

  // ---------- 按 id 批量取（含签名 URL，供 PDF 合成用） ----------
  async listByIdsWithUrls(userId: string, ids: string[]): Promise<(TimelineItem & { url?: string })[]> {
    if (!ids.length) return []
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .select(SELECT_COLS)
      .eq('user_id', userId)
      .in('id', ids)
      .is('deleted_at', null)
    if (error) throw new Error(error.message)
    const items = (data || []) as unknown as TimelineItem[]
    const enriched = await this.withUrls(items)
    return enriched as (TimelineItem & { url?: string })[]
  }

  // ---------- 加入 / 移出复习本 ----------
  async addToReviewBook(userId: string, ids: string[]): Promise<{ updated: number }> {
    if (!ids.length) return { updated: 0 }
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .update({
        in_review_book: true,
        added_to_review_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .in('id', ids)
      .select('id')
    if (error) throw new Error(error.message)
    return { updated: (data || []).length }
  }

  async removeFromReviewBook(userId: string, ids: string[]): Promise<{ updated: number }> {
    if (!ids.length) return { updated: 0 }
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .update({
        in_review_book: false,
        added_to_review_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .in('id', ids)
      .select('id')
    if (error) throw new Error(error.message)
    return { updated: (data || []).length }
  }

  // ---------- 首页概览 ----------
  async overview(userId: string) {
    const client = getSupabaseClient()
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
    const base = () =>
      client.from(TABLE).select('id', { count: 'exact', head: true })
        .eq('user_id', userId).is('deleted_at', null)

    const [totalRes, weekRes, pendingRes, reviewRes, subjectRowsRes, recentRes] = await Promise.all([
      base(),
      base().gte('created_at', weekAgo),
      base().eq('kind', 'question').eq('content->>status', 'pending'),
      base().eq('in_review_book', true),
      client
        .from(TABLE)
        .select('subject_id, subjects:subject_id(id, name, color)')
        .eq('user_id', userId)
        .is('deleted_at', null),
      client
        .from(TABLE)
        .select(SELECT_COLS)
        .eq('user_id', userId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(6),
    ])

    // 聚合学科统计
    const statsMap: Record<string, { subject_id: string; name: string; color: string; count: number; week_count: number }> = {}
    for (const row of (subjectRowsRes.data || []) as any[]) {
      const sid = row.subject_id || 'none'
      const meta = row.subjects
      if (!statsMap[sid]) {
        statsMap[sid] = {
          subject_id: sid,
          name: meta?.name || '未分类',
          color: meta?.color || 'gray-500',
          count: 0,
          week_count: 0,
        }
      }
      statsMap[sid].count += 1
    }

    return {
      total: totalRes.count || 0,
      week_total: weekRes.count || 0,
      pending: pendingRes.count || 0,
      review_total: reviewRes.count || 0,
      subject_stats: Object.values(statsMap),
      recent: (recentRes.data || []) as unknown as TimelineItem[],
    }
  }
}
