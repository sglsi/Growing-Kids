import type { RecognizedItem } from '../ocr/ocr.types'

/**
 * 【Phase 3 · 交付 3】处理前后 OCR 一致性度量。
 *
 * 目的：智能高清（SR）本质是像素级重采样 + 锐化，理论上应当**提升**可识别度、
 * 绝不应当**劣化**。但任何图像处理链都可能在极端情况下（过锐化产生振铃、
 * 色度分离、放大插值把细笔画糊掉）让 VLM 的识别结果变差。
 *
 * 我们没有人工标注作为"真值"，于是用**自一致性**作为代理指标：
 * 同一份文档的**原图**与**处理后图**各跑一次 OCR，若两次结果高度一致，
 * 说明处理没有破坏可识别内容；若显著不一致，则保守**回退原图**（宁可不增强，
 * 也不能交一张识别不出来的图）。
 *
 * 该模块为**纯函数**，无 IO、无依赖，便于单测与复用。
 */

export interface OcrConsistency {
  /** 综合判定：score ≥ 阈值即认为一致 */
  similar: boolean
  /** 题面字符集 Jaccard 相似度 [0,1] */
  charOverlap: number
  /** 题数一致度 = min/max ∈ [0,1] */
  countRatio: number
  /** 总字数一致度 = min/max ∈ [0,1] */
  lengthRatio: number
  /** 综合加权分 [0,1] */
  score: number
  /** 诊断：两侧分别识别到的题数与总字数 */
  detail: { aCount: number; bCount: number; aChars: number; bChars: number }
}

/** 默认判定阈值（可由 IMG_OCR_MIN_SCORE 覆盖）。 */
export const OCR_CONSISTENCY_THRESHOLD = 0.75

/**
 * 把一道题的所有文本字段拼成一条串，用于字符集/字数统计。
 * 刻意**不含** source（页码/来源噪声大）与 status（派生字段，无信息量）。
 */
function itemText(it: RecognizedItem): string {
  return [it.question_content, it.wrong_answer, it.answer_content, it.solution]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join('\n')
}

/** 归一化：去掉所有空白字符，仅保留有意义的可见字符。 */
function normalize(s: string): string {
  return s.replace(/\s+/g, '')
}

/** 字符集（去重），用于 Jaccard。 */
function charset(s: string): Set<string> {
  const set = new Set<string>()
  for (const ch of s) set.add(ch)
  return set
}

/**
 * 对比两次识别结果的一致性。
 *
 * - `charOverlap`：题面字符集 Jaccard = |A∩B| / |A∪B|。对公式/符号敏感，
 *   但正是因为"符号丢没丢"才是判断处理是否劣化的关键信号。
 * - `countRatio`：题数一致度 = min/max。少识别出一整道题是严重劣化。
 * - `lengthRatio`：总字数一致度 = min/max。整体内容缩水/膨胀的粗粒度信号。
 * - `score = 0.5·charOverlap + 0.25·countRatio + 0.25·lengthRatio`。
 *
 * 边界：两侧皆空（无题可识别）→ 视为**一致**（score=1），因为"都没有内容"
 * 不存在劣化，回退也无意义；任一侧为空而另一侧非空 → score=0（严重不一致）。
 */
export function compareRecognized(
  a: RecognizedItem[],
  b: RecognizedItem[],
  threshold: number = OCR_CONSISTENCY_THRESHOLD,
): OcrConsistency {
  const listA = Array.isArray(a) ? a : []
  const listB = Array.isArray(b) ? b : []

  const textA = normalize(listA.map(itemText).join('\n'))
  const textB = normalize(listB.map(itemText).join('\n'))
  const aChars = textA.length
  const bChars = textB.length

  const detail = { aCount: listA.length, bCount: listB.length, aChars, bChars }

  // 两侧皆空：无内容可判劣化 → 视为一致
  if (aChars === 0 && bChars === 0) {
    return { similar: true, charOverlap: 1, countRatio: 1, lengthRatio: 1, score: 1, detail }
  }
  // 一侧有内容、一侧全空：严重不一致
  if (aChars === 0 || bChars === 0) {
    return { similar: false, charOverlap: 0, countRatio: 0, lengthRatio: 0, score: 0, detail }
  }

  // 字符集 Jaccard
  const setA = charset(textA)
  const setB = charset(textB)
  let inter = 0
  for (const ch of setA) if (setB.has(ch)) inter += 1
  const union = setA.size + setB.size - inter
  const charOverlap = union > 0 ? inter / union : 1

  // 题数比（任一为 0 已在上面处理，此处必 >0）
  const maxCount = Math.max(listA.length, listB.length)
  const countRatio = maxCount > 0 ? Math.min(listA.length, listB.length) / maxCount : 1

  // 总字数比
  const maxChars = Math.max(aChars, bChars)
  const lengthRatio = maxChars > 0 ? Math.min(aChars, bChars) / maxChars : 1

  const score = 0.5 * charOverlap + 0.25 * countRatio + 0.25 * lengthRatio
  const safeThreshold = Number.isFinite(threshold) ? threshold : OCR_CONSISTENCY_THRESHOLD

  return {
    similar: score >= safeThreshold,
    charOverlap,
    countRatio,
    lengthRatio,
    score,
    detail,
  }
}
