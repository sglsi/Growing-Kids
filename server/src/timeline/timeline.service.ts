import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { mirrorInsert, mirrorUpdate } from '../storage/database/dual-write'
import { findSimilarQuestions } from '../ocr/ocr-similar'
import { buildReviewPlan, nextReviewCount } from './review'
import { StorageService } from '../storage/storage.service'
import { BlobService } from '../storage/blob.service'
import {
  memGet, memSet, invalidateUserTimeline, stableQuery,
  TL_LIST_PREFIX, TL_ITEM_PREFIX, TL_OV_KEY,
} from '../shared/mem-cache'
import type {
  TimelineItem, TimelineListQuery, CreateTimelineDto, UpdateTimelineDto, TimelineItemWithUrl, QuestionContent,
} from './timeline.types'

const TABLE = 'timeline_items'
const SELECT_COLS = '*, subjects:subject_id(id, name, color)'
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

/** overview 返回结构（显式声明，供 mem-cache 泛型用） */
export interface OverviewResult {
  total: number
  week_total: number
  pending: number
  review_total: number
  subject_stats: { subject_id: string; name: string; color: string; count: number; week_count: number }[]
  recent: TimelineItem[]
}

/**
 * 统一收件箱服务（最近题目 / 复习本）
 * ⚠️ service_role 绕过 RLS ⇒ 每个查询都必须 .eq('user_id', userId)
 */
@Injectable()
export class TimelineService {
  constructor(
    private readonly storageService: StorageService,
    private readonly blobService: BlobService,
  ) {}

  /** 给条目补签名 URL（图片 file_key / 题目内 images） */
  async withUrls(items: TimelineItem[]): Promise<TimelineItem[]> {
    return Promise.all(
      items.map(async (it) => {
        const enriched: TimelineItemWithUrl = { ...it }
        if (it.file_key) enriched.url = await this.storageService.getPublicUrl(it.file_key)
        if (it.thumb_key) enriched.thumb_url = await this.storageService.getPublicUrl(it.thumb_key)
        const imgs = it.content?.images
        if (Array.isArray(imgs) && imgs.length) {
          enriched.image_urls = await Promise.all(imgs.map((k) => this.storageService.getPublicUrl(k)))
        }
        const qImgs = it.content?.question_images
        if (Array.isArray(qImgs) && qImgs.length) {
          enriched.question_image_urls = await Promise.all(qImgs.map((k) => this.storageService.getPublicUrl(k)))
        }
        const aImgs = it.content?.answer_images
        if (Array.isArray(aImgs) && aImgs.length) {
          enriched.answer_image_urls = await Promise.all(aImgs.map((k) => this.storageService.getPublicUrl(k)))
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
    // 内存缓存 30s（思傅 2026-10-21：后端读缓存，与前端 SWR 双管齐下）；
    // 写操作全部走 invalidateUserTimeline 失效，最坏 30s 旧值。
    const cacheKey = `${TL_LIST_PREFIX}${userId}:${stableQuery(query as Record<string, unknown>)}`
    const cached = memGet<{ list: TimelineItem[]; total: number; page: number; page_size: number }>(cacheKey)
    if (cached) return cached

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

    // ⚠️ 哨兵值（思傅 2026-10-21「点未分类筛不出题」）：
    //   overview 的 subject_stats 把「无学科」的题目汇总为 subject_id='none'
    //   （真实值是 NULL）。列表若直接 .eq('subject_id','none') 必然查 0 条
    //   ⇒ 首页点「未分类」显示空列表。「语数英正常」正是因为它们是真实 id。
    //   'none'（以及前端可能传的 'null'/'uncategorized'）一律按 IS NULL 过滤。
    if (query.subject_id) {
      const sid = String(query.subject_id)
      if (sid === 'none' || sid === 'null' || sid === 'uncategorized') {
        q = q.is('subject_id', null)
      } else {
        q = q.eq('subject_id', sid)
      }
    }
    if (query.tag) q = q.contains('tags', [query.tag])
    if (query.keyword) {
      const kw = `%${query.keyword}%`
      // 题目按题干/答案/题号标签搜；图片按 title 搜（content->>question / content->>question_label / title）
      q = q.or(`title.ilike.${kw},content->>question.ilike.${kw},content->>answer.ilike.${kw},content->>question_label.ilike.${kw}`)
    }
    if (query.since) {
      if (scope === 'review') {
        // review 模式按加入复习本的时间过滤。
        // 兼容历史数据：早期加入复习本的记录 added_to_review_at 可能为 NULL，
        // 直接 gte 会因 NULL 比较为假而被整条排除（表现为"筛选后列表变空"），
        // 故对空值回退到 created_at 参与过滤。
        q = q.or(
          `added_to_review_at.gte.${query.since},and(added_to_review_at.is.null,created_at.gte.${query.since})`,
        )
      } else {
        q = q.gte('created_at', query.since)
      }
    }

    const orderField = scope === 'review' ? 'added_to_review_at' : 'created_at'
    q = q.order(orderField, { ascending: false }).range(from, to)

    const { data, error, count } = await q
    if (error) throw new Error(error.message)

    const result = {
      list: (data || []) as unknown as TimelineItem[],
      total: count || 0,
      page,
      page_size: pageSize,
    }
    memSet(cacheKey, result)
    return result
  }

  // ---------- 单条 ----------
  async findOne(userId: string, id: string): Promise<TimelineItem> {
    // 内存缓存 30s（详情页重复进入/编辑后回显都不再打 Supabase）
    const cacheKey = `${TL_ITEM_PREFIX}${userId}:${id}`
    const cached = memGet<TimelineItem>(cacheKey)
    if (cached) return cached

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
    const item = data as unknown as TimelineItem
    memSet(cacheKey, item)
    return item
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
    const payload = this.buildPayload(userId, dto)

    const { data, error } = await client.from(TABLE).insert(payload).select(SELECT_COLS).single()
    if (error) throw new Error(error.message)
    // 迁移双写：DB_PROVIDER=dual 时把同一行镜像到腾讯云 PG（best-effort，失败不影响主库）
    await mirrorInsert(TABLE, payload)
    // 新建条目 ⇒ 列表/概览缓存失效（详情缓存按 id 失效，防旧详情残留）
    invalidateUserTimeline(userId)
    return data as unknown as TimelineItem
  }

  /** 组装单条插入 payload（create 与 createBatch 共用） */
  private buildPayload(userId: string, dto: CreateTimelineDto): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      user_id: userId,               // 强制写入，禁止信任前端
      kind: dto.kind,
      subject_id: dto.subject_id ?? null,
      // ⚠️ 允许「只有图、没文字」的题目（思傅 2026-10-21：裁剪后不识别，只把图存入错题库）——
      //    此时题干为空，title 兜底为「图片题目」，否则列表里是一条空白标题。
      title: dto.title ?? (dto.kind === 'image'
        ? '图片素材'
        : ((dto.content?.question || '').slice(0, 40)
          || (((dto.content?.question_images || []).length || (dto.content?.answer_images || []).length) ? '图片题目' : ''))),
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
        // 题面图 / 答题卡图区分存储（避免混在 images[] 里分不清哪张是答案）
        question_images: c.question_images || [],
        answer_images: c.answer_images || [],
        level: typeof c.level === 'number' ? c.level : null,
        parent_index: c.parent_index ?? null,
        stem: c.stem || '',
        // P2-16 / P2-18：错因分析结论与艾宾浩斯复习阶段计数（jsonb 免迁移，直接存）
        error_analysis: c.error_analysis ?? null,
        review_count: typeof c.review_count === 'number' ? c.review_count : 0,
        // P3：规范题号标签（错题库唯一指认「节·小类 题号」）
        question_label: c.question_label ?? null,
      }
    }
    return payload
  }

  /**
   * 批量创建：一次提取多道题时替代「循环单条 create」，一次 insert 落库，减少往返。
   * 每条复用 buildPayload；逐条轻量校验，避免脏数据进库。
   */
  async createBatch(userId: string, dtos: CreateTimelineDto[]): Promise<TimelineItem[]> {
    if (!Array.isArray(dtos) || !dtos.length) return []
    const client = getSupabaseClient()
    const payloads = dtos.map((dto) => {
      if (dto.kind !== 'image' && dto.kind !== 'question') {
        throw new BadRequestException('kind 仅支持 image / question')
      }
      if (dto.kind === 'image' && !dto.file_key) {
        throw new BadRequestException('图片条目缺少 file_key')
      }
      // ⚠️ 判据放宽为「有题干 **或** 有题面图/答案图」（思傅 2026-10-21）：
      //    错题提取允许「只裁剪、不识别」，这类条目只有图没有文字。
      //    若仍要求必须有 question，批量插入会整批 400 失败（表现：点了保存什么都没进库）。
      if (dto.kind === 'question') {
        const c2 = dto.content || {}
        const hasAny = !!c2.question
          || !!((c2.question_images || []).length)
          || !!((c2.answer_images || []).length)
          || !!((c2.images || []).length)
        if (!hasAny) throw new BadRequestException('题目条目缺少 content.question 或题面图')
      }
      return this.buildPayload(userId, dto)
    })
    const { data, error } = await client.from(TABLE).insert(payloads).select(SELECT_COLS)
    if (error) throw new Error(error.message)
    // 迁移双写：DB_PROVIDER=dual 时把这批行镜像到腾讯云 PG（best-effort，失败不影响主库）
    await mirrorInsert(TABLE, payloads)
    // 批量入库（错题提取保存）⇒ 失效列表/概览缓存
    invalidateUserTimeline(userId)
    return (data || []) as unknown as TimelineItem[]
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
    // 内容局部更新合并（P3 链路复核发现的数据丢失）：content 为局部 patch 时
    // 先读现价再合并——详情页等调用方只传题干/答案/解答/状态，全量替换会把
    // question_images/question_label/level/stem/error_analysis/review_count 清空。
    // 显式传值（含空串/null）照常覆盖；未传的字段保留原值。
    let mergedContent: QuestionContent | undefined
    if (dto.content !== undefined) {
      const { data: cur } = await client
        .from(TABLE)
        .select('content')
        .eq('user_id', userId)
        .eq('id', id)
        .maybeSingle()
      const curContent = (cur as { content?: QuestionContent } | null)?.content ?? {}
      mergedContent = { ...curContent, ...dto.content }
    }
    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (dto.title !== undefined) payload.title = dto.title
    if (dto.subject_id !== undefined) payload.subject_id = dto.subject_id
    if (dto.tags !== undefined) payload.tags = dto.tags
    if (mergedContent !== undefined) payload.content = mergedContent
    // 图片字段（kind=image 的「原位替换」）：
    // ⚠️ 必须支持原位替换（前端编辑已入库图片时直接 PUT file_key/thumb_key）。
    // 旧方案「新建条目+软删旧条目」会让新条目插到列表最前、旧条目软删失败时残留，
    // 造成「编辑 A 后编辑 B，打开的却是 A 的图」的错位（列表顺序每次编辑都在变）。
    if (dto.file_key !== undefined) payload.file_key = dto.file_key
    if (dto.thumb_key !== undefined) payload.thumb_key = dto.thumb_key
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
    // 迁移双写：DB_PROVIDER=dual 时把同一行变更镜像到腾讯云 PG（best-effort，失败不影响主库）
    await mirrorUpdate(TABLE, payload, { user_id: userId, id })

    // 2) 单独查询返回完整记录（此时嵌入 subjects 走的是普通 SELECT，稳定返回）
    // 先失效再查：findOne 会把最新数据写回缓存，杜绝「更新后读到旧缓存」
    invalidateUserTimeline(userId)
    return this.findOne(userId, id)
  }

  // ---------- 删除（软删） ----------
  async remove(userId: string, id: string): Promise<{ id: string }> {
    await this.removeMany(userId, [id])
    return { id }
  }

  /**
   * 批量软删。
   *
   * ⚠️ 存储优化要点（复习本与项目设计.md §11.3 策略 4/5）：
   * 软删时**释放 blob 引用计数**。顺序很重要：
   *   1) 先查出待删行的 file_hash（必须在置 deleted_at **之前**查，否则可能查不到）；
   *   2) 再做软删；
   *   3) 最后释放引用 —— 归零的 blob 才进待回收队列（由 maintenance 真删文件）。
   * `deleted_at is null` 的过滤保证**同一条目重复删除只释放一次**，防止计数被多减。
   */
  async removeMany(userId: string, ids: string[]): Promise<{ removed: number }> {
    if (!ids.length) return { removed: 0 }
    const client = getSupabaseClient()

    // 1) 先取待删条目的内容 hash（此时还未置 deleted_at）
    const { data: pending } = await client
      .from(TABLE)
      .select('id, file_hash')
      .eq('user_id', userId)
      .in('id', ids)
      .is('deleted_at', null)

    const hashes = Array.from(
      new Set(((pending || []) as { file_hash: string | null }[]).map((r) => r.file_hash).filter(Boolean) as string[]),
    )

    // 2) 软删（带 deleted_at is null 过滤 ⇒ 幂等，重复删不会二次释放）
    const { data, error } = await client
      .from(TABLE)
      .update({ deleted_at: new Date().toISOString() })
      .eq('user_id', userId)
      .in('id', ids)
      .is('deleted_at', null)
      .select('id')
    if (error) throw new Error(error.message)

    // 3) 释放引用（失败不阻断删除；孤儿由 GC 核对兜底）
    for (const h of hashes) {
      await this.blobService.release(h).catch((e) =>
        console.warn('[timeline] 释放 blob 引用失败', h, e),
      )
    }

    // 软删 ⇒ 列表/详情/概览缓存全部失效
    invalidateUserTimeline(userId)
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
    // 复习本归属变化 ⇒ review 列表与概览缓存失效
    invalidateUserTimeline(userId)
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
    // 复习本归属变化 ⇒ review 列表与概览缓存失效
    invalidateUserTimeline(userId)
    return { updated: (data || []).length }
  }

  // ---------- P2-17 相似题推荐（基于用户自建错题历史） ----------
  async findSimilar(userId: string, id: string, limit = 5) {
    return findSimilarQuestions(userId, id, limit)
  }

  // ---------- P2-18 艾宾浩斯复习：标记完成一次复习 ----------
  /**
   * 把指定题的复习计数 +1（封顶 total 阶段数），返回更新后的计数与现算的复习计划。
   * 复习计划由 created_at + review_count 现算（见 ./review.ts），不冗余存储。
   */
  async markReviewed(userId: string, id: string): Promise<{ review_count: number; plan: ReturnType<typeof buildReviewPlan> }> {
    const item = await this.findOne(userId, id)
    const cur = typeof item.content?.review_count === 'number' ? item.content.review_count : 0
    const next = nextReviewCount(cur)
    const merged = { ...(item.content || {}), review_count: next }
    const updated = await this.update(userId, id, { content: merged })
    return { review_count: next, plan: buildReviewPlan(updated.created_at, next) }
  }

  // ---------- 首页概览 ----------
  async overview(userId: string): Promise<OverviewResult> {
    // 内存缓存 30s（首页每次进入都打 6 个并行查询，是重复请求大户）
    const cacheKey = `${TL_OV_KEY}${userId}`
    const cached = memGet<OverviewResult>(cacheKey)
    if (cached) return cached

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

    const result = {
      total: totalRes.count || 0,
      week_total: weekRes.count || 0,
      pending: pendingRes.count || 0,
      review_total: reviewRes.count || 0,
      subject_stats: Object.values(statsMap),
      recent: (recentRes.data || []) as unknown as TimelineItem[],
    }
    memSet(cacheKey, result)
    return result
  }
}
