import {
  Injectable,
  BadRequestException,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { LLMClient, FetchClient, Config, type ContentPart } from '../ai/llm-provider'
import * as http from 'http'
import * as https from 'https'
import { execFileSync } from 'child_process'
import sharp from 'sharp'
import { StorageService } from '../storage/storage.service'
import type {
  RecognizedItem,
  ExportDocxItem,
  LocalOcrResult,
  LocalOcrTextRegion,
  LocalOcrLayoutBlock,
  OcrBox,
} from './ocr.types'
import {
  Ppsv3Client,
  getPpsv3Client,
  getPpsv3Supervisor,
  type Ppsv3Block,
  type Ppsv3Result,
  type Ppsv3TextRegion,
} from './ppsv3.client'
import { toolOcr, resolvePython, warmupFastOcr, shutdownFastOcr } from './ocr-tool'
import { EnvRecoveryService } from './env-recovery.service'
import { getDiagnoseProbeBuffer } from './diagnose-probe'
import { inferHierarchy as inferHierarchyRules, linkHierarchy } from './ocr-hierarchy'
import { structureLocalItems } from './ocr-struct'
import {
  Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel, AlignmentType, Footer, PageNumber,
} from 'docx'

const MODEL = 'doubao-seed-2-0-pro-260215'

// ---------- 3.x 引擎适配层（PP-StructureV3 → LocalOcrResult 契约） ----------

/**
 * 文本区域轴对齐框：优先 rec_boxes（PP-OCRv5 检测的 [x0,y0,x1,y1]），
 * 缺失时由 dt_polys 四边形推导（坐标保真模式下与输入图同坐标系）。
 */
function ppsv3RegionBox(t: Ppsv3TextRegion): OcrBox {
  if (t.box && t.box.length >= 4) return [t.box[0], t.box[1], t.box[2], t.box[3]]
  if (t.quad && t.quad.length >= 4) {
    const xs = t.quad.map((p) => p[0])
    const ys = t.quad.map((p) => p[1])
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
  }
  return [0, 0, 0, 0]
}

/**
 * 3.x 全链路结果 → 2.x LocalOcrResult 契约（下游 wrongq / 复习本链路零改动）。
 *  - raw_text：行级拼接（保留换行，degradeToPlainText 按行切题号依赖此结构）；无区域时回落块内容
 *  - text_regions：行级区域（与 2.x 粒度一致，坐标在原图系——侧车以 PPSV3_UNWARP/ORIENT_CLS=0 运行）
 *  - confidence / low_confidence：沿用 2.x 口径（OCR_LOW_CONF_THRESHOLD，默认 0.6）
 *  - layout：PP-StructureV3 版面块（label/bbox/content），比 2.x 更语义化
 */
export function ppsv3ToLocal(r: Ppsv3Result): LocalOcrResult {
  const regions: LocalOcrTextRegion[] = (r.text_regions ?? [])
    .filter((t) => (t.text || '').trim().length > 0)
    .map((t) => ({ text: t.text, box: ppsv3RegionBox(t), score: t.score ?? 0 }))
  const rawFromRegions = regions.map((x) => x.text).join('\n')
  const rawFromBlocks = (r.blocks ?? []).map((b) => b.content).filter(Boolean).join('\n')
  const conf = regions.length ? regions.reduce((s, x) => s + (x.score ?? 0), 0) / regions.length : 0
  const lowConfThreshold = Number(process.env.OCR_LOW_CONF_THRESHOLD ?? 0.6)
  return {
    raw_text: rawFromRegions || rawFromBlocks,
    text_regions: regions,
    layout: (r.blocks ?? []).map((b) => ({ type: b.label ?? 'text', box: b.bbox, text: b.content })),
    tables: [],
    formulas: [],
    confidence: conf,
    engine_used: ['ppsv3'],
    low_confidence: regions.length === 0 || conf < lowConfThreshold,
  }
}

/**
 * 全页 OCR 的产物（供分段消费）。
 *
 * ⭐ blocks 是分段质量的命门：PP-StructureV3 的版面块**自带阅读序与段落合并**，
 *    分段时直接用它；RapidOCR 没有版面概念（blocks 恒空），分段退回行级算法。
 *    （此前页面文本栏一律用行级 regions → 一行一段，故「分段不合理」。）
 */
export interface PageOcrResult {
  regions: LocalOcrTextRegion[]
  layout: LocalOcrLayoutBlock[]
  /** 引擎版面块（阅读序）；无版面能力的引擎为空数组 */
  blocks: Ppsv3Block[]
}

const EXAM_TASK =
  '现在给你一张或多张作业/试卷图片，其中包含若干道题目，部分题目上有老师批改痕迹（如红叉、红勾、订正）。'
const DOC_TASK =
  '现在给你一份作业/试卷文档的文字内容，其中包含若干道题目，可能包含学生作答与正确答案。'
const PAIR_TASK =
  '用户将【题目图片】和【答案图片】分开上传。题目图片中是一份试卷/作业的多道题目（可能含大题与小题），答案图片中是这些题目的标准答案与解析。请按题号将答案图片中的答案与解析，与题目图片中对应题号的题目关联匹配，输出多道题。JSON 结构为 {"items":[{...},...]}，items 为与题目图片题号一一对应的题目数组（可能包含多道，切勿只输出一道）。'

@Injectable()
export class OcrService implements OnApplicationBootstrap, OnApplicationShutdown {
  // VLM 客户端懒加载：本地 OCR 是主路径，不应因缺少 VLM 凭证而在构造期崩溃。
  // 仅当真正需要 VLM（语义切分 / 兜底看图）时才实例化。
  private vlmClient?: LLMClient
  // 生产 OCR 引擎：PaddleOCR 3.7.0 侧车（PP-StructureV3，:9301）——2026-10-15 起替换 2.x 融合侧车。
  // 2.x（LocalOcrClient, :9300）降级为回滚备份，生产代码不再引用。
  private readonly ppsv3: Ppsv3Client
  private readonly sidecar = getPpsv3Supervisor()
  // ④（#143）VL 手写识别配额：进程内计数（VL CPU 推理慢，防主链路被拖垮）
  private vlCalls = 0
  private readonly vlMaxCalls = Number(process.env.OCR_VL_MAX_BLOCKS ?? 8)

  constructor(
    private readonly storageService: StorageService,
    private readonly envRecovery: EnvRecoveryService,
  ) {
    // 3.x 侧车：失败静默返回 null（见 Ppsv3Client），由下方 VLM 降级接管。
    // 注入共享单例 telemetry/alertSink（与 SidecarSupervisor 共用同一份），并启动主动健康探针——
    // 侧车失联触发告警、恢复通知，解决"侧车宕机静默降级、无人知晓"的隐患（见 ocr-health.ts）。
    this.ppsv3 = new Ppsv3Client({
      autoProbe: (process.env.PPSV3_AUTO_PROBE ?? 'true') !== 'false',
    })
    this.ppsv3.startProbe()
  }

  /**
   * 启动自检（沙箱重置自愈，用户要求全流程自动、无需人工命令）：
   * 后台延迟 3s 全量 import 自检 OCR venv，缺失/损坏即自动重装（约 3~6 分钟），
   * 不阻塞服务启动；过程日志可检索 `[ocr-env]`。
   */
  onApplicationBootstrap(): void {
    // 沙箱重置自愈 + 快速识别常驻进程预热（均后台进行，不阻塞服务启动）
    void this.envRecovery.bootstrap()
    void warmupFastOcr()
  }

  /** 服务关闭时释放快速识别常驻进程，避免残留孤儿子进程。 */
  onApplicationShutdown(): void {
    shutdownFastOcr()
  }

  private getVlm(): LLMClient {
    if (!this.vlmClient) this.vlmClient = new LLMClient()
    return this.vlmClient
  }

  /**
   * VLM 使用策略（降低对 VLM 依赖的总开关）。
   *  - OCR_USE_VLM=false   / OCR_VLM_MODE=never  → 彻底禁用 VLM（离线 / 省配额场景）
   *  - OCR_VLM_MODE=always                       → 总是走 VLM（对照 / 灰度用）
   *  - 默认 auto                                  → 本地结构化达标就不用 VLM
   *  - OCR_LOCAL_MIN_AVG_LEN=<n>                  → 本地结构化"单题平均字数"门槛，默认 12
   */
  private vlmPolicy(): { vlmMode: string; allowVlm: boolean; minAvgLen?: number } {
    const vlmMode = (process.env.OCR_VLM_MODE || 'auto').toLowerCase()
    const allowVlm = vlmMode !== 'never' && (process.env.OCR_USE_VLM ?? 'true') !== 'false'
    const raw = process.env.OCR_LOCAL_MIN_AVG_LEN
    const minAvgLen = raw && Number.isFinite(Number(raw)) ? Number(raw) : undefined
    return { vlmMode, allowVlm, minAvgLen }
  }

  // 下载文件原始字节并按 UTF-8 解码（针对纯文本，避免 FetchClient 中文乱码）
  private downloadAsUtf8(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https:') ? https : http
      mod
        .get(url, (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const buf = Buffer.concat(chunks)
            let text = buf.toString('utf-8')
            if (buf.length && text.includes('\uFFFD') && !/^[\u0000-\u007F]+$/.test(text)) {
              const fixed = Buffer.from(buf.toString('latin1'), 'utf-8').toString('utf-8')
              if (!fixed.includes('\uFFFD')) text = fixed
            }
            resolve(text)
          })
        })
        .on('error', reject)
    })
  }

  private async extractDocumentText(fileUrl: string): Promise<string> {
    const path = fileUrl.split('?')[0]
    const isTextLike = /\.(txt|text|md|csv|log)$/i.test(path)
    if (isTextLike) {
      try {
        const raw = await this.downloadAsUtf8(fileUrl)
        if (raw.trim()) return raw.trim()
      } catch (e) {
        // 下载失败，回退到 FetchClient
      }
    }
    const fetchClient = new FetchClient(new Config())
    const resp = await fetchClient.fetch(fileUrl)
    const text = (resp.content || [])
      .filter((item) => item.type === 'text' && item.text)
      .map((item) => item.text)
      .join('\n')
    if (!text.trim()) throw new BadRequestException('未能从文档中提取到文本，请确认文档内容为文字（扫描件PDF请先转成图片识别）')
    return text.trim()
  }

  // ---------------- 本地 OCR（主识别，3.x PP-StructureV3） ----------------
  /** 调 3.x 侧车识别一组图片，合并为多图结果；任意失败返回 null（交给 VLM 兜底）。 */
  private async recognizeLocalByUrls(urls: string[]): Promise<LocalOcrResult | null> {
    if ((process.env.OCR_FALLBACK_TO_VLM ?? 'true') === 'false') return null
    try {
      // 侧车守护：OCR 调用时按需拉起 3.x 侧车，空闲/资源紧张时自动回收（见 sidecar.supervisor）
      // 串行逐张：3.x 推理在侧车内已串行化（_INFER_LOCK），并行发请求只会在服务端排队，
      // 让后发的请求先在客户端超时；串行的超时语义更干净（2.x 并行是因为其侧车无全局锁）。
      const results: LocalOcrResult[] = []
      for (const u of urls) {
        const r = await this.sidecar.withSidecar(() => this.ppsv3.parse({ image_url: u }, false))
        if (r) results.push(ppsv3ToLocal(r))
      }
      if (!results.length) return null
      return {
        raw_text: results.map((r) => r.raw_text).join('\n\n'),
        layout: results.flatMap((r) => r.layout),
        text_regions: results.flatMap((r) => r.text_regions),
        tables: results.flatMap((r) => r.tables as unknown[]),
        formulas: results.flatMap((r) => r.formulas as unknown[]),
        confidence: results.reduce((s, r) => s + r.confidence, 0) / results.length,
        engine_used: results.flatMap((r) => r.engine_used),
        low_confidence: results.some((r) => r.low_confidence),
      }
    } catch {
      return null
    }
  }

  /** VLM 失败且本地 OCR 也不可用时的退化：把本地纯文字按题号粗略分组，前端可编辑。 */
  private degradeToPlainText(local: LocalOcrResult): RecognizedItem[] {
    const lines = local.raw_text.split(/\n+/).map((s) => s.trim()).filter(Boolean)
    if (!lines.length) return []
    const groups: string[] = []
    let cur = ''
    for (const ln of lines) {
      if (/^\d+[.、)）]/.test(ln) && cur) {
        groups.push(cur)
        cur = ''
      }
      cur += (cur ? '\n' : '') + ln
    }
    if (cur) groups.push(cur)
    const arr = groups.length ? groups : lines
    return arr.map((q) => ({
      question_content: q,
      wrong_answer: '',
      answer_content: '',
      solution: '',
      source: '',
      status: 'pending',
      question_image_keys: [],
    }))
  }

  // ---------------- VLM 语义切分 / 兜底（豆包） ----------------
  /** 用本地 OCR 的文字+版面喂 VLM 做语义切分（VLM 不再看图，仅做结构化）。 */
  private async structureWithVlm(local: LocalOcrResult, task: string, userHint: string): Promise<{ items: RecognizedItem[] }> {
    const layoutSummary = local.layout.length
      ? local.layout.map((b) => `[${b.type}] ${b.text || '(无文字)'}`.trim()).join('\n')
      : '(无版面信息)'
    const userText = `${userHint}\n\n以下是通过本地OCR从图片提取的文字（已按阅读顺序排列）：\n${local.raw_text}\n\n版面结构：\n${layoutSummary}`
    const response = await this.getVlm().invoke(
      [
        { role: 'system', content: this.buildJsonSystem(task) },
        { role: 'user', content: [{ type: 'text', text: userText }] },
      ],
      { model: MODEL, temperature: 0.1 },
    )
    console.log('[ocr/local+vlm] 模型原始返回:', response.content)
    return this.extractJson(response.content)
  }

  /** VLM 直接看图（本地 OCR 失败/低置信时的兜底）。 */
  private async vlmDirectImages(urls: string[], task: string): Promise<{ items: RecognizedItem[] }> {
    const imageParts: ContentPart[] = urls.map((url) => ({
      type: 'image_url',
      image_url: { url, detail: 'high' },
    }))
    const response = await this.getVlm().invoke(
      [
        { role: 'system', content: this.buildJsonSystem(task) },
        {
          role: 'user',
          content: [...imageParts, { type: 'text', text: '请识别图片中的全部题目、学生错误作答与批改后的正确答案，按题目顺序输出。' }],
        },
      ],
      { model: MODEL, temperature: 0.1 },
    )
    console.log('[ocr/exam] 模型原始返回:', response.content)
    return this.extractJson(response.content)
  }

  /** 文字文档直接结构化（recognize-doc 文本类路径）。 */
  /**
   * 纯文本文档结构化：本地规则为主，VLM 仅在其质量不达标时兜底。
   * （此前无论文本多规整都要跑一次大模型，纯属浪费 —— 按题号切题是确定性规则题。）
   */
  private async structureTextDoc(rawText: string): Promise<{ items: RecognizedItem[] }> {
    const { vlmMode, allowVlm, minAvgLen } = this.vlmPolicy()
    if (vlmMode !== 'always') {
      const struct = structureLocalItems(rawText, { minAvgLen })
      console.log(
        `[ocr/doc] 本地结构化 ${struct.quality.count} 题，平均 ${struct.quality.avgLen.toFixed(1)} 字，` +
          `层级 ${struct.quality.inferred} 条 → ${struct.quality.ok ? '达标' : '不达标（' + struct.quality.reason + '）'}`,
      )
      if (struct.quality.ok || !allowVlm) return { items: struct.items }
    }
    const response = await this.getVlm().invoke(
      [
        { role: 'system', content: this.buildJsonSystem(DOC_TASK) },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `以下是从文档提取的原始内容，请识别其中的全部题目、学生错误作答与正确答案，按题目出现顺序输出。\n\n${rawText}`,
            },
          ],
        },
      ],
      { model: MODEL, temperature: 0.1 },
    )
    console.log('[ocr/doc] 模型原始返回:', response.content)
    return this.extractJson(response.content)
  }

  // ---------------- 统一图片识别流程：本地结构化（主） → VLM 切分（备） → VLM 看图（备） → 纯文字退化 ----------------
  /**
   * 主路径是**本地结构化**（ocr-struct.ts：按题号切分 + 本地层级推断），零 VLM 调用。
   * 只有当本地结构化质量自评不达标（切碎 / OCR 低置信），或显式要求用 VLM 时，才走 VLM。
   *
   * 详见 vlmPolicy() 的环境变量说明。
   */
  private async recognizeImages(
    urls: string[],
    task: string,
  ): Promise<{ items: RecognizedItem[]; rawText?: string }> {
    const local = await this.recognizeLocalByUrls(urls)
    const { vlmMode, allowVlm, minAvgLen } = this.vlmPolicy()

    // ① 本地结构化（主路径）
    if (local && vlmMode !== 'always') {
      const struct = structureLocalItems(local.raw_text, {
        regions: local.text_regions,
        confidence: local.confidence,
        lowConfidence: local.low_confidence,
        minAvgLen,
      })
      console.log(
        `[ocr] 本地结构化 ${struct.quality.count} 题，平均 ${struct.quality.avgLen.toFixed(1)} 字，` +
          `层级 ${struct.quality.inferred} 条 → ${struct.quality.ok ? '达标' : '不达标（' + struct.quality.reason + '）'}`,
      )
      if (struct.quality.ok) {
        // 本地已达标 → 直接返回，不调 VLM（默认路径：识别一次零大模型调用）
        return { items: struct.items, rawText: local.raw_text }
      }
      if (!allowVlm) {
        console.warn(`[ocr] 本地不达标但 VLM 已禁用，仍返回本地结果（前端可编辑）: ${struct.quality.reason}`)
        return { items: struct.items, rawText: local.raw_text }
      }
      // ② 不达标 → VLM 用本地文字做语义切分（VLM 不看图，更稳更快）
      try {
        const r = await this.structureWithVlm(local, task, '请识别上面的题目、学生错误作答与批改后的正确答案，按题目顺序输出。')
        return { items: r.items, rawText: local.raw_text }
      } catch (e) {
        console.warn('[ocr] VLM 语义切分失败，转 VLM 直接看图:', String(e))
      }
    }

    if (!allowVlm) {
      if (local) return { items: this.degradeToPlainText(local), rawText: local.raw_text }
      throw new BadRequestException('识别服务暂不可用（VLM 已禁用且本地 OCR 无结果），请稍后重试')
    }

    // ③ 本地失败 / 低置信 → VLM 直接看图
    try {
      return await this.vlmDirectImages(urls, task)
    } catch (e) {
      console.warn('[ocr] VLM 直接看图也失败:', String(e))
      if (local) {
        console.warn('[ocr] 退化为本地纯文字（前端可编辑）')
        return { items: this.degradeToPlainText(local), rawText: local.raw_text }
      }
      throw new BadRequestException('识别服务暂不可用，请稍后重试或更换更清晰的图片')
    }
  }

  // ---------------- 对外接口（保持原签名，供 controller 调用） ----------------
  async recognizeDoc(fileUrl: string): Promise<{ items: RecognizedItem[]; rawText: string }> {
    if (!fileUrl) throw new BadRequestException('file_url 不能为空')
    const path = fileUrl.split('?')[0]
    const isTextLike = /\.(txt|text|md|csv|log)$/i.test(path)
    const isImage = /\.(png|jpe?g|webp|bmp)$/i.test(path)

    if (isTextLike) {
      const rawText = await this.extractDocumentText(fileUrl)
      const result = await this.structureTextDoc(rawText)
      return { items: result.items, rawText }
    }
    if (isImage) {
      // 与 recognizeImages 同一策略：本地结构化为主，VLM 仅备用
      const result = await this.recognizeImages([fileUrl], DOC_TASK)
      return { items: result.items, rawText: result.rawText ?? '' }
    }
    // 其他文档（如富文本/扫描件）：FetchClient 取文本再结构化
    const rawText = await this.extractDocumentText(fileUrl)
    const result = await this.structureTextDoc(rawText)
    return { items: result.items, rawText }
  }

  private buildJsonSystem(task: string): string {
    return `你是一名严谨的中小学阅卷与错题整理助手。${task}
要求：
1. 逐题完整识别，保留题号、公式、符号、选项与数字，不得编造图片中没有的内容。
2. 区分"学生的错误作答"(wrong_answer) 与"批改后的正确答案"(answer_content)；若图片无批改痕迹则 wrong_answer 取学生原作答、answer_content 留空。
3. solution 仅填写图片中给出的解析，没有则留空。
4. 答案缺失（没有红笔批改、没有标准答案）时 status 必须为 "pending"，否则为 "answered"。
5. source 填写能识别到的来源，如试卷名/作业名/页码，没有则留空。
6. question_image_keys 一律返回空数组 []。
7. 【大题/小题层级，务必处理】试卷常出现"一道大题含若干小题"的结构，例如：
   "三、阅读理解。阅读下面的文字，完成 1-3 题。…… 1. 下列对…理解正确的一项是（ ）  2. …  3. …"
   此时**不得**把 1./2./3. 各自孤立成一道题而丢掉"三、阅读理解…"这段大题题干，否则小题就成了无本之木。正确做法：
   - 用 level 标注层级：1 = 大题/父题（独立成题），2 = 小题/子题。
   - 子题用 parent_index 指向其所属父题在 items 数组中的下标（从 0 开始）；顶层题 parent_index 为 null。
   - 用 stem 填写该子题**所属大题的完整题干**（子题必须继承它）。
   - 子题的 question_content 必须"自带大题题干"：即先写大题题干，再写本小题的设问，
     使其脱离父题也能独立读懂、可独立作答。
   - 若该小题在原文中已自带上下文（题干本身完整可答），stem 仍须填写，但 question_content 无需重复拼接。
只输出 JSON，不要输出任何解释或 markdown 代码块标记。JSON 结构：
{"items":[{"question_content":"","wrong_answer":"","answer_content":"","solution":"","source":"","status":"answered|pending","question_image_keys":[],"level":1,"parent_index":null,"stem":""}]}`
  }

  private extractJson(text: string): { items: RecognizedItem[] } {
    if (!text || !text.trim()) {
      throw new BadRequestException('识别服务未返回内容，请重试或更换更清晰的图片')
    }
    let cleaned = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim()
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1)
    let parsed: { items?: RecognizedItem[] }
    try {
      parsed = JSON.parse(cleaned)
    } catch {
      throw new BadRequestException('识别结果解析失败，请裁剪图片或重新拍摄后重试')
    }
    const items: RecognizedItem[] = Array.isArray(parsed.items) ? parsed.items : []
    items.forEach((it) => {
      if (!Array.isArray(it.question_image_keys)) it.question_image_keys = []
      it.status = it.answer_content ? 'answered' : 'pending'
    })
    // ① 先做本地层级推断（兜底模型漏填的 parent_index），② 再回填大题题干
    const inferred = this.applyLocalHierarchy(items)
    if (inferred > 0) {
      console.log(`[ocr] 本地层级推断补出父子关系 ${inferred} 条（模型未标注）`)
    }
    linkHierarchy(items)
    return { items }
  }

  /**
   * 本地父子关系推断兜底：模型常常漏填 parent_index，导致"大题含若干小题"时
   * 各小题平铺、大题题干丢失。此处用纯规则（编号约定 + "完成 1-3 题"线索）补齐，
   * 只填未标注的题，已标注的一律尊重。详见 ocr-hierarchy.ts。
   */
  private applyLocalHierarchy(items: RecognizedItem[]): number {
    if (!items.length) return 0
    try {
      const res = inferHierarchyRules(items)
      if (!res.inferred) return 0
      for (let i = 0; i < items.length; i++) {
        items[i].parent_index = res.items[i].parent_index
        items[i].level = res.items[i].level
      }
      return res.inferred
    } catch (e) {
      console.warn(`[ocr] 层级推断失败，回退模型原始标注: ${e instanceof Error ? e.message : e}`)
      return 0
    }
  }

  async recognizeExam(subjectId: string, imageKeys: string[]): Promise<{ items: RecognizedItem[] }> {
    if (!imageKeys?.length) throw new BadRequestException('image_keys 不能为空')
    const urls = await Promise.all(imageKeys.map((k) => this.storageService.getPublicUrl(k)))
    void subjectId
    return this.recognizeImages(urls, EXAM_TASK)
  }

  async recognizeExamByUrls(subjectId: string, urls: string[]): Promise<{ items: RecognizedItem[] }> {
    if (!urls?.length) throw new BadRequestException('urls 不能为空')
    void subjectId
    return this.recognizeImages(urls, EXAM_TASK)
  }

  /**
   * 题目 + 答案分传：把多道题目（题目图）与整份答案/解析（答案图）按题号关联成多道题。
   *
   * 历史硬伤：原实现硬编码「只输出单题」(PAIR_TASK + items[0])，拍一份卷子 + 一张答题卡只会出 1 题。
   * 现改为返回多题数组：
   *  ① 有答案图 + 允许 VLM → VLM 按题号跨图关联（PAIR_TASK 多题版）；
   *  ② ① 失败或 vlmMode=always → VLM 直接看图关联；
   *  ③ 无答案图 / VLM 禁用 / 全失败 → 本地结构化多题（仅题目图文字）。
   * 每题 question_image_keys 统一设为题目图 keys；答案图 keys 由 controller 透传回前端单独存储。
   */
  async recognizePair(questionKeys: string[], answerKeys: string[]): Promise<{ items: RecognizedItem[] }> {
    if (!questionKeys?.length) throw new BadRequestException('question_image_keys 不能为空')

    const qUrls = await Promise.all(questionKeys.map((k) => this.storageService.getPublicUrl(k)))
    const aUrls = answerKeys?.length ? await Promise.all(answerKeys.map((k) => this.storageService.getPublicUrl(k))) : []
    const local = await this.recognizeLocalByUrls([...qUrls, ...aUrls])
    const { vlmMode, allowVlm, minAvgLen } = this.vlmPolicy()

    // 每道题的题面图统一为题目图（答案图单独挂 answer_image_keys，由 controller 透传前端落库）
    const finalize = (items: RecognizedItem[]): RecognizedItem[] => {
      items.forEach((it) => { it.question_image_keys = questionKeys })
      return items
    }
    const hint = `前面 ${questionKeys.length} 张是题目图片（含多道题目），后面 ${aUrls.length} 张是对应答案图片，请按题号把答案关联到对应题目，输出所有题目（不要只输出一道）。`

    // ① 有答案图 + 本地可用 + 允许 VLM（非 always 强制）：用 PAIR_TASK 多题版做跨图题号匹配
    if (aUrls.length && allowVlm && vlmMode !== 'always' && local && !local.low_confidence) {
      try {
        const r = await this.structureWithVlm(local, PAIR_TASK, hint)
        if (r.items.length) return { items: finalize(r.items) }
      } catch {
        // 转 VLM 直接看图
      }
    }

    // ② VLM 直接看图（含 vlmMode='always'，或 ① 失败兜底）：跨图按题号关联成多题
    if (aUrls.length && allowVlm) {
      try {
        const qParts = qUrls.map((u) => ({ type: 'image_url' as const, image_url: { url: u, detail: 'high' as const } }))
        const aParts = aUrls.map((u) => ({ type: 'image_url' as const, image_url: { url: u, detail: 'high' as const } }))
        const response = await this.getVlm().invoke(
          [
            { role: 'system', content: this.buildJsonSystem(PAIR_TASK) },
            {
              role: 'user',
              content: [...qParts, ...aParts, { type: 'text', text: hint }],
            },
          ],
          { model: MODEL, temperature: 0.1 },
        )
        console.log('[ocr/pair] 模型原始返回:', response.content)
        const result = this.extractJson(response.content)
        if (Array.isArray(result.items) && result.items.length) return { items: finalize(result.items) }
      } catch (e) {
        console.warn('[ocr/pair] VLM 失败:', String(e))
      }
    }

    // ③ 无答案图 / VLM 禁用 / 全部失败：本地结构化多题（仅基于题目图文字）
    if (local) {
      const struct = structureLocalItems(local.raw_text, {
        regions: local.text_regions,
        confidence: local.confidence,
        lowConfidence: local.low_confidence,
        minAvgLen,
      })
      if (struct.quality.ok && struct.items.length) return { items: finalize(struct.items) }
      const degraded = this.degradeToPlainText(local)
      if (degraded.length) return { items: finalize(degraded) }
    }

    // 兜底：至少返回一道空题，保证前端有可编辑草稿
    const fallback = this.emptyItem()
    fallback.question_image_keys = questionKeys
    return { items: [fallback] }
  }

  private emptyItem(): RecognizedItem {
    return {
      question_content: '',
      wrong_answer: '',
      answer_content: '',
      solution: '',
      source: '',
      status: 'pending',
      question_image_keys: [],
    }
  }

  /**
   * 把识别结果直接导出为 Word（.docx）。
   * 用户诉求：OCR 识别出的内容直接存储为 word 文档，并在前端提供可直接打开的位置。
   * 层级（大题/小题）在文档中以「第 N 题（小题）」标注，子题题干已含大题题干，独立可读。
   */
  async exportDocx(items: ExportDocxItem[], title: string): Promise<Buffer> {
    const children: Paragraph[] = []

    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
        children: [new TextRun({ text: title || '识别结果', bold: true })],
      }),
    )
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 360 },
        children: [
          new TextRun({
            text: `共 ${items.length} 题 · 生成于 ${new Date().toLocaleString('zh-CN')}`,
            size: 18,
            color: '9A948A',
          }),
        ],
      }),
    )

    const pushLines = (label: string, text: string | undefined, color?: string) => {
      const t = (text || '').trim()
      if (!t) return
      children.push(
        new Paragraph({
          spacing: { after: 60 },
          children: [new TextRun({ text: `${label}：`, bold: true })],
        }),
      )
      t.split('\n').forEach((line) => {
        children.push(
          new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: line, color })] }),
        )
      })
    }

    if (!items.length) {
      pushLines('说明', '本次识别未得到任何题目内容。')
    }

    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx]
      const isSub = it.level === 2
      children.push(
        new Paragraph({
          heading: isSub ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_2,
          spacing: { before: 240, after: 120 },
          children: [new TextRun({ text: `第 ${idx + 1} 题${isSub ? '（小题）' : ''}`, bold: true })],
        }),
      )
      pushLines('题干', it.question_content)
      pushLines('学生作答', it.wrong_answer, 'C0392B')
      pushLines('正确答案', it.answer_content, '1E8449')
      pushLines('解析', it.solution)
      if (it.source) pushLines('来源', it.source)
      // #150 人工辅助整理：用户手动裁剪的错题图片按序嵌入（题干之后）
      for (const url of it.images ?? []) {
        const img = await this.fetchDocxImage(url)
        if (img) {
          // 宽度上限 600px（docx 以 96dpi 计的像素；A4 正文宽约 602px），等比缩放
          const w = Math.min(600, img.width)
          const h = Math.max(1, Math.round((img.height * w) / img.width))
          children.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { before: 80, after: 160 },
              children: [new ImageRun({ data: img.data, type: img.type, transformation: { width: w, height: h } })],
            }),
          )
        } else {
          children.push(
            new Paragraph({
              spacing: { after: 60 },
              children: [new TextRun({ text: '（该图片未能嵌入 Word，请回原流程重试）', color: '9A948A', size: 18 })],
            }),
          )
        }
      }
    }
    const doc = new Document({
      styles: { default: { document: { run: { font: '宋体', size: 22 } } } },
      sections: [
        {
          properties: {},
          footers: {
            default: new Footer({
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [
                    new TextRun({
                      children: ['第 ', PageNumber.CURRENT, ' 页 / 共 ', PageNumber.TOTAL_PAGES, ' 页'],
                      size: 18,
                      color: '9A948A',
                    }),
                  ],
                }),
              ],
            }),
          },
          children,
        },
      ],
    })
    return Packer.toBuffer(doc)
  }

  /**
   * 下载导出用图片并量取尺寸（#150 人工辅助整理：手动裁剪图嵌入 Word）。
   * 失败返回 null（调用方降级为文字说明，不阻断整份文档导出）。
   *
   * ⚠️ docx 的 ImageRun 必须显式传 type（"jpg" | "png" | "gif" | "bmp"）：
   * 漏传时媒体文件扩展名会是 .undefined、[Content_Types].xml 无对应声明，
   * Word 直接打不开这些图（线上目验：图裂）。webp/tiff 等不支持的格式
   * 统一转 PNG 再嵌。
   */
  private async fetchDocxImage(
    url: string,
  ): Promise<{ data: Buffer; width: number; height: number; type: 'jpg' | 'png' | 'gif' | 'bmp' } | null> {
    const u = (url || '').trim()
    if (!/^https?:\/\//i.test(u)) return null
    try {
      let buf = await this.downloadBinary(u, 10_000, 8 * 1024 * 1024)
      if (!buf.length) return null
      let meta = await sharp(buf).metadata()
      const width = meta.width ?? 0
      const height = meta.height ?? 0
      if (!width || !height) return null
      let type: 'jpg' | 'png' | 'gif' | 'bmp' = 'png'
      const fmt = meta.format
      if (fmt === 'jpeg') type = 'jpg'
      else if (fmt === 'gif') type = 'gif'
      else if (fmt === 'png') type = 'png'
      else {
        // bmp/webp/tiff/svg 等：sharp 量不出或 docx 不直接支持 → 统一转 PNG
        buf = await sharp(buf).png().toBuffer()
        meta = await sharp(buf).metadata()
        type = 'png'
      }
      return { data: buf, width: meta.width ?? width, height: meta.height ?? height, type }
    } catch (e) {
      console.warn('[export-docx] 图片下载/解析失败，跳过该图:', u, (e as Error)?.message ?? e)
      return null
    }
  }

  /** 二进制下载（http/https，带超时与大小上限；跟随一次重定向） */
  private downloadBinary(url: string, timeoutMs = 10_000, maxBytes = 8 * 1024 * 1024): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https:') ? https : http
      const req = mod.get(url, (res) => {
        const code = res.statusCode ?? 0
        if ([301, 302, 307, 308].includes(code) && res.headers.location) {
          res.resume()
          this.downloadBinary(res.headers.location, timeoutMs, maxBytes).then(resolve, reject)
          return
        }
        if (code !== 200) {
          res.resume()
          reject(new Error(`HTTP ${code}`))
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > maxBytes) {
            req.destroy(new Error(`图片超过 ${maxBytes} 字节上限`))
            return
          }
          chunks.push(c)
        })
        res.on('end', () => resolve(Buffer.concat(chunks)))
      })
      req.setTimeout(timeoutMs, () => req.destroy(new Error('图片下载超时')))
      req.on('error', reject)
    })
  }

  /**
   * 仅供"处理前后 OCR 一致性校验"使用：直接返回本地 OCR 的**原始文字区域**作为可比对的题面，
   * 不经过 VLM 语义重构（更稳定、可复现）。本地 OCR 不可用时才兜底到 VLM 结构化结果。
   */
  async recognizeRawItems(urls: string[]): Promise<RecognizedItem[]> {
    const local = await this.recognizeLocalByUrls(urls)
    if (local && local.text_regions.length) {
      return local.text_regions.map((r) => ({
        question_content: r.text,
        wrong_answer: '',
        answer_content: '',
        solution: '',
        source: '',
        status: 'pending',
        question_image_keys: [],
      }))
    }
    const r = await this.recognizeImages(urls, EXAM_TASK)
    return r.items
  }

  /**
   * 逐块 OCR：对一张切块（或单张图）跑本地 OCR 侧车，返回其识别文字。
   *
   * 用途：切块→逐块识别流程中，每个切出的错题区域单独识别，得到"该区域 OCR 文本"
   * （这正是错题提取的原始意图，而非存整图）。全程本地优先（PaddleOCR/RapidOCR 侧车），
   * 零 VLM 依赖。侧车不可用时返回空串（不抛），由调用方决定退化策略。
   */
  async recognizeBlockText(url: string): Promise<string> {
    const local = await this.recognizeLocalByUrls([url])
    return local?.raw_text?.trim() ?? ''
  }

  /**
   * 逐块 OCR（**带坐标**）：返回本地 OCR 侧车识别出的文本区域（text + box + score）。
   *
   * 与 `recognizeBlockText` 的区别：后者只有文本，本方法保留每个文本片段的位置与置信度，
   * 供 P1-9「题干 / 学生作答 / 教师批改」三分离使用 —— 没有坐标就无法把文本区域
   * 与彩色笔迹掩膜对应起来，也就无从判断"这一行是印刷的还是红笔写的"。
   *
   * 坐标语义：**相对于传入图片的左上角**（[x0,y0,x1,y1]，轴对齐包围盒）。
   * 侧车不可用时返回空数组（不抛），由调用方退化处理。
   */
  async recognizeBlockRegions(url: string): Promise<LocalOcrTextRegion[]> {
    const local = await this.recognizeLocalByUrls([url])
    if (!local || !Array.isArray(local.text_regions)) return []
    return local.text_regions.filter((r) => (r.text || '').trim().length > 0)
  }

  /**
   * 逐块 OCR（**整块文本 + 带坐标区域，一次返回**）。
   *
   * `recognizeBlockText` 只给文本、`recognizeBlockRegions` 只给区域——P1-9「题干/学生作答/
   * 教师批改」三分离需要**同时**拿到整块文本（作 full text）与各区域的 box（与彩色笔迹掩膜
   * 对应）。若分两次调用会让同一切块被 OCR 两遍。本方法一次调用 `recognizeLocalByUrls`
   * 同时取回 `raw_text` 与 `text_regions`，侧车不可用时返回 null（不抛）。
   */
  async recognizeBlockFull(url: string): Promise<LocalOcrResult | null> {
    const local = await this.recognizeLocalByUrls([url])
    if (!local) return null
    return local
  }

  /**
   * ④（#143）手写答案识别（PaddleOCR-VL 增强）：错题块裁图 → 文本。
   *
   * 为什么单开一路（而不是并进 recognizeBlockFull）：PP-OCRv5 是印刷文本优化模型，
   * 学生手写答案（used to do sth. 类）识别质量差；PaddleOCR-VL-0.9B 是文档解析 VLM，
   * 对「题干印刷 + 手写答案 + 红笔订正」混合内容更强。但 VL 内存峰值 >8GB（CPU），
   * 必须门控使用：
   *   - `OCR_VL_HANDWRITE=1` 才启用（默认关，现网零影响）；
   *   - 每请求进程内最多 `OCR_VL_MAX_BLOCKS` 块（默认 8）——VL CPU 推理慢（几十秒/块），
   *     不设上限会把错题提取主链路拖垮；
   *   - 侧车加载失败/超时/返回空 → 静默返回 null，调用方回落 v5 链路（零回归）。
   *
   * 输入是块裁图 buffer（非 URL）：VL 端点直接吃 base64，省一次 ingest+取 URL。
   */
  async recognizeHandwrite(buf: Buffer): Promise<string | null> {
    if ((process.env.OCR_VL_HANDWRITE ?? '0') !== '1') return null
    if (this.vlCalls >= this.vlMaxCalls) return null
    this.vlCalls += 1
    try {
      // vlParse 自带 AbortSignal 超时（PPSV3_TIMEOUT_MS，默认 180s）；侧车守护
      // withSidecar 保证长驻实例在线。失败/超时/空文本 → null，调用方回落 v5。
      const r = await getPpsv3Supervisor().withSidecar(async () => {
        const client = getPpsv3Client()
        return client.vlParse({ image_base64: buf.toString('base64') })
      })
      if (!r?.text) return null
      return r.text
    } catch (e) {
      console.warn('[ocr-vl] 手写识别失败，回落 v5：', (e as Error)?.message ?? e)
      return null
    }
  }

  /**
   * 全页 OCR（**原图尺度**，带坐标 + 版面块）。
   *
   * 用途：P1-12 纯版面切块兜底 + ②（#141）错题提取结构增强。
   *  - `regions`：阶段 A/B 的题号行输入（红笔锚点 → 题号定界整题满框）；
   *  - `layout`：3.x 版面模型的标题类块（paragraph_title/doc_title/header），
   *    供 analyzeQuestionUnits 保守融合补出文本规则识别不了的节标题。
   *
   * 坐标语义：直接对原图 buffer 跑 3.x 侧车（PP-StructureV3，PPSV3_UNWARP/ORIENT_CLS=0
   * 坐标保真模式），返回的 box 即原图像素坐标，与 `extractWrong` 按 `ctx.flatBuf` 裁图的
   * 坐标系一致；**不经过入库的 1600 长边 resize**，因此不存在坐标错配。
   *
   * 调用方式：**工具式隔离**（每次独立子进程跑 main3.py --once，崩/卡只影响当次，
   * 硬超时可 SIGKILL 中断）——与 2.x 时代的 recognizeByBase64 架构一致；任意用户图是
   * 崩溃风险面，不能让一段卡死的推理污染长驻侧车实例。
   *
   * 大图先等比缩到长边 ≤2000 再识别（CPU 推理，过大会超时），坐标按比例回算到原图。
   * 侧车不可用时返回空数组/空版面（不抛），由调用方退化处理。
   */
  async recognizePage(
    buf: Buffer,
  ): Promise<{ regions: LocalOcrTextRegion[]; layout: LocalOcrLayoutBlock[] }> {
    try {
      const meta = await sharp(buf).metadata()
      const ow = meta.width ?? 0
      const oh = meta.height ?? 0
      const maxEdge = 2000
      let ocrBuf = buf
      let sx = 1
      let sy = 1
      if (ow > maxEdge || oh > maxEdge) {
        const scale = maxEdge / Math.max(ow, oh)
        sx = 1 / scale
        sy = 1 / scale
        ocrBuf = await sharp(buf)
          .resize({ width: Math.round(ow * scale), height: Math.round(oh * scale) })
          .png()
          .toBuffer()
      }
      const r = await this.ppsv3.parseByBase64(ocrBuf.toString('base64'))
      if (!r) return { regions: [], layout: [] }
      const local = ppsv3ToLocal(r)
      const regions = (Array.isArray(local.text_regions) ? local.text_regions : [])
        .filter((t) => (t.text || '').trim().length > 0)
        .map((t) => ({
          ...t,
          box: [
            Math.round(t.box[0] * sx),
            Math.round(t.box[1] * sy),
            Math.round(t.box[2] * sx),
            Math.round(t.box[3] * sy),
          ] as OcrBox,
        }))
      const layout = (local.layout ?? [])
        .filter((b) => b.box && b.box.length >= 4 && (b.text || '').trim().length > 0)
        .map((b) => ({
          ...b,
          box: [
            Math.round(b.box[0] * sx),
            Math.round(b.box[1] * sy),
            Math.round(b.box[2] * sx),
            Math.round(b.box[3] * sy),
          ] as OcrBox,
        }))
      return { regions, layout }
    } catch {
      return { regions: [], layout: [] }
    }
  }

  /** 只要文本区域的便捷包装（P1-12 纯版面兜底等旧调用点）。 */
  async recognizePageRegions(buf: Buffer): Promise<LocalOcrTextRegion[]> {
    const { regions } = await this.recognizePage(buf)
    return regions
  }

  /**
   * OCR 前处理：长边 >2000 等比缩图（CPU 推理，过大会超时），返回缩放后 buffer
   * 与坐标回算比例（regions/layout 的 box 乘回原图系）。
   */
  private async shrinkForOcr(buf: Buffer): Promise<{ ocrBuf: Buffer; sx: number; sy: number }> {
    const meta = await sharp(buf).metadata()
    const ow = meta.width ?? 0
    const oh = meta.height ?? 0
    const maxEdge = 2000
    if (ow <= maxEdge && oh <= maxEdge) return { ocrBuf: buf, sx: 1, sy: 1 }
    const scale = maxEdge / Math.max(ow, oh)
    const ocrBuf = await sharp(buf)
      .resize({ width: Math.round(ow * scale), height: Math.round(oh * scale) })
      .png()
      .toBuffer()
    return { ocrBuf, sx: 1 / scale, sy: 1 / scale }
  }

  /** regions/layout 的 box 按比例回算到输入图坐标系（缩图识别的坐标还原） */
  private scaleRegions(
    local: LocalOcrResult,
    sx: number,
    sy: number,
  ): { regions: LocalOcrTextRegion[]; layout: LocalOcrLayoutBlock[] } {
    const regions = (Array.isArray(local.text_regions) ? local.text_regions : [])
      .filter((t) => (t.text || '').trim().length > 0)
      .map((t) => ({
        ...t,
        box: [
          Math.round(t.box[0] * sx),
          Math.round(t.box[1] * sy),
          Math.round(t.box[2] * sx),
          Math.round(t.box[3] * sy),
        ] as OcrBox,
      }))
    const layout = (local.layout ?? [])
      .filter((b) => b.box && b.box.length >= 4 && (b.text || '').trim().length > 0)
      .map((b) => ({
        ...b,
        box: [
          Math.round(b.box[0] * sx),
          Math.round(b.box[1] * sy),
          Math.round(b.box[2] * sx),
          Math.round(b.box[3] * sy),
        ] as OcrBox,
      }))
    return { regions, layout }
  }

  /**
   * 版面块（PP-StructureV3 parsing_res_list）的 bbox 回算到输入图坐标系。
   * 与 scaleRegions 同口径：缩图识别后必须还原，否则分段坐标与展示图错位。
   */
  private scaleBlocks(blocks: Ppsv3Block[], sx: number, sy: number): Ppsv3Block[] {
    return (blocks || [])
      .map((b) => {
        const bb = Array.isArray(b.bbox) ? b.bbox : []
        if (bb.length < 4) return b
        return {
          ...b,
          bbox: [
            Math.round(bb[0] * sx),
            Math.round(bb[1] * sy),
            Math.round(bb[2] * sx),
            Math.round(bb[3] * sy),
          ] as [number, number, number, number],
        }
      })
  }

  /**
   * 「快速」模式全页 OCR（#150 人工辅助）：2.x 融合侧车 RapidOCR 通道
   * （main.py --once --op recognize --mode rapid，工具式独立子进程）。
   *
   * 与 recognizePageForPanel 同口径（长边缩 2000、坐标回算），但跳过 UVDoc 矫正/
   * 版面分析/PP-StructureV3 全链路：单页 1~3s（精准模式 15~20s）。
   *  - 引擎缺失（脚本/python/rapidocr 未部署）→ 显式抛错，调用方提示改用精准模式；
   *  - 引擎在但本次执行失败（超时/崩溃退出/输出损坏）→ **显式抛错并附 stderr 摘录**——
   *    2026-10 用户实测「未识别到文字」却无任何线索，根因即这些失败被静默吞成空文本栏；
   *  - 正常执行但图中无文字 → 空（不抛），用户重试或换图即可。
   */
  async recognizePageFast(buf: Buffer): Promise<PageOcrResult> {
    // 沙箱重置自愈：venv 缺失时自动重装并等待（上限 45s）；未完成则显式报错而非静默空结果
    if (!(await this.envRecovery.ensureReady())) {
      throw new Error(
        'OCR 运行环境缺失且自动恢复未完成（恢复仍在后台进行，稍后重试；状态见 /api/image/ocr-diagnose 的 envRecovery 段）',
      )
    }
    const { ocrBuf, sx, sy } = await this.shrinkForOcr(buf)
    const r = await toolOcr(ocrBuf, {
      op: 'recognize',
      engine: 'legacy',
      mode: 'rapid',
      timeoutMs: Number(process.env.OCR_TOOL_TIMEOUT_MS ?? 120_000),
    })
    if (!r.ok || !r.data) {
      const detail = r.stderr ? `：${r.stderr}` : ''
      if (r.reason === 'no-script' || r.reason === 'spawn-error') {
        throw new Error(`快速识别引擎不可用（${r.reason}）：RapidOCR 侧车（main.py）未部署？${detail}`)
      }
      throw new Error(
        `快速识别引擎执行失败（${r.reason ?? 'unknown'}，${r.ms}ms）${detail}——请查看后端日志或改用精准识别`,
      )
    }
    // 2.x main.py --once 输出：{ raw_text, text_regions: [{text, box:[x0,y0,x1,y1], score}] }
    // ⚠️ RapidOCR 是纯行级引擎，没有版面/段落概念——blocks 恒空，分段走行级算法
    //    （见 ocr-segment.ts segmentsFromTextRegions）。
    const local = r.data as unknown as LocalOcrResult
    return { ...this.scaleRegions(local, sx, sy), blocks: [] }
  }

  /**
   * 全页 OCR（HTTP 侧车路径）——#150 人工辅助错题整理的「OCR 文本栏」数据源。
   *
   * 与 recognizePage 同口径（超长边缩到 2000、box 还原到输入图坐标系），
   * 但走长驻侧车 HTTP（parse + withSidecar 守护）：recognizePage 用的
   * parseByBase64 是「工具式子进程」路径（每次独立拉起 main3.py），
   * 不经侧车守护的探活/回收，首触达代价高；本方法只服务人工整理的单页轻量
   * OCR，复用 URL 批量路径同一套守护更稳。
   *
   * 可用性语义（2026-10 修复，用户实测"未能识别出文字"却无任何服务不可用提示）：
   *  - 托管模式侧车自动启动失败（venv 缺失/spawn 失败/启动超时）→ **抛错**；
   *  - 侧车不可达（外部模式 :9301 无监听 / healthz 无响应）→ **抛错**；
   *  - parse 返回 null 只可能是失败（侧车 5xx/超时/响应缺 blocks）——**一律抛错并附原因**；
   *    真正的「图中无文字」是 200 + blocks:[]（r 为真、regions 为空），返回空文本栏不抛。
   * 抛出的错误由 image.service.ocrPage 转成模式化 BadRequest，前端明确提示。
   */
  async recognizePageForPanel(buf: Buffer): Promise<PageOcrResult> {
    // 沙箱重置自愈：venv 缺失时自动重装并等待（上限 45s），再拉起侧车
    if (!(await this.envRecovery.ensureReady())) {
      throw new Error(
        'OCR 运行环境缺失且自动恢复未完成（恢复仍在后台进行，稍后重试；状态见 /api/image/ocr-diagnose 的 envRecovery 段）',
      )
    }
    const { ocrBuf, sx, sy } = await this.shrinkForOcr(buf)
    // 托管模式：先确保侧车就绪。auto 判定 venv/python 缺失时 supervisor.disabled=true
    // （外部侧车模式，透传）；PPSV3_SUPERVISE=1 强制托管但 spawn 失败时这里显式失败。
    if (!this.sidecar.disabled && !(await this.sidecar.ensureReady())) {
      throw new Error('OCR 侧车自动启动失败（检查 PPSV3_PYTHON venv 与 main3.py 是否随部署落地）')
    }
    const r = await this.sidecar.withSidecar(() =>
      this.ppsv3.parse({ image_base64: ocrBuf.toString('base64') }, false),
    )
    if (!r) {
      // parse 返回 null 只可能是失败：侧车 5xx / 超时 / 响应缺 blocks 字段。
      // 「图中无文字」的合法形态是 200 + blocks:[]（r 为真、regions 为空）——那条路不抛。
      // 2026-10 用户实测「未识别到文字」无任何线索：旧代码在这里静默返回空文本栏。
      const healthy = await this.ppsv3.health()
      if (!healthy) throw new Error('OCR 侧车不可达（PPSV3_URL /healthz 无响应）')
      const detail = this.ppsv3.getLastParseError()
      throw new Error(
        `OCR 侧车本次解析失败${detail ? `：${detail}` : ''}（侧车健康检查通过，可能是推理崩溃/超时，请查看侧车日志 /tmp/ocr-sidecar-*.log）`,
      )
    }
    // ⭐ 版面块一路带到分段层：PP-StructureV3 的 parsing_res_list 已完成
    //   「版面区域 + 区内行合并成段 + 阅读序排序」，直接用它即是最成熟的分段
    //   （此前只把它塞进 layout、再用行级 regions 出文本栏，故一行一段）。
    const { regions, layout } = this.scaleRegions(ppsv3ToLocal(r), sx, sy)
    return { regions, layout, blocks: this.scaleBlocks(r.blocks ?? [], sx, sy) }
  }

  /**
   * OCR 诊断端点核心：在不影响生产链路的前提下，逐项实测两条识别路径与侧车状态，
   * 返回结构化报告，帮助定位「本页未检测到文本」这类静默空结果的根因。
   *  - 快速路径：用内置已知文字探针图跑 RapidOCR（main.py --mode rapid），验证引擎可调用且能出文字；
   *  - 精准路径：用同一探针图跑 PP-StructureV3 侧车 /ppsv3，验证侧车可达且能出 blocks；
   *  - 侧车状态：disabled 原因 / 健康 / 最近一次 parse 失败原因；
   *  - 环境：python 解析路径与版本、端口配置。
   */
  async diagnose(): Promise<Record<string, unknown>> {
    const probe = getDiagnoseProbeBuffer()
    const pyVersion = (py: string): string | null => {
      try {
        return execFileSync(py, ['--version'], { timeout: 8000 }).toString().trim().split('\n')[0] || null
      } catch (e) {
        return `不可用：${String((e as Error)?.message ?? e).split('\n')[0]}`
      }
    }

    const fastPython = resolvePython('legacy')
    const precisePython = resolvePython('ppsv3')
    const sup = this.sidecar

    // 1) 快速路径实测
    let fastEngine: Record<string, unknown> = { status: 'UNKNOWN' }
    try {
      const fast = await toolOcr(probe, {
        op: 'recognize',
        engine: 'legacy',
        mode: 'rapid',
        timeoutMs: 60_000,
      })
      const regions = ((fast.data as { text_regions?: unknown[] } | null)?.text_regions ?? []) as Array<{ text?: string }>
      fastEngine = {
        status: fast.ok && regions.length > 0 ? 'OK' : fast.ok ? 'EMPTY（引擎可跑但无文字）' : 'FAIL',
        ok: fast.ok,
        reason: fast.reason ?? null,
        ms: fast.ms,
        stderr: fast.stderr ?? null,
        regionCount: regions.length,
        sample: regions.slice(0, 3).map((r) => r.text ?? ''),
      }
    } catch (e) {
      fastEngine = { status: 'ERROR', error: String((e as Error)?.message ?? e) }
    }

    // 2) 精准路径实测（侧车）
    let preciseEngine: Record<string, unknown> = { status: 'UNKNOWN' }
    try {
      const healthy = await this.ppsv3.health()
      preciseEngine = { healthz: healthy }
      if (healthy) {
        const r = await this.ppsv3.parse({ image_base64: probe.toString('base64') }, false)
        if (r && Array.isArray(r.blocks) && r.blocks.length > 0) {
          preciseEngine.status = 'OK'
          preciseEngine.blockCount = r.blocks.length
          preciseEngine.sample = r.blocks.slice(0, 3).map((b) => b.content ?? b.label ?? '')
        } else if (r) {
          preciseEngine.status = 'EMPTY（侧车可达但无文字）'
          preciseEngine.blockCount = 0
        } else {
          preciseEngine.status = 'FAIL'
          preciseEngine.lastParseError = this.ppsv3.getLastParseError()
        }
      } else {
        preciseEngine.status = 'UNREACHABLE'
        preciseEngine.lastParseError = this.ppsv3.getLastParseError() ?? '侧车 /healthz 无响应'
      }
    } catch (e) {
      preciseEngine = {
        status: 'ERROR',
        error: String((e as Error)?.message ?? e),
        lastParseError: this.ppsv3.getLastParseError(),
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      env: {
        fastPython,
        precisePython,
        ppsv3Url: process.env.PPSV3_URL ?? 'http://127.0.0.1:9301',
        ocrEngineUrl: process.env.OCR_ENGINE_URL ?? 'http://127.0.0.1:9300',
        supervise: process.env.PPSV3_SUPERVISE ?? 'auto',
      },
      pythonVersions: {
        fast: pyVersion(fastPython),
        precise: pyVersion(precisePython),
      },
      sidecar: {
        disabled: sup.disabled,
        disabledReason: sup.disabled ? sup.disabledReason() : '(已启用)',
        state: sup.getState(),
      },
      envRecovery: this.envRecovery.snapshot(),
      fastEngine,
      preciseEngine,
    }
  }
}
