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
 *   IMA_KB_ID                   —— 知识库 ID，**支持逗号分隔多库**（思傅 2026-10-23 选定
 *                                   6 个 K12 订阅库合并检索，见 .env.secrets 注释）。
 *                                   多库并行请求、结果按各库相关序交错合并+按标题去重。
 *
 * ⚠️ 知识库条目没有外链：WebItem.url 置空，上层 refs 展示时按「无链接」处理。
 * ⚠️ highlight_content 含 <em> 高亮标签与 HTML 实体，必须清洗——
 *    小程序 Text 组件会把 <em> 当字面文字显示（「是<em>一</em>条」）。
 */

const IMA_SEARCH_ENDPOINT = 'https://ima.qq.com/openapi/wiki/v1/search_knowledge'
/** ima 是腾讯自家服务、本机实测 0.3s 可达，多库并行也留足余量 */
const IMA_TIMEOUT_MS = Number(process.env.IMA_SEARCH_TIMEOUT_MS || 15000)

/** 去掉高亮片段里的 HTML 标签与实体，还原成干净可读文本 */
function cleanHighlight(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 按标题归一化去重（同一文档可能出现在多个库里） */
function dedupeKey(title: string): string {
  return title.replace(/\s+/g, '').toLowerCase()
}

export class ImaKnowledgeProvider {
  private readonly logger = new Logger(ImaKnowledgeProvider.name)

  /** 解析配置的知识库 ID 列表（逗号分隔，忽略空项） */
  kbIds(): string[] {
    return (process.env.IMA_KB_ID || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }

  /** 三个凭据齐了才可用；缺任何一个都在返回里给出明确配置指引 */
  available(): boolean {
    return !!(
      (process.env.IMA_CLIENT_ID || '').trim() &&
      (process.env.IMA_API_KEY || '').trim() &&
      this.kbIds().length > 0
    )
  }

  /** 缺少的凭据名（用于生成可操作的提示，不泄露任何值） */
  missingKeys(): string[] {
    const miss: string[] = []
    if (!(process.env.IMA_CLIENT_ID || '').trim()) miss.push('IMA_CLIENT_ID')
    if (!(process.env.IMA_API_KEY || '').trim()) miss.push('IMA_API_KEY')
    if (this.kbIds().length === 0) miss.push('IMA_KB_ID')
    return miss
  }

  /** 单库检索（内部使用）：失败抛错，由上层决定整体降级策略 */
  private async searchOne(
    query: string,
    kbId: string,
    count: number,
  ): Promise<WebItem[]> {
    const clientId = (process.env.IMA_CLIENT_ID || '').trim()
    const apiKey = (process.env.IMA_API_KEY || '').trim()

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
      const highlight = cleanHighlight(String(it?.highlight_content || ''))
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
    return items
  }

  /**
   * 多库并行检索 → 按各库相关序交错合并 → 按标题去重 → 截到 count。
   *
   * 交错合并（而非简单拼接）是为了让排在前面的库不挤掉后面库的高质量命中：
   * 6 个库各取 Top N，按 库1[0],库2[0],…,库6[0],库1[1],… 的顺序交织。
   *
   * 部分库失败（无权限/超时）不拖垮整体：有成功就返回成功的，
   * 全部失败才抛错（上层转成 source=none + 明确说明）。
   */
  async search(query: string, count: number): Promise<WebItem[]> {
    const kbIds = this.kbIds()
    if (!(process.env.IMA_CLIENT_ID || '').trim() || !(process.env.IMA_API_KEY || '').trim()) {
      throw new Error(`ima 凭据不完整（缺 ${this.missingKeys().join(' / ')}）`)
    }
    if (kbIds.length === 0) {
      throw new Error('ima 凭据不完整（缺 IMA_KB_ID）')
    }

    const settled = await Promise.allSettled(
      kbIds.map((kbId) => this.searchOne(query, kbId, count)),
    )

    const errors: string[] = []
    const perKb: WebItem[][] = []
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        perKb.push(r.value)
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
        errors.push(`${kbIds[i]}: ${msg}`)
      }
    })

    if (perKb.length === 0) {
      throw new Error(`ima 全部 ${kbIds.length} 个知识库检索失败 —— ${errors[0]}`)
    }
    if (errors.length > 0) {
      this.logger.warn(`[answer-search] ima ${errors.length}/${kbIds.length} 个库失败：${errors.join(' | ')}`)
    }

    // 交错合并 + 标题去重
    const merged: WebItem[] = []
    const seen = new Set<string>()
    const depth = Math.max(...perKb.map((l) => l.length), 0)
    for (let d = 0; d < depth && merged.length < count; d++) {
      for (const list of perKb) {
        if (merged.length >= count) break
        const it = list[d]
        if (!it) continue
        const key = dedupeKey(it.title)
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(it)
      }
    }

    this.logger.log(
      `[answer-search] ima 知识库命中 ${merged.length} 条（${perKb.length}/${kbIds.length} 库成功）：${query.slice(0, 40)}`,
    )
    return merged
  }
}
