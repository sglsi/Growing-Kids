import { Injectable } from '@nestjs/common'
import { LLMClient, SearchClient, type SearchResponse } from 'coze-coding-dev-sdk'

const MODEL = 'doubao-seed-2-0-pro-260215'

@Injectable()
export class SearchService {
  private readonly llm: LLMClient
  private readonly searchClient: SearchClient

  constructor() {
    this.llm = new LLMClient()
    this.searchClient = new SearchClient()
  }

  async solveQuestion(questionContent: string): Promise<{
    answer_content: string
    solution: string
    references: { title: string; url: string; site_name?: string }[]
  }> {
    if (!questionContent?.trim()) {
      return { answer_content: '', solution: '', references: [] }
    }

    console.log('[search/solve] 检索题目:', questionContent)
    const searchResult: SearchResponse = await this.searchClient.advancedSearch(questionContent, {
      searchType: 'web',
      count: 8,
      needContent: true,
      needUrl: true,
    })

    const webItems = searchResult.web_items || []
    const context = webItems
      .map(
        (item, idx) =>
          `[${idx + 1}] ${item.title}\n${item.summary || ''}\n${(item.content || '').slice(0, 600)}${item.url ? `\n来源: ${item.url}` : ''}`,
      )
      .join('\n\n')

    const references = webItems
      .filter((i) => i.url)
      .slice(0, 5)
      .map((i) => ({ title: i.title, url: i.url as string, site_name: i.site_name }))

    const response = await this.llm.invoke(
      [
        {
          role: 'system',
          content:
            '你是一名解题老师。请根据下方网络检索资料解出这道题，给出【正确答案】与【解题过程】。若检索资料不足以确定答案，请基于学科知识严谨推导。只输出 JSON：{"answer_content":"最终答案","solution":"分步骤的详细解题过程"}，不要输出 markdown 代码块或其他文字。',
        },
        {
          role: 'user',
          content: `题目：\n${questionContent}\n\n网络检索资料：\n${context || '（无有效检索结果，请自行解答）'}`,
        },
      ],
      { model: MODEL, temperature: 0.2 },
    )

    console.log('[search/solve] 模型返回:', response.content)
    let cleaned = response.content.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim()
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1)

    let parsed: { answer_content: string; solution: string }
    try {
      parsed = JSON.parse(cleaned)
    } catch {
      parsed = { answer_content: '', solution: response.content }
    }

    return {
      answer_content: parsed.answer_content || '',
      solution: parsed.solution || '',
      references,
    }
  }
}
