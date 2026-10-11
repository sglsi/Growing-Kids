/**
 * 错因分析结果（P2-16，本地规则引擎产出；`sbert` 仅在启用自托管语义模型时填充）。
 * 是"候选诊断"而非权威结论——用户可在前端覆盖。
 */
export interface ErrorAnalysis {
  /** 机器可读的错因类别 */
  type:
    | 'no-answer'        // 未作答 / 完全不会
    | 'unscored'         // 已作答但无标准答案可比对
    | 'careless-sign'    // 粗心·符号错误
    | 'careless-calc'    // 粗心·计算错误
    | 'concept-mix'      // 概念混淆
    | 'misread'          // 审题/表述偏差（差一点就对了）
    | 'method-step'      // 方法/步骤错误
    | 'unknown'
  /** 给人看的错因标签 */
  label: string
  /** 错因说明 */
  reason: string
  /** 解法建议 */
  suggestion: string
  /**
   * 可选的 SBERT 语义差异分 [0,1]（1 = 完全一致）。
   * 仅当 `sbertPolicy().enabled` 时由自托管 embedding 端点计算；否则为 undefined。
   */
  sbert?: number
}

export interface RecognizedItem {
  question_content: string
  wrong_answer: string
  answer_content: string
  solution: string
  source: string
  status: 'answered' | 'pending'
  question_image_keys: string[]
  /**
   * P2-16 错因分析结论（本地规则引擎产出；可选）。
   */
  error_analysis?: ErrorAnalysis
  /**
   * 答题卡/答案图 file_key（与题面图区分存储）。
   * 切块流程（extract-wrong）中：每道错题块都挂载整张答案图 key，
   * 落库后由 timeline.content.answer_images 承载，detail 按"题面块/答案块"分组展示。
   */
  answer_image_keys?: string[]
  /**
   * 层级：1 = 大题/父题（独立成题），2 = 小题/子题（从属于某道大题）。
   * 用于解决"大题含若干小题时，小题被拆开识别、大题题干被丢弃"的问题。
   */
  level?: number
  /** 所属父题在 items 中的下标（0 起）；顶层题为 null */
  parent_index?: number | null
  /** 所属大题的完整题干。子题必须携带它，才能脱离父题独立读懂（无本之木问题） */
  stem?: string
  /**
   * 知识点标签候选（P1-13 本地轻量抽取，见 ocr-dedup.pickKeywords）。
   * 存到 timeline_items.tags（独立列，非 jsonb），用户可在前端增删。
   * ⚠️ 是"候选"而非分类器结论 —— 本地规则抽取，未接教育词库/语义模型。
   */
  tags?: string[]
}

export interface RecognizeExamDto {
  subject_id: string
  image_keys: string[]
}

export interface RecognizeExamUrlDto {
  subject_id: string
  urls: string[]
}

export interface RecognizePairDto {
  question_image_keys: string[]
  answer_image_keys: string[]
}

export interface RecognizeDocDto {
  file_url: string
}

// ---------- 本地 OCR 侧车（PaddleOCR + RapidOCR 融合）响应契约 ----------
// 与 ocr-engine/main.py 的 /recognize 输出对齐
export type OcrBox = [number, number, number, number]

export interface LocalOcrTextRegion {
  text: string
  box: OcrBox
  score: number
}

export interface LocalOcrLayoutBlock {
  type: string
  box: OcrBox
  text: string
}

export interface LocalOcrResult {
  raw_text: string
  text_regions: LocalOcrTextRegion[]
  layout: LocalOcrLayoutBlock[]
  tables: unknown[]
  formulas: unknown[]
  confidence: number
  engine_used: string[]
  low_confidence: boolean
}
