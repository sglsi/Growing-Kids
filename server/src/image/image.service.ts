import { Injectable, BadRequestException } from '@nestjs/common'
import {
  ImageGenerationClient,
  Config,
  HeaderUtils,
} from 'coze-coding-dev-sdk'
import * as http from 'http'
import * as https from 'https'
import { StorageService } from '../storage/storage.service'
import { MaterialsService } from '../materials/materials.service'
import type { ImageAction, ProcessImageDto, ImageProcessResult } from './image.types'

const PROMPTS: Record<ImageAction, { prompt: string; desc: string }> = {
  auto: {
    prompt:
      '自动校准这张照片：将倾斜/透视变形的文字内容扶正拉平，使文本行保持水平、边缘规整，同时完整保留画面中的所有印刷文字与手写内容，不改变文字内容与颜色，保持清晰。',
    desc: '自动调正',
  },
  enhance: {
    prompt:
      '智能高清增强：提升这张图片的分辨率与清晰度，锐化文字笔画、增强对比度与细节，使印刷文字与手写内容更清晰易读，不改变内容与排版，保持真实自然的纸张质感。',
    desc: '智能高清',
  },
  erase: {
    prompt:
      '去除图片中的手写笔迹：擦除学生的手写答案、笔痕与涂改痕迹，只保留印刷的题目内容与印出的选项/原文；被手写遮挡的印刷文字按原样重建补全，输出干净的纯题目图片，不添加任何新内容。',
    desc: '去手写',
  },
}

@Injectable()
export class ImageService {
  constructor(
    private readonly storageService: StorageService,
    private readonly materialsService: MaterialsService,
  ) {}

  private download(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https:') ? https : http
      const req = mod.get(url, (res) => {
        // 图生图服务可能返回 3xx 缩短链接
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this.download(res.headers.location).then(resolve, reject)
          res.resume()
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`下载处理图失败(status ${res.statusCode})`))
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      })
      req.setTimeout(60000, () => req.destroy(new Error('下载处理图超时')))
      req.on('error', reject)
    })
  }

  /**
   * 用图生图模型处理图片（自动调正 / 智能高清 / 去手写），
   * 结果转存项目 TOS 得到持久 URL，并归档为素材，返回新图地址。
   */
  async process(dto: ProcessImageDto, forwardHeaders: Record<string, string>): Promise<ImageProcessResult> {
    const action: ImageAction = dto.action || 'enhance'
    const prompt = PROMPTS[action]?.prompt
    if (!prompt) throw new BadRequestException('action 仅支持 auto / enhance / erase')
    if (!dto.image_url) throw new BadRequestException('image_url 不能为空')

    const headers = HeaderUtils.extractForwardHeaders(forwardHeaders)
    const client = new ImageGenerationClient(new Config(), headers)
    const response = await client.generate({
      prompt,
      image: dto.image_url,
      size: '2K',
      watermark: false,
    })

    const helper = client.getResponseHelper(response)
    if (!helper.success) {
      throw new BadRequestException(helper.errorMessages.join(';') || `${PROMPTS[action].desc}处理失败`)
    }
    const resultUrl = helper.imageUrls[0]
    if (!resultUrl) throw new BadRequestException('处理服务未返回图片')

    const buffer = await this.download(resultUrl)

    const key = await this.storageService.uploadBuffer(buffer, `processed-${Date.now()}.png`, 'image/png')
    const url = await this.storageService.getPublicUrl(key)

    // 归档为素材，供后续复用
    let materialId = ''
    try {
      const material = await this.materialsService.createMaterial({
        name: `${PROMPTS[action].desc}-${Date.now()}.png`,
        type: 'image',
        file_key: key,
        url,
        mime_type: 'image/png',
        size_bytes: buffer.length,
      })
      materialId = material.id
    } catch (e) {
      console.error('[image] 素材归档失败（不影响处理）', e)
    }

    return { url, key, material_id: materialId }
  }
}