/**
 * 题目查重 + 知识点关键词抽取（P1-13）
 * ------------------------------------------------------------------
 * 技术文档里写的是"接已有 `memory` 模块"，实际核对后**语义不匹配**——
 * `memory` 模块是「成长记忆」（孩子的生活/学习随手记，见 memory.types.ts），
 * 既没有题目文本也没有学科维度，拿它做题目查重是南辕北辙。
 * 题目去重真正该挂的是 **timeline / 复习本（错题池）**，所以这里做成
 * **与存储无关的纯函数**，由调用方决定对哪一批 items 去重。
 *
 * ── 为什么是 SimHash 而不是余弦/SBERT ──────────────────────────────
 * 用户原则要求"尽量不依赖大模型"，所以不引 sentence-transformers。
 * SimHash 是工业界通用的近重复检测算法：把文档压成 64 位指纹，
 * 两篇考试的相似程度 ≈ 指纹的汉明距离。优点是 O(1) 存储、比较只要一次异或，
 * 且对"搬运了几句话/改了几个字"鲁棒。行业通行阈值：64 位下汉明距离 ≤3 视为重复。
 *
 * ── 分词策略（中文）─────────────────────────────────────────────
 * 没有引入分词器，用**字级 bigram**：中文不分词也能得到稳定的近重复判别，
 * 且对 OCR 错别字（把"解"认成"鲜"）比精确词匹配更鲁棒。
 */
import type { RecognizedItem } from './ocr.types'

/** 64 位 FNV-1a（用 BigInt 保证 64 位宽度；本模块数据量仅几十条，性能无碍） */
const MASK64 = (1n << 64n) - 1n

function fnv1a64(s: string): bigint {
  let h = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (let i = 0; i < s.length; i++) {
    h = (h ^ BigInt(s.charCodeAt(i))) & MASK64
    h = (h * prime) & MASK64
  }
  return h
}

/** 归一化：去掉空白与绝大多数标点，避免换行/空格差异影响查重 */
export function normalizeForDedup(s: string): string {
  return (s || '')
    .replace(/\s+/g, '')
    .replace(/[，。、；：？！"'“”‘’（）()【】\[\]{}《》·—\-–_,.;:?!\/\\|+=*#~`^$@%&]/g, '')
}

/** 取字级 bigram（纯中文/数字/字母；单字文档会退化成自身） */
function bigrams(s: string): string[] {
  const t = normalizeForDedup(s)
  if (t.length <= 1) return t ? [t] : []
  const out: string[] = []
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2))
  return out
}

/** 计算 64 位 SimHash 指纹 */
export function simhash64(text: string): bigint {
  const grams = bigrams(text)
  if (!grams.length) return 0n
  const v = new Array<number>(64).fill(0)
  for (const g of grams) {
    const h = fnv1a64(g)
    for (let i = 0; i < 64; i++) {
      // 位为 1 加权 +1，为 0 加权 -1（权重恒取 1：题面较短，词频本身不稳定，
      // 加权反而会被 OCR 错字带偏）
      v[i] += (h >> BigInt(i)) & 1n ? 1 : -1
    }
  }
  let out = 0n
  for (let i = 0; i < 64; i++) if (v[i] > 0) out |= 1n << BigInt(i)
  return out
}

/** 两个 64 位指纹的汉明距离 */
export function hamming64(a: bigint, b: bigint): number {
  let x = a ^ b
  let n = 0
  while (x) {
    n += Number(x & 1n)
    x >>= 1n
  }
  return n
}

export interface DedupGroup {
  /** 保留下来的代表题在原始数组中的下标 */
  keep: number
  /** 被判定为重复的题在原数组中的下标们 */
  dupes: number[]
}

export interface DedupResult<T> {
  items: T[]
  /** 被合并掉的重复题数量 */
  removed: number
  groups: DedupGroup[]
}

/**
 * 对一批题目做近重复去重。
 *
 * 默认阈值 3（64 位汉明距离），对应"高度相似但允许个别字/标点差异"——
 * OCR 会把同一个题在相邻切块里认出略有不同的结果，这正是要合并的场景。
 * 注意：**只在题面足够长时才去重**，短题干（<8 字）指纹不可靠，宁可留着让用户删。
 */
export function dedupItems<T extends { question_content?: string; stem?: string }>(
  items: T[],
  opts: { threshold?: number; minLen?: number } = {},
): DedupResult<T> {
  const threshold = opts.threshold ?? 3
  const minLen = opts.minLen ?? 8
  const fps = items.map((it) => {
    const t = (it.question_content || it.stem || '').slice(0, 1200)
    return { fp: simhash64(t), short: normalizeForDedup(t).length < minLen }
  })
  const dupeOf = new Array<number>(items.length).fill(-1)

  for (let i = 0; i < items.length; i++) {
    if (fps[i].short) continue
    for (let j = 0; j < i; j++) {
      if (dupeOf[j] >= 0 || fps[j].short) continue
      if (hamming64(fps[i].fp, fps[j].fp) <= threshold) { dupeOf[i] = j; break }
    }
  }

  const out: T[] = []
  const groups: DedupGroup[] = []
  for (let i = 0; i < items.length; i++) {
    if (dupeOf[i] >= 0) continue
    out.push(items[i])
  }
  for (let i = 0; i < items.length; i++) {
    if (dupeOf[i] < 0) continue
    let g = groups.find((x) => x.keep === dupeOf[i])
    if (!g) { g = { keep: dupeOf[i], dupes: [] }; groups.push(g) }
    g.dupes.push(i)
  }
  return { items: out, removed: items.length - out.length, groups }
}

// ---------------------------------------------------------------------------
// 知识点关键词抽取
//
// ⚠️ 诚实边界：真正的知识点分类需要**教育词库 + 语义模型**（主流做法 BERT+词库，F1≈0.88，
// 见技术文档 §4.3）。这里只做本地轻量版——**学科词表命中 + 高频 bigram**，够用来
// 给 tags 填候选、给家长一个"这题大概在考什么"的提示，但不宣称是知识点分类器。
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '与', '及', '有', '把', '被', '对', '从', '到', '为', '以',
  '请', '下列', '以下', '本题', '根据', '要求', '完成', '回答', '下列', '如图', '已知', '求',
  '若', '则', '那么', '这个', '一个', '可以', '不是', '没有', '什么', '多少', '小题', '共',
])

/** 学科特征词（够本地命中用；后续按真实学科词库扩充即可，不影响代码结构） */
const SUBJECT_LEXICON: ReadonlyArray<{ keys: string[]; tag: string }> = [
  { keys: ['方程', '方程组', '解方程'], tag: '方程' },
  { keys: ['不等式', '取值范围', '最大值', '最小值'], tag: '不等式' },
  { keys: ['函数', '一次函数', '二次函数', '反比例'], tag: '函数' },
  { keys: ['三角形', '全等', '相似', '勾股'], tag: '三角形' },
  { keys: ['圆', '半径', '直径', '圆周角', '切线'], tag: '圆' },
  { keys: ['面积', '周长', '体积', '表面积'], tag: '几何度量' },
  { keys: ['概率', '可能性', '随机'], tag: '概率' },
  { keys: ['平均数', '中位数', '众数', '方差', '统计图'], tag: '统计' },
  { keys: ['因式分解', '多项式', '合并同类项'], tag: '代数式' },
  { keys: ['分数', '通分', '约分', '百分数'], tag: '数与式' },
  { keys: ['比例', '比例尺', '正反比例'], tag: '比例' },
  { keys: ['速度', '路程', '时间', '相遇'], tag: '行程问题' },
  { keys: ['工程', '效率', '工作总量'], tag: '工程问题' },
  { keys: ['古诗', '诗句', '作者', '朝代'], tag: '古诗文' },
  { keys: ['阅读', '短文', '文章', '段落', '选文'], tag: '阅读理解' },
  { keys: ['词语', '成语', '近义词', '反义词', '组词'], tag: '字词' },
  { keys: ['作文', '写作', '题目自拟'], tag: '习作' },
  { keys: ['拼音', '声母', '韵母', '声调'], tag: '拼音' },
  { keys: ['单词', '词组', '时态', '语法', '单项选择'], tag: '英语基础' },
  { keys: ['完形', '阅读理', '翻译'], tag: '英语读写' },
  { keys: ['物理', '重力', '浮力', '压强', '电流', '电压', '电阻'], tag: '物理' },
  { keys: ['化学', '氧气', '二氧化碳', '化合价', '方程式配平'], tag: '化学' },
  { keys: ['生物', '细胞', '光合', '遗传'], tag: '生物' },
  { keys: ['单位换算', '进率'], tag: '单位换算' },
]

/**
 * 抽主题关键词作为 tag 候选。
 * 返回长度 ≤ max 的标签数组（可能为空 —— 抽不到就别乱标，比标错强）。
 */
export function pickKeywords(text: string, max = 3): string[] {
  const norm = normalizeForDedup(text)
  if (norm.length < 6) return []
  const hits: Array<{ tag: string; weight: number }> = []
  for (const { keys, tag } of SUBJECT_LEXICON) {
    for (const k of keys) {
      if (k.length < 2) continue
      const idx = norm.indexOf(k)
      if (idx < 0) continue
      const w = 1 + Math.min(2, k.length / 3)
      const prev = hits.find((h) => h.tag === tag)
      if (prev) prev.weight += w
      else hits.push({ tag, weight: w })
      break
    }
  }
  if (!hits.length) {
    // 词表没命中：退化为高频 bigram（去停用词），至少给个线索
    const grams = bigrams(norm)
    const cnt = new Map<string, number>()
    for (const g of grams) {
      if (STOPWORDS.has(g)) continue
      if (/^\d+$/.test(g)) continue
      cnt.set(g, (cnt.get(g) ?? 0) + 1)
    }
    const top = [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, max)
    return top.filter(([, c]) => c >= 3).map(([g]) => g)
  }
  return hits.sort((a, b) => b.weight - a.weight).slice(0, max).map((h) => h.tag)
}

/** 给一批题目补 tags 候选（不覆盖已有的） */
export function attachKeywordTags(items: Array<RecognizedItem & { tags?: string[] }>): void {
  for (const it of items) {
    const kws = pickKeywords(it.stem || it.question_content || '')
    if (kws.length) it.tags = Array.from(new Set([...(it.tags || []), ...kws]))
  }
}
