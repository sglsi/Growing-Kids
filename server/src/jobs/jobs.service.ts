import { randomUUID } from 'crypto'
import { createHash } from 'crypto'
import {
  Injectable, Logger, OnModuleInit,
  BadRequestException, NotFoundException, HttpException, HttpStatus,
} from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { ImageService } from '../image/image.service'
import { OcrService } from '../ocr/ocr.service'
import { AnswerSearchService } from '../answer-search/answer-search.service'
import { SearchService } from '../search/search.service'
import {
  JOB_STAGE, JOB_TTL_MS,
  type JobRow, type JobStatus, type JobType, type JobView,
  type OcrPageJobParams, type DocRecognizeJobParams, type AnswerSearchJobParams, type SearchSolveJobParams,
} from './jobs.types'

const TABLE = 'async_jobs'
const SELECT_COLS = 'id,user_id,type,status,dedupe_key,params,result,error,stage,attempts,created_at,updated_at,started_at,finished_at,expires_at'

/**
 * 全局并发闸门：精准 OCR 是 CPU 密集、搜答案要花钱。
 * 没有闸门时用户连点几下就会把机器拖死，表现为「全部超时」——
 * 而用户只会觉得「这功能坏了」，不会想到是自己点了五次。
 */
const MAX_RUNNING_TOTAL = 3
/** 单用户并发：防止一人占满全局闸门 */
const MAX_RUNNING_PER_USER = 2

const JOB_TYPES: ReadonlyArray<JobType> = ['ocr-page', 'doc-recognize', 'answer-search', 'search-solve']

/**
 * 异步任务服务
 *
 * ⚠️ service_role 绕过 RLS ⇒ 每个查询都必须 .eq('user_id', userId)
 * ⚠️ 任务只在**本进程内存**中执行；进程重启 ⇒ 未完成任务失效（启动时统一标记 failed）
 */
@Injectable()
export class JobsService implements OnModuleInit {
  private readonly logger = new Logger(JobsService.name)
  /** 内存中正在执行的任务：user_id → Set<job_id> */
  private readonly runningByUser = new Map<string, Set<string>>()
  private runningTotal = 0

  constructor(
    private readonly imageService: ImageService,
    private readonly ocrService: OcrService,
    private readonly answerSearchService: AnswerSearchService,
    private readonly searchService: SearchService,
  ) {}

  // ------------------------------------------------------------------
  // 启动回收：本进程不认识任何 pending/running（内存是空的）
  // ------------------------------------------------------------------
  /**
   * 启动回收：本进程不认识任何 pending/running（内存是空的）
   *
   * ⚠️ 这是**全局运维操作**，故意不按 user_id 过滤：进程重启后所有未完成任务都已失效，
   *    按用户过滤只会漏掉别人的僵尸任务（它们会永远停在 running，客户端轮询到超时）。
   *    本操作只写 status/error，**不读取也不返回任何用户数据**。
   */
  async onModuleInit() {
    try {
      const client = getSupabaseClient()
      // check-isolation-ignore: 全局运维操作，理由见方法头注释
      const { data, error } = await client
        .from(TABLE)
        .update({
          status: 'failed' as JobStatus,
          error: '服务已重启，任务中断，请重新发起',
          stage: null,
          finished_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .in('status', ['pending', 'running'])
        .select('id')
      if (error) {
        this.logger.warn(`[jobs] 启动回收失败: ${error.message}`)
        return
      }
      if (data?.length) this.logger.log(`[jobs] 启动回收 ${data.length} 个未完成任务（进程重启）`)
    } catch (e) {
      // 回收失败不能阻塞启动——表不存在（迁移未跑）时最常见
      this.logger.warn(`[jobs] 启动回收异常（可忽略，通常是表尚未创建）: ${e}`)
    }
  }

  // ------------------------------------------------------------------
  // 提交
  // ------------------------------------------------------------------
  async submit(
    userId: string,
    type: JobType,
    params: Record<string, unknown>,
    forwardHeaders: Record<string, string>,
  ): Promise<{ id: string; status: JobStatus; stage: string; deduped: boolean }> {
    if (!JOB_TYPES.includes(type)) throw new BadRequestException(`不支持的任务类型：${String(type)}`)

    const client = getSupabaseClient()
    const dedupeKey = this.dedupeKeyOf(userId, type, params)

    // ① 幂等：同参数已有在跑的 ⇒ 复用（精准 OCR 重跑既浪费算力又拖慢彼此）
    if (dedupeKey) {
      const { data: dup } = await client
        .from(TABLE)
        .select('id,status,stage')
        .eq('user_id', userId)
        .eq('dedupe_key', dedupeKey)
        .in('status', ['pending', 'running'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (dup?.id) {
        return { id: dup.id, status: dup.status as JobStatus, stage: dup.stage ?? '', deduped: true }
      }
    }

    // ② 并发闸门
    const userRunning = this.runningByUser.get(userId)?.size ?? 0
    if (userRunning >= MAX_RUNNING_PER_USER) {
      throw new HttpException('你这个账号已有任务在进行中，请等它完成后再发起', HttpStatus.TOO_MANY_REQUESTS)
    }
    if (this.runningTotal >= MAX_RUNNING_TOTAL) {
      throw new HttpException('当前服务繁忙，请稍后再试', HttpStatus.TOO_MANY_REQUESTS)
    }

    // ③ 落库
    const id = randomUUID()
    const now = new Date().toISOString()
    const { error: insErr } = await client.from(TABLE).insert({
      id,
      user_id: userId,
      type,
      status: 'pending' as JobStatus,
      dedupe_key: dedupeKey,
      params,
      stage: JOB_STAGE[type].queue,
      attempts: 0,
      created_at: now,
      updated_at: now,
      expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
    })
    if (insErr) {
      this.logger.error(`[jobs] 提交落库失败: ${insErr.message}`)
      throw new BadRequestException(`任务创建失败（${insErr.message}）`)
    }

    // ④ 立刻在后台跑（不 await —— 这正是异步化的意义）
    void this.runJob(id, userId, type, params, forwardHeaders)

    return { id, status: 'pending' as JobStatus, stage: JOB_STAGE[type].queue, deduped: false }
  }

  // ------------------------------------------------------------------
  // 查询
  // ------------------------------------------------------------------
  async get(userId: string, id: string): Promise<JobView> {
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .select(SELECT_COLS)
      .eq('id', id)
      .eq('user_id', userId) // ⚠️ RLS 未启用，隔离必须靠这一行
      .maybeSingle()
    if (error) throw new BadRequestException(`查询任务失败（${error.message}）`)
    // ⚠️ 查不到与越权都返回 404：不区分可避免「用 403/404 探测别人的任务是否存在」
    if (!data) throw new NotFoundException('任务不存在或无权访问')

    const row = data as JobRow
    const ttl = JOB_TTL_MS[row.type] ?? 180_000

    // 看门狗：running 超 TTL 仍未完成 ⇒ 判失败（否则客户端会永远轮询）
    if (row.status === 'running' && row.started_at) {
      const elapsed = Date.now() - new Date(row.started_at).getTime()
      if (elapsed > ttl) {
        await client
          .from(TABLE)
          .update({
            status: 'failed' as JobStatus,
            error: `任务超时（超过 ${Math.round(ttl / 1000)} 秒未完成），请重试`,
            stage: null,
            finished_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', id)
          .eq('user_id', userId)
        return this.toView({ ...row, status: 'failed', error: `任务超时（超过 ${Math.round(ttl / 1000)} 秒未完成），请重试` })
      }
    }

    return this.toView(row)
  }

  /** 我未完成的 task（页面重载后「接上」用） */
  async listActive(userId: string): Promise<JobView[]> {
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .select(SELECT_COLS)
      .eq('user_id', userId)
      .in('status', ['pending', 'running'])
      .order('created_at', { ascending: false })
      .limit(10)
    if (error) throw new BadRequestException(`查询任务失败（${error.message}）`)
    return ((data || []) as JobRow[]).map((r) => this.toView(r))
  }

  /** 删除记录（清理用；不提供「取消正在跑的任务」——Node 无法安全中断） */
  async remove(userId: string, id: string): Promise<{ deleted: boolean }> {
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .delete()
      .eq('id', id)
      .eq('user_id', userId)
      .select('id')
    if (error) throw new BadRequestException(`删除任务失败（${error.message}）`)
    return { deleted: (data?.length ?? 0) > 0 }
  }

  // ------------------------------------------------------------------
  // 执行
  // ------------------------------------------------------------------
  private async runJob(
    id: string,
    userId: string,
    type: JobType,
    params: Record<string, unknown>,
    forwardHeaders: Record<string, string>,
  ) {
    const client = getSupabaseClient()
    const startedAt = new Date().toISOString()
    this.markRunning(userId, id)

    await client
      .from(TABLE)
      .update({ status: 'running' as JobStatus, started_at: startedAt, stage: JOB_STAGE[type].run, updated_at: startedAt })
      .eq('id', id)
      .eq('user_id', userId)

    // 超时兜底：没人轮询时也要收敛（内存里那个 promise 仍在跑，
    // 之后即使完成了也只会被忽略——客户端早已放弃，不会看到「失败后又成功」）
    const ttl = JOB_TTL_MS[type] ?? 180_000
    const timer = setTimeout(() => {
      void client
        .from(TABLE)
        .update({
          status: 'failed' as JobStatus,
          error: `任务超时（超过 ${Math.round(ttl / 1000)} 秒未完成），请重试`,
          stage: null,
          finished_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('user_id', userId)
        .eq('status', 'running')
    }, ttl)

    try {
      const result = await this.execute(type, userId, params, forwardHeaders)
      const now = new Date().toISOString()
      await client
        .from(TABLE)
        .update({
          status: 'done' as JobStatus,
          result: result as Record<string, unknown>,
          stage: null,
          finished_at: now,
          updated_at: now,
        })
        .eq('id', id)
        .eq('user_id', userId)
    } catch (e) {
      // ⚠️ 必须给可读文案。历史上这类失败直接变 "Internal server error"，
      //    用户与排查者都无从下手（见 image.service 的同款约定）
      const raw = (e as Error)?.message ?? String(e)
      const msg = raw.length > 200 ? raw.slice(0, 200) + '…' : raw
      this.logger.error(`[jobs] 任务失败 id=${id} type=${type}: ${msg}`)
      const now = new Date().toISOString()
      await client
        .from(TABLE)
        .update({ status: 'failed' as JobStatus, error: msg || '任务失败，请重试', stage: null, finished_at: now, updated_at: now })
        .eq('id', id)
        .eq('user_id', userId)
    } finally {
      clearTimeout(timer)
      this.unmarkRunning(userId, id)
    }
  }

  private async execute(
    type: JobType,
    userId: string,
    params: Record<string, unknown>,
    forwardHeaders: Record<string, string>,
  ): Promise<unknown> {
    if (type === 'ocr-page') {
      const p = params as unknown as OcrPageJobParams
      if (!p?.image_url) throw new BadRequestException('image_url 不能为空')
      return this.imageService.ocrPage(
        { image_url: p.image_url, mode: p.mode === 'fast' ? 'fast' : 'precise', rectify: p.rectify !== false, force: p.force },
        forwardHeaders,
      )
    }
    if (type === 'doc-recognize') {
      const p = params as unknown as DocRecognizeJobParams
      if (!p?.file_url) throw new BadRequestException('file_url 不能为空')
      return this.ocrService.recognizeDoc(p.file_url, p.force)
    }
    if (type === 'answer-search') {
      const p = params as unknown as AnswerSearchJobParams
      if (!p?.item_id) throw new BadRequestException('item_id 不能为空')
      return this.answerSearchService.searchAnswer(userId, p.item_id, {
        force: p.force === true,
        mode: p.mode === 'ai' ? 'ai' : p.mode === 'kb' ? 'kb' : 'search',
      })
    }
    // search-solve
    const p = params as unknown as SearchSolveJobParams
    if (!p?.question_content?.trim()) throw new BadRequestException('question_content 不能为空')
    return this.searchService.solveQuestion(p.question_content.trim(), userId)
  }

  // ------------------------------------------------------------------
  // 工具
  // ------------------------------------------------------------------
  private markRunning(userId: string, id: string) {
    this.runningTotal += 1
    const s = this.runningByUser.get(userId) ?? new Set<string>()
    s.add(id)
    this.runningByUser.set(userId, s)
  }

  private unmarkRunning(userId: string, id: string) {
    this.runningTotal = Math.max(0, this.runningTotal - 1)
    const s = this.runningByUser.get(userId)
    if (s) {
      s.delete(id)
      if (!s.size) this.runningByUser.delete(userId)
    }
  }

  /** 幂等键：不含易变字段（时间戳之类），保证「同一件事」算出同一个 key */
  private dedupeKeyOf(userId: string, type: JobType, params: Record<string, unknown>): string {
    const canonical = JSON.stringify(params, Object.keys(params ?? {}).sort())
    return createHash('sha256').update(`${userId}|${type}|${canonical}`).digest('hex').slice(0, 64)
  }

  private toView(row: JobRow): JobView {
    const base = row.started_at ? new Date(row.started_at).getTime() : new Date(row.created_at).getTime()
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      stage: row.stage,
      error: row.error,
      result: row.result,
      created_at: row.created_at,
      started_at: row.started_at,
      finished_at: row.finished_at,
      waited_ms: Math.max(0, Date.now() - base),
    }
  }

  /** 清理过期行（任务结果只在 24h 内有意义；不清理会让表无限增长） */
  @Cron('0 */6 * * *')
  /**
   * 清理过期行（任务结果只在 24h 内有意义；不清理会让表无限增长）
   *
   * ⚠️ 这是**全局 GC**，故意不按 user_id 过滤：按 expires_at 删除，
   *    不涉及读取或返回任何用户数据。
   *    （用源码级行豁免而非表级/文件级白名单——后者会把整个文件放开，
   *     未来新增漏写就抓不到了。）
   */
  async purgeExpired() {
    try {
      const client = getSupabaseClient()
      // check-isolation-ignore: 全局 GC，理由见方法头注释
      const { data, error } = await client
        .from(TABLE)
        .delete()
        .lt('expires_at', new Date().toISOString())
        .select('id')
      if (error) this.logger.warn(`[jobs] 清理过期任务失败: ${error.message}`)
      else if (data?.length) this.logger.log(`[jobs] 已清理 ${data.length} 个过期任务`)
    } catch (e) {
      this.logger.warn(`[jobs] 清理异常: ${e}`)
    }
  }
}
