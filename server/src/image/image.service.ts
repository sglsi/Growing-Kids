import { Injectable, BadRequestException } from '@nestjs/common'
import {
  ImageGenerationClient,
  Config,
  HeaderUtils,
} from 'coze-coding-dev-sdk'
import * as http from 'http'
import * as https from 'https'
import { StorageService } from '../storage/storage.service'
import { IngestService } from '../storage/ingest.service'
import { TimelineService } from '../timeline/timeline.service'
import type { ImageAction, ProcessImageDto, ImageProcessResult } from './image.types'
import {
  fitSizeToRatio,
  isSizeValid,
  measureTone,
  matchTone,
  readMeta,
  verifyResult,
  conformSize,
  RATIO_TOLERANCE,
} from './image-preprocess'
import { buildHandwritingMask } from './handwriting-segmenter'
import {
  inpaint,
  blendWithMask,
  unmodifiedRegionSimilarity,
  type InpaintStrategy,
} from './handwriting-mask'

/**
 * 提示词：一律加上"锁版式"约束。
 *
 * 关键认知：当前走的是**图生图（整图重绘）**，生成模型天生倾向于"重新排版"。
 * 所以提示词里必须**显式、反复**禁止重排/改尺寸/改色调，把漂移压到最小。
 * 这只治标；根治要靠 mask + 局部修复（阶段二）。
 */
const STYLE_LOCK =
  '严格要求：严格保持原图的版式、字体、字号、行距、页面边距、图片尺寸与长宽比完全不变；' +
  '不得重新排版、不得移动或缩放任何原有内容、不得裁切画面边缘、不得改变图片的尺寸比例；' +
  '严禁新增、删改、编造任何文字内容。'

const TONE_LOCK =
  '同时严格保持原图的纸张底色、墨色深浅与整体色调、对比度一致，不要提亮或调色，保持真实自然的纸张质感。'

// erase_v2 不走提示词（本地 mask + 修复），因此这里只对"图生图"动作要求完整
const PROMPTS: Record<Exclude<ImageAction, 'erase_v2'>, { prompt: string; desc: string }> = {
  auto: {
    prompt:
      '自动校准这张照片：将倾斜/透视变形的文字内容扶正拉平，使文本行保持水平、边缘规整，' +
      '同时完整保留画面中的所有印刷文字与手写内容，不改变文字内容与颜色，保持清晰。' +
      STYLE_LOCK,
    desc: '自动调正',
  },
  enhance: {
    prompt:
      '智能高清增强：提升这张图片的分辨率与清晰度，锐化文字笔画、增强细节，' +
      '使印刷文字与手写内容更清晰易读，不改变内容与排版。' +
      STYLE_LOCK +
      TONE_LOCK,
    desc: '智能高清',
  },
  erase: {
    prompt:
      '去除图片中的手写笔迹：擦除学生的手写答案、笔痕与涂改痕迹，只保留印刷的题目内容与印出的选项/原文；' +
      '被手写遮挡的印刷文字按原样重建补全，输出干净的纯题目图片，不添加任何新内容。' +
      STYLE_LOCK +
      TONE_LOCK,
    desc: '去手写',
  },
}

@Injectable()
export class ImageService {
  constructor(
    private readonly storageService: StorageService,
    private readonly ingestService: IngestService,
    private readonly timelineService: TimelineService,
  ) {}

  private download(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https:') ? https : http
      const req = mod.get(url, (res) => {
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
   * 【阶段二】去手写 V2：mask + 局部修复 + blend
   *
   * 与 `process()`（图生图重绘）的本质区别：
   *
   *   旧路径：把整图交给生成模型**重画一张** → 必然重排、必丢边缘、必变色。
   *   本方法：① 分割出手写 mask → ② 只修复 mask 区域 → ③ **非 mask 像素原样保留**。
   *
   * 第 ③ 步的 blend 公式 `out = inpainted*(1-mask) + original*mask`
   * 是"**绝不重排**"的数学保证 —— 非手写区域的像素根本没被替换过。
   *
   * 验收指标：`unmodifiedRegionSimilarity` 必须接近 1。
   */
  async eraseV2(
    userId: string,
    dto: ProcessImageDto,
    forwardHeaders: Record<string, string>,
  ): Promise<ImageProcessResult & { debug?: Record<string, unknown> }> {
    if (!dto.image_url) throw new BadRequestException('image_url 不能为空')

    // 原图
    const srcBuffer = await this.download(dto.image_url)
    const srcMeta = await readMeta(srcBuffer)

    // ① 分割：拿到手写 mask（VLM 优先，失败降级色域阈值）
    const seg = await buildHandwritingMask(srcBuffer, dto.image_url, forwardHeaders, {
      allowVlm: dto.use_vlm !== false,
    })
    const { mask } = seg

    // 没有手写 → 直接返回原图，不做任何改动（对用户最安全）
    if (mask.coverage <= 0.0001) {
      // 仍走存储优化管线：压缩 + 去重（原图未改动，但没必要原样存 PNG）
      const ing = await this.ingestService.ingest(srcBuffer, 'image/png')
      const key = ing.key
      const url = await this.storageService.getPublicUrl(key)
      console.log('[image] 去手写V2：未检测到手写区域，原样返回')
      return {
        url,
        key,
        timeline_id:
          dto.save === true
            ? await this.archive(userId, key, ing.sizeBytes, ing.thumbKey, ing.width, ing.height, ing.hash)
            : '',
        debug: { coverage: 0, usedVlm: seg.usedVlm, note: '未检测到手写，原图返回' },
      }
    }

    // 覆盖过大时保护：超过 70% 说明分割可能失效，避免把整页涂掉
    if (mask.coverage > 0.7) {
      throw new BadRequestException(
        `检测到的手写区域占比过高（${(mask.coverage * 100).toFixed(0)}%），为避免误擦整页已中止。请重试或改用「编辑裁剪」缩小范围。`,
      )
    }

    // ② 局部修复：只对 mask 区域重建
    //    默认用 'adaptive'（区域分类 + 差异化填充，方案A）：
    //      · 空白答题区 → 纸张底色填充（抹干净大面积手写）
    //      · 压在印刷体/横线上的区域 → 沿邻域结构把被截断的线/笔画延拓接回，
    //        而不是留一个底色缺口。
    //    'masked'/'median'/'blur'/'edge' 保留供特殊场景选择。
    const strategy: InpaintStrategy = dto.strategy || 'adaptive'
    const inpainted = await inpaint(srcBuffer, strategy, mask)

    // ③ Blend：只替换 mask 区域，其余像素取自原图
    const merged = await blendWithMask(srcBuffer, inpainted, mask)

    // 验收：非手写区域一致性（越接近 1 越说明"没重排"）
    const sim = await unmodifiedRegionSimilarity(srcBuffer, merged, mask)

    // 存储优化：结果图（AI 输出常为 2000px+ PNG）统一压缩转 WebP + 去重
    const ing = await this.ingestService.ingest(merged, 'image/png')
    const key = ing.key
    const url = await this.storageService.getPublicUrl(key)

    console.log(
      `[image] 去手写V2 完成：${srcMeta.width}x${srcMeta.height}；` +
        `mask 来源 ${seg.usedVlm ? 'VLM' : '色域阈值'}，覆盖 ${(mask.coverage * 100).toFixed(2)}%，` +
        `区域数 ${seg.rects.length}；修复策略 ${strategy}；` +
        `非手写区域一致性 ${(sim.similarity * 100).toFixed(2)}%（采样 ${sim.sampled} 像素）；` +
        `存储 ${(merged.length / 1024).toFixed(0)}KB → ${(ing.sizeBytes / 1024).toFixed(0)}KB`,
    )

    return {
      url,
      key,
      timeline_id:
        dto.save === true
          ? await this.archive(userId, key, ing.sizeBytes, ing.thumbKey, ing.width, ing.height, ing.hash)
          : '',
      debug: {
        coverage: mask.coverage,
        usedVlm: seg.usedVlm,
        regions: seg.rects.length,
        strategy,
        unmodifiedSimilarity: sim.similarity,
        srcSize: `${srcMeta.width}x${srcMeta.height}`,
      },
    }
  }

  /**
   * 归档进「最近题目」（供 process / eraseV2 复用）。
   *
   * ⚠️ 存储优化：这里的结果图此前是**未压缩的 PNG**，而 AI 输出普遍是
   * 2000px+ 的大图，是存储的最大户。现在统一走 IngestService：
   * 压缩成 WebP + 生成缩略图 + 内容去重，并回写 thumb_key/width/height，
   * 使列表能走缩略图而非原图。
   */
  private async archive(
    userId: string,
    key: string,
    size: number,
    thumbKey?: string,
    width?: number,
    height?: number,
    hash?: string,
  ): Promise<string> {
    try {
      const item = await this.timelineService.create(userId, {
        kind: 'image',
        title: `去手写-${Date.now()}.webp`,
        file_key: key,
        thumb_key: thumbKey,
        mime_type: 'image/webp',
        width,
        height,
        size_bytes: size,
        file_hash: hash ?? '',
        source: 'album',
      })
      return item.id
    } catch (e) {
      console.error('[image] 归档进 timeline 失败（不影响处理）', e)
      return ''
    }
  }

  /**
   * 图生图处理（自动调正 / 智能高清 / 去手写），结果转存并返回可访问 URL。
   *
   * 阶段一增强（保比例 / 锁版式 / 色调一致性 / 结果校验）：
   *  1. 先读原图尺寸 → `fitSizeToRatio` 算出**与原图同比例**的合法尺寸，传给模型
   *     （替掉写死的 '2K'，这是"左右吞字"的直接原因）；
   *  2. 处理前统计原图**色调**，处理用 `matchTone` 把 AI 结果**拉回**原图色调
   *     （对齐"纸张底色 / 墨色 / 对比度"，消除重绘导致的整体偏色）；
   *  3. `verifyResult` 校验结果长宽比偏差，超阈值**直接判失败**（不再静默存坏图）；
   *  4. `conformSize` 把结果等比对齐到原图尺寸，观感一致。
   *
   * 关于落库（最近题目）：
   *  - 默认【不】写入 timeline，仅返回 url/key 供前端预览；
   *  - 仅当 dto.save === true（用户显式点「保存图片」时）才归档进最近题目。
   *
   * userId 由控制器从请求上下文传入（service_role 下必须显式隔离）。
   */
  async process(
    userId: string,
    dto: ProcessImageDto,
    forwardHeaders: Record<string, string>,
  ): Promise<ImageProcessResult> {
    const action: ImageAction = dto.action || 'enhance'
    const cfg = PROMPTS[action]
    if (!cfg) throw new BadRequestException('action 仅支持 auto / enhance / erase')
    if (!dto.image_url) throw new BadRequestException('image_url 不能为空')

    // —— 下载原图，拿到真实尺寸与色调基准 ——
    const srcBuffer = await this.download(dto.image_url)
    const srcMeta = await readMeta(srcBuffer)
    const srcTone = await measureTone(srcBuffer)

    // —— ① 保比例：算出与原图同比例的合法目标尺寸 ——
    const target = fitSizeToRatio(srcMeta.width, srcMeta.height)
    const sizeCheck = isSizeValid(target.width, target.height)
    if (!sizeCheck.ok) {
      throw new BadRequestException(`无法为原图计算合法尺寸：${sizeCheck.reason}`)
    }

    const headers = HeaderUtils.extractForwardHeaders(forwardHeaders)
    const client = new ImageGenerationClient(new Config(), headers)
    const response = await client.generate({
      prompt: cfg.prompt,
      image: dto.image_url,
      // ② 用同比例自定义尺寸替代写死的 '2K'，避免模型为适配档位而裁掉左右内容
      size: target.size,
      watermark: false,
    })

    const helper = client.getResponseHelper(response)
    if (!helper.success) {
      throw new BadRequestException(helper.errorMessages.join('；') || `${cfg.desc}处理失败`)
    }
    const resultUrl = helper.imageUrls[0]
    if (!resultUrl) throw new BadRequestException('处理服务未返回图片')

    const rawBuffer = await this.download(resultUrl)
    const rawMeta = await readMeta(rawBuffer)

    // —— ③ 结果校验：长宽比偏差超阈值直接判失败 ——
    const verify = verifyResult(srcMeta, rawMeta, { tolerance: RATIO_TOLERANCE })
    if (!verify.ok) {
      throw new BadRequestException(
        `${cfg.desc}结果异常：${verify.reason}。原图 ${verify.srcSize} → 结果 ${verify.outSize}。请重试或改用「编辑裁剪」缩小范围后再试。`,
      )
    }

    // —— ④ 色调一致性：把 AI 结果拉回原图色调（对齐纸张底色与墨色）——
    const tone = await matchTone(rawBuffer, srcTone, { strength: 0.85 })

    // —— ⑤ 尺寸对齐到原图，观感与操作前一致 ——
    const aligned = await conformSize(tone.buffer, srcMeta)

    // 存储优化：结果图统一压缩转 WebP + 生成缩略图 + 内容去重
    const ing = await this.ingestService.ingest(aligned, 'image/png')
    const key = ing.key
    const url = await this.storageService.getPublicUrl(key)

    console.log(
      `[image] ${cfg.desc} 完成：原图 ${verify.srcSize} → 模型 ${verify.outSize} → 输出 ${srcMeta.width}x${srcMeta.height}；` +
        `比例偏差 ${(verify.ratioDeviation * 100).toFixed(2)}%；` +
        `色调校正 ${tone.applied ? `已应用（偏差 ${tone.deltaBefore.toFixed(1)} → ${tone.deltaAfter.toFixed(1)}）` : '无需（偏差已很小）'}；` +
        `存储 ${(aligned.length / 1024).toFixed(0)}KB → ${(ing.sizeBytes / 1024).toFixed(0)}KB`,
    )

    // 仅在用户显式保存时才归档进 timeline（最近题目）
    let timelineId = ''
    if (dto.save === true) {
      try {
        const item = await this.timelineService.create(userId, {
          kind: 'image',
          title: `${cfg.desc}-${Date.now()}.webp`,
          file_key: key,
          thumb_key: ing.thumbKey,
          mime_type: 'image/webp',
          width: ing.width,
          height: ing.height,
          size_bytes: ing.sizeBytes,
          file_hash: ing.hash,
          source: 'album',
        })
        timelineId = item.id
      } catch (e) {
        console.error('[image] 归档进 timeline 失败（不影响处理）', e)
      }
    }

    return { url, key, timeline_id: timelineId }
  }
}
