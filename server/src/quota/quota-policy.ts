/**
 * 配额策略 —— 纯函数与常量（不依赖 Nest / 数据库，便于单独测试）。
 *
 * 依据：复习本与项目设计.md §11.3 策略 6
 *     方案：策略6-配额方案.md
 *
 * 档位口径（方案文档 §三）：双阈值 —— 存储配额与张数**先到先触发**；
 * 月上传流量是「原图留档不计入配额」之后的安全兜底。
 */

export type QuotaMode = 'off' | 'shadow' | 'warn' | 'block'

export interface QuotaTier {
  tier: string
  quotaBytes: number
  quotaCount: number
  monthlyBytes: number
}

const MB = 1024 * 1024
const GB = 1024 * 1024 * 1024

export const QUOTA_TIERS: Record<string, QuotaTier> = {
  anonymous: { tier: 'anonymous', quotaBytes: 20 * MB, quotaCount: 10, monthlyBytes: 50 * MB },
  free: { tier: 'free', quotaBytes: 500 * MB, quotaCount: 300, monthlyBytes: 200 * MB },
  member: { tier: 'member', quotaBytes: 10 * GB, quotaCount: 5000, monthlyBytes: 2 * GB },
  family: { tier: 'family', quotaBytes: 50 * GB, quotaCount: Number.MAX_SAFE_INTEGER, monthlyBytes: 10 * GB },
}

/** 默认档位（user_quota 表里没有记录时） */
export const DEFAULT_TIER: QuotaTier = QUOTA_TIERS.free

/** 环境值归一化：非法值一律退回 warn（默认不阻断，避免误伤存量用户） */
export function normalizeMode(raw: string | undefined | null): QuotaMode {
  const m = String(raw || '').trim().toLowerCase()
  return m === 'off' || m === 'shadow' || m === 'warn' || m === 'block' ? m : 'warn'
}

export interface QuotaUsageInput {
  usedBytes: number
  usedCount: number
}

/**
 * 判定本次上传是否超限。
 * @param used      当前用量（逻辑口径）
 * @param tier      档位
 * @param incoming  本次将写入的字节
 */
export function decideQuota(
  used: QuotaUsageInput,
  tier: QuotaTier,
  incoming = 0,
): { over: boolean; code?: 'QUOTA_BYTES' | 'QUOTA_COUNT' } {
  if (used.usedBytes + (incoming || 0) > tier.quotaBytes) return { over: true, code: 'QUOTA_BYTES' }
  if (used.usedCount + 1 > tier.quotaCount) return { over: true, code: 'QUOTA_COUNT' }
  return { over: false }
}

/** 用量百分比（0~100） */
export function usagePct(usedBytes: number, quotaBytes: number): number {
  if (!quotaBytes || quotaBytes <= 0) return 0
  return Math.min(100, Math.max(0, (usedBytes / quotaBytes) * 100))
}
