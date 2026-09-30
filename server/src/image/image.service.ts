import { Injectable, BadRequestException, HttpException, HttpStatus } from '@nestjs/common'
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
import { straightenImage, type Corner } from './image-dewarp'
import { enhanceImage } from './image-superres'
import { compareRecognized, OCR_CONSISTENCY_THRESHOLD, type OcrConsistency } from './image-quality'
import { classifySr, srGate, srUserQuota, srGateEnabled } from './sr-gate'
import { OcrService } from '../ocr/ocr.service'

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

/**
 * 「去手写」未检出时的**可操作**提示文案。
 *
 * ⭐ 为什么要按失败原因分分支（第八轮）：
 *   笼统一句"没检测到手写"等于没告诉用户任何信息——他不知道下一步该改什么，
 *   只会反复点按钮（这正是"点了没反应"投诉的来源）。手写分割有多种**性质完全不同**
 *   的失败原因，各自对应不同的补救动作，必须分别给出。
 *
 * @param segDebug buildHandwritingMask 返回的 debug（含深色路径的 reason）
 */
function eraseHint(segDebug?: Record<string, unknown>): string {
  const dark = (segDebug?.darkDebug ?? {}) as Record<string, unknown>
  const reason = String(dark.reason ?? '')
  const tail =
    '\n\n可以这样做：\n' +
    '· 把答案写在题目之间的空白处，字写得比印刷字大一些；\n' +
    '· 改用蓝色/红色笔书写后重新拍照；\n' +
    '· 或用「编辑裁剪」把含手写的区域裁掉。'

  // 行级判据找到"高行"但被基线护栏判为印刷 → 几乎可以肯定是大号印刷标题/加粗字。
  // ⚠️ reason 名随判据改名同步更新（第八轮）：判据从「墨迹密度」换成「基线众数」
  //    后，这里若还写 density_guard 就会永远匹配不上，用户又拿不到原因了 ——
  //    判据与提示文案必须一起改，否则反馈闭环会被静默切断。
  if (reason === 'baseline_guard') {
    return (
      '页面上比正文大的文字都被判定为**印刷体**（字符底边严格对齐同一条基线，' +
      '是排版特征），不是手写。\n' +
      '这通常发生在试卷有**大号标题/加粗字**时——自动识别宁可不擦，也不能把题目擦掉。' +
      tail
    )
  }
  // 手写与印刷体处在同一行（压字）→ 行高被印刷行主导，无法分离
  if (reason === 'no_tall_row') {
    return (
      '没有找到明显高于印刷正文的手写行。常见原因：\n' +
      '· 答案直接**压在题目文字上**（擦除会连带毁掉被压住的印刷内容，因此主动放弃）；\n' +
      '· 用黑色中性笔/铅笔写得和印刷字差不多大——同为黑色、同样大小，几何与颜色上都无法区分。' +
      tail
    )
  }
  return (
    '自动识别支持：① 蓝/红等彩色笔迹；② 写在空白处、明显大于印刷字号的手写（铅笔/黑色中性笔）。\n' +
    '若用黑色中性笔或铅笔、且写得和印刷字差不多大，笔迹与印刷体同为黑色，几何与颜色上都无法区分，\n' +
    '自动识别会主动放弃（宁可不擦，也不能把题目一起擦掉）。' +
    tail
  )
}

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

/**
 * 【P1 多模式】归一化输出模式。
 * 非法/未知值一律落回 'enhance' —— 宁可走通用默认，也不要因为一个拼错的枚举值
 * 让整条管线静默退化（这是本项目"点了没反应"类反馈的老教训）。
 */
function normalizeEnhancePreset(v?: string): 'original' | 'enhance' | 'bw' {
  const s = (v || '').toLowerCase()
  return s === 'original' || s === 'bw' ? s : 'enhance'
}

/** 【P1 强度档位】归一化，未知值落回 'medium' */
function normalizeEnhanceStrength(v?: string): 'weak' | 'medium' | 'strong' {
  const s = (v || '').toLowerCase()
  return s === 'weak' || s === 'strong' ? s : 'medium'
}

@Injectable()
export class ImageService {
  constructor(
    private readonly storageService: StorageService,
    private readonly ingestService: IngestService,
    private readonly timelineService: TimelineService,
    private readonly ocrService: OcrService,
  ) {}

  /**
   * 【Phase 3 · 交付 3】处理前后 OCR 一致性校验。
   *
   * 对「原图」与「处理后的图」各跑一次 VLM 识别，用字符集 Jaccard + 题数比 + 字数比
   * 计算一致性分数。分数低于阈值 → 判定处理劣化了可识别内容 → 返回 `accept=false`，
   * 调用方据此**回退原图**（宁可不增强，也不交付识别不出来的图）。
   *
   * 关键约束（方案 §4）：
   *  - **整体 try/catch**：OCR 任一步失败（网络/配额/超时）都**默认接受处理图**
   *    （`verified:false, accept:true`），绝不因校验环节本身的问题阻塞主流程。
   *  - 有超时保护，避免 VLM 抖动把整条 enhance 链路拖死。
   *  - 关闭开关：`IMG_OCR_VERIFY=off` 或 dto.verify_ocr=false（在 enhance 里判断）。
   */
  private async verifyOcrConsistency(
    srcUrl: string,
    processedBuffer: Buffer,
    forwardHeaders: Record<string, string>,
  ): Promise<{ accept: boolean; verified: boolean; consistency?: OcrConsistency; procUrl?: string; reason?: string }> {
    const timeoutMs = Number(process.env.IMG_OCR_TIMEOUT_MS || 45000)
    let timer: NodeJS.Timeout | undefined
    try {
      // ① 处理图先落存储拿公网 URL（VLM 需要可访问 URL，无法直接吃 Buffer）
      const procIng = await this.ingestService.ingest(processedBuffer, 'image/png')
      const procUrl = await this.storageService.getPublicUrl(procIng.key)

      // ② 原图与处理图并行识别（temperature=0.1，降低随机性）
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`OCR 一致性校验超时(${timeoutMs}ms)`)), timeoutMs)
      })
      const [srcRes, procRes] = await Promise.race([
        Promise.all([
          this.ocrService.recognizeExamByUrls('', [srcUrl]),
          this.ocrService.recognizeExamByUrls('', [procUrl]),
        ]),
        timeout,
      ])

      // ③ 一致性度量
      const threshold = Number(process.env.IMG_OCR_MIN_SCORE || OCR_CONSISTENCY_THRESHOLD)
      const consistency = compareRecognized(srcRes.items, procRes.items, threshold)
      console.log(
        `[image] OCR 一致性校验：score=${consistency.score.toFixed(3)} ` +
          `(overlap=${consistency.charOverlap.toFixed(3)} ` +
          `count=${consistency.countRatio.toFixed(3)} length=${consistency.lengthRatio.toFixed(3)}) ` +
          `阈值 ${threshold} → ${consistency.similar ? '接受处理图' : '回退原图'}`,
      )
      return {
        accept: consistency.similar,
        verified: true,
        consistency,
        procUrl,
        reason: consistency.similar ? undefined : `识别一致性偏低(${consistency.score.toFixed(2)} < ${threshold})`,
      }
    } catch (e) {
      // OCR 失败/超时 → 默认接受处理图，不阻塞（方案 §4 硬约束）
      console.warn('[image] OCR 一致性校验失败，默认接受处理图：', (e as Error).message)
      return { accept: true, verified: false, reason: (e as Error).message }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 仅对「同源/同组织」域名透传鉴权头，避免把运行时令牌泄露给任意第三方 CDN。
   * 覆盖 Coze / 火山引擎 / 字节系回传域名；其余一律不带头（也足够，公网图无需鉴权）。
   */
  private static SAFE_FORWARD_HOSTS = ['coze', 'volcengine', 'byteimg', 'bytedance', 'volces']

  private static allowForwardHeaders(url: string): boolean {
    try {
      const host = new URL(url).hostname.toLowerCase()
      return ImageService.SAFE_FORWARD_HOSTS.some((h) => host.includes(h))
    } catch {
      return false
    }
  }

  private download(url: string, forwardHeaders?: Record<string, string>): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https:') ? https : http
      const reqHeaders =
        forwardHeaders && ImageService.allowForwardHeaders(url) ? { ...forwardHeaders } : {}
      const req = mod.get(url, reqHeaders, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this.download(res.headers.location, forwardHeaders).then(resolve, reject)
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
    const fwd = HeaderUtils.extractForwardHeaders(forwardHeaders)
    const srcBuffer = await this.download(dto.image_url, fwd)
    const srcMeta = await readMeta(srcBuffer)

    // ① 分割：拿到手写 mask（VLM 优先，失败降级色域阈值；manual_regions 无条件并入）
    const seg = await buildHandwritingMask(srcBuffer, dto.image_url, forwardHeaders, {
      allowVlm: dto.use_vlm !== false,
      manualRects: dto.manual_regions,
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
        debug: {
          coverage: 0,
          usedVlm: seg.usedVlm,
          segDebug: seg.debug,
          note: '未检测到手写，原图返回',
          // ⭐ 必须带 notice：此前这里静默返回原图，前端当成功处理 → 用户看到「点了没反应」。
          // ⭐ 文案按**具体失败原因**定制（第八轮）：不同原因对应不同的可操作建议，
          //    笼统一句"没检测到"等于没说 —— 用户不知道下一步该改什么。
          notice: {
            level: 'info',
            title: '未检测到可擦除的手写',
            message: eraseHint(seg.debug),
          },
        },
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
   * 【阶段三 / Phase 1】自动调正 = 几何纠偏（透视变换）。
   *
   * 与 `process()`（auto 走图生图重绘）的本质区别：
   *   旧路径：把整图交给生成模型**重画** → 必重排、必丢边缘、必变色。
   *   本方法：① 拿到文档四角 → ② 仅做透视变换把斜拍压平成正面矩形。
   *   像素未被重画，**内容 100% 保真** —— 这是它优于图生图的根本。
   *
   * 四角来源：
   *   - manual_corners（前端拉框，优先）：100% 精准、即时可用；
   *   - auto 自动检测：本期 detectDocumentCorners 返回 null（精准检测需 OpenCV 绑定，后续增强）。
   *   两者皆无 → 返回**原图**（不重画）+ debug.needManual 提示前端拉框（方案 §2.3 降级，绝不静默存坏图）。
   *
   * 灰度开关见 image.controller.ts：仅当 IMG_PIPELINE_MODE ∈ {new, hybrid} 时 auto 才进入本方法，
   * 否则回落到 process() 图生图兜底。
   */
  async straighten(
    userId: string,
    dto: ProcessImageDto,
    forwardHeaders: Record<string, string>,
  ): Promise<ImageProcessResult & { debug?: Record<string, unknown> }> {
    if (!dto.image_url) throw new BadRequestException('image_url 不能为空')

    const fwd = HeaderUtils.extractForwardHeaders(forwardHeaders)
    const srcBuffer = await this.download(dto.image_url, fwd)
    const srcMeta = await readMeta(srcBuffer)

    // 手动四角：前端以**归一化 [0,1]** 坐标提交（相对于原图）。
    // 兼容性：若任一坐标 > 1，则判定调用方已按**像素**提交，不再乘尺寸——
    // 依据「坐标是否超出 [0,1]」自动区分口径，避免破坏既有像素调用方。
    const manualCorners = dto.manual_corners?.map(([x, y]): Corner => [x, y])
    if (manualCorners && manualCorners.some(([x, y]) => x > 1 || y > 1)) {
      // 已是像素坐标，原样使用
    } else if (manualCorners) {
      // 归一化 → 像素
      for (const p of manualCorners) {
        p[0] *= srcMeta.width
        p[1] *= srcMeta.height
      }
    }

    const result = await straightenImage(srcBuffer, {
      manualCorners,
      auto: true,
      curved: dto.dewarp_curved === true,
    })

    // 未命中自动检测且无手动四角 → 原样返回（不重画），提示前端拉框
    if (result.needManual) {
      const ing = await this.ingestService.ingest(srcBuffer, 'image/png')
      const url = await this.storageService.getPublicUrl(ing.key)
      console.log('[image] 自动调正：无四角/自动检测未命中，原样返回，提示手动拉框')
      return {
        url,
        key: ing.key,
        timeline_id:
          dto.save === true
            ? await this.archive(userId, ing.key, ing.sizeBytes, ing.thumbKey, ing.width, ing.height, ing.hash)
            : '',
        debug: {
          method: 'geometric-dewarp',
          needManual: true,
          note: '请前端拉出试卷四角后提交 auto',
          notice: {
            level: 'info',
            title: '未能自动识别到歪斜',
            message:
              '这张图里既没找到可用于纠偏的纸张边缘（通常是纸面占满了整个画面），\n' +
              '也没检测到明显的文字行倾斜 —— 说明它可能本来就是正的。\n\n' +
              '如果确实拍歪了，请改用「四角拉框」手动框出试卷四角，再点「确认四角」。',
          },
        },
      }
    }

    // 几何纠偏成功：内容保真，仅透视压平
    const ing = await this.ingestService.ingest(result.buffer!, 'image/png')
    const key = ing.key
    const url = await this.storageService.getPublicUrl(key)
    console.log(
      `[image] 自动调正(几何纠偏) 完成：${srcMeta.width}x${srcMeta.height} → ` +
        `${result.width}x${result.height}；路径 ${result.method}；排序后四角 ${JSON.stringify(result.orderedCorners)}`,
    )
    return {
      url,
      key,
      timeline_id:
        dto.save === true
          ? await this.archive(userId, key, ing.sizeBytes, ing.thumbKey, ing.width, ing.height, ing.hash)
          : '',
      debug: {
        method: 'geometric-dewarp',
        path: result.method,
        width: result.width,
        height: result.height,
        orderedCorners: result.orderedCorners,
        // skew 路径：实际施加的旋转角，便于排查「转多了/转反了」
        rotateDeg: result.rotateDeg,
        confidence: result.confidence,
        // perspective 路径：行不平行度的前后值，便于排查「该修没修 / 越修越歪」
        parallelBefore: result.parallelBefore,
        parallelAfter: result.parallelAfter,
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
   * 【阶段三 / Phase 2】智能高清 = 轻量超分辨率（进程内 CPU 推理，零外部模型服务）。
   *
   * 与 `process()`（enhance 走图生图重绘）的本质区别：
   *   旧路径：把整图交给生成模型**重画**放大 → 必重排、必变色、必丢手写字迹。
   *   本方法：① 亮度通道走 SR（ESPCN 引擎 / 经典 Lanczos+unsharp）→ ② 色度走 Lanczos
   *     升采样 → ③ 重组回 RGB。像素级处理、内容保真、CPU 可跑。
   *
   * 默认 mode='classical'（零权重、离线可用、对文档文字最稳）；置 SR_MODE=espcn 并经
   * ESPCN_WEIGHTS_URL 提供真·学习权重时切换为 ESPCN 神经网络推理（同接口、同引擎）。
   *
   * 灰度开关见 image.controller.ts：仅当 IMG_PIPELINE_MODE ∈ {new, hybrid} 时 enhance 进入本方法，
   * 否则回落到 process() 图生图兜底。
   */
  async enhance(
    userId: string,
    dto: ProcessImageDto,
    forwardHeaders: Record<string, string>,
  ): Promise<ImageProcessResult & { debug?: Record<string, unknown> }> {
    if (!dto.image_url) throw new BadRequestException('image_url 不能为空')

    const fwd = HeaderUtils.extractForwardHeaders(forwardHeaders)
    const srcBuffer = await this.download(dto.image_url, fwd)
    const srcMeta = await readMeta(srcBuffer)

    const mode: 'classical' | 'espcn' =
      dto.sr_mode === 'espcn' || (process.env.SR_MODE || 'classical').toLowerCase() === 'espcn'
        ? 'espcn'
        : 'classical'
    const scale = dto.sr_scale && [2, 3, 4].includes(dto.sr_scale) ? dto.sr_scale : 2
    // —— P1 多模式 / 强度档位（方案 §P1）——
    const preset = normalizeEnhancePreset(dto.enhance_preset ?? process.env.IMG_ENHANCE_PRESET)
    const strength = normalizeEnhanceStrength(dto.enhance_strength ?? process.env.IMG_ENHANCE_STRENGTH)
    // ESPCN_WEIGHTS_URL 支持 {scale} 占位符，便于一份配置加载分倍率权重
    // （如 ESPCN_WEIGHTS_URL=/weights/espcn_x{scale}.json → 实际请求 espcn_x2.json ...）
    const weightsUrl = process.env.ESPCN_WEIGHTS_URL
      ? process.env.ESPCN_WEIGHTS_URL.replace(/\{scale\}/g, String(scale))
      : undefined

    // —— 服务端限流 / 排队（依据 Phase 2 压测结论）——
    // 重任务 = x3/x4（任意模式）或 espcn（任意倍率）；仅 x2-classical 为轻任务（不占闸）。
    // 两道防线：① 用户级配额（防滥用，429）② 全局并发闸（防 CPU 雪崩，排队/超时 503）。
    const cls = classifySr(scale, mode)
    const gateOn = srGateEnabled()
    const useGate = gateOn && cls.heavy
    let quotaHeld = false
    let acquired = false

    if (useGate) {
      const q = srUserQuota.check(userId)
      if (!q.ok) {
        // 重任务被用户级配额拦截 → 429
        throw new HttpException(
          {
            code: q.code,
            msg: q.msg,
            data: { retry_after_ms: q.retryAfterMs, suggest: { scale: 2, mode: 'classical' } as const },
          },
          HttpStatus.TOO_MANY_REQUESTS,
        )
      }
      quotaHeld = true

      const acq = await srGate.acquire(cls.cost, cls.lane, {
        timeoutMs: Number(process.env.IMG_SR_QUEUE_TIMEOUT_MS || 20000),
      })
      if (!acq.ok) {
        srUserQuota.releaseUser(userId)
        // 排队超时 / 队列满 → 503 + 降级建议（引导改选 x2 轻任务）
        const msg =
          acq.reason === 'queue_full'
            ? '当前高清处理排队已满，请稍后再试，或改选 x2 快速模式'
            : '当前高清处理排队较多（等待超时），请稍后再试，或改选 x2 快速模式'
        throw new HttpException(
          {
            code: 'SR_QUEUE_TIMEOUT',
            msg,
            data: { reason: acq.reason, waited_ms: acq.waitedMs, suggest: { scale: 2, mode: 'classical' } as const },
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        )
      }
      acquired = true
    }

    let result: Awaited<ReturnType<typeof enhanceImage>>
    try {
      result = await enhanceImage(srcBuffer, { scale, mode, weightsUrl, preset, strength })
    } finally {
      // 额度必须归还（异常路径也不能泄漏）
      if (acquired) srGate.release(cls.cost, cls.lane)
      if (quotaHeld) srUserQuota.releaseUser(userId)
    }

    // —— 处理前后 OCR 一致性自动回退（Phase 3 交付 3）——
    // 默认仅 enhance 开启；IMG_OCR_VERIFY=off 或 dto.verify_ocr=false 可关。
    // 「原图」模式一步未动，一致性恒为 1，校验纯属浪费 → 跳过。
    const ocrVerifyEnabled =
      (process.env.IMG_OCR_VERIFY || 'on').toLowerCase() !== 'off' &&
      dto.verify_ocr !== false &&
      preset !== 'original'
    let ocrFallback = false
    let verifyInfo: { verified: boolean; consistency?: OcrConsistency; reason?: string } | undefined
    let outputBuffer = result.buffer
    if (ocrVerifyEnabled) {
      const v = await this.verifyOcrConsistency(dto.image_url, result.buffer, forwardHeaders)
      verifyInfo = { verified: v.verified, consistency: v.consistency, reason: v.reason }
      if (!v.accept) {
        // 回退原图：清晰度未提升，但保证内容可识别（绝不交付劣化图）
        ocrFallback = true
        outputBuffer = srcBuffer
        console.warn(`[image] 智能高清：OCR 一致性不达标，回退原图。原因：${v.reason}`)
      }
    }

    const ing = await this.ingestService.ingest(outputBuffer, 'image/png')
    const url = await this.storageService.getPublicUrl(ing.key)
    console.log(
      `[image] 智能高清(SR) 完成：${srcMeta.width}x${srcMeta.height} → ` +
        `${result.width}x${result.height}；模式 ${result.mode} 倍率 x${scale}` +
        (useGate ? `；闸 lane=${cls.lane} cost=${cls.cost}` : '；轻任务(未过闸)') +
        (ocrVerifyEnabled ? `；OCR一致性${ocrFallback ? '★回退原图' : verifyInfo?.verified ? '通过' : '跳过(校验失败)'}` : ''),
    )
    return {
      url,
      key: ing.key,
      timeline_id:
        dto.save === true
          ? await this.archive(userId, ing.key, ing.sizeBytes, ing.thumbKey, ing.width, ing.height, ing.hash)
          : '',
      debug: {
        method: 'super-resolution',
        mode: result.mode,
        preset,
        strength,
        // 文档增强诊断：字高 / 窗口 / 版面保护块数 / 各环节耗时（方案 §六 可观测性）
        enhance: result.debug,
        scale,
        width: ocrFallback ? srcMeta.width : result.width,
        height: ocrFallback ? srcMeta.height : result.height,
        ocrVerify: ocrVerifyEnabled,
        ocrVerified: verifyInfo?.verified ?? false,
        ocrFallback,
        ocrScore: verifyInfo?.consistency?.score,
        ocrReason: verifyInfo?.reason,
        // ⭐ OCR 一致性不达标已回退原图：必须告知，否则用户只看到「点了没反应」
        notice: ocrFallback
          ? {
              level: 'warn',
              title: '高清处理未通过内容校验，已保留原图',
              message:
                `处理前后的文字识别一致性为 ${(verifyInfo?.consistency?.score ?? 0).toFixed(2)}，` +
                `低于阈值 ${Number(process.env.IMG_OCR_MIN_SCORE || 0.75)}。\n` +
                '为避免交付一张「看着更清楚但识别更差」的图，已回退到原图。\n\n' +
                '可以试试：改用 x2 快速模式重新处理（改动更温和，更容易通过校验）。',
            }
          : undefined,
        // 限流诊断：heavy 任务过闸，light 任务不过闸
        gate: { enabled: gateOn, heavy: cls.heavy, lane: cls.lane, cost: cls.cost },
      },
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
      // 显式要求 URL 回传（SDK 默认也是 url，但显式声明可消除模型端的不确定性）
      responseFormat: 'url',
    })

    const helper = client.getResponseHelper(response)
    // 诊断日志：记录 generate 究竟返回了 url 还是 b64，便于部署侧快速定位「未返回图片」类问题
    const b64Count = (response.data || []).filter((d) => d.b64_json).length
    console.log(
      `[image] ${cfg.desc} generate 返回：success=${helper.success} urlCount=${helper.imageUrls.length} b64Count=${b64Count}` +
        (helper.success ? '' : ` err=${helper.errorMessages.join('；')}`),
    )
    if (!helper.success) {
      throw new BadRequestException(helper.errorMessages.join('；') || `${cfg.desc}处理失败`)
    }

    // 结果可能以 URL 或 base64 返回：优先用 URL，缺失时回退到 base64，
    // 避免「模型返回 b64 → imageUrls 为空 → 三功能全抛『未返回图片』」的系统性失效。
    const resultUrl = helper.imageUrls[0]
    let rawBuffer: Buffer
    if (resultUrl) {
      rawBuffer = await this.download(resultUrl, headers)
    } else {
      const b64 = response.data?.find((d) => d.b64_json)?.b64_json
      if (!b64) throw new BadRequestException('处理服务未返回图片')
      rawBuffer = Buffer.from(b64, 'base64')
      console.log(`[image] ${cfg.desc}：模型以 base64 回传，已本地解码`)
    }
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
