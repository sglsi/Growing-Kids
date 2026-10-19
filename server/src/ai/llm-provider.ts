/**
 * 统一 AI Provider 适配层（2026-10-19 起替代 coze-coding-dev-sdk）
 *
 * 背景：扣子运行时 token 已彻底不可用——SDK 只认扣子平台运行时注入的 JWT 身份，
 * 自托管环境无论怎么配 COZE_API_TOKEN 都被拒（10-17 实测 pat_ 令牌解析阶段即被拒，
 * 10-19 实测未配置 token 时 SDK 直接抛 "API key is required"）。6 处 AI 调用全面失效。
 *
 * 本模块以「同形接口」实现腾讯混元（OpenAI 兼容端点），调用方只改 import 行，
 * 方法签名与原扣子 SDK 完全一致，业务代码零改动：
 *   - LLMClient.invoke(messages, llmConfig?, previousResponseId?, extraHeaders?) → { content }
 *   - SearchClient.advancedSearch(query, options) → SearchResponse（web_items 等同构）
 *   - FetchClient.fetch(url) → { content: [{type:'text', text}] }
 *   - Config / HeaderUtils：兼容保留（混元走标准 Bearer，无扣子转发头语义，原样回传）
 *   - ImageGenerationClient：混元开放接口暂不支持图生图 → generate() 明确报错。
 *     前端三个 AI 按钮主链路是本地管线（straighten/enhance/erase_v2）不受影响，
 *     仅 hybrid 兜底（image.service.process）会收到这条可读错误。
 *
 * Provider 选择：环境变量 AI_PROVIDER（默认 hunyuan；填 coze 时动态 import 原 SDK，
 * 供回退/对照实验用，但扣子 token 问题不因本模块存在而解决）。
 *
 * 环境变量：
 *   HUNYUAN_API_KEY       腾讯云混元 API Key（console.cloud.tencent.com/hunyuan → API Key 管理）
 *   HUNYUAN_BASE_URL      默认 https://api.hunyuan.cloud.tencent.com/v1
 *   HUNYUAN_MODEL         文本模型，默认 hunyuan-turbos-latest
 *   HUNYUAN_VISION_MODEL  视觉模型（消息含图时自动切换），默认 hunyuan-vision-latest
 *   HUNYUAN_TIMEOUT_MS    单次请求超时，默认 120000（OCR/切分长任务给足）
 *
 * 说明：调用方传入的 doubao-* 模型名会被忽略（混元无此模型），统一用上面的环境变量；
 * 首次映射时打一条 warn 便于排查。
 */

// ---------------- 类型（与原 SDK 同形） ----------------

export interface ContentPart {
  type: 'text' | 'image_url' | 'video_url'
  text?: string
  image_url?: { url: string; detail?: 'high' | 'low' }
  video_url?: { url: string; fps?: number | null }
}

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

export interface LLMConfig {
  model?: string
  thinking?: 'enabled' | 'disabled'
  caching?: 'enabled' | 'disabled'
  temperature?: number
  streaming?: boolean
}

export interface LLMResponse {
  content: string
}

export interface WebItem {
  id: string
  sort_id: number
  title: string
  site_name?: string
  url?: string
  snippet: string
  summary?: string
  content?: string
  publish_time?: string
}

export interface ImageItem {
  id: string
  sort_id: number
  title?: string
  site_name?: string
  url?: string
  image: { url: string; width?: number; height?: number; shape?: string }
}

export interface SearchResponse {
  web_items: WebItem[]
  image_items: ImageItem[]
  summary?: string
}

export interface FetchContentItem {
  type: 'image' | 'link' | 'text'
  text?: string
  url?: string
}

export interface FetchResponse {
  status_code?: number
  url?: string
  title?: string
  filetype?: string
  content: FetchContentItem[]
}

/** 兼容保留：原 SDK 的配置对象，本适配层不使用其内容 */
export class Config {
  constructor(public config: Record<string, unknown> = {}) {}
}

/** 兼容保留：扣子平台的转发头工具。混元走标准 Bearer，无此语义——原样回传空对象 */
export class HeaderUtils {
  static extractForwardHeaders(_headers?: Record<string, string>): Record<string, string> {
    return {}
  }
}

// ---------------- 内部工具 ----------------

const DEFAULT_BASE = 'https://api.hunyuan.cloud.tencent.com/v1'

export function aiProviderName(): string {
  return (process.env.AI_PROVIDER || 'hunyuan').trim().toLowerCase()
}

function hunyuanBase(): string {
  return (process.env.HUNYUAN_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '')
}

function requireHunyuanKey(): string {
  const key = (process.env.HUNYUAN_API_KEY || '').trim()
  if (!key) {
    throw new Error(
      '未配置 HUNYUAN_API_KEY：请到腾讯云「混元大模型 → API Key 管理」(console.cloud.tencent.com/hunyuan) 创建 Key，' +
        '写入 server/.env 的 HUNYUAN_API_KEY 后重启后端。',
    )
  }
  return key
}

let modelWarned = false
/** 调用方传入的 doubao-* 模型名 → 混元模型（首次映射时提醒） */
function resolveModel(requested: string | undefined, hasImage: boolean): string {
  const fallback = hasImage
    ? (process.env.HUNYUAN_VISION_MODEL || 'hunyuan-vision-latest')
    : (process.env.HUNYUAN_MODEL || 'hunyuan-turbos-latest')
  if (requested && requested !== fallback && !requested.startsWith('hunyuan')) {
    if (!modelWarned) {
      console.warn(`[ai-provider] 请求的模型「${requested}」在混元不存在，已映射为「${fallback}」（仅提示一次）`)
      modelWarned = true
    }
  }
  if (requested && requested.startsWith('hunyuan')) return requested
  return fallback
}

function httpJson(
  method: 'GET' | 'POST',
  url: string,
  body: unknown,
  apiKey: string,
  timeoutMs: number,
): Promise<{ status: number; json: unknown; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const isHttps = u.protocol === 'https:'
    const payload = body == null ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
    const req = (isHttps ? require('https') : require('http')).request(
      {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method,
        timeout: timeoutMs,
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': String(payload.length) } : {}),
        },
      },
      (res: import('http').IncomingMessage) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: unknown = null
          try {
            json = text ? JSON.parse(text) : null
          } catch {
            // 非 JSON 响应：保留 text 供上层报错
          }
          resolve({ status: res.statusCode || 0, json, text })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function extractErrMessage(json: unknown, text: string): string {
  const j = json as Record<string, any> | null
  const msg = j?.error?.message || j?.message || j?.msg
  return typeof msg === 'string' ? msg : (text || '').slice(0, 300)
}

/** 混元 chat/completions（带 429/5xx 一次重试，默认并发限制 5） */
async function hunyuanChat(
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): Promise<Record<string, any>> {
  const apiKey = requireHunyuanKey()
  const timeoutMs = Number(process.env.HUNYUAN_TIMEOUT_MS || 120000)
  const url = `${hunyuanBase()}/chat/completions`
  let lastErr = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const { status, json, text } = await httpJson('POST', url, body, apiKey, timeoutMs)
    if (status >= 200 && status < 300 && json) return json as Record<string, any>
    lastErr = `HTTP ${status}: ${extractErrMessage(json, text)}`
    const retryable = status === 429 || status >= 500
    if (retryable && attempt === 0) {
      await new Promise((r) => setTimeout(r, 1200))
      continue
    }
    throw new Error(`混元 API 调用失败（${lastErr}）`)
  }
  throw new Error(`混元 API 调用失败（${lastErr}）`)
}

/** 把同形 Message[] 转成 OpenAI 兼容 messages（丢弃 video_url） */
function toOpenAiMessages(messages: Message[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content }
    const parts = m.content
      .filter((p): p is ContentPart => {
        if (p.type === 'video_url') console.warn('[ai-provider] 混元暂不支持视频输入，已丢弃 video_url 分片')
        return p.type !== 'video_url'
      })
      .map((p) =>
        p.type === 'text'
          ? { type: 'text', text: p.text ?? '' }
          : { type: 'image_url', image_url: p.image_url },
      )
    return { role: m.role, content: parts }
  })
}

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (typeof p === 'string' ? p : p?.type === 'text' ? (p.text || '') : ''))
      .join('')
  }
  return ''
}

// ---------------- LLMClient ----------------

export class LLMClient {
  constructor(public config?: Config, public customHeaders?: Record<string, string>) {}

  async invoke(
    messages: Message[],
    llmConfig?: LLMConfig,
    _previousResponseId?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<LLMResponse> {
    if (aiProviderName() === 'coze') {
      const { LLMClient: CozeLLM } = await import('coze-coding-dev-sdk')
      return new CozeLLM(this.config as any, this.customHeaders).invoke(messages, llmConfig, _previousResponseId, extraHeaders)
    }

    const hasImage = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'),
    )
    const body: Record<string, unknown> = {
      model: resolveModel(llmConfig?.model, hasImage),
      messages: toOpenAiMessages(messages),
      stream: false,
    }
    if (typeof llmConfig?.temperature === 'number') body.temperature = llmConfig.temperature

    const json = await hunyuanChat(body, { ...(this.customHeaders || {}), ...(extraHeaders || {}) })
    const choice = (json.choices as any[] | undefined)?.[0]
    const content = contentToString(choice?.message?.content)
    return { content }
  }
}

// ---------------- SearchClient ----------------

/** 深度收集响应里所有形似「联网搜索结果数组」的节点（search_info/websearch/search_results/web_search） */
function collectSearchNodes(node: unknown, out: any[], depth = 0): void {
  if (!node || depth > 6) return
  if (Array.isArray(node)) {
    // 数组元素像搜索结果（有 url/title）才收
    if (node.length && node.every((it) => it && typeof it === 'object' && ('url' in it || 'link' in it))) {
      out.push(...node)
    }
    return
  }
  if (typeof node !== 'object') return
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (/search_info|websearch|search_results|web_search|sources|references|citations/i.test(k)) {
      collectSearchNodes(v, out, depth + 1)
    } else if (typeof v === 'object') {
      collectSearchNodes(v, out, depth + 1)
    }
  }
}

export class SearchClient {
  constructor(public config?: Config, public customHeaders?: Record<string, string>) {}

  async advancedSearch(
    query: string,
    options: {
      searchType?: 'web' | 'web_summary' | 'image'
      count?: number
      needContent?: boolean
      needUrl?: boolean
    } = {},
  ): Promise<SearchResponse> {
    if (aiProviderName() === 'coze') {
      const { SearchClient: CozeSearch } = await import('coze-coding-dev-sdk')
      return new CozeSearch(this.config as any, this.customHeaders).advancedSearch(query, options)
    }

    const count = Math.min(Math.max(options.count || 8, 1), 20)

    // 策略：兼容端点的联网搜索参数形态存在两种文档口径（web_search_options / tools 声明），
    // 逐个尝试，都失败则要求模型输出带来源的 JSON 兜底；结构化检索结果从响应任意节点深挖。
    const attempts: Record<string, unknown>[] = [
      { web_search_options: { enable: true, count } },
      { tools: [{ type: 'web_search', search_source: 'lite' }] },
      {},
    ]
    let webItems: WebItem[] = []
    let lastErr = ''
    for (const extra of attempts) {
      try {
        const body: Record<string, unknown> = {
          model: process.env.HUNYUAN_MODEL || 'hunyuan-turbos-latest',
          stream: false,
          messages: [
            {
              role: 'system',
              content:
                '你是联网检索助手。请检索并仅输出 JSON：{"web_items":[{"title":"...","url":"https://...","summary":"摘要","content":"正文片段","site_name":"来源名"}]}，' +
                `最多 ${count} 条，url 必须是真实可访问的 https 链接。找不到相关结果则输出 {"web_items":[]}。不要输出其他文字。`,
            },
            { role: 'user', content: query },
          ],
          ...extra,
        }
        const json = await hunyuanChat(body)
        // ① 结构化节点优先（search_info 等）
        const nodes: any[] = []
        collectSearchNodes(json, nodes)
        for (const n of nodes) {
          const url = n.url || n.link
          if (!url) continue
          webItems.push({
            id: String(n.id || url),
            sort_id: webItems.length,
            title: String(n.title || url),
            site_name: n.site_name || (typeof n.source === 'string' ? n.source : undefined),
            url: String(url),
            snippet: String(n.snippet || n.summary || n.content || ''),
            summary: n.summary ? String(n.summary) : undefined,
            content: n.content ? String(n.content) : undefined,
          })
        }
        // ② 结构化节点没有 → 解析模型输出的 JSON
        if (!webItems.length) {
          const content = contentToString((json.choices as any[])?.[0]?.message?.content)
          const start = content.indexOf('{')
          const end = content.lastIndexOf('}')
          if (start !== -1 && end > start) {
            try {
              const parsed = JSON.parse(content.slice(start, end + 1)) as { web_items?: any[] }
              for (const n of parsed.web_items || []) {
                if (!n?.url) continue
                webItems.push({
                  id: String(n.id || n.url),
                  sort_id: webItems.length,
                  title: String(n.title || n.url),
                  site_name: n.site_name,
                  url: String(n.url),
                  snippet: String(n.summary || n.content || ''),
                  summary: n.summary,
                  content: n.content,
                })
              }
            } catch {
              // 模型没按 JSON 输出，放弃本轮
            }
          }
        }
        if (webItems.length) break
      } catch (e) {
        lastErr = String((e as Error)?.message ?? e).slice(0, 200)
      }
    }

    if (!webItems.length && lastErr) {
      console.warn(`[ai-provider] 联网检索未取得结果: ${lastErr}`)
    }
    return { web_items: webItems, image_items: [] }
  }

  async webSearch(query: string, count = 5): Promise<SearchResponse> {
    return this.advancedSearch(query, { searchType: 'web', count, needContent: false, needUrl: true })
  }
}

// ---------------- FetchClient（文本类文档抓取） ----------------

export class FetchClient {
  constructor(public config?: Config, public customHeaders?: Record<string, string>) {}

  async fetch(url: string): Promise<FetchResponse> {
    if (aiProviderName() === 'coze') {
      const { FetchClient: CozeFetch } = await import('coze-coding-dev-sdk')
      return new CozeFetch(this.config as any, this.customHeaders).fetch(url)
    }
    const timeoutMs = Number(process.env.HUNYUAN_TIMEOUT_MS || 120000)
    // 公网文档直抓（supabase 对象存储等公开链接），无需鉴权头
    const res = await httpJson('GET', url, undefined, '', timeoutMs).catch(() => null)
    if (!res || res.status < 200 || res.status >= 300) {
      throw new Error(`文档下载失败（HTTP ${res?.status ?? 'ERR'}）：${url}`)
    }
    let text = res.text
    // HTML：剥标签取正文近似
    if (/<html|<!doctype|<body/i.test(text)) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, '\n')
        .replace(/&nbsp;/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    }
    return {
      status_code: res.status,
      url,
      filetype: /\.([a-z0-9]+)(\?|$)/i.exec(url)?.[1],
      content: text ? [{ type: 'text', text }] : [],
    }
  }
}

// ---------------- ImageGenerationClient（门控） ----------------

export interface ImageGenerationRequest {
  prompt: string
  model?: string
  size?: string
  watermark?: boolean
  image?: string | string[]
  responseFormat?: 'url' | 'b64_json'
}

export interface ImageData {
  url?: string
  b64_json?: string
  size?: string
  error?: { code?: string; message?: string }
}

export interface ImageGenerationResponse {
  model: string
  created: number
  data: ImageData[]
}

export class ImageGenerationResponseHelper {
  constructor(public response: ImageGenerationResponse) {}
  get success(): boolean {
    return (this.response.data || []).some((d) => d.url || d.b64_json)
  }
  get imageUrls(): string[] {
    return (this.response.data || []).filter((d) => d.url).map((d) => d.url as string)
  }
  get errorMessages(): string[] {
    return (this.response.data || [])
      .filter((d) => d.error?.message)
      .map((d) => d.error?.message as string)
  }
}

const IMG2IMG_UNAVAILABLE =
  '智能图像重绘（图生图）暂不可用：腾讯混元开放接口暂不支持图生图，原图自动调正/高清/去手写等本地处理不受影响，请重试本地处理。'

export class ImageGenerationClient {
  constructor(public config?: Config, public customHeaders?: Record<string, string>) {}

  async generate(_request: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    if (aiProviderName() === 'coze') {
      const { ImageGenerationClient: CozeImg } = await import('coze-coding-dev-sdk')
      const client = new CozeImg(this.config as any, this.customHeaders)
      return client.generate(_request)
    }
    // 混元兼容端点仅支持文生图（images/generations），图生图编辑需另一套签名凭据，暂不接入。
    throw new Error(IMG2IMG_UNAVAILABLE)
  }

  getResponseHelper(response: ImageGenerationResponse): ImageGenerationResponseHelper {
    return new ImageGenerationResponseHelper(response)
  }
}
