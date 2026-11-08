/**
 * P-015 / D-018：参考例题（相似题思路借鉴）筛选。
 *
 * 目标（思傅 2026-11-07）：题库的主要目的是检索到「正确的解答思路和解答过程」。
 * 题目与库内不完全一致、但主要解题思路和解题方法具有借鉴意义时，可以把库内
 * 题目内容与解题过程提供给用户借鉴 —— **但必须事先声明**。
 *
 * 🔴 本模块与判定层的关系：**判定层 `question-match.ts` 一行未动**。
 *    `exact` 的六条硬闸、举证责任倒置、`verified` 语义、`answer` 字段口径全部原样。
 *    这里只是**并列的第二层**：从已被召回、已通过入库校验的对象里挑出带完整解析、
 *    与题干有共现信号的例题，作为「参考例题」另行呈现。
 *
 * 🔴 结构不变量（从根上避免「题干 A + 别人解析」）：
 *    每条参考例题的 stem 与 solution **必须来自同一个 `question_objects` 行**，
 *    绝不跨对象拼接；并带来源位置供家长回原文核对。
 *
 * 🔴 输出边界：本模块只产出参考例题，**永远不写 `answer`、不置 `verified=true`、
 *    不提供「采纳」**；声明文案由 `REFERENCE_DISCLAIMER` 统一下发，
 *    前端必须在渲染任何参考内容**之前**先行渲染，且每条卡片重复声明。
 *
 * 零业务依赖：只 import `question-match.ts` 的纯函数与类型，不碰数据库 / 网络 / 配置。
 */
import { extractDistinctive, validateStoredObject } from './question-match'
import type { StoredQuestionObject } from './question-match'

/**
 * 事先声明文案（服务端唯一真相源；前端 `src/constants/reference-disclaimer.ts` 是逐字镜像）。
 * 三要素：不是本题答案 / 仅供借鉴解题思路 / 请先自己想一想。
 * ⚠️ M37 断言两边逐字一致，改这里必须同步改前端并 bump CACHE_VERSION。
 */
export const REFERENCE_DISCLAIMER = '以下不是本题答案：资料库里没有找到与这道题完全一致的原题，下面是解题思路相近的例题（题目与解题过程均来自资料库原题），仅供借鉴解题思路和解题方法。请先自己想一想，再对照例题的方法，不要直接抄写。'

/** 每条参考例题都重复一次，防止用户滚动后脱离顶部声明 */
export const REFERENCE_ITEM_HINT = '这是资料库里的另一道题，不是本题答案，仅供借鉴解题思路'

export interface ReferenceExample {
  /** 库内原题题干（截 500 字） */
  stem: string
  /** 库内原题自己的解析过程（截 1200 字）—— 与 stem 同一行，绝不拼接 */
  solution: string
  sourceId: string
  sourceName: string
  objectIndex: number
  label: string
  charStart: number
  charEnd: number
  /** 与题干的共现信号，用于向用户解释「为什么推荐这道」 */
  sharedSignals: string[]
  /** 去空白后的解析长度，用于排序（过程更完整的优先） */
  solutionChars: number
  /**
   * P-017 / D-020：原题快照（含图形与公式）的可访问 URL。
   * 缺失即「这道题没有快照」（转换失败 / 题干定位不到），前端不得用相邻题目的图顶替。
   */
  figureUrl?: string
  figureWidth?: number
  figureHeight?: number
  /** 该题在原文档里的页码（1 起），仅用于「查看原页」与人工核对 */
  figurePage?: number
}

/**
 * P-017 / D-020：原题快照 URL。
 *
 * 走**已公开**的 `GET /api/storage/files/*`：小程序 `<Image src>` / `previewImage`
 * 只发 GET、不带任何头部，令牌到不了服务端（见 `user-context.ts` PUBLIC_ROUTES 说明）。
 * local 驱动下 `STORAGE_PUBLIC_BASE_URL` 必须配成公网可达基址，否则前端拿到相对路径。
 */
export function figureUrlFor(key: string): string {
  const base = (process.env.STORAGE_PUBLIC_BASE_URL || '').replace(/\/+$/, '')
  return `${base}/api/storage/files/${key}`
}

export interface ReferenceValidation {
  hash: (s: string) => string
  expectedRevision: string
}

export interface CollectOptions extends ReferenceValidation {
  /** exact 已放行的对象索引（同一来源内），避免同一道题既当答案又当参考 */
  excludeObjectIndexes?: number[]
  /** 本轮上限，仍受 MAX_REFERENCES 硬顶 */
  max?: number
}

export const MIN_SOLUTION_CHARS = 60
export const MIN_SHARED_SIGNALS = 3
export const MAX_REFERENCES = 3
export const STEM_LIMIT = 500
export const SOLUTION_LIMIT = 1200

/**
 * K12 常见「知识点 / 解题方法」术语。两边题干都出现才算共现。
 * 为什么需要它：`longAnchors` 是 6 字滑窗，OCR 错字与符号写法差异会让精确滑窗
 * 几乎命不中（D-017 实测：干净几何单题仍 exact=0）。术语共现是行业里
 * 「考点 / 知识点召回」的最小可行实现，不引入向量库（见 P-015 §1）。
 * ⚠️ 本期只覆盖中文理科题干；英文 OCR 错字样本仍锁，不在此造词表硬凑。
 */
const TOPIC_TERMS = [
  '中点', '面积', '周长', '最大值', '最小值', '最值', '取值范围',
  '菱形', '矩形', '正方形', '平行四边形', '等边', '等腰', '全等', '相似',
  '三角形', '四边形', '圆', '切线', '勾股', '旋转', '平移', '对称', '折叠',
  '动点', '垂线段', '锐角', '钝角', '直角', '正弦', '余弦', '正切',
  '抛物线', '二次函数', '一次函数', '反比例函数', '方程', '不等式',
  '概率', '统计', '平均数', '中位数', '众数', '方差', '体积', '表面积',
  '证明', '数列', '因数', '倍数', '分数', '百分数', '比例', '速度', '效率',
]

/**
 * 题干与库内原题之间的共现信号。
 * ① 判定层同源长锚点（最强，精确 6 字滑窗 / 数值 / 变量名）
 * ② 学科术语共现（同知识点 / 同方法，容忍 OCR 错字）
 * ③ 大写变量名共现（同图形 / 同对象，如 BMDN / ABCD / EFC）
 */
export function sharedSignals(question: string, stem: string, longAnchors: string[]): string[] {
  const hits: string[] = []
  for (const a of longAnchors) if (stem.includes(a)) hits.push(a)
  for (const t of TOPIC_TERMS) if (question.includes(t) && stem.includes(t)) hits.push(t)
  const qVars = new Set((question.toUpperCase().match(/[A-Z]{2,6}/g) || []))
  const sVars = new Set((stem.toUpperCase().match(/[A-Z]{2,6}/g) || []))
  for (const v of qVars) if (sVars.has(v)) hits.push(v)
  return [...new Set(hits)]
}

/**
 * 从**某一份来源**的结构化对象里挑参考例题。
 * 调用方（`netdisk-search.service.ts` 深挖循环）负责对多份来源汇总、去重、再取 top-N。
 */
export function collectReferences(
  question: string,
  rows: StoredQuestionObject[],
  opts: CollectOptions,
): ReferenceExample[] {
  if (!question.trim() || !Array.isArray(rows) || rows.length === 0) return []
  const longAnchors = extractDistinctive(question).longAnchors
  const excluded = new Set(opts.excludeObjectIndexes || [])
  const validation = { hash: opts.hash, expectedRevision: opts.expectedRevision }
  const out: ReferenceExample[] = []

  for (const row of rows) {
    // ① 与 exact 链路同一套入库校验（版本 / 指纹 / link_status / 解析边界），
    //    只会减少候选，绝不放宽。
    if (validateStoredObject(row, validation)) continue
    if (excluded.has(row.object_index)) continue
    // ② 必须有解题过程：只要答案、没有推导的例题对「借鉴思路」无价值
    const solution = String(row.solution_text || '').trim()
    if (!row.has_solution || solution.replace(/\s+/g, '').length < MIN_SOLUTION_CHARS) continue
    const stem = String(row.stem_text || '').trim()
    if (!stem) continue
    const signals = sharedSignals(question, stem, longAnchors)
    if (signals.length < MIN_SHARED_SIGNALS) continue

    // 🔴 同源配对：stem / solution / 来源全部取自同一个 row
    out.push({
      stem: stem.slice(0, STEM_LIMIT),
      solution: solution.slice(0, SOLUTION_LIMIT),
      sourceId: row.source_id || '',
      sourceName: row.source_name || '',
      objectIndex: row.object_index,
      label: row.label || '',
      charStart: row.char_start,
      charEnd: row.char_end,
      sharedSignals: signals.slice(0, 8),
      solutionChars: solution.replace(/\s+/g, '').length,
    })
  }

  return out
    .sort((a, b) => b.sharedSignals.length - a.sharedSignals.length || b.solutionChars - a.solutionChars)
    .slice(0, Math.min(opts.max ?? MAX_REFERENCES, MAX_REFERENCES))
}

/** 跨来源汇总 + 去重 + 全局 top-N（调用方在深挖结束后调用一次） */
export function mergeReferences(pools: ReferenceExample[][], max = MAX_REFERENCES): ReferenceExample[] {
  const seen = new Set<string>()
  const all: ReferenceExample[] = []
  for (const pool of pools) {
    for (const r of pool) {
      const key = `${r.sourceId}#${r.objectIndex}`
      if (seen.has(key)) continue
      seen.add(key)
      all.push(r)
    }
  }
  return all
    .sort((a, b) => b.sharedSignals.length - a.sharedSignals.length || b.solutionChars - a.solutionChars)
    .slice(0, Math.min(max, MAX_REFERENCES))
}
