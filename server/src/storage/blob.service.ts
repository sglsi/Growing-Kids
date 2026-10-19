import { Injectable, Logger } from '@nestjs/common'
import { getSupabaseClient } from './database/supabase-client'

const TABLE = 'blob_objects'

export interface BlobRecord {
  content_hash: string
  storage_key: string
  ref_count: number
  size_bytes: number | null
  mime_type: string | null
  kind: string
  width: number | null
  height: number | null
  variants: Record<string, string>
  created_at: string
  last_ref_at: string
}

export interface UpsertBlobInput {
  contentHash: string
  storageKey: string
  sizeBytes?: number
  mimeType?: string
  kind?: 'image' | 'doc' | 'temp'
  width?: number
  height?: number
  variants?: Record<string, string>
}

/**
 * 临时对象（AI 识别前的中间上传）的存活时长。
 * 到点后由孤儿 GC 统一回收（ref_count 恒为 0，天然命中回收条件）。
 */
export const TEMP_BLOB_TTL_MS = 24 * 60 * 60 * 1000

/**
 * blob_objects 引用计数服务 —— 全局内容去重的地基。
 *
 * 依据：复习本与项目设计.md §11.3 策略 4（内容去重 + 引用计数）
 *
 * 核心契约（顺序不可颠倒，否则会误删共享文件）：
 *   1. 上传：先 `acquire()`。命中已有 content_hash ⇒ ref_count++ 且**复用 storage_key**，
 *      调用方**不要再上传**对象存储；未命中 ⇒ 返回 existed=false，调用方才去上传，再 `register()`。
 *   2. 删除：只 `release()`（ref_count--）。**归零时返回 shouldDelete=true**，由调用方删文件；
 *      仍然 >0 则**绝不能删**，因为别的用户还在用。
 *
 * ⚠️ PostgREST 没有原子自增，这里用「读-改-写 + 乐观校验」：
 *   更新时带上 `ref_count=旧值` 作为条件（CAS），若并发导致未命中则重试。
 *   在「每用户串行上传」的实际负载下已足够；即便极端并发下少计，也只会让 blob 提前进入
 *   待回收队列（GC 前还会做孤儿二次核对），不会误删在用文件 —— 安全方向是正确的。
 */
@Injectable()
export class BlobService {
  private readonly logger = new Logger(BlobService.name)

  /** 查是否已存在该内容（不改变计数） */
  async find(contentHash: string): Promise<BlobRecord | null> {
    if (!contentHash) return null
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .select('*')
      .eq('content_hash', contentHash)
      .maybeSingle()
    if (error) {
      this.logger.warn(`[blob] 查询失败 ${contentHash}: ${error.message}`)
      return null
    }
    return (data as BlobRecord) || null
  }

  /**
   * 声明要引用该内容（上传路径调用）。
   * @returns existed=true 表示复用已有对象（调用方跳过上传）；false 表示需要上传后 `register()`
   */
  async acquire(contentHash: string): Promise<{ existed: boolean; record: BlobRecord | null }> {
    const rec = await this.find(contentHash)
    if (!rec) return { existed: false, record: null }

    const ok = await this.bumpRef(contentHash, rec.ref_count, +1)
    if (!ok) {
      // CAS 未命中（并发），重读一次再试；仍失败则退化为「已存在但计数未增」，
      // 由 GC 的孤儿核对兜底，不阻断上传。
      const again = await this.find(contentHash)
      if (again) await this.bumpRef(contentHash, again.ref_count, +1)
    }

    // 「转正」：同一份内容先被中间上传登记为 temp，之后又走正式上传 ——
    // 说明它已被真正引用，必须脱离 temp 的回收队列，否则 24h 后会被 GC 删掉 → 图片裂。
    if (rec.kind === 'temp') await this.promote(contentHash)

    return { existed: true, record: rec }
  }

  /**
   * temp → 正式资产转正（kind 改为 image）。
   * 只为「同一内容被正式引用」这一条路径服务；转正后不再被 temp 回收规则命中。
   */
  async promote(contentHash: string): Promise<void> {
    const client = getSupabaseClient()
    const { error } = await client
      .from(TABLE)
      .update({ kind: 'image', last_ref_at: new Date().toISOString() })
      .eq('content_hash', contentHash)
      .eq('kind', 'temp') // 只对 temp 生效，避免误改正式记录
    if (error) this.logger.warn(`[blob] 转正失败 ${contentHash}: ${error.message}`)
  }

  /**
   * 首次登记（正式上传完成后调用），ref_count 初始化为 1。
   *
   * ⚠️ 安全约束：**不覆盖已有的正式记录**。若该内容已登记过（尤其是 kind='image'），
   * 直接返回原记录、不动 kind —— 否则一次 temp 上传会把正式资产「降格」成 temp，
   * 24 小时后被 GC 删掉 → 已保存的图片裂掉。这是本表最危险的误用方式。
   */
  async register(input: UpsertBlobInput): Promise<BlobRecord | null> {
    // 并发路径：acquire 时还不存在，但上传期间被他人先登记了。
    // 此时本调用方确实多了一份引用 ⇒ 计数 +1，且**保留原 kind**（不让 temp 覆盖正式资产）。
    const existing = await this.find(input.contentHash)
    if (existing) {
      await this.bumpRef(existing.content_hash, existing.ref_count, +1)
      return existing
    }

    const client = getSupabaseClient()
    const row = {
      content_hash: input.contentHash,
      storage_key: input.storageKey,
      ref_count: 1,
      size_bytes: input.sizeBytes ?? null,
      mime_type: input.mimeType ?? null,
      kind: input.kind ?? 'image',
      width: input.width ?? null,
      height: input.height ?? null,
      variants: input.variants ?? {},
      last_ref_at: new Date().toISOString(),
    }
    // upsert：并发下可能已被他人先登记，则退化为 +1
    const { data, error } = await client
      .from(TABLE)
      .upsert(row, { onConflict: 'content_hash', ignoreDuplicates: false })
      .select('*')
      .maybeSingle()
    if (error) {
      this.logger.warn(`[blob] 登记失败 ${input.contentHash}: ${error.message}`)
      return null
    }
    return (data as BlobRecord) || null
  }

  /**
   * 登记**临时对象**（中间上传，如 AI 识别前的图片）。
   *
   * 与 register() 的两处关键差别：
   *   - `ref_count = 0`：无人正式引用 ⇒ 到 TTL 后由**已有的孤儿 GC** 统一回收
   *     （GC 的判据正是 ref_count=0 + 静止超宽限期），**不需要新增定时任务**。
   *   - `kind='temp'`：后续若被正式上传命中，`acquire()` 会把它转正为 image。
   *
   * @returns 该内容已登记过（无论 image 还是 temp）时**直接复用、不改动任何字段** ——
   *          绝不把正式资产降格成 temp，否则 24h 后会被删 → 已保存的图片裂。
   */
  async registerTemp(input: UpsertBlobInput): Promise<BlobRecord | null> {
    const existing = await this.find(input.contentHash)
    if (existing) return existing

    const client = getSupabaseClient()
    const row = {
      content_hash: input.contentHash,
      storage_key: input.storageKey,
      ref_count: 0, // 关键：0 引用 ⇒ 到期可回收，不会像正式上传那样永久占着
      size_bytes: input.sizeBytes ?? null,
      mime_type: input.mimeType ?? null,
      kind: 'temp' as const,
      width: input.width ?? null,
      height: input.height ?? null,
      variants: input.variants ?? {},
      last_ref_at: new Date().toISOString(),
    }
    const { data, error } = await client
      .from(TABLE)
      .insert(row)
      .select('*')
      .maybeSingle()
    if (error) {
      this.logger.warn(`[blob] 登记临时对象失败 ${input.contentHash}: ${error.message}`)
      return null
    }
    return (data as BlobRecord) || null
  }

  /**
   * 释放一次引用（删除/软删时调用）。
   * @returns shouldDelete=true ⇒ ref_count 已归零，调用方可以删对象存储文件 + 清本行；
   *          false ⇒ 仍有其他引用，**禁止删文件**。
   */
  async release(contentHash: string): Promise<{ shouldDelete: boolean; remaining: number }> {
    if (!contentHash) return { shouldDelete: false, remaining: 0 }
    const rec = await this.find(contentHash)
    if (!rec) return { shouldDelete: false, remaining: 0 }

    const remaining = Math.max(0, rec.ref_count - 1)
    const ok = await this.bumpRef(contentHash, rec.ref_count, -1)
    if (!ok) {
      // 并发下重试一次
      const again = await this.find(contentHash)
      if (again) return { shouldDelete: again.ref_count <= 1, remaining: Math.max(0, again.ref_count - 1) }
      return { shouldDelete: false, remaining }
    }
    return { shouldDelete: remaining === 0, remaining }
  }

  /** 彻底移除登记行（GC 删完文件后调用） */
  async removeRecord(contentHash: string): Promise<void> {
    const client = getSupabaseClient()
    const { error } = await client.from(TABLE).delete().eq('content_hash', contentHash)
    if (error) this.logger.warn(`[blob] 移除登记失败 ${contentHash}: ${error.message}`)
  }

  /** 列出待回收对象：ref_count=0 且静止超过 minAgeMs（给软删宽限期） */
  async listCollectable(minAgeMs: number, limit = 200): Promise<BlobRecord[]> {
    const client = getSupabaseClient()
    const before = new Date(Date.now() - minAgeMs).toISOString()
    const { data, error } = await client
      .from(TABLE)
      .select('*')
      .eq('ref_count', 0)
      .lt('last_ref_at', before)
      .order('last_ref_at', { ascending: true })
      .limit(limit)
    if (error) {
      this.logger.warn(`[blob] 列出待回收失败: ${error.message}`)
      return []
    }
    return (data || []) as BlobRecord[]
  }

  /** 用量统计（供监控/文档引用） */
  async stats(): Promise<{ objects: number; activeObjects: number; totalBytes: number }> {
    const client = getSupabaseClient()
    const { data, error } = await client.from(TABLE).select('ref_count, size_bytes')
    if (error || !data) return { objects: 0, activeObjects: 0, totalBytes: 0 }
    let totalBytes = 0
    let active = 0
    for (const r of data as { ref_count: number; size_bytes: number | null }[]) {
      totalBytes += r.size_bytes || 0
      if ((r.ref_count || 0) > 0) active += 1
    }
    return { objects: data.length, activeObjects: active, totalBytes }
  }

  /** CAS 自增/自减；命中返回 true */
  private async bumpRef(contentHash: string, expected: number, delta: number): Promise<boolean> {
    const client = getSupabaseClient()
    const next = Math.max(0, expected + delta)
    const { data, error } = await client
      .from(TABLE)
      .update({ ref_count: next, last_ref_at: new Date().toISOString() })
      .eq('content_hash', contentHash)
      .eq('ref_count', expected) // CAS：只有计数没被别人改过才生效
      .select('content_hash')
    if (error) {
      this.logger.warn(`[blob] 计数更新失败 ${contentHash}: ${error.message}`)
      return false
    }
    return Array.isArray(data) && data.length > 0
  }
}
