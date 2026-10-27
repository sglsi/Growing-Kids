import { Injectable, Logger } from '@nestjs/common'
import { createHash } from 'crypto'
import { LLMClient } from '../ai/llm-provider'
import { cacheGet, cacheSet } from '../shared/mem-cache'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { TimelineService } from '../timeline/timeline.service'
import { OcrService } from '../ocr/ocr.service'
import { resolveSearchProvider } from './search-provider'
import { ImaKnowledgeProvider } from './ima-provider'
import type { AnswerSearchResult, WebItem } from './answer-search.types'

/**
 * 题目答案的三种获取方式（思傅 2026-10-23 明确拆分，互不混淆）：
 *
 *   mode=search（联网搜题）：**只做真实网络检索**，不喂给 AI 解题。
 *     直接返回最相关来源的摘要 + 参考链接，让用户自己看原文。
 *     检索不到就如实说检索不到，**绝不拿 AI 答案冒充搜索结果**。      source=search / verified=true
 *
 *   mode=kb（知识库）：**只检索 ima 知识库**，不喂给 AI。
 *     思傅自建知识库内容权威、检索秒级（联网搜题实测 83s，知识库 <2s），
 *     作为第三种解题来源；未配凭据时给出明确配置指引，绝不静默降级。    source=kb / verified=true
 *
 *   mode=ai（AI 解题）：**只做模型推理**，不检索。
 *     模型基于学科知识推导，明确标注「未联网核实」。                  source=llm / verified=false
 *
 *   三者都失败 → source=none，明确说明原因，绝不伪造。
 *
 * ⚠️ 历史：早期版本把「检索」和「推理」混在一条链里（检索成功→AI 基于检索提炼，失败→AI 纯推理），
 *    导致按钮叫「联网搜答案」但结果可能是 AI 推理——思傅 2026-10-23 指出此问题。
 *    现按「检索」与「推理」彻底分离；原 RAG 提炼（refine）随之移除。
 */

const CACHE_PREFIX = 'ans:srch:'
const QUOTA_PREFIX = 'ans:q:'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_DAILY_LIMIT = 20

/**
 * 持久化答案缓存（思傅 2026-10-24 定，为省 ima 日配额）：
 *   - 成功结果默认**永久**（ANSWER_CACHE_TTL_DAYS=0 表示不过期；设正数=保留 N 天）；
 *   - 失败/零命中结果按 ANSWER_CACHE_NEG_TTL_HOURS（默认 12h）短期记忆——
 *     防同一道搜不到的题反复白扣配额，同时不把「配额耗尽」状态永久固化。
 *   - key 含题面 hash ⇒ 题面改了自动换 key，不存在陈旧结果问题。
 */
const CACHE_PERSIST_DAYS = Number(process.env.ANSWER_CACHE_TTL_DAYS || 0)
const NEG_TTL_HOURS = Number(process.env.ANSWER_CACHE_NEG_TTL_HOURS || 12)

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

  /** 当日配额（缓存计数，Redis 后端时多实例共享）；force 刷新缓存同样计入，防止刷接口 */
  private async checkQuota(userId: string): Promise<{ ok: boolean; used: number; limit: number }> {
    const day = new Date().toISOString().slice(0, 10)
    const key = `${QUOTA_PREFIX}${userId}:${day}`
    const used = (await cacheGet<number>(key)) || 0
    const limit = this.dailyLimit()
    if (used >= limit) return { ok: false, used, limit }
    await cacheSet(key, used + 1, CACHE_TTL_MS)
    return { ok: true, used: used + 1, limit }
  }

  /**
   * 持久化缓存读取（answer_cache 表）。
   *
   * 命中即省下一次外部调用（ima 日配额 / 联网检索 83s / LLM token），
   * 这是「同一道题永不重复消耗配额」的唯一保障——内存缓存重启即丢，撑不住日配额。
   *
   * ⚠️ RLS 全注释 + service_role ⇒ 必须显式 .eq('user_id')，否则会读到别人的缓存。
   */
  private async cacheRead(
    userId: string,
    qHash: string,
    mode: string,
  ): Promise<AnswerSearchResult | null> {
    try {
      const client = getSupabaseClient()
      const { data, error } = await client
        .from('answer_cache')
        .select('result, created_at, hit_count')
        .eq('user_id', userId)
        .eq('q_hash', qHash)
        .eq('mode', mode)
        .maybeSingle()
      if (error || !data) return null

      const result = data.result as AnswerSearchResult | null
      if (!result || typeof result !== 'object') return null

      // 成功结果按 CACHE_PERSIST_DAYS（0=永久）；零命中/失败按 NEG_TTL_HOURS 短期记忆
      const ok = result.source !== 'none'
      const ttlMs = ok
        ? CACHE_PERSIST_DAYS > 0
          ? CACHE_PERSIST_DAYS * 24 * 60 * 60 * 1000
          : Number.POSITIVE_INFINITY
        : NEG_TTL_HOURS * 60 * 60 * 1000
      const age = Date.now() - new Date(String(data.created_at)).getTime()
      if (age > ttlMs) return null

      // 命中计数（best-effort：失败不影响主流程，但必须打全错）
      void client
        .from('answer_cache')
        .update({
          hit_count: Number(data.hit_count || 0) + 1,
          last_hit_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
        .eq('q_hash', qHash)
        .eq('mode', mode)
        .then(
          () => undefined,
          (e) => console.error('[answer-search] 缓存命中计数失败', e),
        )

      return result
    } catch (e) {
      // 缓存层任何异常都不能拖垮搜题主流程（降级为未命中）
      console.error('[answer-search] 持久化缓存读取失败', e)
      return null
    }
  }

  /** 持久化缓存写入（upsert：同一 user+q_hash+mode 覆盖，不动 created_at） */
  private async cacheWrite(
    userId: string,
    qHash: string,
    mode: string,
    result: AnswerSearchResult,
  ): Promise<void> {
    try {
      const client = getSupabaseClient()
      const { error } = await client.from('answer_cache').upsert(
        {
          user_id: userId,
          q_hash: qHash,
          mode,
          result: result as unknown as Record<string, unknown>,
          last_hit_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,q_hash,mode' },
      )
      if (error) throw new Error(error.message)
    } catch (e) {
      // best-effort：写缓存失败只损失「下次省配额」，不能让本次结果丢失
      console.error('[answer-search] 持久化缓存写入失败', e)
    }
  }

  async searchAnswer(
    userId: string,
    itemId: string,
    opts: { force?: boolean; mode?: 'search' | 'ai' | 'kb' } = {},
  ): Promise<AnswerSearchResult> {
    const mode: 'search' | 'ai' | 'kb' =
      opts.mode === 'ai' ? 'ai' : opts.mode === 'kb' ? 'kb' : 'search'
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

    // ③ 缓存（按题干内容哈希；⚠️ key 必须带 mode——检索结果与推理结果不能混用，
    //    否则先调过联网搜题再点 AI 解题，会拿到检索缓存冒充 AI 结果）
    //    两级：进程内存（24h，扛同一会话内的重复点击）→ 数据库（默认永久，扛重启与跨天）
    const qHash = createHash('sha256').update(question).digest('hex').slice(0, 32)
    const cacheKey = `${CACHE_PREFIX}${mode}:${qHash}`
    if (!opts.force) {
      const cached = await cacheGet<AnswerSearchResult>(cacheKey)
      if (cached) return { ...cached, cached: true }

      const persisted = await this.cacheRead(userId, qHash, mode)
      if (persisted) {
        await cacheSet(cacheKey, persisted, CACHE_TTL_MS)
        this.logger.log(
          `[answer-search] 持久化缓存命中（mode=${mode}）→ 省 1 次外部调用（ima 日配额很紧，命中即赚）`,
        )
        return { ...persisted, cached: true }
      }
    }

    // ④ 配额
    const quota = await this.checkQuota(userId)
    if (!quota.ok) {
      return {
        source: 'none', verified: false, answer: '', solution: '', refs: [], confidence: 0,
        note: `今日搜题次数已用完（${quota.limit} 次/天），明天再试`,
      }
    }

    // ⑤ 按 mode 分三条互不混淆的路径
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
    } else if (mode === 'kb') {
      // ---------- 知识库检索：只查 ima 知识库，不喂给 AI ----------
      const ima = new ImaKnowledgeProvider()
      if (!ima.available()) {
        result = {
          source: 'none', verified: false, answer: '', solution: '', refs: [], confidence: 0,
          note: `知识库未配置（缺 ${ima.missingKeys().join(' / ')}）：请在服务器 .env.secrets 填入 IMA_CLIENT_ID / IMA_API_KEY / IMA_KB_ID（ima.qq.com/agent-interface 获取）后重跑 encrypt-env 并重启后端`,
        }
      } else {
        let items: WebItem[] = []
        let kbErr = ''
        try {
          items = await ima.search(question, 8)
        } catch (e) {
          kbErr = e instanceof Error ? e.message : String(e)
          this.logger.warn(`[answer-search] ima 知识库检索失败: ${kbErr}`)
        }
        // ima 检索已按语义相关度排序，非空即采用（confidence 仅作参考信息展示）
        const conf = relevance(question, items)
        if (items.length > 0) {
          const top = items[0]
          result = {
            source: 'kb', verified: true,
            answer: (top.summary || top.snippet || '').slice(0, 500),
            solution: items.slice(0, 3).map((i) => `${i.title}：${(i.summary || i.snippet || '').slice(0, 200)}`).join('\n\n'),
            refs: items.slice(0, 5).map((i) => ({ title: i.title, url: i.url })),
            confidence: Number(conf.toFixed(2)),
            note: '来自 ima 知识库（未做 AI 整理），请核对后采纳',
          }
        } else {
          // 220021 = ima 日配额耗尽（按调用计数，零命中也扣）——专属文案，别混在泛化失败里
          const quotaHit = /220021|已达上限/.test(kbErr)
          result = {
            source: 'none', verified: false, answer: '', solution: '', refs: [], confidence: 0,
            note: quotaHit
              ? '知识库今日调用次数已达上限，请明天再试；可改试「联网搜题」或「AI 解题」'
              : kbErr
                ? `知识库检索失败（${kbErr.slice(0, 80)}），可改试「联网搜题」或「AI 解题」`
                : '知识库中未找到该题的相关内容，可改试「联网搜题」或「AI 解题」',
          }
        }
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

    // 结果入两级缓存（含 source=none：短期记忆，避免同一道搜不到的题反复白扣 ima 配额）
    await cacheSet(cacheKey, result, CACHE_TTL_MS)
    await this.cacheWrite(userId, qHash, mode, result)
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
