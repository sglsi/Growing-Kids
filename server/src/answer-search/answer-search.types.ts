/** 联网搜答案的类型定义（设计见「题目答案功能-设计方案.md」§3） */
// P-015 / D-018：参考例题与原题判定并列，判定层零改动
import type { ReferenceExample } from '../shared/question-reference'

/** 检索命中的一条网页 */
export interface WebItem {
  title: string
  url: string
  snippet?: string
  summary?: string
  site_name?: string
}

/**
 * 搜答案的结果。
 *
 * ⚠️ 安全阀：`source='llm'` 表示**未经联网核实**（纯模型推理），`verified=false`，
 *    前端必须明示「未联网核实」，且**只有用户点「采纳」才允许入库**，
 *    杜绝模型幻觉答案静默污染题库。
 */
export interface AnswerSearchResult {
  /**
   * search = 有真实网络来源；kb = 来自 ima 知识库；netdisk = 来自百度网盘资料；
   * llm = 无检索、纯模型推理；none = 都不可用
   */
  source: 'search' | 'kb' | 'netdisk' | 'llm' | 'none'
  /**
   * P-006 / D-009：原题判定档位。
   *  - exact = 找到了这道题并定位到它的答案/解析段 ⇒ 允许填 answer、允许采纳
   *  - topic = 只找到同主题资料 ⇒ answer 必须为空、禁止采纳
   *  - none  = 什么都没找到
   * ⚠️ 只有 mode=kb 会带；老缓存（v3 及以前）没有此字段，前端按缺省值 topic 处理更安全。
   */
  match_level?: 'exact' | 'topic' | 'none'
  /** 是否经过核实（检索类=true；纯模型推理=false） */
  verified: boolean
  answer: string
  solution: string
  /** 参考来源；知识库条目没有外链，url 为空串（前端按「无链接」展示，不提供复制） */
  refs: { title: string; url?: string }[]
  /** 相关性 0~1（检索片段与题干的显著片段重叠率） */
  confidence: number
  /** 降级 / 异常的人类可读说明 */
  note?: string
  /** 是否命中 24h 缓存 */
  cached?: boolean
  /**
   * P-009 / D-012：exact 结果的来源位置，供家长复核「答案出自哪份资料、第几题」。
   * 只在 match_level='exact' 且确实定位到题目对象时出现；topic / none 一律不带。
   * ⚠️ 与「双减」合规同向：给答案必须可追溯，不能只给一段无出处的解析。
   */
  source_location?: {
    source_id?: string
    source_name?: string
    object_index: number
    label: string
    char_start: number
    char_end: number
  }
  /**
   * P-015 / D-018：题目不完全一致但解题思路可借鉴时的库内例题。
   * 🔴 只在没有 exact 答案时出现；**永不进 answer、不置 verified=true、不提供采纳**。
   *    每条 stem 与 solution 同源配对（同一个 question_objects 行）。
   *    ⚠️ 改本结构必须 bump CACHE_VERSION，否则旧缓存会显示成没有声明的裸内容。
   */
  references?: ReferenceExample[]
  /** 事先声明文案；前端必须在渲染任何参考内容之前先渲染 */
  reference_disclaimer?: string
}

export interface SearchProvider {
  name: 'bocha' | 'none' | 'coze'
  /** 依赖的 key 是否已配置 */
  available(): boolean
  search(query: string, count: number): Promise<WebItem[]>
}
