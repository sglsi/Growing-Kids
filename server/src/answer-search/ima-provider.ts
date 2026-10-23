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
 *
 * ⚠️ 知识库条目没有外链：WebItem.url 置空，上层 refs 展示时按「无链接」处理。
 * ⚠️ highlight_content 含 <em> 高亮标签与 HTML 实体，必须清洗——
 *    小程序 Text 组件会把 <em> 当字面文字显示（「是<em>一</em>条」）。
 *
 * ⚠️⚠️ 三条 2026-10-23 实测红线（详见各处注释，改检索策略前必读）：
 *   1. search_knowledge 是**全词 AND 语义**：query 每个词都必须在文档里命中。
 *      「一元二次方程」24 条，加「解法/例题/求根」后 0 条。自然语句题干直接搜必零。
 *   2. ima 有**每日调用配额**（code=220021「资料获取次数已达上限，请明天再尝试」）——
 *      按调用计数（零命中也计数），不是可退避的 QPS 限流。每题调用次数必须抠着花。
 *   3. ima 还有**账号级 QPS 限流**（code=200001「请求频率超限」HTTP 403）——
 *      6 库并行连续打会触发，需退避重试。
 */

const IMA_SEARCH_ENDPOINT = 'https://ima.qq.com/openapi/wiki/v1/search_knowledge'
/** ima 是腾讯自家服务、本机实测 0.3s 可达，单库请求超时放宽 */
const IMA_TIMEOUT_MS = Number(process.env.IMA_SEARCH_TIMEOUT_MS || 15000)

/**
 * 限流/配额治理（2026-10-23 实测）：
 *   库间 250ms（串行）+ 轮间 600ms，把 QPS 压到限流阈值下；
 *   单库撞 QPS 限流（200001）退避 900ms 重试一次；
 *   撞日配额（220021）立即整体停检（重试无意义，明天才恢复）。
 */
const IMA_KB_GAP_MS = Number(process.env.IMA_KB_GAP_MS || 250)
const IMA_ROUND_GAP_MS = Number(process.env.IMA_ROUND_GAP_MS || 600)
const IMA_RETRY_BACKOFF_MS = Number(process.env.IMA_RETRY_BACKOFF_MS || 900)

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 日配额耗尽（220021）——不可重试，需立即停检并向上透出 */
function isQuotaExceeded(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /220021|已达上限/.test(msg)
}

/** QPS 限流（200001）——可退避重试 */
function isRateLimited(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /频率超限|200001/.test(msg)
}

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

/**
 * 问句停用词（多字）：题目里的功能词，对检索无价值。
 * 中文题目按空格/标点切词后，这些整词丢掉。
 */
const STOP_WORDS = new Set([
  '什么', '怎么', '怎样', '如何', '为什么', '为何', '是否', '能不能', '可不可以',
  '可以', '应该', '应当', '需要', '多少', '多久', '哪些', '哪个', '哪里', '哪儿',
  '给出', '答案', '解答', '解析', '解释', '说明', '一下', '简要', '详细', '大约',
  '大概', '左右', '我们', '你们', '他们', '它们', '下面', '下列', '以下', '根据',
  '结合', '运用', '使用', '通过', '关于', '对于', '来说', '而言', '以及', '或者',
  '并且', '如果', '虽然', '但是', '因为', '所以', '然后', '接着', '首先', '其次',
])

/** 单字停用词：整个 token 都是这些字时丢掉（混合词如「各题」保留） */
const STOP_CHARS = new Set('的吗了呢吧啊请求解答给出是在有和与及或并把被让向从到于以其此该各每几谁啥呀嗯哦')

/** 嵌在长 token 内部的停用词（中文无空格，整句是一个 token，只能内部剔除） */
const INNER_STOP = /请问|大约|大概|什么|怎么|怎样|如何|是否|能不能|可以|应该|应当|需要|多少|多久|哪些|哪个|哪里|给出|答案|解答|解析|解释|说明|一下|简要|详细|下面|下列|以下|根据|结合|通过|关于|对于|来说|而言/g

/**
 * 4 字窗滑窗（步长 1、上限 3）：把「地球围绕太阳公转一周…」这类无空格长串
 * 拆成可检索片段。步长 1 是为了不错过 3 字主题（「出师表」恰在窗 i=1）。
 */
function ngrams(token: string): string[] {
  if (token.length <= 4) return [token]
  const out: string[] = []
  for (let i = 0; i + 4 <= token.length && out.length < 3; i++) {
    const g = token.slice(i, i + 4)
    if (!out.includes(g)) out.push(g)
  }
  return out
}

/** 提取书名号内容（《出师表》→「出师表」）——中文题目里最强的主题信号 */
function bookTitles(rawQuery: string): string[] {
  return [...rawQuery.matchAll(/《([^》]+)》/g)].map((m) => m[1].trim()).filter(Boolean)
}

/**
 * 探针查询链（顺序即优先级，主库命中即停，详见 search() 注释「先导探针」）：
 *
 * ⚠️ 自然语句题干按 AND 语义必零命中（2026-10-23 实测 4/4 案例）——
 *    但空格分隔的关键词串（用户手动整理过）第一级就是原串，不亏。
 *
 *   1. 关键词串（按空格/标点切词、去停用词后拼回）
 *   2. 前 4 词（>4 词时）→ 前 2 词（>2 词时）——主题短语通常在句首
 *   3. tokens[0]（首主题词；单 token 场景与第 1 级重复会被去重跳过）
 *   4. 书名号内容（《出师表》→ 出师表）——强主题信号
 *   5. 最长 token 的 4 字窗（去内部停用词后）——无空格长句的主题词兜底
 */
export function buildQueryFallbacks(rawQuery: string): string[] {
  const out: string[] = []
  const push = (q: string) => {
    const t = q.trim()
    if (t && !out.includes(t)) out.push(t)
  }

  const books = bookTitles(rawQuery)
  const tokens = rawQuery
    .replace(/[?!。？！，,、；;：:（）()[\]【】{}"'’“”\-—_·…]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && ![...t].every((c) => STOP_CHARS.has(c)) && !STOP_WORDS.has(t))
  if (tokens.length === 0) {
    books.forEach(push)
    return out.length ? out : [rawQuery.trim()].filter(Boolean)
  }

  push(tokens.join(' '))
  if (tokens.length > 4) push(tokens.slice(0, 4).join(' '))
  if (tokens.length > 2) push(tokens.slice(0, 2).join(' '))
  // tokens[0] 也去内部停用词：「请问三角形的面积公式是什么」→「三角形的」
  push(tokens[0].replace(INNER_STOP, ''))
  for (const t of books.slice(0, 1)) push(t)
  const longest = [...tokens].sort((a, b) => b.length - a.length)[0]
  if (longest && longest.length > 4) {
    for (const g of ngrams(longest.replace(INNER_STOP, ''))) push(g)
  }
  return out
}

/** 把多个库的结果按「相关序交错合并 + 标题去重」合成一列，截到 count */
function interleave(perKb: WebItem[][], count: number): WebItem[] {
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
  return merged
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

    const fire = async () => {
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
      return json
    }

    // QPS 限流（200001）：退避重试一次；仍失败按普通失败上报。
    // 日配额耗尽（220021）：直接抛，上层识别后整体停检（重试无意义）。
    let json: Record<string, any>
    try {
      json = await fire()
    } catch (e) {
      if (isQuotaExceeded(e)) throw e
      if (!isRateLimited(e)) throw e
      await sleep(IMA_RETRY_BACKOFF_MS)
      try {
        json = await fire()
      } catch {
        throw e
      }
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
   * 全库串行检索一轮（兜底路径用）：库间 250ms 间隔压 QPS，
   * 撞日配额（220021）立即中断剩余库并上抛专用错误。
   *
   * 部分库失败（无权限/超时/限流重试仍失败）不拖垮整体：有成功就返回成功的，
   * 全部失败才抛错（上层转成 source=none + 明确说明）。
   */
  private async searchAllKbs(query: string, count: number): Promise<WebItem[]> {
    const kbIds = this.kbIds()
    const errors: string[] = []
    const perKb: WebItem[][] = []
    for (let i = 0; i < kbIds.length; i++) {
      if (i > 0) await sleep(IMA_KB_GAP_MS)
      try {
        perKb.push(await this.searchOne(query, kbIds[i], count))
      } catch (e) {
        if (isQuotaExceeded(e)) {
          throw new Error(`ima 今日调用次数已达上限（220021），请明天再试`)
        }
        const msg = e instanceof Error ? e.message : String(e)
        errors.push(`${kbIds[i]}: ${msg}`)
      }
    }
    if (perKb.length === 0) {
      throw new Error(`ima 全部 ${kbIds.length} 个知识库检索失败 —— ${errors[0]}`)
    }
    if (errors.length > 0) {
      this.logger.warn(`[answer-search] ima ${errors.length}/${kbIds.length} 个库失败：${errors.join(' | ')}`)
    }
    return interleave(perKb, count)
  }

  /**
   * 对外入口：**先导探针式**检索（2026-10-23 为省日配额重构）。
   *
   * 背景：ima 按调用计数扣日配额（零命中也扣，220021），每题必须抠着花。
   * 旧版「降级链 × 6 库并行」最坏 54 次/题，真实用户点两次就打爆全天配额。
   *
   * 策略（详见 buildQueryFallbacks）：
   *   ① 只用**主库**（配置里的第一个）逐级试探查询链——每题典型 2~4 次调用；
   *   ② 主库任一级命中即返回（主库是思傅选定的最相关库，命中即最相关）；
   *   ③ 主库全级零命中（典型：文科题撞上数学主库）→ 全库串行兜底一轮
   *      （6 次调用，交错合并）——至此最坏 4+6=10 次/题。
   */
  async search(query: string, count: number): Promise<WebItem[]> {
    const kbIds = this.kbIds()
    if (!(process.env.IMA_CLIENT_ID || '').trim() || !(process.env.IMA_API_KEY || '').trim()) {
      throw new Error(`ima 凭据不完整（缺 ${this.missingKeys().join(' / ')}）`)
    }
    if (kbIds.length === 0) {
      throw new Error('ima 凭据不完整（缺 IMA_KB_ID）')
    }

    const stages = buildQueryFallbacks(query)
    const primary = kbIds[0]
    let probeCalls = 0
    let probeErr = ''

    // ① 主库探针：逐级试探，命中即返回
    for (const q of stages) {
      try {
        const probe = await this.searchOne(q, primary, count)
        probeCalls++
        if (probe.length > 0) {
          if (q !== query) {
            this.logger.log(`[answer-search] ima 主库探针命中（${probeCalls} 次调用）：「${q.slice(0, 40)}」`)
          }
          return probe
        }
      } catch (e) {
        if (isQuotaExceeded(e)) throw e // 配额耗尽：立即停检，专用错误上抛
        probeErr = e instanceof Error ? e.message : String(e)
        this.logger.warn(`[answer-search] ima 主库探针失败：${probeErr.slice(0, 120)}`)
        break // 主库持续报错（非配额问题）→ 直接转全库兜底
      }
    }

    // ③ 全库兜底一轮：用链中第一个「≤8 字的无空格单词」= 最强主题词
    //    （关键词串/整句都带空格或超长，AND 语义下不如单词；
    //      ≤8 字排除「《出师表》中先帝不以臣卑鄙的古义是」这类去停用整串）
    const tail =
      stages.find((q) => !q.includes(' ') && q.length <= 8) || stages[stages.length - 1] || query
    const items = await this.searchAllKbs(tail, count)
    this.logger.log(
      `[answer-search] ima 全库兜底命中 ${items.length} 条（探针 ${probeCalls} 次零命中/报错）：「${tail.slice(0, 40)}」`,
    )
    return items
  }
}
