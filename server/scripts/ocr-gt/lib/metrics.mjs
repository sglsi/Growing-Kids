// ============================================================
// OCR 质量评测指标（零依赖）
//
// 只用两个指标，刻意不追指标数量：
//   CER      —— 字符错误率（编辑距离 / 参考长度），衡量"整体抄得准不准"
//   行命中率 —— 参考文本的每一行在识别结果里能否找到，衡量"有没有整行丢掉"
//
// 为什么两个都要：CER 会被"长度"稀释。一整行完全没识别出来（例如竖式、公式行）
// 可能只让 CER 涨 0.03，看起来还行；而行命中率会直接掉一格。教辅场景里
// 「整行丢失」比「个别字错」严重得多——丢掉的那行往往正是答案行。
// ============================================================

/**
 * 归一化：只做**无损**变换，绝不"模糊匹配"到丢失判据的程度。
 *
 * 允许：
 *   · 去空白（OCR 的空格位置本来就不可靠，中英文混排尤其明显）
 *   · 全角 → 半角（数字、字母、括号、四则运算符）——同一字符的两种码位，不是识别错误
 * 不允许：
 *   · 把 × 和 x、O 和 0、l 和 1 当成一样 —— 那恰恰是要测的错误
 */
export function normalize(s) {
  if (!s) return ''
  let out = String(s)
  // 全角 ASCII（U+FF01–U+FF5E）→ 半角
  out = out.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
  // 全角空格
  out = out.replace(/\u3000/g, '')
  // 常见中文标点归一（同一标点的两种写法，不涉及字符识别）
  out = out.replace(/[，]/g, ',').replace(/[。]/g, '.').replace(/[：]/g, ':').replace(/[；]/g, ';')
  // 去所有空白
  out = out.replace(/\s+/g, '')
  return out
}

/** 字符级编辑距离（Levenshtein，滚动数组） */
export function levenshtein(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  const prev = new Array(b.length + 1)
  const cur = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]
  }
  return prev[b.length]
}

/** 字符错误率；参考为空时返回 0（没有可错的） */
export function cer(ref, hyp) {
  const r = normalize(ref)
  const h = normalize(hyp)
  if (!r.length) return h.length ? 1 : 0
  return levenshtein(r, h) / r.length
}

/**
 * 行命中率：参考文本逐行判断是否在识别结果里"出现了"。
 *
 * 判定用「该行最佳匹配窗口的 CER ≤ tol」，而不是严格子串包含——
 * 因为 OCR 会把段合并、把行内空格吃掉，严格包含会把"只错一个字"判成整行丢失。
 * 窗口长度取 len*1.4 上下滑动，容忍少量多识别字符。
 */
export function lineRecall(ref, hyp, tol = 0.25) {
  const h = normalize(hyp)
  const lines = String(ref).split('\n').map((l) => normalize(l)).filter(Boolean)
  if (!lines.length) return { total: 0, hit: 0, ratio: 1, missed: [] }
  let hit = 0
  const missed = []
  for (const line of lines) {
    if (findBestLineCer(line, h) <= tol) hit += 1
    else missed.push(line)
  }
  return { total: lines.length, hit, ratio: hit / lines.length, missed }
}

/** 在长文本里找与 line 最像的一段，返回最小 CER */
function findBestLineCer(line, hay) {
  if (!hay.length) return 1
  if (hay.includes(line)) return 0
  const n = line.length
  const minWin = Math.max(1, Math.floor(n * 0.75))
  const maxWin = Math.min(hay.length, Math.ceil(n * 1.4))
  let best = 1
  for (let w = minWin; w <= maxWin; w += Math.max(1, Math.floor(n / 6))) {
    for (let i = 0; i + w <= hay.length; i++) {
      const c = levenshtein(line, hay.slice(i, i + w)) / n
      if (c < best) best = c
      if (best === 0) return 0
    }
  }
  return best
}

/**
 * 数字 token 召回：教辅里"数"错了等于全错。
 * 从参考文本抽出所有数字串，检查是否出现在识别结果中。
 */
export function numberRecall(ref, hyp) {
  const nums = String(ref).match(/\d+(?:\.\d+)?/g) || []
  if (!nums.length) return { total: 0, hit: 0, ratio: 1, missed: [] }
  const h = normalize(hyp)
  const missed = nums.filter((n) => !h.includes(n))
  return { total: nums.length, hit: nums.length - missed.length, ratio: (nums.length - missed.length) / nums.length, missed }
}
