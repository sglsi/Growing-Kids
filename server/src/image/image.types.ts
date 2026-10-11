export type ImageAction = 'auto' | 'enhance' | 'erase' | 'erase_v2'

/**
 * 错题提取（切块→逐块识别→题号关联）请求体：POST /api/image/extract-wrong
 * 与 recognize-pair 的区别：本接口先本地切块，再对每块单独 OCR，落库的是"题块图+区域文本"而非整图。
 */
export interface ExtractWrongDto {
  /** 题面图（带红笔批改痕迹）的公网可访问 URL */
  image_url: string
  /** 答题卡/答案图 key（可选）；提供则按题号把答案文本关联到每道错题块 */
  answer_image_keys?: string[]
}

/** 切块依据来源（诊断用，便于排查"为什么切得不对"） */
export type WrongqBlockSource = 'red' | 'layout' | 'local-vlm' | 'none'

/** `POST /api/image/extract-wrong` 的响应体 */
export interface ExtractWrongResult {
  items: import('../ocr/ocr.types').RecognizedItem[]
  unmatched_questions: string[]
  answer_image_keys: string[]
  /** P1-8：拍摄清晰度门禁（仅提示，不阻断） */
  quality?: { sharpness: number; sharp: boolean; hint?: string | null; sample_size?: number }
  /** 本次切块走了哪条路：red=红笔锚定 / layout=纯版面兜底 / local-vlm=自托管 VLM 升级 */
  block_source?: WrongqBlockSource
  /** P1-13：被判定为近重复而合并掉的题数 */
  deduped?: number
  /** 诊断信息（块数、各分支计数等） */
  debug?: Record<string, unknown>
}

export interface ProcessImageDto {
  // 自动调正 auto / 智能高清 enhance / 去手写(图生图) erase / 去手写(局部修复) erase_v2
  action: ImageAction
  // 待处理图片的公网 URL
  image_url: string
  // 是否在处理完成后归档进「最近题目」（默认 false：仅预览，不落库）
  save?: boolean
  // erase_v2 专用：是否允许用 VLM 做手写区域分割（默认 true，false 则只走色域阈值）
  use_vlm?: boolean
  /**
   * erase_v2 专用：⭐ 交互式补擦（扫描王/TextIn 同款兜底交互）。
   * 用户在前端框选"没擦干净"的残留区域（归一化坐标 0~1），服务端**无条件**并入
   * 擦除 mask——自动检测对「黑笔手写 vs 黑色印刷」有理论上限（几何/色彩特征
   * 全面重叠），漏检零容忍场景下这是确定性手段，优先级高于一切自动检测。
   * 格式同 VLM 输出：{x,y,w,h} 均为归一化值，可与 use_vlm/自动检测叠加使用。
   */
  manual_regions?: Array<{ x: number; y: number; w: number; h: number }>
  // erase_v2 专用：局部修复策略（缺省 adaptive：空白区填底色 / 压字区结构延拓）
  strategy?: 'median' | 'blur' | 'masked' | 'edge' | 'adaptive'
  /**
   * erase_v2 专用：⭐ 擦除模式（v18.2 / v21.5）。
   *  - **'word'（缺省默认）**：只擦「确信手写」的词（词级判别器 state===1），
   *    印刷(0) 与 疑虑(2) 一律保留 —— 即「疑罪从无」，宁可少擦也不误伤印刷。
   *    端到端实测 4 卷：擦净 34/44(77%)、插图受损 6/16、框外改动 90,881px（损伤最低）。
   *  - 'union_generic'：hybrid 经**颜色无关印刷保护**后 ∪ 词通道确信手写。
   *    召回更高（84%）、损伤略升（95,783px），适合「更想擦干净」的场景。
   *  - 'union'：旧三通道并集，服务黑笔/铅笔手写卷；
   *  - 'color'：仅彩色笔迹通道 + 印刷保护闸，服务**红/蓝笔批改卷**——
   *    红笔卷上深色/槽位通道对红笔清除零贡献，却会连带吞掉大量印刷正文
   *    （实测 mask 内被删像素 42.5% 是印刷）。color 模式误删降 52%~99%。
   */
  erase_mode?: 'union' | 'color' | 'word' | 'union_generic'
  /**
   * 自动调正(几何纠偏)专用：前端手动拉出的试卷四角，顺序任意
   * [[x,y],[x,y],[x,y],[x,y]]。提供则直接做透视压平（100% 保真，不重画）；
   * 未提供且自动检测未命中时降级返回原图并提示手动拉框（方案 §2.3）。
   *
   * 坐标口径：**归一化 [0,1]（相对原图）优先**——服务端按原图尺寸还原为像素；
   * 兼容旧调用方直接传像素坐标（任一坐标 >1 即判定为像素，不再缩放）。
   */
  manual_corners?: [[number, number], [number, number], [number, number], [number, number]]
  /**
   * 错题区域提取（POST /image/wrongq）专用。
   *  - wrongq_chroma_min：红笔色域彩度阈值，默认 14（v6 实测：22 会漏细对勾）
   *  - wrongq_allow_vlm：是否允许调用 VLM 做语义判错。**本环境 COZE_API_TOKEN 未配置时
   *    自动 fail-open**，改由本地证据层产出，并在 debug.vlmError 中说明原因
   *  - wrongq_assets：是否为每个题块产出 raw/enhanced/clean 三份裁图（默认 false，省时）
   */
  wrongq_chroma_min?: number
  wrongq_allow_vlm?: boolean
  wrongq_assets?: boolean
  /**
   * 智能高清【高清扩展】专用：升采样倍率，默认 2，支持 2/3/4（X2/X3/X4）。
   * 即"高清扩展"清晰度增强——彩色增强模式可选开启；黑白模式强制原生分辨率不启用。
   * 仅当 IMG_PIPELINE_MODE ∈ {new, hybrid} 时生效；否则回落图生图 enhance。
   */
  sr_scale?: 2 | 3 | 4
  /**
   * 智能高清(SR)专用：推理模式，'classical'(默认,零权重) | 'espcn'(需置 ESPCN_WEIGHTS_URL)。
   * 缺省读环境变量 SR_MODE。
   */
  sr_mode?: 'classical' | 'espcn'
  /**
   * 【P1 多模式输出】智能高清专用（对齐扫描全能王，方案 §P1）：
   *  - `original` 原图：不做任何像素改动（保真场景，如已很清晰的印刷件）
   *  - `enhance`  增强（**默认**）：背景归一化 + 局部对比软增强 + 自适应锐化，
   *                保留灰阶，不破坏照片/插图 —— 通用首选
   *  - `bw`       黑白：上述 + Sauvola 硬二值化，纯文字文档可读性最大，
   *                ⚠️ 会丢失灰阶（图表/照片区由版面感知自动保护，不被二值化）
   * 缺省读环境变量 IMG_ENHANCE_PRESET。
   */
  enhance_preset?: 'original' | 'enhance' | 'bw' | 'brighten' | 'gray'
  /**
   * 【P1 后续：多模式并列输出】智能高清专用。
   * 置 true 时一次产出**全部五种模式**（原图/增强/黑白/增亮/灰度）的预览图，
   * 在 `ImageProcessResult.modes` 返回各模式 url，供前端并列渲染缩略图让用户自选
   * （方案 §P1「预览自选 UX」）。主 `url` 仍是智能默认档那张。
   * ⚠️ 预览为轻量档（内部 scale=1，不做高清扩展），用户选定后再按选定模式
   *    请求最终画质（scale=2 高清扩展 + OCR 一致性校验），避免 5 份大图浪费算力。
   */
  multi_modes?: boolean
  /**
   * 【P1 强度档位】智能高清专用：'weak' | 'medium'(默认) | 'strong'。
   * 存在理由：把"是否过头"的最终把控权交给用户，避免算法自说自话（方案 §P1）。
   * 缺省读环境变量 IMG_ENHANCE_STRENGTH。
   */
  enhance_strength?: 'weak' | 'medium' | 'strong'
  /**
   * 【Phase 3】处理前后 OCR 一致性自动回退。
   * 仅 enhance 默认开启（auto/erase 不启用）；置 false 可关。
   * 处理图识别一致性低于阈值(IMG_OCR_MIN_SCORE,默认0.75)时自动回退原图。
   */
  verify_ocr?: boolean
  /**
   * 【Phase 3】自动调正专用：是否尝试曲面展开(dewarping)。
   * 默认 false 走平面透视变换。当前经典曲面法实测不达标，置 true 亦会安全回落平面。
   */
  dewarp_curved?: boolean
}

/**
 * 给用户看的「处理结果提示」。
 *
 * ⭐ 存在的理由（五轮「点了不能用」反馈的根因）：
 *   三个功能都存在「安全地原样返回原图」的分支（未检出手写 / 未命中纸张四角 /
 *   OCR 一致性不达标回退）。这些分支在后端是**正确且必要**的（宁可不改也不能改坏），
 *   但此前前端拿到 200 + url 就当成功静默替换 → 用户看到的是「点了没反应」。
 *   因此凡是「没改动」的返回，都必须带 notice，由前端弹窗明确告知原因与下一步。
 */
export interface ImageNotice {
  level: 'info' | 'warn'
  title: string
  message: string
}

/** 单模式产出的图（多模式并列输出中的一项） */
export interface ModeAsset {
  url: string
  key: string
  width: number
  height: number
  sizeBytes: number
}

export interface ImageProcessResult {
  url: string
  key: string
  timeline_id: string
  /**
   * 【P1 后续】多模式并列输出：`multi_modes=true` 时返回五种模式各自的图，
   * 键为模式名（original / enhance / bw / brighten / gray）。
   * 前端据此渲染缩略图条，点击即把该模式设为主图（预览自选，方案 §P1）。
   */
  modes?: Record<'original' | 'enhance' | 'bw' | 'brighten' | 'gray', ModeAsset>
  /** erase_v2 会带回处理诊断信息（覆盖比例 / mask 来源 / 一致性等） */
  debug?: Record<string, unknown> & { notice?: ImageNotice }
}
