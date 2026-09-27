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
   * erase_v2 专用：局部修复策略。
   *  - masked（默认）：背景底色填充 —— 能抹除**大面积实心手写**，推荐
   *  - edge：由内向外扩散填充 —— 适合需要延续底色渐变的场景
   *  - median：中值滤波 —— 只适合细笔迹落在空白/浅色背景
   *  - blur：高斯模糊 —— 浅色笔迹的柔和淡化
   */
  strategy?: 'median' | 'blur' | 'masked' | 'edge'
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
   * 智能高清(SR)专用：升采样倍率，默认 2，支持 2/3/4。
   * 仅当 IMG_PIPELINE_MODE ∈ {new, hybrid} 时生效；否则回落图生图 enhance。
   */
  sr_scale?: 2 | 3 | 4
  /**
   * 智能高清(SR)专用：推理模式，'classical'(默认,零权重) | 'espcn'(需置 ESPCN_WEIGHTS_URL)。
   * 缺省读环境变量 SR_MODE。
   */
  sr_mode?: 'classical' | 'espcn'
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

export interface ImageProcessResult {
  url: string
  key: string
  timeline_id: string
  /** erase_v2 会带回处理诊断信息（覆盖比例 / mask 来源 / 一致性等） */
  debug?: Record<string, unknown>
}
