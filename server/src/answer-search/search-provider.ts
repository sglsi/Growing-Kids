import { Logger } from '@nestjs/common'
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
 * 按配置取搜索源。
 * `ANSWER_SEARCH_PROVIDER=bocha`（默认）且配了 BOCHA_API_KEY 才用博查；
 * 否则一律降级 `none` —— 宁可走大模型兜底，也绝不返回伪造的检索结果。
 */
export function resolveSearchProvider(): SearchProvider {
  const want = (process.env.ANSWER_SEARCH_PROVIDER || 'bocha').trim().toLowerCase()
  if (want === 'none') return new NoneProvider()
  const bocha = new BochaProvider()
  if (bocha.available()) return bocha
  return new NoneProvider()
}
