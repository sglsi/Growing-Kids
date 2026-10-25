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
  /**
   * P2：该题在题面页上的像素框（extract-wrong / recrop 回传，供前端叠加视图与改框）。
   * 与 wrongq 引擎同口径（flatBuf 像素空间）。落库时不消费（存储只取内容字段）。
   */
  box?: { x0: number; y0: number; x1: number; y1: number }
  /** P2：系统/用户判定（wrong=错题；供叠加视图颜色编码） */
  verdict?: 'wrong' | 'correct' | 'blank' | 'unknown'
  /** P1：规范题号标签（如 "预习案·Ⅱ.汉译英 18"；两节重号时可唯一指认题目） */
  question_label?: string
  /**
   * ④（#143）PaddleOCR-VL 手写识别全文（OCR_VL_HANDWRITE=1 时产出）。
   * VL 对「题干印刷 + 学生手写答案 + 红笔订正」混合内容比 PP-OCRv5 强，
   * 作 wrong_answer 的兜底源与人工核对材料；未开启/失败时不存在该字段。
   */
  vl_full_text?: string
}

/**
 * 导出 Word 的条目（#150 人工辅助错题整理）：
 * 前端把「粘贴栏」每条题目回传——文本 + 手动裁剪的图片 URL 列表。
 *
 * 与 RecognizedItem 的关系：后者是自动识别链路的结构化产物（字段多、落库用）；
 * 本类型只取导出所需字段，images 为公网可访问 URL，服务端下载后嵌入 docx。
 * 既有的「识别结果导出」调用方传的 items 结构上兼容本类型（多余字段被忽略）。
 */
export interface ExportDocxItem {
  question_content: string
  /** 手动裁剪的错题图片 URL（公网可访问）；导出时按序嵌入题干之后 */
  images?: string[]
  wrong_answer?: string
  answer_content?: string
  solution?: string
  source?: string
  level?: number
}

/**
 * force=true ⇒ 忽略已有缓存、强制重跑识别并覆盖写入（#121 手动「重新识别」）。
 * 用于「上次识别结果不对，我想重来一次」——默认 false。
 */
export interface RecognizeExamDto {
  subject_id: string
  image_keys: string[]
  force?: boolean
}

export interface RecognizeExamUrlDto {
  subject_id: string
  urls: string[]
  force?: boolean
}

export interface RecognizePairDto {
  question_image_keys: string[]
  answer_image_keys: string[]
  force?: boolean
}

export interface RecognizeDocDto {
  file_url: string
  force?: boolean
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
