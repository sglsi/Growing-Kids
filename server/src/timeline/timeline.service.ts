import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { mirrorInsert, mirrorUpdate } from '../storage/database/dual-write'
import { findSimilarQuestions } from '../ocr/ocr-similar'
import { buildReviewPlan, advanceReview, firstReviewAt, endOfLocalDay, REVIEW_STAGES, type ReviewResult } from './review'
import { StorageService } from '../storage/storage.service'
import { BlobService } from '../storage/blob.service'
import { IngestService } from '../storage/ingest.service'
import {
  cacheGet, cacheSet, invalidateUserTimeline, stableQuery,
  TL_LIST_PREFIX, TL_ITEM_PREFIX, TL_OV_KEY, TL_REVIEW_SUM_KEY,
} from '../shared/mem-cache'
import type {
  TimelineItem, TimelineListQuery, CreateTimelineDto, UpdateTimelineDto, TimelineItemWithUrl, QuestionContent,
} from './timeline.types'

const TABLE = 'timeline_items'

/**
 * 从对象 key 取出内容哈希段：`blobs/ab/<hash>/display.webp` → `<hash>`。
 * 非 blobs/ 内容寻址路径（如历史 `tmp/...`）返回 ''。
 */
function hashOfKey(key?: string | null): string {
  if (!key) return ''
  const m = /^blobs\/[0-9a-f]{2}\/([^/]+)\//i.exec(key)
  return m ? m[1] : ''
}

/**
 * 缩略图是否与主图同源（同一份内容的 thumb 变体）。
 * 主图 key 与缩略图 key 的哈希段必须一致；任一方取不到哈希时不作判断（视为不一致，回退主图）。
 */
function isThumbConsistent(fileKey?: string | null, thumbKey?: string | null): boolean {
  const fh = hashOfKey(fileKey)
  if (!fh) return false
  return hashOfKey(thumbKey) === fh
}
const SELECT_COLS = '*, subjects:subject_id(id, name, color)'
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100
/**
 * 排程汇总一次最多扫多少条复习本记录。
 * 复习本是用户级小集合（几十到几百条），一次取回后本地分组比多次 count 更快也更一致；
 * Supabase/PostgREST 默认单次上限 1000 行，故取 1000 ——**超出时计数会低估**，
 * 届时应改为「DB 侧 count + 本地 due 判定」的混合方案（届时也不必再怕不一致：
 * 到期判定已收敛到 review.ts 的 endOfLocalDay）。
 */
const SUMMARY_SCAN_LIMIT = 1000

/** overview 返回结构（显式声明，供缓存泛型用） */
export interface OverviewResult {
  total: number
  week_total: number
  pending: number
  review_total: number
  subject_stats: { subject_id: string; name: string; color: string; count: number; week_count: number }[]
  recent: TimelineItem[]
  /** 今日该复习（含逾期）——首页「复习本」卡片上的待办数 */
  review_due: number
}

/** 复习排程汇总（「今日该复习 N 题」入口的数据源） */
export interface ReviewSummary {
  /** 复习本总量 */
  in_book: number
  /** 今天该复习（含逾期） */
  due_today: number
  /** 在复习本但没排程（异常信号：多为历史数据） */
  unscheduled: number
  /** 五档走完 */
  graduated: number
  /** 最近的未来到期时间（没有则为 null） */
  next_due_at: string | null
}

/**
 * 统一收件箱服务（最近题目 / 复习本）
 * ⚠️ service_role 绕过 RLS ⇒ 每个查询都必须 .eq('user_id', userId)
 */
@Injectable()
export class TimelineService {
  private readonly logger = new Logger(TimelineService.name)

  constructor(
    private readonly storageService: StorageService,
    private readonly blobService: BlobService,
    private readonly ingestService: IngestService,
  ) {}

  /**
   * 把「临时对象」固化为常驻资产（思傅 2026-10-22 真机反馈的根因之一）。
   *
   * 背景：`tmp/<hash前2>/<hash>.ext` 是**中间态**对象 —— ref_count=0，24h 后会被
   * maintenance 的孤儿 GC **真删**。若某条 timeline 的 file_key 落在 tmp/ 上，
   * 用户会在一天后发现「图片凭空消失」。老版本前端换图时用 purpose='temp' 上传，
   * 正是这样把 tmp key 写进了 file_key（线上已实测到 2 条）。
   *
   * 兜底策略（**放在服务端，不依赖前端版本**）：写路径上只要看到 tmp/ 前缀，
   * 就重新 ingest 成 `blobs/<hash前2>/<hash>/display.webp` 常驻资产，
   * 并顺带拿到配套缩略图，一次解决「临时对象被回收」+「缩略图过期」两个隐患。
   *
   * @returns 固化后的 { file_key, thumb_key }；非 tmp/ 或固化失败时返回 null（调用方沿用原值，不阻断业务）
   */
  private async promoteTempFileKey(
    key?: string | null,
  ): Promise<{ file_key: string; thumb_key: string } | null> {
    if (!key || !key.startsWith('tmp/')) return null
    try {
      const buf = await this.storageService.readObject(key)
      if (!buf || !buf.length) return null
      const ext = (key.split('.').pop() || '').toLowerCase()
      const mime = ext === 'png' ? 'image/png'
        : (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg'
          : 'image/webp'
      const res = await this.ingestService.ingest(buf, mime)
      if (!res?.key) return null
      this.logger.log(`[timeline] 临时对象已固化：${key} → ${res.key}`)
      return { file_key: res.key, thumb_key: res.thumbKey || res.key }
    } catch (e) {
      this.logger.warn(`[timeline] 临时对象固化失败，沿用原 key: ${key} ${e}`)
      return null
    }
  }

  /** 给条目补签名 URL（图片 file_key / 题目内 images） */
  async withUrls(items: TimelineItem[]): Promise<TimelineItem[]> {
    return Promise.all(
      items.map(async (it) => {
        const enriched: TimelineItemWithUrl = { ...it }
        if (it.file_key) enriched.url = await this.storageService.getPublicUrl(it.file_key)
        // ⭐ 缩略图一致性自愈（思傅 2026-10-22 反馈「列表是老图、详情是新图」）：
        //    对象 key 形如 `blobs/<hash前2位>/<内容哈希>/<variant>.ext`，
        //    主图(display) 与缩略图(thumb) **内嵌同一内容哈希**。历史 bug 换主图时
        //    没同步换 thumb_key ⇒ 两者哈希段不同 ⇒ 缩略图仍指向旧图。
        //    这里按哈希段比对，不一致就丢掉过期缩略图、回退用主图 —— 纯读路径自愈，
        //    不改数据、无需迁移，对所有历史损坏记录**立即生效**。
        if (it.thumb_key && isThumbConsistent(it.file_key, it.thumb_key)) {
          enriched.thumb_url = await this.storageService.getPublicUrl(it.thumb_key)
        } else if (it.file_key) {
          enriched.thumb_url = enriched.url
        }
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
        // 答案附件（图片 / 文档 / 文本）：逐个补签名 URL，前端直接渲染即可
        const atts = it.content?.answer_attachments
        if (Array.isArray(atts) && atts.length) {
          enriched.answer_attachments = await Promise.all(
            atts.map(async (a) => ({
              ...a,
              url: a.file_key ? await this.storageService.getPublicUrl(a.file_key) : undefined,
              thumb_url: a.thumb_key ? await this.storageService.getPublicUrl(a.thumb_key) : undefined,
            })),
          )
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
    // 读缓存 30s（思傅 2026-10-21：后端读缓存，与前端 SWR 双管齐下；后端见 cache-store.ts）；
    // 写操作全部走 invalidateUserTimeline 失效，最坏 30s 旧值。
    const cacheKey = `${TL_LIST_PREFIX}${userId}:${stableQuery(query as Record<string, unknown>)}`
    const cached = await cacheGet<{ list: TimelineItem[]; total: number; page: number; page_size: number }>(cacheKey)
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

    // due=1 时强制走复习语义（前端即便只传 due 不传 scope 也不会查错）
    const scope: 'recent' | 'review' = query.due ? 'review' : (query.scope || 'recent')
    if (scope === 'review') {
      q = q.eq('in_review_book', true)
    }
    if (query.due) {
      // 到期 = next_review_at 落在今天或更早。
      // 上界取**本地日末**而非 now：排程是日历语义，晚上才到期的题在当天上午也该算
      // 「今天该复习」，否则家长早上打开看不到任何待办，会以为功能没生效。
      q = q.lte('next_review_at', endOfLocalDay().toISOString())
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

    // 排序：
    //   复习本默认按「到期先后」——按加入时间倒序等于「谁最近进本谁排前」，
    //   与「该复习谁」毫无关系，天然形成块状 + 集中，与间隔/交错都相反（SRS-20 C5）。
    //   ASC 在 Postgres 里 NULL 自然垫底（已毕业/未排程排最后），正是想要的顺序。
    if (scope === 'review' && query.sort !== 'added') {
      q = q
        .order('next_review_at', { ascending: true })
        .order('added_to_review_at', { ascending: false })
    } else {
      const orderField = scope === 'review' ? 'added_to_review_at' : 'created_at'
      q = q.order(orderField, { ascending: false })
    }
    q = q.range(from, to)

    const { data, error, count } = await q
    if (error) throw new Error(error.message)

    const result = {
      list: (data || []) as unknown as TimelineItem[],
      total: count || 0,
      page,
      page_size: pageSize,
    }
    await cacheSet(cacheKey, result)
    return result
  }

  // ---------- 单条 ----------
  async findOne(userId: string, id: string): Promise<TimelineItem> {
    // 读缓存 30s（详情页重复进入/编辑后回显都不再打 Supabase）
    const cacheKey = `${TL_ITEM_PREFIX}${userId}:${id}`
    const cached = await cacheGet<TimelineItem>(cacheKey)
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
    await cacheSet(cacheKey, item)
    return item
  }

  // ---------- 新增（图片归档 / 题目） ----------
  /**
   * #121：按内容指纹查该用户**已存在**的条目（同文件去重）。
   *
   * 物理层早已去重（blob_objects 引用计数），但业务条目此前照建不误 ——
   * 同一份文件反复上传时，用户在列表里看到的是「同一张图好几行」。
   * 这里给出「是否已经存过这份内容」的判据，由上传入口决定是复用还是新建。
   *
   * @param includeDeleted true = 连回收站条目也一并返回（调用方可据此"恢复"而非新建）
   */
  async findByHash(
    userId: string,
    fileHash: string,
  ): Promise<{ item: TimelineItem; inTrash: boolean } | null> {
    if (!fileHash) return null
    const client = getSupabaseClient()
    // SELECT_COLS 含 '*' ⇒ deleted_at 已在结果里，无需额外指定
    const { data, error } = await client
      .from(TABLE)
      .select(SELECT_COLS)
      .eq('user_id', userId)
      .eq('file_hash', fileHash)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) {
      // best-effort：查重失败不能阻断上传 —— 退化为「当作没存过」，照常新建
      console.error('[timeline] 按指纹查重失败（按未存过处理）:', fileHash.slice(0, 12), error.message)
      return null
    }
    if (!data) return null
    // TimelineItem 类型未声明 deleted_at（对外不暴露），这里局部断言读取即可
    const raw = data as unknown as { deleted_at?: string | null }
    return { item: data as unknown as TimelineItem, inTrash: !!raw.deleted_at }
  }

  /**
   * #121：把回收站里的条目收回列表（deleted_at → null）。
   *
   * 同文件重复上传时，若命中「已存在但被软删」的条目，正确动作是恢复它
   * ——再建一条会让用户看到两份同样内容，且旧那份还在回收站里越积越多。
   */
  async restore(userId: string, id: string): Promise<TimelineItem | null> {
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .update({ deleted_at: null, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId) // ⚠️ RLS 全注释 ⇒ 必须显式带 user_id，防越权恢复他人条目
      .select(SELECT_COLS)
      .maybeSingle()
    if (error) {
      console.error('[timeline] 恢复失败:', id, error.message)
      return null
    }
    return (data as unknown as TimelineItem) || null
  }

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
    const payload = await this.buildPayload(userId, dto)

    const { data, error } = await client.from(TABLE).insert(payload).select(SELECT_COLS).single()
    if (error) throw new Error(error.message)
    // 迁移双写：DB_PROVIDER=dual 时把同一行镜像到腾讯云 PG（best-effort，失败不影响主库）
    await mirrorInsert(TABLE, payload)
    // 新建条目 ⇒ 列表/概览缓存失效（详情缓存按 id 失效，防旧详情残留）
    await invalidateUserTimeline(userId)
    return data as unknown as TimelineItem
  }

  /** 组装单条插入 payload（create 与 createBatch 共用）；async：含 tmp/ 临时对象固化 */
  private async buildPayload(userId: string, dto: CreateTimelineDto): Promise<Record<string, unknown>> {
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
      // tmp/ 临时对象兜底固化（详见 promoteTempFileKey 注释）
      const promoted = await this.promoteTempFileKey(dto.file_key)
      const fileKey = promoted?.file_key || dto.file_key
      payload.file_key = fileKey
      // 缩略图必须与主图**同源**（内容哈希一致），否则宁可留空 —— 读路径会回退用主图，
      // 绝不让列表渲染出指向旧内容的过期缩略图。
      payload.thumb_key = (dto.thumb_key && isThumbConsistent(fileKey, dto.thumb_key))
        ? dto.thumb_key
        : (promoted?.thumb_key || null)
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
        // 答案（思傅 2026-10-21）：附件 / 来源 / 参考链接与题目同记录存储
        answer_attachments: Array.isArray(c.answer_attachments) ? c.answer_attachments : [],
        answer_source: c.answer_source ?? null,
        answer_refs: Array.isArray(c.answer_refs) ? c.answer_refs : [],
        answer_searched_at: c.answer_searched_at ?? null,
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
    const payloads: Record<string, unknown>[] = []
    for (const dto of dtos) {
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
      payloads.push(await this.buildPayload(userId, dto))
    }
    const { data, error } = await client.from(TABLE).insert(payloads).select(SELECT_COLS)
    if (error) throw new Error(error.message)
    // 迁移双写：DB_PROVIDER=dual 时把这批行镜像到腾讯云 PG（best-effort，失败不影响主库）
    await mirrorInsert(TABLE, payloads)
    // 批量入库（错题提取保存）⇒ 失效列表/概览缓存
    await invalidateUserTimeline(userId)
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
    //
    // ⚠️ thumb_key 与 file_key 是**两个独立存储位置**（列表渲染 thumb_url || url）。
    //    调用方只换 file_key 不换 thumb_key ⇒ 列表仍显示旧缩略图
    //    （思傅 2026-10-21 反馈「改了图列表还是旧图」的真因，非缓存）。
    //    防御：换 file_key 而未显式给 thumb_key 时，默认让缩略图跟随主图，
    //    保证任何调用方都不会留下过期缩略图。
    if (dto.file_key !== undefined) {
      // tmp/ 临时对象兜底固化（详见 promoteTempFileKey 注释）：老前端换图用 purpose='temp'
      // 上传，会把 24h 后即被回收的 key 写进 file_key，这里在服务端一律转成常驻资产。
      const promoted = await this.promoteTempFileKey(dto.file_key)
      const fileKey = promoted?.file_key || dto.file_key
      payload.file_key = fileKey
      // 缩略图优先级：与主图同源的显式值 > 固化产出的配套缩略图 > 跟随主图。
      // ⚠️ 与主图内容哈希不一致的 thumb_key 一律丢弃 —— 那必然是过期的旧缩略图。
      payload.thumb_key = (dto.thumb_key && isThumbConsistent(fileKey, dto.thumb_key))
        ? dto.thumb_key
        : (promoted?.thumb_key || fileKey)
    } else if (dto.thumb_key) {
      // 只换缩略图、不动主图（少见但合法）：显式值说了算
      payload.thumb_key = dto.thumb_key
    }
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
    await invalidateUserTimeline(userId)
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
    await invalidateUserTimeline(userId)
    return { removed: (data || []).length }
  }

  // ---------- 按 id 批量取（含签名 URL，供 PDF 合成用） ----------
  // ⚠️ 返回 TimelineItemWithUrl（而非 TimelineItem & { url }）：合成链路要读
  //    question_image_urls（#119 复习本选题合成 = 题目条目的题面图逐张入列）。
  async listByIdsWithUrls(userId: string, ids: string[]): Promise<TimelineItemWithUrl[]> {
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
    return enriched as TimelineItemWithUrl[]
  }

  // ---------- 加入 / 移出复习本 ----------
  async addToReviewBook(userId: string, ids: string[]): Promise<{ updated: number; scheduled: number }> {
    if (!ids.length) return { updated: 0, scheduled: 0 }
    const client = getSupabaseClient()
    const now = new Date().toISOString()
    const { data, error } = await client
      .from(TABLE)
      .update({
        in_review_book: true,
        added_to_review_at: now,
        updated_at: now,
      })
      .eq('user_id', userId)
      .in('id', ids)
      .select('id')
    if (error) throw new Error(error.message)

    // 给「还没排程」的条目排上第一档（1 天后到期）。
    // ⚠️ 只补空、不改已有排程：重复点「加入复习本」不应把正在等的条目重置回第 1 档，
    //    否则反复勾选就能把间隔永久锁死在最短档位。
    // ⚠️ 已毕业（review_count = 5）的不再排程：它们已经走完五档。
    const { data: scheduled } = await client
      .from(TABLE)
      .update({ next_review_at: firstReviewAt(), updated_at: now })
      .eq('user_id', userId)
      .in('id', ids)
      .is('next_review_at', null)
      .lt('review_count', REVIEW_STAGES)
      .select('id')

    // 复习本归属变化 ⇒ review 列表 / 概览 / 排程汇总缓存失效
    await invalidateUserTimeline(userId)
    return { updated: (data || []).length, scheduled: (scheduled || []).length }
  }

  async removeFromReviewBook(userId: string, ids: string[]): Promise<{ updated: number }> {
    if (!ids.length) return { updated: 0 }
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .update({
        in_review_book: false,
        added_to_review_at: null,
        // 移出即取消排程，否则会继续占用「今日该复习」的待办位
        // （review_count / review_lapses 保留：再次加入时从原档位继续，不白费之前的复习）
        next_review_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .in('id', ids)
      .select('id')
    if (error) throw new Error(error.message)
    // 复习本归属变化 ⇒ review 列表 / 概览 / 排程汇总缓存失效
    await invalidateUserTimeline(userId)
    return { updated: (data || []).length }
  }

  // ---------- P2-17 相似题推荐（基于用户自建错题历史） ----------
  async findSimilar(userId: string, id: string, limit = 5) {
    return findSimilarQuestions(userId, id, limit)
  }

  // ---------- C4 复习排程：记录一次复习 ----------
  /**
   * 记录一次复习结果，推进或回退排程（推导见 ./review.ts 的 advanceReview）。
   *
   * 为什么必须区分对错：
   *   旧实现只有一个「今天复习了 ✓」按钮，做对做错一个样 ⇒ review_count 单调递增，
   *   五档走完就「毕业」，与是否真的记住毫无关系。而分散练习的收益前提是**成功提取**
   *   （Roediger & Karpicke 2006），答错说明这次提取失败，间隔必须回到最短档位。
   *
   * @param result 'correct' 做对（推进一档）/ 'wrong' 做错（归零，明天再来）
   */
  async review(userId: string, id: string, result: ReviewResult = 'correct') {
    const item = await this.findOne(userId, id)
    const adv = advanceReview(item, result)
    const client = getSupabaseClient()
    const now = new Date().toISOString()

    const { data, error } = await client
      .from(TABLE)
      .update({
        review_count: adv.review_count,
        review_lapses: adv.review_lapses,
        last_reviewed_at: adv.last_reviewed_at,
        next_review_at: adv.next_review_at,
        // 未入本的题被直接复习时自动入本（否则排程无处生根：不在本里就不参与待办）
        in_review_book: true,
        added_to_review_at: item.added_to_review_at || now,
        updated_at: now,
      })
      .eq('user_id', userId)   // 隔离红线：不带上就是越权改别人数据
      .eq('id', id)
      .is('deleted_at', null)
      .select('id')
    if (error) throw new Error(error.message)
    if (!data || !data.length) throw new NotFoundException('题目不存在')

    await invalidateUserTimeline(userId)
    const merged = { ...item, ...adv, in_review_book: true, added_to_review_at: item.added_to_review_at || now }
    return {
      review_count: adv.review_count,
      review_lapses: adv.review_lapses,
      last_reviewed_at: adv.last_reviewed_at,
      next_review_at: adv.next_review_at,
      plan: buildReviewPlan(merged),
    }
  }

  /**
   * 复习排程汇总：给「今日该复习 N 题」这个入口供数。
   *
   * 三个数字分别对应三种真实处境，不能只给一个 due：
   *   due_today   —— 今天该做（含逾期）；这是唯一需要推动用户行动的数字
   *   unscheduled —— 在复习本但没排程；通常意味着历史数据或代码漏排，属异常信号
   *   graduated   —— 五档走完；用来向家长证明「这些已经掌握」，不是失败
   *
   * ⚠️ 实现上刻意只发**一次查询**、计数在本地算：
   *   早先版本用 5 个 `count:'exact', head:true` 并行查（in_book / due / 未排程 / 毕业 / 最近到期）。
   *   两个问题——① 5 次跨境往返任一卡住就整体超时（实测出现过 >60s）；
   *   ② 5 个独立查询不是同一快照，due_today 可能与 due 列表条数对不上，
   *   用户会看到「今天该复习 3 题」点进去只有 2 条。
   *   复习本是**用户级小集合**（几十到几百条），一次取回全部再在内存里分组既更快也更一致。
   */
  async reviewSummary(userId: string) {
    const cacheKey = `${TL_REVIEW_SUM_KEY}${userId}`
    const cached = await cacheGet<ReviewSummary>(cacheKey)
    if (cached) return cached

    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .select('next_review_at, review_count')
      .eq('user_id', userId)     // 隔离红线
      .is('deleted_at', null)
      .eq('in_review_book', true)
      .limit(SUMMARY_SCAN_LIMIT)
    if (error) throw new Error(error.message)

    const rows = (data || []) as { next_review_at: string | null; review_count: number | null }[]
    const now = new Date()
    // 与 buildReviewPlan 的判定同源（本地日界）：跨端比较一律走时间戳，
    // 不要拿 ISO 字符串比较 —— Postgres 回的是 "+00:00"，JS 生成的是 "Z"。
    const endTodayMs = endOfLocalDay(now).getTime()

    let dueToday = 0
    let unscheduled = 0
    let graduated = 0
    let nextDueMs: number | null = null
    let nextDueAt: string | null = null

    for (const row of rows) {
      const nra = row.next_review_at
      const count = Number(row.review_count) || 0
      if (!nra) {
        if (count >= REVIEW_STAGES) graduated++
        else unscheduled++
        continue
      }
      const ms = new Date(nra).getTime()
      if (Number.isNaN(ms)) { unscheduled++; continue }
      if (ms <= endTodayMs) {
        dueToday++
      } else if (nextDueMs === null || ms < nextDueMs) {
        nextDueMs = ms
        nextDueAt = nra
      }
    }

    const result: ReviewSummary = {
      in_book: rows.length,
      due_today: dueToday,
      unscheduled,
      graduated,
      next_due_at: nextDueAt,
    }
    await cacheSet(cacheKey, result)
    return result
  }

  // ---------- 首页概览 ----------
  async overview(userId: string): Promise<OverviewResult> {
    // 读缓存 30s（首页每次进入都打 6 个并行查询，是重复请求大户）
    const cacheKey = `${TL_OV_KEY}${userId}`
    const cached = await cacheGet<OverviewResult>(cacheKey)
    if (cached) return cached

    const client = getSupabaseClient()
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
    const base = () =>
      client.from(TABLE).select('id', { count: 'exact', head: true })
        .eq('user_id', userId).is('deleted_at', null)

    const [totalRes, weekRes, pendingRes, reviewRes, dueRes, subjectRowsRes, recentRes] = await Promise.all([
      base(),
      base().gte('created_at', weekAgo),
      base().eq('kind', 'question').eq('content->>status', 'pending'),
      base().eq('in_review_book', true),
      // 今日该复习（含逾期）：首页「复习本」卡片靠它显示待办角标
      base().eq('in_review_book', true).lte('next_review_at', endOfLocalDay().toISOString()),
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
      review_due: dueRes.count || 0,
      subject_stats: Object.values(statsMap),
      recent: (recentRes.data || []) as unknown as TimelineItem[],
    }
    await cacheSet(cacheKey, result)
    return result
  }
}
