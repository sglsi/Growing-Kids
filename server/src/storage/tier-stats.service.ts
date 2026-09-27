import { Injectable, Logger } from '@nestjs/common'
import { getSupabaseClient } from './database/supabase-client'
import { computeTierReport, type BlobStatRow, type TierReport } from './tier-stats'

/**
 * 分层统计服务 —— 把 blob_objects 的行喂给纯函数 computeTierReport()。
 *
 * 用途（策略 3 的验收与告警）：
 *   1. 配生命周期规则**前后各跑一次**，即可核对「是否真的省了」（而不是只看账单猜）；
 *   2. 作为容量告警的数据源：total.bytes 超过阈值即告警（设计文档 §11.5 第 6 条）。
 */
@Injectable()
export class TierStatsService {
  private readonly logger = new Logger(TierStatsService.name)

  /** 全量分层报告（分页扫表，默认最多 2 万行） */
  async report(maxRows = 20000): Promise<TierReport> {
    const rows = await this.fetchRows(maxRows)
    return computeTierReport(rows)
  }

  private async fetchRows(maxRows: number): Promise<BlobStatRow[]> {
    const client = getSupabaseClient()
    const out: BlobStatRow[] = []
    const pageSize = 1000
    for (let from = 0; from < maxRows; from += pageSize) {
      const { data, error } = await client
        .from('blob_objects')
        .select('kind, size_bytes, original_bytes, thumb_bytes, last_ref_at')
        .range(from, from + pageSize - 1)
      if (error) {
        this.logger.warn(`[tier-stats] 查询失败: ${error.message}`)
        break
      }
      const batch = (data || []) as BlobStatRow[]
      out.push(...batch)
      if (batch.length < pageSize) break
    }
    return out
  }
}
