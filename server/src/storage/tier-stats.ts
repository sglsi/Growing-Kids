/**
 * 存储分层统计 —— 纯函数（不依赖 Nest / 数据库，便于单独测试）。
 *
 * 依据：复习本与项目设计.md §11.3 策略 3（生命周期分层）
 *     配套：策略3-生命周期分层-配置清单.md
 *
 * 它解决一个具体问题：生命周期规则是在**云控制台**配的（代码改不了存储类型），
 * 那么「配了到底省了多少」必须有可核对的数字 —— 否则只能看账单猜。
 * 这里按与控制台**完全相同的天数与倍率**算出：
 *   - 各档位的真实对象数与字节
 *   - 有多少字节已经「够冷」（达到转档天数）
 *   - 转档前后的月费估算
 * 于是配置前后各跑一次，就能验收规则是否真的生效。
 */

/** 与策略3文档一致的转档天数 */
export const TIER_RULES = {
  displayToInfrequentDays: 90,   // 展示图 90 天 → 低频
  docToInfrequentDays: 90,       // 生成文档 90 天 → 低频
  originalToInfrequentDays: 30,  // 原图 30 天 → 低频
  originalToArchiveDays: 180,    // 原图 180 天 → 归档
  tempDeleteHours: 24,           // 临时对象 24 小时 → 删除（策略 5②/7）
} as const

/** 单价：元/GB·月（COS 广州标准存储口径）；低频/归档用相对倍率，与策略3文档一致 */
export const STORAGE_PRICE = {
  standardYuanPerGbMonth: 0.118,
  infrequentRatio: 0.45,
  archiveRatio: 0.17,
} as const

export interface BlobStatRow {
  kind: string | null
  size_bytes: number | null        // display 档字节
  original_bytes?: number | null   // original 留档字节（迁移 0005 补）
  thumb_bytes?: number | null      // thumb 档字节
  last_ref_at: string | null
}

export interface TierBucket {
  tier: 'thumb' | 'display' | 'original' | 'doc' | 'temp'
  objects: number
  bytes: number
  /** 已「够冷」、可以转档（或删除）的部分 */
  coldObjects: number
  coldBytes: number
}

export interface TierReport {
  total: { objects: number; bytes: number }
  byTier: TierBucket[]
  lifecycle: {
    displayToInfrequent: { objects: number; bytes: number }
    originalToInfrequent: { objects: number; bytes: number }
    originalToArchive: { objects: number; bytes: number }
    docToInfrequent: { objects: number; bytes: number }
    tempToDelete: { objects: number; bytes: number }
    /** 刻意不转档：缩略图 <64KB，转了不省钱还要付取回费 */
    thumbKeptStandard: { objects: number; bytes: number }
  }
  cost: {
    monthlyYuanNow: number      // 全按标准存储的月费
    monthlyYuanAfter: number    // 按规则分层后的月费
    savedPct: number
  }
  /** 数据缺口提示：original_bytes 为空的行数（老数据未回填，会低估收益） */
  missingOriginalBytes: number
}

const GB = 1024 * 1024 * 1024
const yuan = (bytes: number, ratio: number) => (bytes / GB) * STORAGE_PRICE.standardYuanPerGbMonth * ratio

/**
 * 计算分层报告。
 * @param rows blob_objects 的行（kind / 三档字节 / last_ref_at）
 * @param now  当前时间（注入，便于测试）
 */
export function computeTierReport(rows: BlobStatRow[], now: number = Date.now()): TierReport {
  const buckets: Record<TierBucket['tier'], TierBucket> = {
    thumb: { tier: 'thumb', objects: 0, bytes: 0, coldObjects: 0, coldBytes: 0 },
    display: { tier: 'display', objects: 0, bytes: 0, coldObjects: 0, coldBytes: 0 },
    original: { tier: 'original', objects: 0, bytes: 0, coldObjects: 0, coldBytes: 0 },
    doc: { tier: 'doc', objects: 0, bytes: 0, coldObjects: 0, coldBytes: 0 },
    temp: { tier: 'temp', objects: 0, bytes: 0, coldObjects: 0, coldBytes: 0 },
  }
  const lc = {
    displayToInfrequent: { objects: 0, bytes: 0 },
    originalToInfrequent: { objects: 0, bytes: 0 },
    originalToArchive: { objects: 0, bytes: 0 },
    docToInfrequent: { objects: 0, bytes: 0 },
    tempToDelete: { objects: 0, bytes: 0 },
    thumbKeptStandard: { objects: 0, bytes: 0 },
  }
  let missingOriginalBytes = 0

  const daysSince = (iso: string | null) => {
    if (!iso) return Number.POSITIVE_INFINITY // 无时间戳 ⇒ 视为最冷（保守：宁可多算冷数据）
    const t = new Date(iso).getTime()
    return Number.isFinite(t) ? (now - t) / 86400000 : Number.POSITIVE_INFINITY
  }

  for (const r of rows) {
    const ageDays = daysSince(r.last_ref_at)
    const kind = r.kind || 'image'

    if (kind === 'temp') {
      const b = r.size_bytes || 0
      buckets.temp.objects += 1
      buckets.temp.bytes += b
      if (ageDays * 24 >= TIER_RULES.tempDeleteHours) {
        buckets.temp.coldObjects += 1
        buckets.temp.coldBytes += b
        lc.tempToDelete.objects += 1
        lc.tempToDelete.bytes += b
      }
      continue
    }

    if (kind === 'doc') {
      const b = r.size_bytes || 0
      buckets.doc.objects += 1
      buckets.doc.bytes += b
      if (ageDays >= TIER_RULES.docToInfrequentDays) {
        buckets.doc.coldObjects += 1
        buckets.doc.coldBytes += b
        lc.docToInfrequent.objects += 1
        lc.docToInfrequent.bytes += b
      }
      continue
    }

    // kind === 'image'：三档分别判断
    const displayBytes = r.size_bytes || 0
    const originalBytes = r.original_bytes || 0
    const thumbBytes = r.thumb_bytes || 0
    if (r.original_bytes == null && kind === 'image') missingOriginalBytes += 1

    buckets.display.objects += 1
    buckets.display.bytes += displayBytes
    if (ageDays >= TIER_RULES.displayToInfrequentDays) {
      buckets.display.coldObjects += 1
      buckets.display.coldBytes += displayBytes
      lc.displayToInfrequent.objects += 1
      lc.displayToInfrequent.bytes += displayBytes
    }

    if (originalBytes > 0) {
      buckets.original.objects += 1
      buckets.original.bytes += originalBytes
      if (ageDays >= TIER_RULES.originalToArchiveDays) {
        buckets.original.coldObjects += 1
        buckets.original.coldBytes += originalBytes
        lc.originalToArchive.objects += 1
        lc.originalToArchive.bytes += originalBytes
      } else if (ageDays >= TIER_RULES.originalToInfrequentDays) {
        buckets.original.coldObjects += 1
        buckets.original.coldBytes += originalBytes
        lc.originalToInfrequent.objects += 1
        lc.originalToInfrequent.bytes += originalBytes
      }
    }

    if (thumbBytes > 0) {
      buckets.thumb.objects += 1
      buckets.thumb.bytes += thumbBytes
      // 缩略图刻意不转档（<64KB 最小计量，转了不省且多付取回费）
      lc.thumbKeptStandard.objects += 1
      lc.thumbKeptStandard.bytes += thumbBytes
    }
  }

  const totalBytes = Object.values(buckets).reduce((s, b) => s + b.bytes, 0)
  const totalObjects = Object.values(buckets).reduce((s, b) => s + b.objects, 0)

  // 分层后成本：热数据按标准，冷数据按对应倍率；temp 到期删除 ⇒ 不计入
  const after =
    yuan(buckets.display.bytes - buckets.display.coldBytes, 1) +
    yuan(buckets.display.coldBytes, STORAGE_PRICE.infrequentRatio) +
    yuan(buckets.original.bytes - buckets.original.coldBytes, 1) +
    yuan(
      lc.originalToInfrequent.bytes, // 30~180 天：低频
      STORAGE_PRICE.infrequentRatio,
    ) +
    yuan(lc.originalToArchive.bytes, STORAGE_PRICE.archiveRatio) + // ≥180 天：归档
    yuan(buckets.doc.bytes - buckets.doc.coldBytes, 1) +
    yuan(buckets.doc.coldBytes, STORAGE_PRICE.infrequentRatio) +
    yuan(buckets.thumb.bytes, 1) // 缩略图永远标准

  const nowCost = yuan(totalBytes - buckets.temp.bytes, 1) // 当前全按标准（temp 即将删除，不算）
  const savedPct = nowCost > 0 ? (1 - after / nowCost) * 100 : 0

  return {
    total: { objects: totalObjects, bytes: totalBytes },
    byTier: Object.values(buckets),
    lifecycle: lc,
    cost: {
      monthlyYuanNow: Number(nowCost.toFixed(2)),
      monthlyYuanAfter: Number(after.toFixed(2)),
      savedPct: Number(savedPct.toFixed(1)),
    },
    missingOriginalBytes,
  }
}
