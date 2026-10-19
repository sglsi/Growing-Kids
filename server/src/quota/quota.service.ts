import { Injectable, Logger } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'

/**
 * 配额服务 —— 复习本与项目设计.md §11.3 策略 6（配额 + 分级存储）
 * 方案细节见：策略6-配额方案.md
 *
 * 三条关键口径（与方案文档一致）：
 *   1. **逻辑口径**：用户引用的每个 blob 按全量计（不去重摊薄）⇒ 删除立见效、用户可预期；
 *      去重省下的物理空间归平台。
 *   2. **原图留档不计入配额**：用户消费的是 display/thumb，原图转归档后成本约 2 分钱/GB·月，
 *      送得起；但用「张数 + 月上传流量」双阈值兜底防无限传（见 QUOTA_TIERS.monthlyBytes）。
 *   3. **已软删不计入**：删了就释放配额，用户才有自我管理的路径。
 *
 * 灰度：QUOTA_MODE=off|shadow|warn|block，默认 warn（算用量、给提示，但不阻断上传）。
 *       方案文档要求分三步上线，1 万用户前不开硬阻断 ⇒ 默认不 block。
 */
export type { QuotaMode, QuotaTier } from './quota-policy'
export {
  QUOTA_TIERS,
  DEFAULT_TIER,
  decideQuota,
  normalizeMode,
  usagePct,
} from './quota-policy'
import {
  QUOTA_TIERS,
  DEFAULT_TIER,
  decideQuota,
  normalizeMode,
  usagePct,
  type QuotaMode,
  type QuotaTier,
} from './quota-policy'

export interface Usage {
  usedBytes: number
  usedCount: number
  quotaBytes: number
  quotaCount: number
  tier: string
  pct: number
}

export interface QuotaDecision {
  allowed: boolean
  mode: QuotaMode
  /** 超限原因（allowed=false 时必有） */
  code?: 'QUOTA_BYTES' | 'QUOTA_COUNT'
  usage: Usage
}

const CACHE_TTL_MS = 60 * 1000

@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name)
  private readonly cache = new Map<string, { at: number; usage: Usage }>()

  get mode(): QuotaMode {
    return normalizeMode(process.env.QUOTA_MODE)
  }

  /**
   * 上传前预检。
   * @param userId        用户（匿名为空时用 anonymous 档）
   * @param incomingBytes 本次将写入的字节（display 档大小）
   */
  async checkUpload(userId: string, incomingBytes: number): Promise<QuotaDecision> {
    const mode = this.mode
    const usage = await this.usageOf(userId)

    if (mode === 'off') return { allowed: true, mode, usage }

    const { over, code } = decideQuota(
      { usedBytes: usage.usedBytes, usedCount: usage.usedCount },
      { tier: usage.tier, quotaBytes: usage.quotaBytes, quotaCount: usage.quotaCount, monthlyBytes: 0 },
      incomingBytes,
    )
    if (!over) return { allowed: true, mode, usage }

    // 超限：shadow 只记日志；warn 记日志且不阻断；block 才真正拦截
    this.logger.warn(
      `[quota] 超限 user=${userId || 'anon'} mode=${mode} code=${code} ` +
        `used=${usage.usedBytes}/${usage.quotaBytes}B ${usage.usedCount}/${usage.quotaCount}张`,
    )
    return { allowed: mode !== 'block', mode, code, usage }
  }

  /** 用量（带 60 秒缓存，避免每次上传都全表 SUM） */
  async usageOf(userId: string): Promise<Usage> {
    const key = userId || '__anon__'
    const hit = this.cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.usage

    const tier = await this.tierOf(userId)
    const { usedBytes, usedCount } = await this.computeUsage(userId)
    const usage: Usage = {
      usedBytes,
      usedCount,
      quotaBytes: tier.quotaBytes,
      quotaCount: tier.quotaCount,
      tier: tier.tier,
      pct: tier.quotaBytes > 0 ? Math.min(100, (usedBytes / tier.quotaBytes) * 100) : 0,
    }
    this.cache.set(key, { at: Date.now(), usage })
    return usage
  }

  /** 上传成功后让缓存立即失效（下次重新算） */
  invalidate(userId: string) {
    this.cache.delete(userId || '__anon__')
  }

  private async tierOf(userId: string): Promise<QuotaTier> {
    if (!userId) return QUOTA_TIERS.anonymous
    try {
      const client = getSupabaseClient()
      const { data } = await client
        .from('user_quota')
        .select('tier, quota_bytes, quota_count, monthly_bytes')
        .eq('user_id', userId)
        .maybeSingle()
      if (data) {
        const d = data as { tier: string; quota_bytes: number; quota_count: number; monthly_bytes: number }
        return {
          tier: d.tier,
          quotaBytes: Number(d.quota_bytes) || QUOTA_TIERS.free.quotaBytes,
          quotaCount: Number(d.quota_count) || QUOTA_TIERS.free.quotaCount,
          monthlyBytes: Number(d.monthly_bytes) || QUOTA_TIERS.free.monthlyBytes,
        }
      }
    } catch (e) {
      this.logger.warn(`[quota] 读取档位失败，按免费档: ${e}`)
    }
    return QUOTA_TIERS.free
  }

  /**
   * 逻辑口径用量：
   *   有 file_hash 的行 → 关联 blob_objects，计入 display(size_bytes) + thumb(thumb_bytes)，**不计 original**；
   *   无 file_hash 的旧数据 → 用条目自带的 size_bytes 兜底。
   */
  private async computeUsage(userId: string): Promise<{ usedBytes: number; usedCount: number }> {
    if (!userId) return { usedBytes: 0, usedCount: 0 }
    const client = getSupabaseClient()
    const tables: { table: string; hasSize: boolean }[] = [
      { table: 'timeline_items', hasSize: true },
      { table: 'library_docs', hasSize: true },
      { table: 'documents', hasSize: true },
    ]

    let usedCount = 0
    let legacyBytes = 0
    const hashes = new Set<string>()

    for (const t of tables) {
      try {
        const { data, error } = await client
          .from(t.table)
          .select('file_hash, size_bytes')
          .eq('user_id', userId)
          .is('deleted_at', null)
        if (error) continue
        for (const row of (data || []) as { file_hash: string | null; size_bytes: number | null }[]) {
          usedCount += 1
          if (row.file_hash) hashes.add(row.file_hash)
          else if (t.hasSize && row.size_bytes) legacyBytes += Number(row.size_bytes) || 0
        }
      } catch (e) {
        this.logger.warn(`[quota] 统计 ${t.table} 失败: ${e}`)
      }
    }

    let blobBytes = 0
    if (hashes.size) {
      try {
        const list = [...hashes]
        // in() 一次别塞太多，分批 200
        for (let i = 0; i < list.length; i += 200) {
          const { data } = await client
            .from('blob_objects')
            .select('content_hash, size_bytes, thumb_bytes')
            .in('content_hash', list.slice(i, i + 200))
          for (const b of (data || []) as { size_bytes: number | null; thumb_bytes: number | null }[]) {
            blobBytes += (Number(b.size_bytes) || 0) + (Number(b.thumb_bytes) || 0)
          }
        }
      } catch (e) {
        this.logger.warn(`[quota] 关联 blob 失败: ${e}`)
      }
    }

    return { usedBytes: blobBytes + legacyBytes, usedCount }
  }
}
