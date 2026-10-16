import { Controller, Post, Get, Body, HttpCode, HttpException, Req } from '@nestjs/common'
import { ImageService } from './image.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'
import type { ProcessImageDto, ExtractWrongDto, RecropWrongDto, OcrPageDto } from './image.types'

/** 后端图像能力版本号：前端据此判断线上服务是否包含本地处理管线 */
const IMAGE_CAPABILITIES_VERSION = 3

@Controller('image')
export class ImageController {
  constructor(private readonly imageService: ImageService) {}

  // ⭐ 能力自检端点（无需登录也可访问的轻量 GET）：
  //   GET /api/image/capabilities → 200 = 新版后端（含本地 straighten/enhance/erase_v2）；
  //   404 = 旧版后端（没有本路由，auto/enhance 会落 Coze 兜底且大概率失败）。
  //   用途：前端在图像功能失败时先查此端点，把「服务未更新」与「处理失败」区分开，
  //   彻底终结「点了不能用但看不到原因」的循环反馈。
  @Get('capabilities')
  @HttpCode(200)
  capabilities() {
    const MODE = (process.env.IMG_PIPELINE_MODE || 'hybrid').toLowerCase()
    return {
      code: 200,
      msg: 'success',
      data: {
        version: IMAGE_CAPABILITIES_VERSION,
        pipeline_mode: MODE,
        // 以下三项都是**本地自有功能**（不依赖外部 AI 服务）：
        straighten: true,   // 自动调正：本地几何纠偏（透视压平，100% 保真）
        enhance: true,      // 智能高清：本地超分/锐化（CPU 推理）
        erase_v2: true,     // 去手写：本地手写检测 + 局部修复
        external_fallback: MODE === 'hybrid' || MODE === 'gen', // 仅兜底用（需 COZE_API_TOKEN）
      },
    }
  }

  // 图片处理：
  //   auto     自动调正
  //   enhance  智能高清
  //   erase    去手写（图生图重绘，阶段一增强）
  //   erase_v2 去手写（mask + 局部修复，阶段二，不重排）
  @Post('process')
  @HttpCode(200)
  async process(@Body() dto: ProcessImageDto, @Req() req: RequestWithUser) {
    const userId = requireUserId(req)
    const headers = (req.headers || {}) as Record<string, string>

    // 阶段二：走 mask + 局部修复路径（不做整图重绘）
    if (dto.action === 'erase_v2') {
      const data = await this.imageService.eraseV2(userId, dto, headers)
      return { code: 200, msg: 'success', data }
    }

    // 阶段三(Phase 1)：auto 走几何纠偏（本地，100% 保真），受 IMG_PIPELINE_MODE 灰度控制。
    // 默认 hybrid：新管线优先，任何异常自动回退到 process() 图生图兜底 —— 既不硬失败，
    // 又保证 Phase 1-3 功能**开箱可用**（旧默认 'gen' 会让新功能静默失效，表现为「点了没反应」）。
    const MODE = (process.env.IMG_PIPELINE_MODE || 'hybrid').toLowerCase()
    if ((MODE === 'new' || MODE === 'hybrid') && dto.action === 'auto') {
      try {
        const data = await this.imageService.straighten(userId, dto, headers)
        return { code: 200, msg: 'success', data }
      } catch (e) {
        if (MODE === 'hybrid') {
          console.warn('[image] auto 几何纠偏失败，回退图生图兜底', e)
        } else {
          throw e
        }
      }
    }

    // 阶段三(Phase 2)：enhance 走智能高清（本地 SR，CPU 推理，保真），同受 IMG_PIPELINE_MODE 灰度控制
    if ((MODE === 'new' || MODE === 'hybrid') && dto.action === 'enhance') {
      try {
        const data = await this.imageService.enhance(userId, dto, headers)
        return { code: 200, msg: 'success', data }
      } catch (e) {
        // ⚠️ 限流类错误（429/503）**绝不能**被 hybrid 兜底吞掉：
        //    否则会把「被闸拦下的重任务」直接推给更贵的图生图，等于绕过保护、放大负载。
        //    这类错误原样抛出，让前端据此提示并降级到 x2。
        if (e instanceof HttpException && this.isRateLimitError(e)) {
          throw e
        }
        if (MODE === 'hybrid') {
          console.warn('[image] 智能高清 SR 失败，回退图生图兜底', e)
        } else {
          throw e
        }
      }
    }

    const data = await this.imageService.process(userId, dto, headers)
    return { code: 200, msg: 'success', data }
  }

  /**
   * 错题区域提取：POST /api/image/wrongq
   *
   * 路径 B：VLM 出题块粗框 + 本地红笔证据校验/收紧。
   * ⚠️ VLM 凭证缺失时自动降级本地证据层（debug.vlmError 写明原因），不阻塞。
   */
  @Post('wrongq')
  @HttpCode(200)
  async wrongq(@Body() dto: ProcessImageDto, @Req() req: RequestWithUser) {
    const userId = requireUserId(req)
    const headers = (req.headers || {}) as Record<string, string>
    const data = await this.imageService.wrongq(userId, dto, headers)
    return { code: 200, msg: 'success', data }
  }

  /**
   * 错题提取（切块→逐块识别→题号关联）：POST /api/image/extract-wrong
   *
   * 与 recognize-pair 的本质区别：先本地切块（wrongq 红线，allowVlm=false），
   * 再对每块单独跑本地 OCR 侧车，落库的是"切出的题块图 + 该区域 OCR 文本"，而非整图。
   * 全程本地优先、零 VLM 依赖（契合"切块引擎尽量不依赖大模型"的约束）。
   */
  @Post('extract-wrong')
  @HttpCode(200)
  async extractWrong(@Body() dto: ExtractWrongDto, @Req() req: RequestWithUser) {
    const userId = requireUserId(req)
    const headers = (req.headers || {}) as Record<string, string>
    const data = await this.imageService.extractWrong(userId, dto, headers)
    return { code: 200, msg: 'success', data }
  }

  /**
   * 错题圈定·用户改框重切重识：POST /api/image/extract-wrong-recrop
   *
   * P2（设计文档 §4.7）：结果页上用户拖动/缩放/删除/新画框后，按用户框重走
   * 「裁图 → 块 OCR → 语义分离」链路（与 extract-wrong 同一 helper），
   * 保存以用户框为准；系统框存在时回传 IoU/差集作为判定准确率数据源。
   */
  @Post('extract-wrong-recrop')
  @HttpCode(200)
  async extractWrongRecrop(@Body() dto: RecropWrongDto, @Req() req: RequestWithUser) {
    const userId = requireUserId(req)
    const headers = (req.headers || {}) as Record<string, string>
    const data = await this.imageService.recropWrongBlock(userId, dto, headers)
    return { code: 200, msg: 'success', data }
  }

  /**
   * 人工辅助错题整理（#150）：全页 OCR 文本栏。POST /api/image/ocr-page
   *
   * 与 extract-wrong 的区别：不做红笔检测/切块，只「摆正 + 全页 OCR + 阅读序平铺」。
   * 返回摆正后的页面图 URL（前端展示与页内裁剪基准）与 OCR 文本片段
   * （用户在文本栏复制需要的内容，粘进底部粘贴栏——人工判断哪题是错题）。
   */
  @Post('ocr-page')
  @HttpCode(200)
  async ocrPage(@Body() dto: OcrPageDto, @Req() req: RequestWithUser) {
    requireUserId(req)
    const headers = (req.headers || {}) as Record<string, string>
    const data = await this.imageService.ocrPage(dto, headers)
    return { code: 200, msg: 'success', data }
  }

  /** 判断是否为 SR 限流类错误（429 / 503）——用于跳过 hybrid 兜底 */
  private isRateLimitError(e: HttpException): boolean {
    const status = e.getStatus()
    return status === 429 || status === 503
  }
}
