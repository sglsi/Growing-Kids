import { Injectable, BadRequestException } from '@nestjs/common'
import { LLMClient, FetchClient, Config, type ContentPart } from 'coze-coding-dev-sdk'
import * as http from 'http'
import * as https from 'https'
import { StorageService } from '../storage/storage.service'
import type { RecognizedItem, LocalOcrResult } from './ocr.types'
import { LocalOcrClient } from './ocr-engine.client'

const MODEL = 'doubao-seed-2-0-pro-260215'

const EXAM_TASK =
  '现在给你一张或多张作业/试卷图片，其中包含若干道题目，部分题目上有老师批改痕迹（如红叉、红勾、订正）。'
const DOC_TASK =
  '现在给你一份作业/试卷文档的文字内容，其中包含若干道题目，可能包含学生作答与正确答案。'
const PAIR_TASK =
  '用户将【题目图片】和【答案图片】分开上传。请把答案图片中的标准答案/解析，与题目图片中的题目自动关联匹配成一道题。只输出单题对象，JSON 结构为 {"items":[{...}]}（items 只含一个元素）。'

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
  private async structureTextDoc(rawText: string): Promise<{ items: RecognizedItem[] }> {
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

  // ---------------- 统一图片识别流程：本地优先 → VLM 切分 → VLM 看图 → 纯文字退化 ----------------
  private async recognizeImages(urls: string[], task: string): Promise<{ items: RecognizedItem[] }> {
    const local = await this.recognizeLocalByUrls(urls)
    // 本地高置信 → 用本地文字让 VLM 做语义切分（VLM 不看图，更稳更快）
    if (local && !local.low_confidence) {
      try {
        return await this.structureWithVlm(local, task, '请识别上面的题目、学生错误作答与批改后的正确答案，按题目顺序输出。')
      } catch (e) {
        console.warn('[ocr] 本地结构化 VLM 失败，转 VLM 直接看图:', String(e))
      }
    }
    // 本地失败/低置信 → VLM 直接看图
    try {
      return await this.vlmDirectImages(urls, task)
    } catch (e) {
      console.warn('[ocr] VLM 直接看图也失败:', String(e))
      if (local) {
        console.warn('[ocr] 退化为本地纯文字（前端可编辑）')
        return { items: this.degradeToPlainText(local) }
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
      const local = await this.recognizeLocalByUrls([fileUrl])
      if (local && !local.low_confidence) {
        const result = await this.structureWithVlm(local, DOC_TASK, '请识别上面的题目、学生错误作答与批改后的正确答案，按题目顺序输出。')
        return { items: result.items, rawText: local.raw_text }
      }
      const result = await this.vlmDirectImages([fileUrl], DOC_TASK)
      return { items: result.items, rawText: '' }
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
只输出 JSON，不要输出任何解释或 markdown 代码块标记。JSON 结构：
{"items":[{"question_content":"","wrong_answer":"","answer_content":"","solution":"","source":"","status":"answered|pending","question_image_keys":[]}]}`
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
    return { items }
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

  async recognizePair(questionKeys: string[], answerKeys: string[]): Promise<RecognizedItem> {
    if (!questionKeys?.length) throw new BadRequestException('question_image_keys 不能为空')

    const qUrls = await Promise.all(questionKeys.map((k) => this.storageService.getPublicUrl(k)))
    const aUrls = answerKeys?.length ? await Promise.all(answerKeys.map((k) => this.storageService.getPublicUrl(k))) : []
    const local = await this.recognizeLocalByUrls([...qUrls, ...aUrls])

    if (local && !local.low_confidence) {
      try {
        const r = await this.structureWithVlm(
          local,
          PAIR_TASK,
          `前面 ${questionKeys.length} 张是题目图片，后面 ${aUrls.length} 张是对应答案图片，请识别并关联。`,
        )
        const item = r.items[0] || this.emptyItem()
        item.question_image_keys = questionKeys
        return item
      } catch {
        // 转 VLM 直接看图
      }
    }

    try {
      const qParts = qUrls.map((u) => ({ type: 'image_url' as const, image_url: { url: u, detail: 'high' as const } }))
      const aParts = aUrls.map((u) => ({ type: 'image_url' as const, image_url: { url: u, detail: 'high' as const } }))
      const response = await this.getVlm().invoke(
        [
          { role: 'system', content: this.buildJsonSystem(PAIR_TASK) },
          {
            role: 'user',
            content: [
              ...qParts,
              ...aParts,
              { type: 'text', text: `前面 ${questionKeys.length} 张是题目图片，后面 ${aUrls.length} 张是对应答案图片，请识别并关联。` },
            ],
          },
        ],
        { model: MODEL, temperature: 0.1 },
      )
      console.log('[ocr/pair] 模型原始返回:', response.content)
      const result = this.extractJson(response.content)
      const item = result.items[0] || this.emptyItem()
      item.question_image_keys = questionKeys
      return item
    } catch (e) {
      console.warn('[ocr/pair] VLM 失败:', String(e))
      if (local) {
        const item = this.degradeToPlainText(local)[0] || this.emptyItem()
        item.question_image_keys = questionKeys
        return item
      }
      throw new BadRequestException('识别服务暂不可用，请稍后重试')
    }
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
