export type ImageAction = 'auto' | 'enhance' | 'erase' | 'erase_v2'

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
   * 自动调正(几何纠偏)专用：前端手动拉出的试卷四角，顺序任意
   * [[x,y],[x,y],[x,y],[x,y]]。提供则直接做透视压平（100% 保真，不重画）；
   * 未提供且自动检测未命中时降级返回原图并提示手动拉框（方案 §2.3）。
   *
   * 坐标口径：**归一化 [0,1]（相对原图）优先**——服务端按原图尺寸还原为像素；
   * 兼容旧调用方直接传像素坐标（任一坐标 >1 即判定为像素，不再缩放）。
   */
  manual_corners?: [[number, number], [number, number], [number, number], [number, number]]
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
  enhance_preset?: 'original' | 'enhance' | 'bw'
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

export interface ImageProcessResult {
  url: string
  key: string
  timeline_id: string
  /** erase_v2 会带回处理诊断信息（覆盖比例 / mask 来源 / 一致性等） */
  debug?: Record<string, unknown> & { notice?: ImageNotice }
}
