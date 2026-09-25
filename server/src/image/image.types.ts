export type ImageAction = 'auto' | 'enhance' | 'erase'

export interface ProcessImageDto {
  // 自动调正 auto / 智能高清 enhance / 去手写 erase
  action: ImageAction
  // 待处理图片的公网 URL
  image_url: string
}

export interface ImageProcessResult {
  url: string
  key: string
  timeline_id: string
}
