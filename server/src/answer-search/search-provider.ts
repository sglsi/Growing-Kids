import { Logger } from '@nestjs/common'
import { aiProviderName } from '../ai/llm-provider'
import type { SearchProvider, WebItem } from './answer-search.types'

/**
 * 搜索源适配层（可插拔）—— 设计见「题目答案功能-设计方案.md」§3.3
 *
 * 为什么要有这一层：
 *   现有 `ai/llm-provider.ts` 的 SearchClient 在 provider=hunyuan 时是**让大模型
 *   自己编一份 JSON 冒充搜索结果**（URL 不由检索系统保证），这不是真搜索。
 *   本模块把「真检索」抽成独立 provider，任何一家不可用就降级 `none`，
 *   由上层决定是否走大模型兜底。**没有 key 也能上线**，key 后补即自动升级为真搜索。
 *
 * 博查接口（已核实）：
 *   POST https://api.bochaai.com/v1/web-search
 *   Authorization: Bearer <BOCHA_API_KEY>
 *   body: { query, summary, freshness, count }
 *   ⚠️ 返回包裹有两种口径（顶层 webPages / data.webPages），必须都兼容。
 */

const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search'
const SEARCH_TIMEOUT_MS = 8000

class BochaProvider implements SearchProvider {
  name = 'bocha' as const
  private readonly logger = new Logger(BochaProvider.name)

  available(): boolean {
    return !!(process.env.BOCHA_API_KEY || '').trim()
  }

  async search(query: string, count: number): Promise<WebItem[]> {
    const key = (process.env.BOCHA_API_KEY || '').trim()
    if (!key) throw new Error('未配置 BOCHA_API_KEY')

    const res = await fetch(BOCHA_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        summary: true,
        freshness: 'noLimit',
        count: Math.min(Math.max(count, 1), 10),
      }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`博查返回 ${res.status}: ${text.slice(0, 200)}`)
    }
    const json = (await res.json()) as Record<string, any>
    // 两种包裹口径都兼容，否则会静默拿到 0 条
    const list: any[] = json?.data?.webPages?.value ?? json?.webPages?.value ?? []
    const items: WebItem[] = []
    for (const it of list) {
      const url = it?.url
      if (!url || typeof url !== 'string') continue
      items.push({
        title: String(it?.name || ''),
        url,
        snippet: String(it?.snippet || ''),
        summary: String(it?.summary || ''),
        site_name: String(it?.siteName || ''),
      })
    }
    this.logger.log(`[answer-search] 博查命中 ${items.length} 条：${query.slice(0, 40)}`)
    return items
  }
}

/** 无搜索源：永远返回空，让上层走大模型兜底 */
class NoneProvider implements SearchProvider {
  name = 'none' as const
  available(): boolean {
    return false
  }
  async search(): Promise<WebItem[]> {
    return []
  }
}

/**
 * 扣子联网检索（思傅 2026-10-22 定：AI_PROVIDER=coze 时联网搜也走扣子）。
 * 复用 llm-provider 的 cozeChatSync 调 bot（bot 须已开启联网插件），
 * 要求 bot 以 JSON 数组返回来源，解析失败则降级为空（上层走大模型兜底，绝不伪造）。
 */
class CozeBotSearchProvider implements SearchProvider {
  name = 'coze' as const
  private readonly logger = new Logger(CozeBotSearchProvider.name)
  available(): boolean {
    return (
      aiProviderName() === 'coze' &&
      !!(process.env.COZE_BOT_ID || '').trim() &&
      !!(process.env.COZE_API_TOKEN || '').trim()
    )
  }
  async search(query: string, count: number): Promise<WebItem[]> {
    const { cozeChatSync } = await import('../ai/llm-provider')
    const prompt =
      `请联网搜索以下问题/关键词的答案，并以 JSON 数组返回最相关的 ${count} 条来源，` +
      `每条格式：{"title":标题,"url":网址,"snippet":摘要}。只返回 JSON 数组本身，不要其他文字。\n问题：${query}`
    try {
      const { content } = await cozeChatSync([{ role: 'user', content: prompt }])
      const m = content.match(/\[[\s\S]*\]/)
      const arr: any[] = m ? JSON.parse(m[0]) : []
      const items: WebItem[] = []
      for (const it of arr) {
        if (it?.url && typeof it.url === 'string') {
          items.push({ title: String(it.title || ''), url: it.url, snippet: String(it.snippet || '') })
        }
      }
      this.logger.log(`[answer-search] 扣子联网命中 ${items.length} 条：${query.slice(0, 40)}`)
      return items
    } catch (e) {
      this.logger.warn(`[answer-search] 扣子联网解析失败，降级为空（上层走模型兜底）：${e}`)
      return []
    }
  }
}

/**
 * 按配置取搜索源。
 * `ANSWER_SEARCH_PROVIDER=bocha`（默认）且配了 BOCHA_API_KEY 才用博查；
 * 否则一律降级 `none` —— 宁可走大模型兜底，也绝不返回伪造的检索结果。
 */
export function resolveSearchProvider(): SearchProvider {
  // 思傅 2026-10-22：AI_PROVIDER=coze 时，联网检索也走扣子 bot（需已发布为 API 且开启联网插件）
  if (
    aiProviderName() === 'coze' &&
    (process.env.COZE_BOT_ID || '').trim() &&
    (process.env.COZE_API_TOKEN || '').trim()
  ) {
    return new CozeBotSearchProvider()
  }
  const want = (process.env.ANSWER_SEARCH_PROVIDER || 'bocha').trim().toLowerCase()
  if (want === 'none') return new NoneProvider()
  const bocha = new BochaProvider()
  if (bocha.available()) return bocha
  return new NoneProvider()
}
