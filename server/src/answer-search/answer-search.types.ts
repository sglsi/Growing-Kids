/** 联网搜答案的类型定义（设计见「题目答案功能-设计方案.md」§3） */

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
  /** search = 有真实检索来源；llm = 无检索、纯模型推理；none = 搜索与模型都不可用 */
  source: 'search' | 'llm' | 'none'
  /** 是否经过联网核实 */
  verified: boolean
  answer: string
  solution: string
  refs: { title: string; url: string }[]
  /** 相关性 0~1（检索片段与题干的显著片段重叠率） */
  confidence: number
  /** 降级 / 异常的人类可读说明 */
  note?: string
  /** 是否命中 24h 缓存 */
  cached?: boolean
}

export interface SearchProvider {
  name: 'bocha' | 'none' | 'coze'
  /** 依赖的 key 是否已配置 */
  available(): boolean
  search(query: string, count: number): Promise<WebItem[]>
}
