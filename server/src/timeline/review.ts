/**
 * 复习排程（C4 · 分散练习）—— 纯计算，零依赖
 * ------------------------------------------------------------------
 * 立论依据：GK-SRS-20《学习科学方法论指引》
 *   §4.3 间隔怎么排 + 准则 M8「必须有排程，不必有智能排程」
 *   §5.2 C4「复习本无排程」= 本项目最严重的机制缺位（分散练习 d = 0.85 从未落地）
 *
 * 三条来自证据的设计约束：
 *
 * ① **基准是「上次复习时间」，不是「题目创建时间」**
 *    旧实现用 createdAt + 累计间隔现算。一道 60 天前录入、今天才加入复习本的题，
 *    一进本就全部逾期——间隔失效。分散练习的定义是「两次学习之间隔多久」，
 *    起算点只能是上一次接触（首次接触 = 加入复习本）。
 *
 * ② **分段常数，不做自适应算法**
 *    Latimier, Peyre & Ramus (2021)：递增间隔 vs 固定间隔 g = 0.034,
 *    95% CI [−0.10, 0.17], p = .59, I² = 0% —— 一个精确、高功效、同质的零。
 *    Cepeda et al. (2008)：最优间隔在目标保留期 70–350 天之间几乎不变（约三周），
 *    峰顶平坦 ⇒ 大致对就够。故此处直接写死五档，不实现 SM-2 / FSRS。
 *
 * ③ **宁可错晚，不可错早**（SRS-20 §4.3 第二条纠正）
 *    峰顶平坦意味着一周与两周差别很小，但过早复习既浪费注意力、又制造「练得顺」的
 *    虚假熟练感（Kornell & Bjork 2008 的 78% 自我判断错误）。故档位取值靠上不靠下。
 *
 * 间隔表怎么来的（对应 SRS-20 §4.3 的「想记住多久」表）：
 *
 *   | 档 | 距上次 | 对应目标             | Cepeda 2008 参考  |
 *   |----|--------|----------------------|-------------------|
 *   | 1  | 1 天   | 明天还要能想起       | 1 周保留 ≈ 1–2 天 |
 *   | 2  | 3 天   | 本周内保持（单元内） | 同上              |
 *   | 3  | 7 天   | 约一个月保留         | 1 个月 ≈ 7–11 天  |
 *   | 4  | 14 天  | 约三个月保留         | 3 个月 ≈ 2–3 周   |
 *   | 5  | 28 天  | 学期 / 学年（≈4 周） | 1 年 ≈ 3–5 周     |
 *
 * 五档走完即「毕业」：next_review_at 置空，题目仍留在复习本，但不再占用待办。
 * 这对应掌握学习（d = 0.52 SD）里「连续多次做对才算掌握」的意思——
 * 旧实现是点一下按钮就 +1，与证据无关（做对做错一个样）。
 */

/** 间隔档位（天）—— 见文件头表格 */
export const REVIEW_INTERVALS = [1, 3, 7, 14, 28] as const

/** 总档数（走完即毕业） */
export const REVIEW_STAGES = REVIEW_INTERVALS.length

/** 首次进入复习本后的第一次复习延迟（天）= 第一档 */
export const FIRST_REVIEW_DAYS = REVIEW_INTERVALS[0]

/** 复习结果：做对推进一档，做错回到第一档 */
export type ReviewResult = 'correct' | 'wrong'

/** 排程只依赖这几列，便于单测构造 */
export interface ReviewState {
  in_review_book?: boolean | null
  added_to_review_at?: string | null
  last_reviewed_at?: string | null
  next_review_at?: string | null
  review_count?: number | null
  review_lapses?: number | null
}

/** 到期状态（前端据此决定「今天该复习」「还有几天」的文案与配色） */
export type ReviewDueStatus =
  /** 不在复习本 */
  | 'out'
  /** 在复习本但没排程（历史数据 / 手动清空） */
  | 'unscheduled'
  /** 今天或更早到期 */
  | 'due'
  /** 已排程，未来某天 */
  | 'upcoming'
  /** 五档走完，不再排程 */
  | 'graduated'

export interface ReviewStage {
  /** 第几档（从 1 起） */
  stage: number
  /** 该档的间隔天数 */
  interval_days: number
  /** 是否已完成 */
  done: boolean
  /** 是否是「当前正在等的那一档」 */
  current: boolean
}

export interface ReviewPlan {
  in_review_book: boolean
  review_count: number
  review_lapses: number
  total_stages: number
  completed: boolean
  status: ReviewDueStatus
  /** 下次到期（ISO）；未排程 / 已毕业为 null */
  next_review_at: string | null
  /** 逾期天数（未到期或未排程为 0） */
  overdue_days: number
  /** 距到期还有几天（逾期为 0；未排程 / 已毕业为 null） */
  days_until_due: number | null
  /** 最近一次复习时间（ISO） */
  last_reviewed_at: string | null
  schedule: ReviewStage[]
}

const DAY_MS = 24 * 3600 * 1000

function clampCount(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(REVIEW_STAGES, Math.floor(v)))
}

function parse(iso?: string | null): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * 本地「日」键（yyyy-mm-dd）。
 *
 * 为什么按日而不是按毫秒比：
 *   排程是「今天该复习」这种日历语义。若按时间戳比，晚上 20 点到期的题
 *   在当天上午看是「未到期」，家长会以为功能没生效。按日比较后，凡落到今天的题全天都算到期。
 *
 * ⚠️ 时区假设：服务器时区即家庭本地时区（当前 Asia/Shanghai）。
 *    若将来部署到 UTC 机器，此函数需显式指定时区，否则早 8 点前会把「今天」算成「昨天」。
 */
export function localDayKey(d: Date): string {
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 本地某天的 23:59:59.999（用于数据库 due 过滤的上界） */
export function endOfLocalDay(now: Date = new Date()): Date {
  const d = new Date(now.getTime())
  d.setHours(23, 59, 59, 999)
  return d
}

/** a - b 的日历天数（按本地日界，避免夏令时 / 时分秒误差） */
export function dayDiff(a: Date, b: Date): number {
  const ka = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()
  const kb = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime()
  return Math.round((ka - kb) / DAY_MS)
}

/** 是否已到期（落在今天或更早） */
export function isDue(next: string | null | undefined, now: Date = new Date()): boolean {
  const d = parse(next)
  if (!d) return false
  return dayDiff(now, d) >= 0
}

/**
 * 由排程状态现算「复习计划」。
 *
 * 刻意**不存整张计划表**：档位只由 review_count 决定，到期只由 next_review_at 决定，
 * 两者已经是全部真相。再存一份 schedule 就是第二份可编辑副本，必然漂移。
 */
export function buildReviewPlan(state: ReviewState, now: Date = new Date()): ReviewPlan {
  const inBook = !!state.in_review_book
  const count = clampCount(state.review_count)
  const lapses = Math.max(0, Math.floor(Number(state.review_lapses) || 0))
  const nextDate = parse(state.next_review_at)
  const completed = inBook && count >= REVIEW_STAGES && !nextDate

  let status: ReviewDueStatus
  if (!inBook) status = 'out'
  else if (completed) status = 'graduated'
  else if (!nextDate) status = 'unscheduled'
  else status = isDue(state.next_review_at, now) ? 'due' : 'upcoming'

  const overdueDays = status === 'due' && nextDate ? Math.max(0, dayDiff(now, nextDate)) : 0
  const daysUntilDue =
    status === 'due' ? 0
      : status === 'upcoming' && nextDate ? Math.max(0, dayDiff(nextDate, now))
        : null

  const schedule: ReviewStage[] = REVIEW_INTERVALS.map((interval, i) => ({
    stage: i + 1,
    interval_days: interval,
    done: i < count,
    current: inBook && i === count && count < REVIEW_STAGES,
  }))

  return {
    in_review_book: inBook,
    review_count: count,
    review_lapses: lapses,
    total_stages: REVIEW_STAGES,
    completed,
    status,
    next_review_at: nextDate ? nextDate.toISOString() : null,
    overdue_days: overdueDays,
    days_until_due: daysUntilDue,
    last_reviewed_at: parse(state.last_reviewed_at)?.toISOString() ?? null,
    schedule,
  }
}

/** 排程推进的结果（直接对应四列要写回的值） */
export interface ReviewAdvance {
  review_count: number
  review_lapses: number
  last_reviewed_at: string
  /** null = 已毕业，不再排程 */
  next_review_at: string | null
}

/**
 * 计算「复习一次」后的新状态。
 *
 * 做对（correct）：档位 +1，下次 = 现在 + 新档位间隔。
 *   例：刚加入（count=0，下次 +1 天）→ 做对 → count=1，下次 +3 天；
 *       count=4 → 做对 → count=5（毕业），next = null。
 *
 * 做错（wrong）：**归零，明天再来**。
 *   - 为什么不只降一档：错意味着这次提取失败。间隔练习的前提是「在可成功边缘提取」，
 *     失败还不缩短间隔，等于把遗忘固化。
 *   - 为什么是 1 天而不是「立刻重做」：立刻重做退化为集中练习（当天连做三遍），
 *     拿不到间隔收益；同时 Metcalfe (2017) 指出「只犯错不纠正」会固化错误，
 *     故次日必须再来一次，且带着订正后的答案来。
 *   - review_lapses 只记账不参与计算：反复错的题是 C2/C3（自评信心 / 错因）的输入，
 *     在还没有那两个维度前，不应凭它编造更复杂的算法（准则 M8）。
 */
export function advanceReview(state: ReviewState, result: ReviewResult, now: Date = new Date()): ReviewAdvance {
  const count = clampCount(state.review_count)
  const lapses = Math.max(0, Math.floor(Number(state.review_lapses) || 0))
  const stamp = now.toISOString()

  if (result === 'wrong') {
    return {
      review_count: 0,
      review_lapses: lapses + 1,
      last_reviewed_at: stamp,
      next_review_at: new Date(now.getTime() + FIRST_REVIEW_DAYS * DAY_MS).toISOString(),
    }
  }

  const nextCount = Math.min(REVIEW_STAGES, count + 1)
  if (nextCount >= REVIEW_STAGES) {
    return { review_count: nextCount, review_lapses: lapses, last_reviewed_at: stamp, next_review_at: null }
  }

  // 推进后按**新档位**的间隔等待：count=1 ⇒ 3 天，count=2 ⇒ 7 天 …
  const waitDays = REVIEW_INTERVALS[nextCount]
  return {
    review_count: nextCount,
    review_lapses: lapses,
    last_reviewed_at: stamp,
    next_review_at: new Date(now.getTime() + waitDays * DAY_MS).toISOString(),
  }
}

/** 首次加入复习本：第一档（1 天后到期） */
export function firstReviewAt(now: Date = new Date()): string {
  return new Date(now.getTime() + FIRST_REVIEW_DAYS * DAY_MS).toISOString()
}

/** 是否还能继续复习（前端决定要不要显示按钮） */
export function canReview(plan: ReviewPlan): boolean {
  return plan.in_review_book && !plan.completed
}
