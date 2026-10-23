import { Injectable, Logger } from '@nestjs/common'
import { createHash } from 'crypto'
import { LLMClient } from '../ai/llm-provider'
import { memGet, memSet } from '../shared/mem-cache'
import { TimelineService } from '../timeline/timeline.service'
import { OcrService } from '../ocr/ocr.service'
import { resolveSearchProvider } from './search-provider'
import type { AnswerSearchResult, WebItem } from './answer-search.types'

/**
 * 题目答案的两种获取方式（思傅 2026-10-23 明确拆分，互不混淆）：
 *
 *   mode=search（联网搜题）：**只做真实网络检索**，不喂给 AI 解题。
 *     直接返回最相关来源的摘要 + 参考链接，让用户自己看原文。
 *     检索不到就如实说检索不到，**绝不拿 AI 答案冒充搜索结果**。      source=search / verified=true
 *
 *   mode=ai（AI 解题）：**只做模型推理**，不检索。
 *     模型基于学科知识推导，明确标注「未联网核实」。                  source=llm / verified=false
 *
 *   两者都失败 → source=none，明确说明原因，绝不伪造。
 *
 * ⚠️ 历史：早期版本把两者混在一条链里（检索成功→AI 基于检索提炼，失败→AI 纯推理），
 *    导致按钮叫「联网搜答案」但结果可能是 AI 推理——思傅 2026-10-23 指出此问题。
 *    现按「检索」与「推理」彻底分离；原 RAG 提炼（refine）随之移除。
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
    opts: { force?: boolean; mode?: 'search' | 'ai' } = {},
  ): Promise<AnswerSearchResult> {
    const mode: 'search' | 'ai' = opts.mode === 'ai' ? 'ai' : 'search'
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

    // ③ 缓存（24h，按题干内容哈希；⚠️ key 必须带 mode——检索结果与推理结果不能混用，
    //    否则先调过联网搜题再点 AI 解题，会拿到检索缓存冒充 AI 结果）
    const qHash = createHash('sha256').update(question).digest('hex').slice(0, 32)
    const cacheKey = `${CACHE_PREFIX}${mode}:${qHash}`
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

    // ⑤ 按 mode 分两条互不混淆的路径
    let result: AnswerSearchResult

    if (mode === 'ai') {
      // ---------- AI 解题：只推理，不检索 ----------
      const deduced = await this.deduce(question)
      result = deduced
        ? {
            source: 'llm', verified: false, answer: deduced.answer, solution: deduced.solution,
            refs: [], confidence: 0,
            note: 'AI 推理结果，未联网核实，请自行判断',
          }
        : {
            source: 'none', verified: false, answer: '', solution: '', refs: [], confidence: 0,
            note: 'AI 解题失败：请检查模型 Key（COZE_API_TOKEN 扣子 / DEEPSEEK_API_KEY DeepSeek / HUNYUAN_API_TOKEN 混元）后重试',
          }
    } else {
      // ---------- 联网搜题：只检索，不喂给 AI ----------
      const provider = resolveSearchProvider()
      let items: WebItem[] = []
      let searchErr = ''
      try {
        items = await provider.search(question, 8)
      } catch (e) {
        searchErr = String(e)
        this.logger.warn(`[answer-search] 检索失败: ${searchErr}`)
      }
      const conf = relevance(question, items)
      const usable = items.length > 0 && conf > 0
      const refs = items.filter((i) => i.url).slice(0, 5).map((i) => ({ title: i.title, url: i.url }))

      if (usable) {
        // 直接给来源摘要，不做 AI 整理——用户点链接看原文，答案可溯源
        const top = items[0]
        result = {
          source: 'search', verified: true,
          answer: (top.summary || top.snippet || '').slice(0, 500),
          solution: items.slice(0, 3).map((i) => `${i.title}：${(i.summary || i.snippet || '').slice(0, 200)}`).join('\n\n'),
          refs, confidence: Number(conf.toFixed(2)),
          note: '来自网络检索（未做 AI 整理），请核对后采纳',
        }
      } else {
        result = {
          source: 'none', verified: false, answer: '', solution: '', refs: [], confidence: 0,
          note: searchErr
            ? `联网检索失败（${searchErr.slice(0, 60)}），可改试「AI 解题」`
            : '未在网络上检索到该题的相关资料，可改试「AI 解题」',
        }
      }
    }

    if (result.source !== 'none') memSet(cacheKey, result, CACHE_TTL_MS)
    return result
  }

  /** AI 解题（mode=ai）：只做模型推理，不联网检索，结果明确标注未核实 */
  private async deduce(question: string): Promise<{ answer: string; solution: string } | null> {
    try {
      const r = await this.llm.invoke(
        [
          {
            role: 'system',
            content:
              '你是一名解题老师。请基于学科知识严谨推导下方题目，' +
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
