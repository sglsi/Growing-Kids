/**
 * 艾宾浩斯复习曲线（P2-18 · 纯计算，零依赖）
 * ------------------------------------------------------------------
 * 技术文档 §5 #18。经典遗忘曲线复习间隔 [1,2,4,7,15,30] 天：
 * 在"创建/加入复习本"后的这些时间点各复习一次，记忆留存率最优。
 *
 * 设计：只在 `timeline_items.content.review_count` 存一个**已完成复习次数**的计数器
 * （整数，封顶 = 间隔数），复习计划由 `created_at + review_count` **现算**，
 * 不冗余存储整张计划表，避免状态漂移。
 */
export const EBBINGHAUS_INTERVALS = [1, 2, 4, 7, 15, 30] as const

export interface ReviewStage {
  /** 第几阶段（从 1 起） */
  stage: number
  /** 距创建的间隔天数 */
  day: number
  /** 该次复习的计划日期（ISO） */
  date: string
  /** 该阶段复习是否已完成 */
  done: boolean
}

export interface ReviewPlan {
  /** 已完成复习次数（= content.review_count） */
  review_count: number
  /** 总阶段数（= 间隔数） */
  total_stages: number
  /** 是否全部阶段完成 */
  completed: boolean
  /** 下一未完成阶段的计划复习日期（ISO）；已完成则为 null */
  next_review_at: string | null
  /** 每个阶段的明细 */
  schedule: ReviewStage[]
}

function toISO(d: Date): string {
  return d.toISOString()
}

function addDays(iso: string, days: number): Date {
  const base = new Date(iso)
  base.setDate(base.getDate() + days)
  return base
}

/**
 * 由创建时间与已完成复习次数现算复习计划。
 * @param createdAt  条目创建时间（ISO）。缺失时按 now 兜底，保证不抛错。
 * @param reviewCount 已完成复习次数（整数，自动 clamp 到 [0, total]）。
 * @param now 当前时间（便于单测注入）。
 */
export function buildReviewPlan(createdAt: string | null | undefined, reviewCount = 0, now: Date = new Date()): ReviewPlan {
  const base = createdAt ? new Date(createdAt) : now
  const total = EBBINGHAUS_INTERVALS.length
  const count = Math.max(0, Math.min(total, Math.floor(reviewCount) || 0))

  const schedule: ReviewStage[] = EBBINGHAUS_INTERVALS.map((day, i) => ({
    stage: i + 1,
    day,
    date: toISO(addDays(base.toISOString(), day)),
    done: i < count,
  }))

  const completed = count >= total
  const nextStage = schedule.find((s) => !s.done)
  return {
    review_count: count,
    total_stages: total,
    completed,
    next_review_at: nextStage ? nextStage.date : null,
    schedule,
  }
}

/** 复习一次：返回新的复习计数（封顶 total） */
export function nextReviewCount(reviewCount = 0): number {
  const total = EBBINGHAUS_INTERVALS.length
  return Math.min(total, Math.max(0, Math.floor(reviewCount) || 0) + 1)
}
