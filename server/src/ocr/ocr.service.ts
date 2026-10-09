import { Injectable, BadRequestException } from '@nestjs/common'
import { LLMClient, FetchClient, Config, type ContentPart } from 'coze-coding-dev-sdk'
import * as http from 'http'
import * as https from 'https'
import { StorageService } from '../storage/storage.service'
import type { RecognizedItem, LocalOcrResult } from './ocr.types'
import { LocalOcrClient } from './ocr-engine.client'
import { inferHierarchy as inferHierarchyRules, linkHierarchy } from './ocr-hierarchy'
import { structureLocalItems } from './ocr-struct'
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Footer, PageNumber,
} from 'docx'

const MODEL = 'doubao-seed-2-0-pro-260215'

const EXAM_TASK =
  '现在给你一张或多张作业/试卷图片，其中包含若干道题目，部分题目上有老师批改痕迹（如红叉、红勾、订正）。'
const DOC_TASK =
  '现在给你一份作业/试卷文档的文字内容，其中包含若干道题目，可能包含学生作答与正确答案。'
const PAIR_TASK =
  '用户将【题目图片】和【答案图片】分开上传。题目图片中是一份试卷/作业的多道题目（可能含大题与小题），答案图片中是这些题目的标准答案与解析。请按题号将答案图片中的答案与解析，与题目图片中对应题号的题目关联匹配，输出多道题。JSON 结构为 {"items":[{...},...]}，items 为与题目图片题号一一对应的题目数组（可能包含多道，切勿只输出一道）。'

@Injectable()
export class OcrService {
  // VLM 客户端懒加载：本地 OCR 是主路径，不应因缺少 VLM 凭证而在构造期崩溃。
  // 仅当真正需要 VLM（语义切分 / 兜底看图）时才实例化。
  private vlmClient?: LLMClient
  private readonly localOcr: LocalOcrClient

  constructor(private readonly storageService: StorageService) {
    // 本地 OCR 侧车：失败静默返回 null（见 LocalOcrClient），由下方 VLM 降级接管
    this.localOcr = new LocalOcrClient()
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

  // ---------------- 本地 OCR（主识别） ----------------
  /** 调本地侧车识别一组图片，合并为多图结果；任意失败返回 null（交给 VLM 兜底）。 */
  private async recognizeLocalByUrls(urls: string[]): Promise<LocalOcrResult | null> {
    if ((process.env.OCR_FALLBACK_TO_VLM ?? 'true') === 'false') return null
    try {
      const results = await Promise.all(urls.map((u) => this.localOcr.recognizeByUrl(u)))
      const ok = results.filter(Boolean) as LocalOcrResult[]
      if (!ok.length) return null
      return {
        raw_text: ok.map((r) => r.raw_text).join('\n\n'),
        layout: ok.flatMap((r) => r.layout),
        text_regions: ok.flatMap((r) => r.text_regions),
        tables: ok.flatMap((r) => r.tables as unknown[]),
        formulas: ok.flatMap((r) => r.formulas as unknown[]),
        confidence: ok.reduce((s, r) => s + r.confidence, 0) / ok.length,
        engine_used: ok.flatMap((r) => r.engine_used),
        low_confidence: ok.some((r) => r.low_confidence),
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
  async exportDocx(items: RecognizedItem[], title: string): Promise<Buffer> {
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

    const pushLines = (label: string, text: string, color?: string) => {
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

    items.forEach((it, idx) => {
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
    })

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
}
