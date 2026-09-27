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
}

export interface ImageProcessResult {
  url: string
  key: string
  timeline_id: string
  /** erase_v2 会带回处理诊断信息（覆盖比例 / mask 来源 / 一致性等） */
  debug?: Record<string, unknown>
}
