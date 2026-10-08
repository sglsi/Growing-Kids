/**
 * 错题区域提取 · 类型定义
 *
 * 依据《错题区域提取-程序设计.md》§6 流水线：
 *   ①预处理 → ②题目切分 → ③批改标记检测 → ④标记↔题目关联 → ⑤VLM → ⑥裁图 → ⑦入库
 *
 * ⚠️ 关键前提（v6 实测）：本环境 VLM 凭证未配置（COZE_API_TOKEN 缺失），
 *    VLM 通路按 fail-open 实现——不可用时本地证据层独立产出结果，绝不阻塞。
 */

/** 批改标记形态类别（规则分类，阈值见 §6.3，待金标准标定） */
export type MarkKind =
  | 'cross' // 红叉
  | 'tick' // 对勾（判"对"的关键证据）
  | 'half_tick' // 半勾
  | 'circle' // 红圈
  | 'underline' // 红横线
  | 'question_mark' // 问号
  | 'deduct' // 扣分标记（附近有数字）
  | 'correction' // 红笔订正/大字批注
  | 'unknown' // 形态不明

export type WrongqVerdict = 'wrong' | 'correct' | 'blank' | 'unknown'

/** 单个红笔标记连通域 */
export interface RedMark {
  id: number
  box: { x0: number; y0: number; x1: number; y1: number }
  /** 像素数 */
  n: number
  /** 填充率 = n / bbox面积 */
  fill: number
  /** 宽高比 */
  aspect: number
  kind: MarkKind
  /** 所属栏索引（0起），-1 表示未归属 */
  col: number
}

/** 候选题块（以红笔标记簇为锚点） */
export interface WrongqBlock {
  id: number
  /** 像素框 */
  box: { x0: number; y0: number; x1: number; y1: number }
  /** 归一化框 [x, y, w, h]，0~1 */
  normBox: [number, number, number, number]
  col: number
  markIds: number[]
  verdict: WrongqVerdict
  confidence: number
  /** 证据来源描述（供前端提示与人工核对） */
  evidence: string[]
  /** local=纯本地证据；vlm=VLM 判定；fused=两者融合 */
  source: 'local' | 'vlm' | 'fused'
  /** VLM 与本地证据不一致时为 true */
  suspect?: boolean
}

export interface WrongqPageResult {
  medH: number
  cols: Array<[number, number]>
  marks: RedMark[]
  blocks: WrongqBlock[]
  /** VLM 是否真正参与（凭证缺失时为 false） */
  vlmUsed: boolean
  vlmError?: string
  debug: {
    inkRatio: number
    furnitureCount: number
    redCoverage: number
    colRowCounts: number[]
  }
}

export interface WrongqOptions {
  /** 色域彩度阈值（v6 实测：22 会漏细对勾，14 更合适） */
  chromaMin?: number
  /** 是否允许调用 VLM（无凭证时自动降级） */
  allowVlm?: boolean
  /** VLM 图像 URL（需公网可达；本环境本地文件无法直传） */
  imageUrl?: string
}
