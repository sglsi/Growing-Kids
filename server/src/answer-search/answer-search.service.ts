import { Injectable, Logger } from '@nestjs/common'
import { createHash } from 'crypto'
import { LLMClient } from '../ai/llm-provider'
import { memGet, memSet } from '../shared/mem-cache'
import { TimelineService } from '../timeline/timeline.service'
import { OcrService } from '../ocr/ocr.service'
import { resolveSearchProvider } from './search-provider'
import type { AnswerSearchResult, WebItem } from './answer-search.types'

/**
 * 联网搜答案：博查真搜索为主，大模型为备用兜底。
 *
 * 降级矩阵（设计见「题目答案功能-设计方案.md」§3.1）：
 *   搜索成功 + 模型可用 → 模型**基于检索片段**提炼（答案有据可依，带来源）  source=search / verified=true
 *   搜索成功 + 模型不可用 → 直接返回检索摘要片段                          source=search / verified=true
 *   搜索失败 + 模型可用 → 模型纯推理                                      source=llm   / verified=false
 *   两者都不可用     → 明确报错，**绝不伪造**                              source=none
 *
 * ⚠️ 与旧 `/api/search/solve` 的本质区别：
 *    旧实现在 provider=hunyuan 时是让大模型编造 JSON 搜索结果（URL 未必真实）；
 *    本服务里「检索」与「推理」职责分离，检索结果只来自真实搜索 API。
 */

const CACHE_PREFIX = 'ans:srch:'
const QUOTA_PREFIX = 'ans:q:'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_DAILY_LIMIT = 20

/** 题干显著片段（长度≥4 的连续切片），用于相关性判定，无需分词库 */
function significantPhrases(q: string, len = 4, max = 40): string[] {
  const s = q.replace(/\s+/g, '')
  if (s.length < len) return s ? [s] : []
  const out: string[] = []
  const step = Math.max(1, Math.floor(s.length / max))
  for (let i = 0; i + len <= s.length && out.length < max; i += step) out.push(s.slice(i, i + len))
  return [...new Set(out)]
}

/** 检索片段与题干的相关性 0~1：显著片段在检索文本里的命中率 */
function relevance(question: string, items: WebItem[]): number {
  const phrases = significantPhrases(question)
  if (!phrases.length || !items.length) return 0
  const text = items.map((i) => `${i.title}\n${i.snippet || ''}\n${i.summary || ''}`).join('\n')
  let hit = 0
  for (const p of phrases) if (text.includes(p)) hit += 1
  return hit / phrases.length
}

@Injectable()
export class AnswerSearchService {
  private readonly logger = new Logger(AnswerSearchService.name)
  private llmInstance?: LLMClient

  constructor(
    private readonly timelineService: TimelineService,
    private readonly ocrService: OcrService,
  ) {}

  /** 延迟初始化：无 key 时构造不报错，调用时才抛（与 SearchService 一致） */
  private get llm(): LLMClient {
    if (!this.llmInstance) this.llmInstance = new LLMClient()
    return this.llmInstance
  }

  private dailyLimit(): number {
    const n = Number(process.env.ANSWER_SEARCH_DAILY_LIMIT || DEFAULT_DAILY_LIMIT)
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_LIMIT
  }

  /** 当日配额（mem-cache 计数）；force 刷新缓存同样计入，防止刷接口 */
  private checkQuota(userId: string): { ok: boolean; used: number; limit: number } {
    const day = new Date().toISOString().slice(0, 10)
    const key = `${QUOTA_PREFIX}${userId}:${day}`
    const used = memGet<number>(key) || 0
    const limit = this.dailyLimit()
    if (used >= limit) return { ok: false, used, limit }
    memSet(key, used + 1, CACHE_TTL_MS)
    return { ok: true, used: used + 1, limit }
  }

  async searchAnswer(
    userId: string,
    itemId: string,
    opts: { force?: boolean } = {},
  ): Promise<AnswerSearchResult> {
    // ① 取题目（含签名 URL）
    let item
    try {
      const raw = await this.timelineService.findOne(userId, itemId)
      // ⚠️ findOne 返回裸行（只有 file_key，没有签名 URL）——OCR 兜底要读
      // url/question_image_urls，必须先过 withUrls 富化（与控制器 GET /:id 同路）。
      // 2026-10-22 前此处直接用裸行，导致「图片题 OCR 题面图」兜底从未生效。
      const [enriched] = await this.timelineService.withUrls([raw])
      item = enriched
    } catch {
      return { source: 'none', verified: false, answer: '', solution: '', refs: [], confidence: 0, note: '题目不存在或无权访问' }
    }

    // ② 题干：优先结构化文本；图片题先 OCR 题面图
    let question = (item.content?.question || item.content?.stem || item.title || '').trim()
    if (!question && item.question_image_urls?.length) {
      try {
        question = (await this.ocrService.recognizeBlockText(item.question_image_urls[0]) || '').trim()
      } catch (e) {
        this.logger.warn(`[answer-search] 题面图 OCR 失败: ${e}`)
      }
    }
    // 纯图片条目（kind=image）没有 content.question_images，主图在 url 上——
    // 思傅 2026-10-22：图片题也要能联网搜题，兜底 OCR 主图
    if (!question && item.url) {
      try {
        question = (await this.ocrService.recognizeBlockText(item.url) || '').trim()
      } catch (e) {
        this.logger.warn(`[answer-search] 图片条目主图 OCR 失败: ${e}`)
      }
    }
    if (!question) {
      return {
        source: 'none', verified: false, answer: '', solution: '', refs: [], confidence: 0,
        note: '题干为空，请先填写题干或识别题面图后再搜答案',
      }
    }

    // ③ 缓存（24h，按题干内容哈希）
    const qHash = createHash('sha256').update(question).digest('hex').slice(0, 32)
    const cacheKey = `${CACHE_PREFIX}${qHash}`
    if (!opts.force) {
      const cached = memGet<AnswerSearchResult>(cacheKey)
      if (cached) return { ...cached, cached: true }
    }

    // ④ 配额
    const quota = this.checkQuota(userId)
    if (!quota.ok) {
      return {
        source: 'none', verified: false, answer: '', solution: '', refs: [], confidence: 0,
        note: `今日搜题次数已用完（${quota.limit} 次/天），明天再试`,
      }
    }

    // ⑤ 主：真实联网搜索
    const provider = resolveSearchProvider()
    let items: WebItem[] = []
    let searchErr = ''
    try {
      items = await provider.search(question, 8)
    } catch (e) {
      searchErr = String(e)
      this.logger.warn(`[answer-search] 搜索失败，降级: ${searchErr}`)
    }
    const conf = relevance(question, items)
    const usable = items.length > 0 && conf > 0

    // ⑥ 组装检索上下文
    const context = items
      .slice(0, 6)
      .map((i, idx) => `[${idx + 1}] ${i.title}\n${i.summary || i.snippet || ''}${i.url ? `\n来源: ${i.url}` : ''}`)
      .join('\n\n')
    const refs = items.filter((i) => i.url).slice(0, 5).map((i) => ({ title: i.title, url: i.url }))

    // ⑦ 提炼 / 兜底
    let result: AnswerSearchResult
    if (usable) {
      const refined = await this.refine(question, context)
      if (refined) {
        result = {
          source: 'search', verified: true, answer: refined.answer, solution: refined.solution,
          refs, confidence: Number(conf.toFixed(2)), note: '来自联网检索，请核对后采纳',
        }
      } else {
        // 模型不可用：直接给检索摘要，仍有真实来源、verified 依然为 true
        const top = items[0]
        result = {
          source: 'search', verified: true,
          answer: (top.summary || top.snippet || '').slice(0, 500),
          solution: items.slice(0, 3).map((i) => `${i.title}：${(i.summary || i.snippet || '').slice(0, 200)}`).join('\n\n'),
          refs, confidence: Number(conf.toFixed(2)),
          note: '来自联网检索（未做模型提炼），请核对后采纳',
        }
      }
    } else {
      const deduced = await this.deduce(question)
      if (deduced) {
        result = {
          source: 'llm', verified: false, answer: deduced.answer, solution: deduced.solution,
          refs: [], confidence: 0,
          note: searchErr ? `联网检索不可用（${searchErr.slice(0, 60)}），以下为模型推理结果，未联网核实` : '未检索到相关资料，以下为模型推理结果，未联网核实',
        }
      } else {
        result = {
          source: 'none', verified: false, answer: '', solution: '', refs: [], confidence: 0,
          note: '联网检索与大模型均不可用：请配置 BOCHA_API_KEY（联网检索），或任一模型 Key' +
            '（COZE_API_TOKEN 扣子 / DEEPSEEK_API_KEY DeepSeek / HUNYUAN_API_KEY 混元）后重试',
        }
      }
    }

    if (result.source !== 'none') memSet(cacheKey, result, CACHE_TTL_MS)
    return result
  }

  /** 基于检索片段提炼答案（RAG）：模型的输入被限定在检索内容里，答案可溯源 */
  private async refine(question: string, context: string): Promise<{ answer: string; solution: string } | null> {
    try {
      const r = await this.llm.invoke(
        [
          {
            role: 'system',
            content:
              '你是一名解题老师。请**严格依据下方联网检索资料**解出这道题，给出【正确答案】与【解题过程】。' +
              '若资料不足以确定答案，只能基于学科常识做严谨推导，并在解题过程开头注明「依据学科常识推导」。' +
              '只输出 JSON：{"answer_content":"最终答案","solution":"分步骤解题过程"}，不要输出 markdown 代码块或其他文字。',
          },
          { role: 'user', content: `题目：\n${question}\n\n联网检索资料：\n${context || '（无）'}` },
        ],
        { temperature: 0.2 },
      )
      return this.parseJson(r.content)
    } catch (e) {
      this.logger.warn(`[answer-search] 模型提炼失败，改为直接给检索摘要: ${e}`)
      return null
    }
  }

  /** 无检索结果时的模型兜底（明确标注未联网核实） */
  private async deduce(question: string): Promise<{ answer: string; solution: string } | null> {
    try {
      const r = await this.llm.invoke(
        [
          {
            role: 'system',
            content:
              '你是一名解题老师。下方题目没有可靠的联网检索资料，请基于学科知识严谨推导，' +
              '给出【正确答案】与【解题过程】。只输出 JSON：{"answer_content":"最终答案","solution":"分步骤解题过程"}，不要输出 markdown 代码块或其他文字。',
          },
          { role: 'user', content: `题目：\n${question}` },
        ],
        { temperature: 0.2 },
      )
      return this.parseJson(r.content)
    } catch (e) {
      this.logger.warn(`[answer-search] 模型兜底失败: ${e}`)
      return null
    }
  }

  private parseJson(raw: string): { answer: string; solution: string } | null {
    const text = (raw || '').trim()
    if (!text) return null
    // 1) 优先按 JSON 解析（混元/DeepSeek 遵循 JSON 指令时走这里）
    let s = text.replace(/^```(json)?/i, '').replace(/```$/, '').trim()
    const start = s.indexOf('{')
    const end = s.lastIndexOf('}')
    if (start !== -1 && end !== -1) s = s.slice(start, end + 1)
    try {
      const p = JSON.parse(s) as { answer_content?: string; solution?: string }
      if (p.answer_content || p.solution) {
        return { answer: String(p.answer_content || ''), solution: String(p.solution || '') }
      }
    } catch {
      /* JSON 解析失败 → 落到下面的标签提取 */
    }
    // 2) 扣子 bot 人设输出【答案】/【解析】散文（可能不遵循 JSON 指令）→ 按标签拆分，
    //    避免 answer 空、正文全落 solution。兼容 【正确答案】/【解题过程】/【解题步骤】 等变体。
    const labeled = this.extractLabeled(text)
    if (labeled && (labeled.answer || labeled.solution)) return labeled
    // 3) 完全无结构：整段当 solution（不伪造 answer）
    return { answer: '', solution: text }
  }

  /** 从【答案】…【解析】散文里拆出 answer/solution；找不到标签返回 null */
  private extractLabeled(raw: string): { answer: string; solution: string } | null {
    // 列表顺序即优先级：长/方括号标签在前，避免 【答案】 命中 【正确答案】 的子串
    const ansLabels = ['【正确答案】', '【答案】', '答案：', '答案:']
    const solLabels = ['【解题过程】', '【解题步骤】', '【解析】', '解析：', '解析:']
    const pick = (labels: string[]) => {
      for (const l of labels) {
        const i = raw.indexOf(l)
        if (i !== -1) return { idx: i, label: l }
      }
      return null
    }
    const ans = pick(ansLabels)
    const sol = pick(solLabels)
    if (!ans && !sol) return null
    let answer = ''
    let solution = ''
    if (ans) {
      const ansStart = ans.idx + ans.label.length
      const ansEnd = sol && sol.idx > ansStart ? sol.idx : raw.length
      answer = raw.slice(ansStart, ansEnd).trim()
    }
    if (sol) {
      solution = raw.slice(sol.idx + sol.label.length).trim()
    }
    if (!answer && !solution) return null
    return { answer, solution }
  }
}
