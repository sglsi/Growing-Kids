import { Injectable, BadRequestException, HttpException, HttpStatus } from '@nestjs/common'
import {
  ImageGenerationClient,
  Config,
  HeaderUtils,
} from 'coze-coding-dev-sdk'
import * as http from 'http'
import * as https from 'https'
import sharp from 'sharp'
import { StorageService } from '../storage/storage.service'
import { IngestService } from '../storage/ingest.service'
import { TimelineService } from '../timeline/timeline.service'
import type { ImageAction, ProcessImageDto, ImageProcessResult, ExtractWrongDto, ExtractWrongResult, WrongqBlockSource } from './image.types'
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
import { buildEraseMask } from './erase-mask-policy'
import {
  inpaint,
  blendWithMask,
  unmodifiedRegionSimilarity,
  type InpaintStrategy,
} from './handwriting-mask'
import { straightenImage, type Corner } from './image-dewarp'
import { enhanceImage, enhanceImageModes } from './image-superres'
import { detectMonoSource, type EnhancePreset, type MonoSourceResult } from './image-doc-enhance'
import { compareRecognized, OCR_CONSISTENCY_THRESHOLD, type OcrConsistency } from './image-quality'
import { classifySr, srGate, srUserQuota, srGateEnabled } from './sr-gate'
import { OcrService } from '../ocr/ocr.service'
import { extractWrongQuestions } from './wrongq'
import { buildLayoutContext } from './wrongq-layout'
import { renderBlockAssets } from './wrongq-render'
import { splitBlocksByNumber, type RowSplitContext } from './wrongq-pureblock'
import { estimateSharpness, sharpnessHint } from './image-sharpness'
import type { WrongqBlock } from './wrongq.types'
import { structureLocalItems } from '../ocr/ocr-struct'
import { parseQuestionNumber, inferHierarchy, linkHierarchy } from '../ocr/ocr-hierarchy'
import { attachKeywordTags, dedupItems } from '../ocr/ocr-dedup'
import { attachErrorAnalysis } from '../ocr/ocr-error'
import { buildColorEvidenceSource, splitBlockRegions } from '../ocr/ocr-semantic'
import { guardExtractQuota, MAX_EXTRACT_BLOCKS } from './extract-wrong-quota'
import { mapWithConcurrency } from './concurrency'
import { localVlmPolicy } from '../ocr/local-vlm.client'
import type { RecognizedItem } from '../ocr/ocr.types'
import { QuotaService } from '../quota/quota.service'

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
/**
 * ⭐ v20.9 框选补擦的用户提示。
 *
 * 背景：框选补擦的机制已从「整块矩形并入mask」改为「框内笔迹像素并入mask」
 *   （见 handwriting-segmenter.ts mergeManualRects）。
 *   副作用：若用户框到了**整幅偏暗的照片**，框内像素会 100% 被判为笔迹 →
 *   该区域被整体重绘 → 图片内容被摧毁。
 *   这类区域与「大面积手写涂抹」在像素层面确实无法区分（实测所有统计判据
 *   AUC 均不成立，见 probe-graphic-guard4.ts），所以**不在后端静默拒擦**，
 *   而是如实上报比例，由前端弹窗告知用户「可能框到了照片」。
 *
 * 与 notice 的既有约定一致（image.types.ts §「凡是没改动的返回都必须带 notice」）：
 *   即使有改动，只要结果可能不符合用户预期，也必须说清楚。
 */
function manualNotice(
  segDebug?: Record<string, unknown>,
  maskDebug?: Record<string, unknown>,
): Record<string, unknown> {
  const src = (maskDebug ?? segDebug ?? {}) as Record<string, unknown>
  const merged = Number(src.manualRects ?? 0)
  if (!merged) return {}
  const ratio = Number(src.manualStrokeRatio ?? 0)
  const detail = typeof src.manualRejectDetail === 'string' ? src.manualRejectDetail : ''
  const out: Record<string, unknown> = {
    manualRects: merged,
    manualStrokeRatio: ratio,
  }
  if (detail) out.manualRectDetail = detail
  // ① 笔迹占比接近 1 = 框内几乎每个像素都要被重绘。
  //    实测：文字区 3%~70%（框越大越低），**整幅偏暗的照片必然接近 1**。
  if (ratio >= 0.95) {
    out.notice = {
      level: 'warn',
      title: '这个框几乎整块都会被擦除',
      message:
        '框内 95% 以上的像素都被判为笔迹。\n' +
        '如果框的是**照片或深色插图**，该区域内容会被整体重绘而丢失。\n' +
        '建议只框需要清理的手写所在的小范围。',
    }
    return out
  }
  // ② 笔迹占比中等 = 大概率框到了印刷体为主的正文区。
  //    实测（probe-print-damage.ts + G3 目检）：框纯印刷体区块时，
  //    框内暗像素**100% 会被擦除** —— 框里没有手写，印刷字却全没了。
  //    这是框选补擦的**固有代价**（用户指令即命令），只能提示，不能静默。
  if (ratio >= 0.15) {
    out.notice = {
      level: 'info',
      title: '框选区域将被整块清除',
      message:
        `框内约 ${(ratio * 100).toFixed(0)}% 的像素（深色笔画）会被清除。\n` +
        '如果这个框里主要是**印刷文字**而不是手写，\n' +
        '请把框缩小到只覆盖手写的那几行。',
    }
  }
  return out
}

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
function normalizeEnhancePreset(v?: string): EnhancePreset {
  const s = (v || '').toLowerCase()
  if (s === 'original' || s === 'bw' || s === 'brighten' || s === 'gray') return s
  return 'enhance'
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
    private readonly quotaService: QuotaService,
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

      // ② 原图与处理图并行识别：优先本地 OCR 原始文字（稳定可比对），VLM 仅兜底
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`OCR 一致性校验超时(${timeoutMs}ms)`)), timeoutMs)
      })
      const [srcItems, procItems] = await Promise.race([
        Promise.all([
          this.ocrService.recognizeRawItems([srcUrl]),
          this.ocrService.recognizeRawItems([procUrl]),
        ]),
        timeout,
      ])

      // ③ 一致性度量
      const threshold = Number(process.env.IMG_OCR_MIN_SCORE || OCR_CONSISTENCY_THRESHOLD)
      const consistency = compareRecognized(srcItems, procItems, threshold)
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
    //    erase_mode='color'：红/蓝笔批改卷走「仅色域+印刷保护」，避免深色/槽位通道吞印刷（v18.2）
    //    ⭐ v20.2 默认 'hybrid'：色域红笔 + 红笔空间先验黑笔（教师只批改学生写过的地方）。
    //       实测 4 张英语灰报：黑笔去除 0.60~0.64（此前 0.003~0.013），印刷误删 ≤0.001。
    //       无红笔卷自动回退 union（segmenter 内自适应，debug.mode=union(hybrid-fallback)），
    //       因此默认值从 union 升级为 hybrid 是安全的——两种场景都覆盖。
    //       显式传 erase_mode='union' 可强制旧三通道并集。
    // ⭐ v21.5 合成策略：默认 'word'（只擦确信手写，疑罪从无）；'union_generic' 为备选。
    //    旧模式 'color' / 'union' 保持原语义，不经词通道。
    //    base mask 对 word / union_generic 统一取 hybrid（词通道在其之上做门控）。
    // ⭐ v21.7 确认：缺省（含显式 'word'）→ 'word'。最终 mask 由 discriminateWords 逐词疑罪从无裁定，
    //    red-ink-prior 的 hybrid 黑笔路径**不**进入 word 路径（仅 'union'/'union_generic' 模式才并入）。
    //    因此"红笔压印刷"的修复（minDomainRatio / 几何过滤）主要发生在 union 路径；word 路径靠
    //    逐词判别器二次把关，天然不受红对勾误判影响。
    const policy: 'word' | 'union_generic' | null =
      dto.erase_mode === 'union_generic' ? 'union_generic'
        : dto.erase_mode === 'union' || dto.erase_mode === 'color' ? null
          : 'word'   // 缺省（含显式 'word'）→ 只擦确信手写
    const seg = await buildHandwritingMask(srcBuffer, dto.image_url, forwardHeaders, {
      allowVlm: dto.use_vlm !== false,
      manualRects: dto.manual_regions,
      // ⭐ 基础分割默认**仍为 hybrid**（E3 门禁语义不变）；'word' / 'union_generic'
      //   是在这个基础 mask 之上叠加的「合成策略」，不是另一套分割模式。
      eraseMode: dto.erase_mode === 'color' ? 'color' : dto.erase_mode === 'union' ? 'union' : 'hybrid',
    })
    let mask = seg.mask
    if (policy) {
      try {
        mask = await buildEraseMask(srcBuffer, mask, policy)
      } catch (e) {
        // 词通道失败必须**降级到基础 mask**，绝不让用户拿不到结果
        console.warn(`[image] 去手写V2：合成策略 ${policy} 失败，降级为基础 mask（${String(e)}）`)
        mask = seg.mask
      }
    }

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
        ...manualNotice(seg.debug, mask.debug),
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
  /**
   * 错题区域提取（路径 B：VLM 出题块粗框 + 本地红笔证据校验/收紧）。
   *
   * ⚠️ VLM 状态：本环境 COZE_API_TOKEN 未配置，VLM 调用 fail-open，
   *    全流程由本地证据层独立产出（blocks.source='local'，置信度刻意压低），
   *    debug.vlmError 写明原因，**绝不阻塞、绝不伪装成 VLM 结果**。
   *    配置凭证后传 imageUrl 即自动启用融合（blocks.source 变 'fused'）。
   */
  async wrongq(
    userId: string,
    dto: ProcessImageDto,
    forwardHeaders: Record<string, string>,
  ): Promise<{ blocks: WrongqBlock[]; debug: Record<string, unknown> }> {
    if (!dto.image_url) throw new BadRequestException('image_url 不能为空')
    const fwd = HeaderUtils.extractForwardHeaders(forwardHeaders)
    const srcBuffer = await this.download(dto.image_url, fwd)

    // 版面上下文单独构建一次：产裁图时要复用同一份（避免重复 straighten）
    const ctx = await buildLayoutContext(srcBuffer)
    const result = await extractWrongQuestions(srcBuffer, {
      chromaMin: dto.wrongq_chroma_min ?? 14,
      allowVlm: dto.wrongq_allow_vlm === true,
      imageUrl: dto.image_url, // VLM 仅接受公网 URL
    }, ctx)

    const debug: Record<string, unknown> = {
      ...result.debug,
      medH: result.medH,
      cols: result.cols.map(([a, b]) => b - a),
      vlmUsed: result.vlmUsed,
    }
    if (result.vlmError) debug.vlmError = result.vlmError
    void userId

    // 可选：为每个题块产出 raw / enhanced / clean 三份裁图
    if (dto.wrongq_assets === true) {
      const assets: Array<Record<string, unknown>> = []
      for (const b of result.blocks) {
        try {
          const a = await renderBlockAssets(ctx.flatBuf, b, ctx)
          const rawIng = await this.ingestService.ingest(a.raw, 'image/png')
          const item: Record<string, unknown> = {
            id: b.id,
            verdict: b.verdict,
            raw: await this.storageService.getPublicUrl(rawIng.key),
            notes: a.notes,
          }
          if (a.enhanced) {
            const g = await this.ingestService.ingest(a.enhanced, 'image/png')
            item.enhanced = await this.storageService.getPublicUrl(g.key)
          }
          if (a.clean) {
            const g2 = await this.ingestService.ingest(a.clean, 'image/png')
            item.clean = await this.storageService.getPublicUrl(g2.key)
          }
          assets.push(item)
        } catch (e) {
          assets.push({ id: b.id, error: String((e as Error)?.message ?? e).slice(0, 120) })
        }
      }
      debug.assets = assets
    }

    return { blocks: result.blocks, debug }
  }

  /**
   * 错题提取（切块 → 逐块识别 → 题号关联）：POST /api/image/extract-wrong
   *
   * 落实《错题提取-技术文档.md》方案 v2 的 P0 核心：从"整图关联"纠正为"切块 + 逐块识别"。
   *
   * 流程（全程本地优先，零 VLM 依赖）：
   *  ① 本地切块：wrongq 引擎以红笔为锚点切出单道错题区域（allowVlm=false，绝不调用大模型）；
   *  ② 逐块识别：每块 → 裁 raw 图 → 入库拿 key/URL → 本地 OCR 侧车识别该区域文本；
   *  ③ 题号关联：从题面块区域文本与答案图文本各解析题号，按题号把"题面块"与"答案块"配对；
   *  ④ 返回切块级 items：question_image_keys=切块裁图 key、question_content=该区域 OCR 文本、
   *     answer_image_keys=整张答案图 key（按题号匹配到的答案文本填入 answer_content）。
   *
   * ⚠️ 与 recognize-pair 的本质区别：存的是"切出的题块图 + 区域文本"，而非整图。
   * 切块与逐块识别全程本地优先（wrongq 本地红线 + 本地 OCR 侧车），满足"尽量不依赖大模型"。
   */
  async extractWrong(
    userId: string,
    dto: ExtractWrongDto,
    forwardHeaders: Record<string, string>,
  ): Promise<ExtractWrongResult> {
    if (!dto.image_url) throw new BadRequestException('image_url 不能为空')
    const answerKeys = Array.isArray(dto.answer_image_keys) ? dto.answer_image_keys.filter(Boolean) : []
    const fwd = HeaderUtils.extractForwardHeaders(forwardHeaders)
    const srcBuffer = await this.download(dto.image_url, fwd)

    // P1-8 清晰度门禁：入口只算一次（拉普拉斯方差），低于阈值只是提示、不拦截（见 image-sharpness.ts）
    const quality = await estimateSharpness(srcBuffer)
    const qualityWarn = sharpnessHint(quality)

    // P1-14 自托管 VLM 升级层策略：默认关闭（OCR_LOCAL_VLM_MODE=off），外部依赖恒为 0；
    // 未配置模型时 enabled=false，下面不会发起任何外部请求。
    const vlmPolicy = localVlmPolicy()

    // ① 本地切块（红笔锚定 + 版面 + decideLocal），绝不调用 VLM
    const ctx = await buildLayoutContext(srcBuffer)
    const result = await extractWrongQuestions(srcBuffer, { chromaMin: 14, allowVlm: false }, ctx)

    // P1-12 纯版面兜底：红笔锚定未切出任何错题块（空白卷/打印卷/答案图等无红笔场景），
    // 改以"全页 OCR + 版面 + 题号"切块，解除"必须红笔"的硬前提（技术文档 §2.7 局限④）。
    let blocks = result.blocks
    let blockSource: WrongqBlockSource = blocks.length ? 'red' : 'none'
    if (!blocks.length) {
      try {
        const pageRegions = await this.ocrService.recognizePageRegions(ctx.flatBuf)
        if (pageRegions.length) {
          const splitCtx: RowSplitContext = { w: ctx.w, h: ctx.h, medH: ctx.medH, cols: ctx.cols }
          const split = splitBlocksByNumber(pageRegions, splitCtx)
          if (split.blocks.length) {
            blocks = split.blocks
            blockSource = 'layout'
          }
        }
      } catch (e) {
        console.warn('[extract-wrong] 纯版面兜底失败，按无切块处理：', (e as Error)?.message ?? e)
      }
    }

    // ③ 题号关联准备：先对答案图做本地 OCR + 结构化，建「题号 → 答案文本」映射
    const answerMap = new Map<number, string>()
    if (answerKeys.length) {
      try {
        const aUrls = await Promise.all(answerKeys.map((k) => this.storageService.getPublicUrl(k)))
        const parts: string[] = []
        for (const u of aUrls) {
          const t = await this.ocrService.recognizeBlockText(u)
          if (t) parts.push(t)
        }
        if (parts.length) {
          const struct = structureLocalItems(parts.join('\n\n'), {})
          for (const it of struct.items) {
            const p = parseQuestionNumber(it.question_content || '')
            if (p.num != null) answerMap.set(p.num, it.question_content)
          }
        }
      } catch (e) {
        console.warn('[extract-wrong] 答案图识别失败，跳过题号关联：', (e as Error)?.message ?? e)
      }
    }

    // P1-11 答案侧对称化：对答案图也按题号切块，让每道错题块挂「对应的答案块裁图」
    // 而非整张答案图（技术文档 §2.7 局限 ③）。仅在切块成功时生效；任何失败都回退为整张
    // 答案图（P0 行为），不阻断主链路。
    const answerBlockMap = new Map<number, string[]>()
    if (answerKeys.length) {
      try {
        // ⑧ 答案侧切块同样走 ingest，受同一上限守卫（与错题块共用 MAX_EXTRACT_BLOCKS）
        let answerIngested = 0
        answerLoop: for (const ak of answerKeys) {
          const aUrl = await this.storageService.getPublicUrl(ak)
          const aBuf = await this.download(aUrl, fwd)
          const aCtx = await buildLayoutContext(aBuf)
          const aRegions = await this.ocrService.recognizePageRegions(aCtx.flatBuf)
          if (!aRegions.length) continue
          const aSplitCtx: RowSplitContext = { w: aCtx.w, h: aCtx.h, medH: aCtx.medH, cols: aCtx.cols }
          const aBlocks = splitBlocksByNumber(aRegions, aSplitCtx).blocks
          for (const ab of aBlocks) {
            if (answerIngested >= MAX_EXTRACT_BLOCKS) {
              console.warn(`[extract-wrong] 答案侧切块已达上限 ${MAX_EXTRACT_BLOCKS}，停止切块`)
              break answerLoop
            }
            answerIngested++
            const { x0: ax0, y0: ay0, x1: ax1, y1: ay1 } = ab.box
            const aCrop = await sharp(aCtx.flatBuf)
              .extract({ left: ax0, top: ay0, width: Math.max(1, ax1 - ax0 + 1), height: Math.max(1, ay1 - ay0 + 1) })
              .png()
              .toBuffer()
            const aIng = await this.ingestService.ingest(aCrop, 'image/png')
            const aCropUrl = await this.storageService.getPublicUrl(aIng.key)
            const aText = await this.ocrService.recognizeBlockText(aCropUrl)
            const ap = parseQuestionNumber(aText)
            if (ap.num != null) {
              const arr = answerBlockMap.get(ap.num) ?? []
              arr.push(aIng.key)
              answerBlockMap.set(ap.num, arr)
            }
          }
        }
      } catch (e) {
        console.warn('[extract-wrong] 答案侧切块失败，回退整张答案图：', (e as Error)?.message ?? e)
      }
    }

    // ② 逐块识别：只取被标记（非"对"）的区域作为错题；若全为"对"则回退取全部块
    const wrongBlocks = blocks.filter((b) => b.verdict !== 'correct')
    const blocksToUse = wrongBlocks.length ? wrongBlocks : blocks

    // ⑧ 配额预检 + 切块数上限（技术文档 §2.7 ⑧）：
    // 此前逐块 ingest 绕过 upload 层 checkUpload，QUOTA_MODE=block 时不拦截；
    // 此处入库前补预检，仅 block 模式且超限才真正拦截（其余模式只记日志，与上传一致）。
    const quotaDecision = await guardExtractQuota({
      blocksToUse,
      srcBuffer,
      ctx,
      userId,
      quotaService: this.quotaService,
    })

    const items: RecognizedItem[] = []
    const unmatched: string[] = []

    // ⑨ 逐块 OCR 有限并发（技术文档 §2.7 ⑨）：
    // 原串行 for 循环下 N 块 = N 次顺序 IO 往返（ingest→取URL→OCR→分离），主链路被拉慢。
    // 改为块内链路顺序不变（OCR 依赖落库后的公开 URL）、块间限 OCR_CONCURRENCY 路并发，
    // 既提速主链路又不打爆本地 OCR 侧车。worker 内保留原「块失败仅 warn+跳过」容错，
    // 单块异常不连坐其余块；结果按原顺序收集，后续层级合并/查重语义不变。
    const OCR_CONCURRENCY = 4
    const blockResults = await mapWithConcurrency(
      blocksToUse,
      async (b) => {
        try {
          // 只取裁图，不复用 renderBlockAssets：后者会无条件重算 enhanced(2x 超分) 与
          // clean(去手写 mask+inpainting)，而本流程只用 raw —— 用它会让每块白跑两轮重计算，
          // N 个切块就是 N 倍浪费。此处直接按块 box 裁图，语义等价且轻量。
          const { x0, y0, x1, y1 } = b.box
          const cropW = Math.max(1, x1 - x0 + 1)
          const cropH = Math.max(1, y1 - y0 + 1)
          const cropBuf = await sharp(ctx.flatBuf)
            .extract({ left: x0, top: y0, width: cropW, height: cropH })
            .png()
            .toBuffer()
          const ing = await this.ingestService.ingest(cropBuf, 'image/png')
          const cropKey = ing.key
          const cropUrl = await this.storageService.getPublicUrl(cropKey)

          // 一次本地 OCR 同时取回「整块文本 + 带坐标区域」：文本作 full text，区域用于 P1-9 语义分离。
          const local = await this.ocrService.recognizeBlockFull(cropUrl)
          const regionText = local?.raw_text?.trim() ?? ''

          // 区域无文字（OCR 侧车不可用/切块为空）：跳过该块，避免落库 content.question 为空被拒
          if (!regionText) {
            console.warn(`[extract-wrong] 块#${b.id} 区域文本为空，跳过`)
            return null
          }

          // ===== 题号回溯（P1-16）=====
          // 裁图收紧后框内常只剩学生的手写答案，而印刷题号在**题目行**（与订正不同行）
          // → 实测 9 条错题题号全部解析不到，用户拿到条目却认不出是哪道题。
          // 解决办法：额外 OCR 块上方的「题号条带」(b.titleBox) 补出题号与印刷题干，
          // 并把它拼到 question_content 前部——**裁图仍聚焦订正处，读文有题号**，两全。
          let titleText = ''
          if ((b as WrongqBlock).titleBox) {
            const tb = (b as WrongqBlock).titleBox!
            try {
              const tbW = Math.max(1, tb.x1 - tb.x0 + 1)
              const tbH = Math.max(1, tb.y1 - tb.y0 + 1)
              const tbBuf = await sharp(ctx.flatBuf)
                .extract({ left: Math.max(0, tb.x0), top: Math.max(0, tb.y0), width: tbW, height: tbH })
                .png()
                .toBuffer()
              const tbIng = await this.ingestService.ingest(tbBuf, 'image/png')
              const tbUrl = await this.storageService.getPublicUrl(tbIng.key)
              const tbLocal = await this.ocrService.recognizeBlockFull(tbUrl)
              titleText = tbLocal?.raw_text?.trim() ?? ''
            } catch (e) {
              console.warn(`[extract-wrong] 块#${b.id} 题号条带识别失败，忽略：`, (e as Error)?.message ?? e)
            }
          }
          // 题号取舍（实测定序，顺序不能反）：
          //  ① **优先区域文本**：订正就发生在这里，里面的题号最可靠
          //     （反例：back 某块区域自带 "15."，条带却是上一题的 "11."，取条带会错号）；
          //  ② 区域无题号时才用条带，且取**最后一个**——条带是订正**上方**若干行，
          //     越靠下越接近订正（反例：条带 "14.远离 16.高温 18.救援人员"，
          //     正确题号是 18 而非第一个 14）。
          // 扫描式取号（兜底 parseQuestionNumber 只认行首的限制）：
          //  · 取**最后一个**（离订正最近）；
          //  · 过滤 >100：年份/数量会被误当题号（实测 "961年以来" 被取成题号 961 ❌）。
          // 扫描式取号（兜底 parseQuestionNumber 只认行首的限制）：
          //  · 取**最后一个**（离订正最近）；
          //  · 过滤 >100：年份/数量会被误当题号（实测 "961年以来" 被取成题号 961 ❌）。
          //  · allowNoDot：题号行常见「数字+空格+中文」无标点写法（如 "10 设法做成 … 12 共同努力"），
          //    仅对**题号条带**启用——条带是题目行，这种无点号题号更可能是真题号；
          //    区域作答正文不启用，避免 "17. campers" 这类正文句子被误当题号。
          const scanLast = (t: string, allowNoDot = false): number | null => {
            let hits = [...t.matchAll(/(\d{1,3})\s*[.、．](?![0-9])/g)]
              .map((m) => Number(m[1]))
              .filter((v) => v > 0 && v <= 100)
            if (allowNoDot) {
              const noDot = [...t.matchAll(/(?<![\d.])\s*(\d{1,3})\s+[一-龥]/g)]
                .map((m) => Number(m[1]))
                .filter((v) => v > 0 && v <= 100)
              hits = hits.concat(noDot)
            }
            return hits.length ? hits[hits.length - 1] : null
          }
          let num = parseQuestionNumber(regionText).num
          if (num == null || num > 100) num = scanLast(regionText)
          if (num == null && titleText) num = scanLast(titleText, true)
          // 展示文本仍把条带放在前部，让用户一眼看到"第几题"；解析已按上面定序完成
          const mergedText = titleText ? `${titleText}\n${regionText}` : regionText
          const p = { num } as ReturnType<typeof parseQuestionNumber>
          let answerContent = ''
          let ansImgKeys = answerKeys
          if (p.num != null && answerMap.has(p.num)) {
            answerContent = answerMap.get(p.num)!
            // P1-11：命中答案块裁图时，挂对应答案块而非整张答案图
            if (answerBlockMap.has(p.num)) ansImgKeys = answerBlockMap.get(p.num)!
          } else if (answerKeys.length) {
            // 本题面块有答案图但按题号未匹配上 → 计入未匹配反馈
            unmatched.push(p.num != null ? String(p.num) : `#${b.id}`)
          }

          // P1-9 区域语义分离（题干 / 学生错答 / 教师批改）：仅在真的分出东西时覆盖字段，
          // 否则保持 P0 行为（stem=全文），绝不因分离失败而丢信息。
          let stem = regionText
          let wrongAnswer = ''
          let solution = ''
          try {
            const colorSrc = await buildColorEvidenceSource(cropBuf)
            const sem = splitBlockRegions(colorSrc, local?.text_regions ?? [])
            if (sem.separated) {
              stem = sem.stem || regionText
              wrongAnswer = sem.wrongAnswer
              solution = sem.correction
            }
          } catch {
            // 分离失败退回全文，不阻断主链路
          }

          return {
            // 带上题号条带文本：让用户一眼看出这是第几题（区域文本可能只有手写答案）
            question_content: mergedText,
            wrong_answer: wrongAnswer,
            answer_content: answerContent,
            solution,
            source: '',
            // 匹配到答案即视为"已作答/有正确答案"，否则待用户联网搜题
            status: answerContent ? 'answered' : 'pending',
            question_image_keys: [cropKey],
            answer_image_keys: ansImgKeys,
            level: 1,
            parent_index: null,
            stem,
          } as RecognizedItem
        } catch (e) {
          console.warn(`[extract-wrong] 块#${b.id} 处理失败，跳过：`, (e as Error)?.message ?? e)
          return null
        }
      },
      OCR_CONCURRENCY,
    )
    for (const r of blockResults) {
      if (r) items.push(r)
    }

    // P1-10 层级合并：大题含小题时，子题继承大题题干、补 level/parent_index（解决"无本之木"）
    const hier = inferHierarchy(items)
    const mergedItems = hier.items
    linkHierarchy(mergedItems)

    // P1-13 知识点关键词候选（本地轻量抽取，非分类器结论；存到 timeline_items.tags）
    attachKeywordTags(mergedItems)

    // P1-13 题目查重：批内近重复合并（SimHash 汉明距离 ≤3；题面过短不查重，避免误并相似但不同的题）
    const dedup = dedupItems(mergedItems, { threshold: 3, minLen: 8 })
    const finalItems = dedup.items

    // P2-16 错因分析：基于已分离的 stem/wrong_answer/solution 做本地规则引擎分类（SBERT 仅可选升级钩子）
    await attachErrorAnalysis(finalItems)

    return {
      items: finalItems,
      unmatched_questions: unmatched,
      answer_image_keys: answerKeys,
      quality: {
        sharpness: quality.score,
        sharp: quality.sharp,
        hint: qualityWarn,
        sample_size: quality.sampleSize,
      },
      block_source: blockSource,
      deduped: dedup.removed,
      debug: {
        blockSource,
        vlmMode: vlmPolicy.mode,
        vlmEnabled: vlmPolicy.enabled,
        vlmReason: vlmPolicy.reason,
        quotaMode: quotaDecision.mode,
        quotaAllowed: quotaDecision.allowed,
        estIngestBytes: quotaDecision.estIngestBytes,
        blocksTotal: blocks.length,
        itemsBeforeDedup: mergedItems.length,
        redCoverage: result.debug?.redCoverage,
        inferredHierarchy: hier.inferred,
      },
    }
  }

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
    // ⭐ 智能默认档（P1 后续）：调用方**未显式指定** preset 时，用单色源检测自动选：
    //    纯黑白打印件 → 默认「黑白」（方案 §P1 实测：黑白源走彩色模式会带色偏格子 28.2%）；
    //    否则 → 默认「增强并锐化」。用户仍可手动切换，不剥夺选择权。
    const explicitPreset = dto.enhance_preset ?? process.env.IMG_ENHANCE_PRESET
    let mono: MonoSourceResult | undefined
    let autoPreset: EnhancePreset | undefined
    let preset: EnhancePreset
    if (explicitPreset) {
      preset = normalizeEnhancePreset(explicitPreset)
    } else {
      try {
        mono = await detectMonoSource(srcBuffer)
        autoPreset = mono.isMono ? 'bw' : 'enhance'
      } catch (e: unknown) {
        console.warn(`[image] 单色源检测失败，回落默认 enhance：${String((e as Error)?.message ?? e)}`)
      }
      preset = autoPreset ?? 'enhance'
    }
    const strength = normalizeEnhanceStrength(dto.enhance_strength ?? process.env.IMG_ENHANCE_STRENGTH)

    // ESPCN_WEIGHTS_URL 支持 {scale} 占位符，便于一份配置加载分倍率权重
    // （如 ESPCN_WEIGHTS_URL=/weights/espcn_x{scale}.json → 实际请求 espcn_x2.json ...）
    const weightsUrl = process.env.ESPCN_WEIGHTS_URL
      ? process.env.ESPCN_WEIGHTS_URL.replace(/\{scale\}/g, String(scale))
      : undefined

    // —— P1 后续：多模式并列输出（预览自选，方案 §P1）——
    //    一次性产出五种模式的**轻量预览**（内部 scale=1，不做高清扩展），供前端
    //    并列渲染缩略图让用户挑；用户选定后再按该模式请求最终画质（scale=2 + OCR 校验）。
    if (dto.multi_modes === true) {
      const mr = await enhanceImageModes(srcBuffer, { scale: 1, mode, weightsUrl, strength })
      const modes: Record<string, { url: string; key: string; width: number; height: number; sizeBytes: number }> = {}
      for (const [name, buf] of Object.entries(mr.modes)) {
        const g = await this.ingestService.ingest(buf, 'image/png')
        modes[name] = {
          url: await this.storageService.getPublicUrl(g.key),
          key: g.key,
          width: g.width,
          height: g.height,
          sizeBytes: g.sizeBytes,
        }
      }
      const main = modes[preset] ?? modes.enhance
      console.log(
        `[image] 智能高清·多模式预览：五模式已产出，默认档=${preset}` +
          (autoPreset ? `（自动判定：单色源=${mono?.isMono}）` : '（调用方指定）'),
      )
      return {
        url: main.url,
        key: main.key,
        timeline_id: '',
        modes: modes as ImageProcessResult['modes'],
        debug: {
          method: 'super-resolution',
          stage: 'multi-modes-preview',
          mode,
          preset,
          autoPreset,
          mono,
          scale: 1,
          modes: Object.keys(modes),
        },
      }
    }

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
        // ⭐ 智能默认档（P1 后续）：前端可据此提示「已按黑白件自动选了黑白模式」
        autoPreset,
        mono,
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
// reloaded 15:42:46
