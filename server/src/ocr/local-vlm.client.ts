/**
 * 自托管本地 VLM 升级层（P1-14 · 底座）
 * ------------------------------------------------------------------
 * 技术文档 §6 把这条张力讲清楚了：用户要求"本地优先、尽量不依赖大模型"，与
 * "置信不足时请 VLM 看图"并不冲突——前提是 **VLM 在哪里跑、什么时候被调用**：
 *
 *   1. 默认不调用（`OCR_LOCAL_VLM_MODE=off`，默认值）——本地切块 + 本地 OCR 侧车已能
 *      独立出结果，VLM 不是必需品；
 *   2. 即使开启，被调用的模型必须是**自己机器上/内网里**跑的多模态模型，
 *      绝不指向任何外部付费 API（下面 `isPrivateHost` 会强制校验，配错即静默降级）；
 *   3. `auto` 模式下也只在**本地置信不足**时才触发，`always` 仅供对比评测使用。
 *
 * @note 本文件当前是**底座**：接口、配置、路由条件与 fail-open 语义都已就位，
 *      但仓库里没有自带任何 VLM 权重。要真正生效，需在本地/内网起一个 OpenAI 兼容
 *      推理服务（vLLM / Ollama / Xinference 均可，模型建议 PaddleOCR-VL-0.9B 或
 *      Qwen2.5-VL-3B），再把 `OCR_LOCAL_VLM_URL` 指过去。**未配置时本文件完全不会被调用。**
 */
export type LocalVlmMode = 'off' | 'auto' | 'always'

export interface LocalVlmPolicy {
  mode: LocalVlmMode
  /** 本次是否允许调用（综合 mode + URL 是否可达 + host 白名单） */
  enabled: boolean
  url: string
  model: string
  /** 未启用的原因（排查用） */
  reason?: string
}

/** OpenAI 兼容推理服务的默认模型名（可由 OCR_LOCAL_VLM_MODEL 覆盖） */
const DEFAULT_VLM_MODEL = process.env.OCR_LOCAL_VLM_MODEL || 'qwen2.5-vl'

function normalizeMode(v: string | undefined): LocalVlmMode {
  const s = (v ?? 'off').toLowerCase()
  return s === 'auto' || s === 'always' ? s : 'off'
}

/**
 * 只允许**本机 / 内网**推理端点。
 *
 * 这是"不依赖外部大模型"那条原则的**代码级执行**：万一有人把 URL 配成了某个公网付费
 * API，这里直接判为未启用，**静默降级回纯本地链路**。宁可不用，也不能悄悄付出去。
 */
function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return true
  // 私有网段：10/8、172.16/12、192.168/16、169.254/16（link-local）、*.local、*.internal
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

/** 读取当前的自托管 VLM 策略（每次调用时现算，便于改 env 后热生效） */
export function localVlmPolicy(): LocalVlmPolicy {
  const mode = normalizeMode(process.env.OCR_LOCAL_VLM_MODE)
  const rawUrl = (process.env.OCR_LOCAL_VLM_URL || '').trim()
  const model = (process.env.OCR_LOCAL_VLM_MODEL || '').trim() || DEFAULT_VLM_MODEL

  if (mode === 'off') return { mode, enabled: false, url: '', model, reason: 'OCR_LOCAL_VLM_MODE=off（默认不启用）' }
  if (!rawUrl) return { mode, enabled: false, url: '', model, reason: '未配置 OCR_LOCAL_VLM_URL' }
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return { mode, enabled: false, url: '', model, reason: `OCR_LOCAL_VLM_URL 不是合法 URL: ${rawUrl}` }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { mode, enabled: false, url: '', model, reason: `不支持的协议: ${u.protocol}` }
  }
  // https 且非私有主机 → 极可能是外部付费 API，按"本地优先"原则拒绝
  if (!isPrivateHost(u.hostname) && u.protocol === 'https:') {
    return { mode, enabled: false, url: '', model, reason: `拒绝外部端点 ${u.hostname}：本链路只允许自托管本地 VLM` }
  }
  return { mode, enabled: true, url: rawUrl.replace(/\/+$/, ''), model }
}

/** VLM 返回的单题粗框（用于与本地切块融合） */
export interface VlmQuestionBox {
  /** 归一化框 [x, y, w, h]，0~1 */
  normBox?: [number, number, number, number]
  /** 像素框（若模型直接给了） */
  box?: [number, number, number, number]
  /** 题面文本（可选，模型顺手认出的） */
  question?: string
  /** 题号（可选） */
  number?: string | number
}

export interface LocalVlmResult {
  used: boolean
  items: VlmQuestionBox[]
  error?: string
}

const EXTRACT_PROMPT =
  '你是试卷版面分析器。请在这张试卷图上找出所有**独立成题**的题目区域，' +
  '按从上到下、从左到右的阅读顺序输出 JSON 数组，每个元素形如 ' +
  '{"box":[x0,y0,x1,y1],"question":"题面文本","number":"题号"}。' +
  '要求：① 坐标必须是**像素整数**，相对于原图左上角；' +
  '② 每道题一个框，包含题干与作答区，但**不要**与其它题的框重叠；' +
  '③ 只输出 JSON，不要任何解释文字、不要 markdown 代码块围栏。'

/**
 * 让自托管 VLM 出"题目粗框"，作为本地切块的**升级/交叉验证**来源。
 *
 * fail-open：任何异常（未启用 / 网络 / 超时 / 解析失败）一律返回 `used=false`。
 * 调用方的逻辑永远是"本地结果优先，VLM 只是可选补充"，所以这里失败不影响主链路。
 *
 * @param imageUrl 公网/内网可达的图片 URL（自托管服务需能访问）
 */
export async function localVlmQuestionBlocks(
  imageUrl: string,
  hintCount?: number,
): Promise<LocalVlmResult> {
  const p = localVlmPolicy()
  if (!p.enabled) return { used: false, items: [], error: p.reason }

  const timeoutMs = Number(process.env.OCR_LOCAL_VLM_TIMEOUT_MS || 120_000)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const hint = hintCount && hintCount > 0 ? `\n图上大约有 ${hintCount} 道题，请据实核实，不要凑数。` : ''
    const res = await fetch(`${p.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: p.model,
        temperature: 0,
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageUrl } },
              { type: 'text', text: EXTRACT_PROMPT + hint },
            ],
          },
        ],
      }),
    })
    if (!res.ok) {
      return { used: false, items: [], error: `自托管 VLM 返回 ${res.status}` }
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = json.choices?.[0]?.message?.content || ''
    const items = parseVlmJson(content)
    return { used: items.length > 0, items, error: items.length ? undefined : '解析出的题目框为空' }
  } catch (e) {
    return { used: false, items: [], error: `自托管 VLM 调用失败: ${String((e as Error)?.message ?? e)}` }
  } finally {
    clearTimeout(timer)
  }
}

/** 从模型回复里抠出 JSON 数组（容忍 markdown 围栏与前后废话） */
export function parseVlmJson(content: string): VlmQuestionBox[] {
  if (!content) return []
  let s = content.trim()
  // 去掉 ```json ... ``` 围栏
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) s = fenced[1].trim()
  const l = s.indexOf('[')
  const r = s.lastIndexOf(']')
  if (l < 0 || r <= l) return []
  let arr: unknown
  try {
    arr = JSON.parse(s.slice(l, r + 1))
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  const out: VlmQuestionBox[] = []
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const box = Array.isArray(o.box) && o.box.length >= 4 ? o.box.map(Number) as [number, number, number, number] : undefined
    const normBox = Array.isArray(o.normBox) && o.normBox.length >= 4
      ? o.normBox.map(Number) as [number, number, number, number]
      : undefined
    if (!box && !normBox) continue
    out.push({
      box,
      normBox,
      question: typeof o.question === 'string' ? o.question : undefined,
      number: typeof o.number === 'string' || typeof o.number === 'number' ? o.number : undefined,
    })
  }
  return out
}
