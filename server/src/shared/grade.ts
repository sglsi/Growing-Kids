/**
 * 年级：字典 / 相邻扩散 / 学年计算
 * ==================================================================
 * 提案：`docs/design/method/proposals/P-005-年级属性与按年级检索.md`
 * 台账：`D-008`（结论 **D 降维**）
 * 准则：`GK-SRS-20a M10`（不得宣称能测量 ZPD / 智能水平）、`M11`（提醒不得成门槛）、
 *       `M8`（排程用分段常数，**年级不得进入间隔表**）
 *
 * ⚠️ 三条不许越的线（改这块之前先读）：
 *   ① **年级只由用户自报**。不得根据正确率、题目难度、停留时长反推年级——
 *      那是「测量能力水平」，被 M10 明确禁止。本文件只做**登记与检索**，不做推断。
 *   ② **年级不进复习排程**。`REVIEW_INTERVALS = [1,3,7,14,28]`（timeline/review.ts）
 *      与年级完全无关；把年级接进排程等于做自适应难度，属 X（D-002 / M8）。
 *   ③ **年级不进结果指标分组**。唯一够格指标仍是「到期首次作答正确率（按档位）」，
 *      多一个分组维度会让档位曲线失去可比性（OPS-22 §6 / 0021）。
 *
 * 为什么连续编号 1..12 而不是「小学/初中/高中 + 年级」两段式：
 *   相邻年级 = `grade ± 1` 一句就够，跨学段（六→初一、初三→高一）天然连续，
 *   不需要为「学段边界」写特例。学段只用于**展示**（`stage` 字段），不参与计算。
 */

/** 年级下界：小学一年级 */
export const GRADE_MIN = 1
/** 年级上界：高中三年级 */
export const GRADE_MAX = 12

/**
 * 相邻年级最多扩散几级（提案单决策 3：±1 → ±2，最多 2 级）。
 *
 * 为什么必须有硬上限：无上限扩散会退化成「全库召回」——
 * 看起来筛过了，实际等于没筛，而且结果里混入的跨年级题会抵消掉筛选的意义。
 */
export const GRADE_SPREAD_MAX = 2

export type GradeStage = '小学' | '初中' | '高中'

export interface GradeOption {
  value: number
  /** 展示名：「一年级」…「高三」 */
  label: string
  /** 学段，仅用于分组展示，不参与相邻计算 */
  stage: GradeStage
}

/**
 * 12 档年级字典（唯一真相源）。
 *
 * ⚠️ 前端有一份镜像：`src/constants/grades.ts`。
 * 两处 label 必须逐字一致 —— `verify/modules/26-grade.mjs` 有一条断言比对它们，
 * 因为「后端叫初三、前端叫九年级」会让家长在两个页面看到不同说法。
 */
export const GRADES: readonly GradeOption[] = Object.freeze([
  { value: 1, label: '一年级', stage: '小学' },
  { value: 2, label: '二年级', stage: '小学' },
  { value: 3, label: '三年级', stage: '小学' },
  { value: 4, label: '四年级', stage: '小学' },
  { value: 5, label: '五年级', stage: '小学' },
  { value: 6, label: '六年级', stage: '小学' },
  { value: 7, label: '初一', stage: '初中' },
  { value: 8, label: '初二', stage: '初中' },
  { value: 9, label: '初三', stage: '初中' },
  { value: 10, label: '高一', stage: '高中' },
  { value: 11, label: '高二', stage: '高中' },
  { value: 12, label: '高三', stage: '高中' },
] as const)

const LABEL_BY_VALUE = new Map(GRADES.map((g) => [g.value, g.label]))

/** 是否是合法年级（整数且在 1..12） */
export function isValidGrade(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= GRADE_MIN && v <= GRADE_MAX
}

/**
 * 把任意来源的值收成「合法年级 | null」。
 *
 * 口径与 `normalizeSubjectId` 同源：**宁可降级成 null，也不抛错**。
 * 理由一样 —— 年级是归档标签，丢了标签可以再设，把整次保存/检索打回才是真损失。
 *
 * ⚠️ 空串 ≠ null 是这里唯一容易踩的坑：前端 Picker 未选时可能发 `''` 或 `'0'`，
 * 直接 `Number('')` 得 0、`Number(null)` 得 0，都会被误判成「一年级」。
 * 所以先排除空值，再做数字转换。
 */
export function normalizeGrade(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw === 'number') return isValidGrade(raw) ? raw : null
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null
  const n = Number(s)
  return isValidGrade(n) ? n : null
}

/** 年级展示名；非法值返回空串（不返回「未知年级」这类噪声文案） */
export function gradeLabel(grade: unknown): string {
  return isValidGrade(grade) ? (LABEL_BY_VALUE.get(grade) ?? '') : ''
}

/**
 * 按年级检索的**扩散序列**（本年级在最前）。
 *
 * 规则（提案单决策 2/3）：本年级 → ±1 → ±2，**低年级先于高年级**。
 *
 *   3  → [3, 2, 4, 1, 5]
 *   6  → [6, 5, 7, 4, 8]      ← 允许跨学段：5 是小学、7 是初一
 *   1  → [1, 2, 3]            ← 下界不越界
 *   12 → [12, 11, 10]         ← 上界不越界
 *
 * 为什么低年级优先：低年级的题多半是**已学过的**（可作复习/衔接），
 * 高年级的题对孩子是**没学过的**（超前）。同样命中，前者的可用性更高。
 *
 * ⚠️ 本函数是纯函数，不查库、不依赖时区 —— 检索顺序必须可被断言逐字锁定
 * （`verify/modules/26-grade.mjs`），否则「相邻」的定义会随实现漂移。
 */
export function gradeSpread(grade: unknown, maxStep: number = GRADE_SPREAD_MAX): number[] {
  if (!isValidGrade(grade)) return []
  const step = Math.max(0, Math.min(GRADE_MAX, Math.floor(maxStep)))
  const out: number[] = [grade]
  for (let s = 1; s <= step; s++) {
    const lower = grade - s
    if (lower >= GRADE_MIN) out.push(lower)
    const upper = grade + s
    if (upper <= GRADE_MAX) out.push(upper)
  }
  return out
}

/**
 * 当前**学年起始年**（中国学年以 9 月 1 日为界）。
 *
 *   2026-11-04 → 2026（2026-09 ~ 2027-08 学年）
 *   2027-03-15 → 2026（仍属上一学年）
 *
 * ⚠️ 必须按东八区算，不能用服务器本地时区：服务器多为 UTC，
 * 9/1 早上 8 点前会被算成上一年，导致升年级提示早一年弹出。
 * 做法与 `timeline.service.ts` 的 `localDateString` 一致（+8h 后用 UTC 取值）。
 */
export function schoolYearStart(at: Date = new Date()): number {
  const t = new Date(at.getTime() + 8 * 60 * 60 * 1000)
  const year = t.getUTCFullYear()
  const month = t.getUTCMonth() + 1
  return month >= 9 ? year : year - 1
}

/**
 * 学年到期后**建议**的年级（只作提示，绝不自动写入）。
 *
 * 返回 null = 不需要提示，三种情况：
 *   ① 用户还没设年级（没得推）；
 *   ② 没有 `grade_confirmed_year`（无从判断过了几个学年，不打扰）；
 *   ③ 建议值与现值相同（已到高三）。
 *
 * ⚠️ 为什么是「建议」而不是定时批量改：
 *   9/1 升一个年级只对**正常升级**的孩子成立。留级、跳级、休学、转学都可能不适用，
 *   而后台静默改用户数据**不可逆且难以自证**（用户只会看到「年级自己变了」）。
 *   所以这里只算一个候选值，由用户在界面上确认——见提案单决策 7。
 *
 * @param currentGrade  用户当前年级（1..12，非法则视为未设）
 * @param confirmedYear 用户最后一次确认年级所属的学年起始年（见 0025 迁移注释）
 * @param at            参考时刻（默认现在；测试可注入固定时间）
 */
export function suggestGrade(
  currentGrade: unknown,
  confirmedYear: unknown,
  at: Date = new Date(),
): number | null {
  if (!isValidGrade(currentGrade)) return null
  if (typeof confirmedYear !== 'number' || !Number.isFinite(confirmedYear)) return null

  // 只认合理的学年值，防止脏数据（如 0 / 9999）推算出离谱年级
  if (confirmedYear < 2000 || confirmedYear > 2200) return null

  const delta = schoolYearStart(at) - confirmedYear
  if (delta <= 0) return null

  const next = Math.min(GRADE_MAX, currentGrade + delta)
  return next === currentGrade ? null : next
}
