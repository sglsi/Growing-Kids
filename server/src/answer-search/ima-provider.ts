import { Logger } from '@nestjs/common'
import type { WebItem } from './answer-search.types'

/**
 * ima 知识库检索 provider（思傅 2026-10-23：把 ima 知识库接入小程序，
 * 作为第三种解题来源——知识库检索是秒级，解决联网搜题 83s 太慢的问题）。
 *
 * 接口（ima 开放平台 OpenAPI，已多渠道核实）：
 *   POST https://ima.qq.com/openapi/wiki/v1/search_knowledge
 *   Headers: ima-openapi-clientid / ima-openapi-apikey / Content-Type: application/json
 *           ⚠️ 两个自定义头传凭据，不是 Bearer Authorization；缺 Content-Type 会被拒
 *   Body:    { query, cursor: "", knowledge_base_id }
 *   返回:    { code: 0, msg, data: { info_list: [{ media_id, title,
 *            parent_folder_id, highlight_content }], is_end, next_cursor } }
 *   code≠0 即失败（msg 人类可读，直接透出）；个别老接口用 { retcode, errmsg }，两种都兼容。
 *
 * 凭据（放 .env.secrets，与 BOCHA_API_KEY/COZE_API_TOKEN 同模式；
 *      改后必须重跑 node server/scripts/encrypt-env.mjs 并重启后端）：
 *   IMA_CLIENT_ID / IMA_API_KEY —— https://ima.qq.com/agent-interface 获取（API Key 只显示一次）
 *   IMA_KB_ID                   —— 目标知识库 ID（ima 客户端知识库设置里查看）
 *
 * ⚠️ 知识库条目没有外链：WebItem.url 置空，上层 refs 展示时按「无链接」处理。
 */

const IMA_SEARCH_ENDPOINT = 'https://ima.qq.com/openapi/wiki/v1/search_knowledge'
/** ima 是腾讯自家服务、本机实测 0.3s 可达，但仍留足余量 */
const IMA_TIMEOUT_MS = Number(process.env.IMA_SEARCH_TIMEOUT_MS || 15000)

export class ImaKnowledgeProvider {
  private readonly logger = new Logger(ImaKnowledgeProvider.name)

  /** 三个凭据齐了才可用；缺任何一个都在返回里给出明确配置指引 */
  available(): boolean {
    return !!(
      (process.env.IMA_CLIENT_ID || '').trim() &&
      (process.env.IMA_API_KEY || '').trim() &&
      (process.env.IMA_KB_ID || '').trim()
    )
  }

  /** 缺少的凭据名（用于生成可操作的提示，不泄露任何值） */
  missingKeys(): string[] {
    const miss: string[] = []
    if (!(process.env.IMA_CLIENT_ID || '').trim()) miss.push('IMA_CLIENT_ID')
    if (!(process.env.IMA_API_KEY || '').trim()) miss.push('IMA_API_KEY')
    if (!(process.env.IMA_KB_ID || '').trim()) miss.push('IMA_KB_ID')
    return miss
  }

  async search(query: string, count: number): Promise<WebItem[]> {
    const clientId = (process.env.IMA_CLIENT_ID || '').trim()
    const apiKey = (process.env.IMA_API_KEY || '').trim()
    const kbId = (process.env.IMA_KB_ID || '').trim()
    if (!clientId || !apiKey || !kbId) {
      throw new Error(`ima 凭据不完整（缺 ${this.missingKeys().join(' / ')}）`)
    }

    const res = await fetch(IMA_SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        'ima-openapi-clientid': clientId,
        'ima-openapi-apikey': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        cursor: '',
        knowledge_base_id: kbId,
      }),
      signal: AbortSignal.timeout(IMA_TIMEOUT_MS),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`ima 返回 HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    const json = (await res.json()) as Record<string, any>
    // 两种错误口径都兼容：{ code, msg } 与 { retcode, errmsg }
    const code = json?.code ?? json?.retcode
    if (code !== undefined && code !== 0) {
      throw new Error(`ima 错误 ${code}: ${String(json?.msg || json?.errmsg || '未知错误').slice(0, 200)}`)
    }
    const list: any[] = json?.data?.info_list ?? []
    const items: WebItem[] = []
    for (const it of list.slice(0, Math.max(1, count))) {
      const title = String(it?.title || '').trim()
      const highlight = String(it?.highlight_content || '').trim()
      // 没有标题也没有高亮内容的条目（如纯文件夹命中）没有展示价值，跳过
      if (!title && !highlight) continue
      items.push({
        title: title || '（无标题）',
        url: '', // 知识库条目无外链
        snippet: highlight,
        summary: highlight,
        site_name: 'ima 知识库',
      })
    }
    this.logger.log(`[answer-search] ima 知识库命中 ${items.length} 条：${query.slice(0, 40)}`)
    return items
  }
}
