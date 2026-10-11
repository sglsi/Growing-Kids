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

/**
 * 书写簇（语义层）：空间上聚成一串的红笔笔画 = 教师在此处的**手写内容**。
 *
 * 为什么要有这一层（实测根因）：
 *   单个连通域的形态分类极不可靠——教师连笔订正会被切成许多小笔画，
 *   碎片几何落在勾/叉区间 → 一页误判出 109 个"勾"、59 个"圈"（实际仅 1 个半勾、0 个叉）。
 *   但**"一串笔画聚在一起"** 这个事实是稳定的：对勾是孤立的单个符号，
 *   而订正必然是成片的多个笔画域。故判定从"数形态"升级为"看书写量"。
 */
export interface WritingCluster {
  id: number
  box: { x0: number; y0: number; x1: number; y1: number }
  markIds: number[]
  /** 连通域（笔画）个数 */
  parts: number
  /** 总红墨像素数 */
  ink: number
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
  /** 来源书写簇 id（语义聚类驱动建块时）；-1 表示非簇驱动 */
  clusterId?: number
  /**
   * 题号回溯条带（块**上方**若干行）。
   *
   * 为什么需要：裁图收紧后框内往往只剩学生的手写答案（印刷题号在题目行，与订正不同行），
   * 实测 9 条错题**题号全部解析不到**，用户看到条目却认不出是哪道题。
   * 故额外给出上方行带，由服务层单独 OCR 补出「题号 + 印刷题干」，
   * 而裁图本身仍聚焦订正处（看图聚焦、读文有题号，两者兼得）。
   */
  titleBox?: { x0: number; y0: number; x1: number; y1: number }
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
  /** 语义书写簇（教师手写订正处），驱动判卷与切块 */
  clusters: WritingCluster[]
  blocks: WrongqBlock[]
  /** VLM 是否真正参与（凭证缺失时为 false） */
  vlmUsed: boolean
  vlmError?: string
  debug: {
    inkRatio: number
    furnitureCount: number
    redCoverage: number
    colRowCounts: number[]
    /** 朝向未经 OCR 消歧确认 → true 时本页结果可能整页倒置，不可直接采信 */
    orientSuspect?: boolean
    orientMethod?: 'projection' | 'ocr' | 'none'
  }
}

export interface WrongqOptions {
  /** 色域彩度阈值（v6 实测：22 会漏细对勾，14 更合适） */
  chromaMin?: number
  /** 是否允许调用 VLM（无凭证时自动降级） */
  allowVlm?: boolean
  /** VLM 图像 URL（需公网可达；本环境本地文件无法直传） */
  imageUrl?: string
  /**
   * 同列内块纵向 IoU ≥ 该值则合并，用于收敛"同一题多处批改"造成的重复块。
   * 默认 0.85（实测扫描：0.85 → 重复率归零且题号召回无损；0.7 虽多减块但会吞掉邻题）。
   * 传 0 可关闭收敛（回归对照用）。
   */
  mergeIoU?: number
  /**
   * 书写簇聚类间距（×medH）。默认 0.5（实测：front/back 两页均命中真值 6/3）。
   * 传 0 可关闭语义聚类、回退到"全部标记建块"（回归对照用）。
   */
  clusterGap?: number
  /** 书写簇最少笔画域数（默认 3）：孤立的对勾只有 1~2 个域，订正则远多于此 */
  clusterMinParts?: number
  /** 书写簇最少墨量（×medH²，默认 0.8）：过滤极淡的偶发红点 */
  clusterMinInk?: number
}
