/**
 * 本地题目结构化（主路径，零 VLM 依赖）
 * ------------------------------------------------------------------
 * 目标：把本地 OCR 侧车输出的纯文字，按中小学试卷的编号约定切成一道道题，
 * 并复用 ocr-hierarchy 推断大题/小题父子关系、回填大题题干。
 *
 * 为什么要有它：此前"本地 OCR 出文字 → 再喂 VLM 做语义切分"，VLM 在主路径上，
 * 既慢（每次识别都要跑一次大模型）、又受 COZE_API_TOKEN 凭证约束、还引入不确定性。
 * 而"按题号切分"本质上是确定性规则题 —— 交给 VLM 是杀鸡用牛刀。
 * 改造后：本地结构化为主路径，VLM 仅在本地质量不达标时兜底（见 ocr.service）。
 *
 * 输入：本地 OCR 的 raw_text（优先）+ text_regions（用于无换行时按 y 坐标恢复行序）。
 */
import type { RecognizedItem, LocalOcrTextRegion } from './ocr.types'
import { inferHierarchy, linkHierarchy, parseQuestionNumber } from './ocr-hierarchy'

/** 本地结构化的质量自评：供调用方决定是否需要 VLM 兜底 */
export interface LocalStructQuality {
  ok: boolean
  reason: string
  /** 切出的题目数 */
  count: number
  /** 题目平均字符长度（过短说明切碎了） */
  avgLen: number
  /** 是否识别出层级（存在父子关系） */
  hasHierarchy: boolean
  /** 由推断（而非模型标注）得到的父子关系条数 */
  inferred: number
}

export interface LocalStructResult {
  items: RecognizedItem[]
  quality: LocalStructQuality
}

/** 质量门槛（设计常数，非回归棘轮） */
export const LOCAL_STRUCT_MIN_AVG_LEN = 12 // 单题平均字符低于此值视为切碎
export const LOCAL_STRUCT_MIN_CONFIDENCE = 0.6 // OCR 侧车自评置信度低于此值视为不可信

/** 把 text_regions 按 y 坐标聚成行，恢复阅读顺序（raw_text 无换行时的兜底） */
function regionsToLines(regions: LocalOcrTextRegion[]): string[] {
  if (!regions.length) return []
  const sorted = [...regions].sort((a, b) => {
    const ay = Math.min(a.box[1], a.box[3])
    const by = Math.min(b.box[1], b.box[3])
    if (Math.abs(ay - by) > 12) return ay - by
    return Math.min(a.box[0], a.box[2]) - Math.min(b.box[0], b.box[2])
  })
  const lines: string[] = []
  let curY = -999
  let cur = ''
  for (const r of sorted) {
    const y = Math.min(r.box[1], r.box[3])
    if (Math.abs(y - curY) > 12) {
      if (cur) lines.push(cur)
      cur = r.text || ''
      curY = y
    } else {
      cur += (cur ? ' ' : '') + (r.text || '')
    }
  }
  if (cur) lines.push(cur)
  return lines
}

/** 归一化输入为行数组 */
function toLines(rawText: string, regions?: LocalOcrTextRegion[]): string[] {
  const fromText = (rawText || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (fromText.length > 1) return fromText
  const fromRegions = regionsToLines(regions || [])
  return fromRegions.length ? fromRegions : fromText
}

/** 判断该行是否开启一道新题：行首带题号，且不是选项行（A. B. C. D.） */
function isQuestionStart(line: string): boolean {
  const p = parseQuestionNumber(line)
  if (p.kind === 'none') return false
  // 避免把题面中间的"（1）""①"当成新题：要求这一行有实质长度（不像孤立的编号）
  if (line.replace(p.raw, '').trim().length < 2) return false
  return true
}

export interface StructureOptions {
  regions?: LocalOcrTextRegion[]
  confidence?: number
  lowConfidence?: boolean
  /** 最小平均长度门槛，默认 LOCAL_STRUCT_MIN_AVG_LEN */
  minAvgLen?: number
}

/**
 * 把本地 OCR 文字切成结构化题目。
 *
 * 切分规则：
 *  1. 行首带题号 → 开新题；
 *  2. 无题号的行并入当前题（作答、选项、解析都跟着本题）；
 *  3. 开新题前的碎片（< 6 字符、无中文）不单独成题，并入上一题；
 *  4. 切完后走 inferHierarchy 推断父子、linkHierarchy 回填大题题干。
 */
export function structureLocalItems(rawText: string, opts: StructureOptions = {}): LocalStructResult {
  const lines = toLines(rawText, opts.regions)
  const blocks: string[] = []
  let cur = ''
  for (const ln of lines) {
    if (isQuestionStart(ln)) {
      if (cur.trim()) blocks.push(cur.trim())
      cur = ln
    } else {
      cur += (cur ? '\n' : '') + ln
    }
  }
  if (cur.trim()) blocks.push(cur.trim())

  // 合并过短碎片到上一块
  const merged: string[] = []
  for (const b of blocks) {
    const meaningful = /[\u4e00-\u9fa5]/.test(b) && b.length >= 6
    if (!meaningful && merged.length) {
      merged[merged.length - 1] += `\n${b}`
    } else {
      merged.push(b)
    }
  }

  const items: RecognizedItem[] = merged.map((q) => ({
    question_content: q,
    wrong_answer: '',
    answer_content: '',
    solution: '',
    source: '',
    status: 'pending' as const,
    question_image_keys: [],
  }))

  // inferHierarchy 返回新数组（不就地修改），必须回写
  const inferred = inferHierarchy(items)
  for (let i = 0; i < items.length; i++) {
    items[i].parent_index = inferred.items[i].parent_index
    items[i].level = inferred.items[i].level
  }
  linkHierarchy(items)

  const avgLen = items.length
    ? items.reduce((s, it) => s + (it.question_content || '').length, 0) / items.length
    : 0
  const hasHierarchy = items.some((it) => typeof it.parent_index === 'number' && it.parent_index !== null)

  // 中文字符占比：过低说明 OCR 出的是噪声/英文碎片，本地切分不可信
  const allText = items.map((it) => it.question_content || '').join('')
  const cjkRatio = allText.length
    ? (allText.match(/[\u4e00-\u9fa5]/g) || []).length / allText.length
    : 0

  let ok = true
  let reason = 'ok'
  if (!items.length) {
    ok = false
    reason = '未切出任何题目'
  } else if (avgLen < (opts.minAvgLen ?? LOCAL_STRUCT_MIN_AVG_LEN)) {
    ok = false
    reason = `单题平均 ${avgLen.toFixed(1)} 字 < ${opts.minAvgLen ?? LOCAL_STRUCT_MIN_AVG_LEN}，疑似切碎`
  } else if (cjkRatio < 0.15) {
    ok = false
    reason = `中文占比仅 ${(cjkRatio * 100).toFixed(0)}%，疑似 OCR 噪声`
  } else if (typeof opts.confidence === 'number' && opts.confidence < LOCAL_STRUCT_MIN_CONFIDENCE) {
    ok = false
    reason = `OCR 置信度 ${opts.confidence.toFixed(2)} < ${LOCAL_STRUCT_MIN_CONFIDENCE}`
  } else if (opts.lowConfidence) {
    ok = false
    reason = 'OCR 侧车自评低置信'
  }

  return {
    items,
    quality: { ok, reason, count: items.length, avgLen, hasHierarchy, inferred: inferred.inferred },
  }
}
