/**
 * 错因分析（P2-16 · 本地优先规则引擎 + 可选 SBERT 升级）
 * ------------------------------------------------------------------
 * 技术文档 §5 #16 点名"规则引擎 + SBERT 语义差异"。SBERT 依赖 embedding 模型权重，
 * 与"尽量不依赖大模型"原则冲突，故：
 *
 *   - **默认 = 纯本地规则引擎**：基于 P1 已分离的 `stem` / `wrong_answer` / `solution`，
 *     结合可析取数字、词面重叠率、学科标签，给出错因类别 + 原因 + 解法建议。
 *   - **SBERT 仅作为可选升级钩子**（`sbertPolicy()`，默认 off、私有网段强校验、fail-open）：
 *     启用时调自托管 embedding 端点算出"学生作答 vs 标准答案"的语义相似分，填进
 *     `ErrorAnalysis.sbert`，用于进一步细化错因；任何失败都静默降级、不影响主链路。
 *
 * 全部零新运行时依赖；`classifyError` 是纯函数，便于单测（无 OCR 侧车也能验证）。
 */
import type { ErrorAnalysis, RecognizedItem } from './ocr.types'
import { normalizeForDedup } from './ocr-dedup'

export interface ErrorInput {
  stem?: string
  wrong_answer?: string
  solution?: string
  answer?: string
  tags?: string[]
}

// ---------------------------------------------------------------------------
// 1. 本地规则引擎
// ---------------------------------------------------------------------------

/** 取文本里的所有数字（含负号、小数、分数近似） */
function extractNumbers(s: string): number[] {
  const out: number[] = []
  const re = /-?\d+(?:\.\d+)?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const n = Number(m[0])
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}

/** 字级 bigram 集合（复用 ocr-dedup 的归一化，但不引 new 依赖） */
function bigramSet(s: string): Set<string> {
  const t = normalizeForDedup(s)
  const set = new Set<string>()
  if (t.length <= 1) {
    if (t) set.add(t)
    return set
  }
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2))
  return set
}

/** 两文本的字面重叠率（Dice 系数 [0,1]，对短中文比 Jaccard 更稳健） */
function surfaceOverlap(a: string, b: string): number {
  const A = bigramSet(a)
  const B = bigramSet(b)
  if (!A.size && !B.size) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return (2 * inter) / (A.size + B.size)
}

const TYPE_META: Record<ErrorAnalysis['type'], { label: string; reason: string }> = {
  'no-answer': { label: '未作答 / 完全不会', reason: '已提取到题干，但该题没有学生作答痕迹' },
  unscored: { label: '暂无可比对答案', reason: '学生有作答，但当前没有标准答案可供比对' },
  'careless-sign': { label: '粗心·符号错误', reason: '数值量级正确但符号相反，多为抄写/看错正负号' },
  'careless-calc': { label: '粗心·计算错误', reason: '数值接近标准答案，疑似中间某步算错或抄错' },
  'concept-mix': { label: '概念混淆', reason: '数值量级与标准答案明显不同，相关概念尚未分清' },
  misread: { label: '审题/表述偏差', reason: '作答与标准答案高度相似，仅个别处偏差，属审题或表述问题' },
  'method-step': { label: '方法/步骤错误', reason: '作答思路与标准答案差异较大，方法或步骤有误' },
  unknown: { label: '错因待判定', reason: '暂无法基于现有文本判定错因' },
}

/** 结合错因类别与学科标签，给出针对性解法建议 */
function buildSuggestion(type: ErrorAnalysis['type'], tags: string[]): string {
  const tagSet = new Set(tags || [])
  const has = (...keys: string[]) => keys.some((k) => tagSet.has(k))

  const base: Record<ErrorAnalysis['type'], string> = {
    'no-answer': '先弄懂对应知识点，再脱离答案独立做一遍，不要边看边写。',
    unscored: '补充该题标准答案后，可自动定位错因并生成复习建议。',
    'careless-sign': '养成"先判正负号、再算数值"的习惯，关键步骤旁标注符号。',
    'careless-calc': '关键计算逐步落笔、算完倒代回原式验算一遍。',
    'concept-mix': '回归课本厘清易混概念，用对比表区分它们的适用条件。',
    misread: '读题时圈出限定词（"不正确""至少""单位"等），避免看漏条件。',
    'method-step': '按"审题→选方法→写步骤→验算"四步重做，补齐缺失的中间过程。',
    unknown: '建议结合答案订正，并标记为薄弱点重点复习。',
  }

  const hints: string[] = []
  if (has('古诗文')) hints.push('古诗文类建议结合背诵默写巩固。')
  if (has('英语基础', '英语读写')) hints.push('英语类建议回归核心词汇与语法点。')
  if (has('方程', '函数', '不等式', '三角形', '圆', '几何度量', '代数式', '数与式', '比例'))
    hints.push('数理类建议规范解题步骤、复算关键一步。')
  if (has('阅读理解', '习作')) hints.push('语文阅读/写作类建议梳理文章结构与答题模板。')

  return hints.length ? `${base[type]} ${hints.join('')}` : base[type]
}

/**
 * 纯本地错因分类（核心纯函数，无 IO、可单测）。
 */
export function classifyError(input: ErrorInput): ErrorAnalysis {
  const wrong = (input.wrong_answer || '').trim()
  const key = (input.solution || input.answer || '').trim()
  const tags = input.tags || []

  if (!wrong) {
    const t: ErrorAnalysis['type'] = key ? 'no-answer' : 'unscored'
    return { type: t, ...TYPE_META[t], suggestion: buildSuggestion(t, tags) }
  }
  if (!key) {
    return { type: 'unscored', ...TYPE_META.unscored, suggestion: buildSuggestion('unscored', tags) }
  }

  // —— 数值型：比对可析取数字 ——
  const wNums = extractNumbers(wrong)
  const kNums = extractNumbers(key)
  if (wNums.length >= 1 && kNums.length >= 1) {
    const w = wNums[wNums.length - 1]
    const k = kNums[kNums.length - 1]
    if (Math.sign(w) !== Math.sign(k) && w !== 0 && k !== 0) {
      return { type: 'careless-sign', ...TYPE_META['careless-sign'], suggestion: buildSuggestion('careless-sign', tags) }
    }
    const ratio = k !== 0 ? Math.abs(w / k) : Infinity
    // 数值接近（±18% 内，容忍常见抄错/算错）→ 粗心·计算错误；再放宽也可覆盖"差一个量级内的近似"
    if (ratio > 0.82 && ratio < 1.22) {
      return { type: 'careless-calc', ...TYPE_META['careless-calc'], suggestion: buildSuggestion('careless-calc', tags) }
    }
    return { type: 'concept-mix', ...TYPE_META['concept-mix'], suggestion: buildSuggestion('concept-mix', tags) }
  }

  // —— 文本型：看字面重叠率（Dice）——
  const overlap = surfaceOverlap(wrong, key)
  let type: ErrorAnalysis['type']
  if (overlap > 0.5) type = 'misread'
  else if (overlap > 0.22) type = 'concept-mix'
  else type = 'method-step'

  return { type, ...TYPE_META[type], suggestion: buildSuggestion(type, tags) }
}

// ---------------------------------------------------------------------------
// 2. 可选升级：自托管 SBERT 语义差异（默认关闭、fail-open）
// ---------------------------------------------------------------------------

export type SbertMode = 'off' | 'auto'

export interface SbertPolicy {
  mode: SbertMode
  enabled: boolean
  url: string
  model: string
  reason?: string
}

function normalizeSbertMode(v: string | undefined): SbertMode {
  return (v ?? 'off').toLowerCase() === 'auto' ? 'auto' : 'off'
}

/** 只允许本机/内网 embedding 端点（与 localVlmPolicy 同款的私有网段强校验） */
function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return true
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

/**
 * 读取当前 SBERT 策略（每次现算，便于改 env 后热生效）。
 * 默认 `SBERT_MODE=off` → enabled=false，绝不发起任何外部请求。
 */
export function sbertPolicy(): SbertPolicy {
  const mode = normalizeSbertMode(process.env.SBERT_MODE)
  const rawUrl = (process.env.SBERT_URL || '').trim()
  const model = (process.env.SBERT_MODEL || '').trim() || 'paraphrase-multilingual-MiniLM-L12-v2'

  if (mode === 'off') return { mode, enabled: false, url: '', model, reason: 'SBERT_MODE=off（默认不启用）' }
  if (!rawUrl) return { mode, enabled: false, url: '', model, reason: '未配置 SBERT_URL' }
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return { mode, enabled: false, url: '', model, reason: `SBERT_URL 不是合法 URL: ${rawUrl}` }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { mode, enabled: false, url: '', model, reason: `不支持的协议: ${u.protocol}` }
  }
  if (!isPrivateHost(u.hostname) && u.protocol === 'https:') {
    return { mode, enabled: false, url: '', model, reason: `拒绝外部端点 ${u.hostname}：SBERT 只允许自托管本地 embedding` }
  }
  return { mode, enabled: true, url: rawUrl.replace(/\/+$/, ''), model }
}

async function embed(text: string, p: SbertPolicy): Promise<number[] | null> {
  const timeoutMs = Number(process.env.SBERT_TIMEOUT_MS || 30_000)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${p.url}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({ model: p.model, input: text }),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> }
    const emb = json.data?.[0]?.embedding
    return Array.isArray(emb) && emb.length ? emb : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom ? dot / denom : 0
}

/**
 * 计算"学生作答 vs 标准答案"的语义相似分 [0,1]（1 = 完全一致）。
 * 仅在 `sbertPolicy().enabled` 时发起请求；失败返回 undefined（fail-open）。
 */
export async function sbertErrorScore(wrong: string, key: string): Promise<number | undefined> {
  const p = sbertPolicy()
  if (!p.enabled || !wrong || !key) return undefined
  try {
    const [w, k] = await Promise.all([embed(wrong, p), embed(key, p)])
    if (!w || !k) return undefined
    return cosine(w, k)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 3. 接线：给一批识别结果补错因分析
// ---------------------------------------------------------------------------

/**
 * 就地给 `items` 补 `error_analysis`（纯本地规则引擎；若启用 SBERT 则异步补 `sbert` 分）。
 * 单条失败不影响整体（catch 后留空，不阻断主链路）。
 */
export async function attachErrorAnalysis(items: RecognizedItem[]): Promise<RecognizedItem[]> {
  const p = sbertPolicy()
  await Promise.all(
    items.map(async (it) => {
      try {
        const analysis = classifyError({
          stem: it.stem,
          wrong_answer: it.wrong_answer,
          solution: it.solution,
          answer: it.answer_content,
          tags: it.tags,
        })
        if (p.enabled) {
          const key = it.solution || it.answer_content
          const s = await sbertErrorScore(it.wrong_answer, key)
          if (typeof s === 'number') analysis.sbert = s
        }
        it.error_analysis = analysis
      } catch {
        // 错因分析是增值项，失败不阻断；保持 item 原样
      }
    }),
  )
  return items
}
