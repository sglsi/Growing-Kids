import { Injectable, BadRequestException } from '@nestjs/common'
import { LLMClient, FetchClient, Config, type ContentPart } from 'coze-coding-dev-sdk'
import * as http from 'http'
import * as https from 'https'
import { StorageService } from '../storage/storage.service'
import type { RecognizedItem } from './ocr.types'

const MODEL = 'doubao-seed-2-0-pro-260215'

@Injectable()
export class OcrService {
  private readonly client: LLMClient

  constructor(private readonly storageService: StorageService) {
    this.client = new LLMClient()
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

  async recognizeDoc(fileUrl: string): Promise<{ items: RecognizedItem[]; rawText: string }> {
    if (!fileUrl) throw new BadRequestException('file_url 不能为空')

    const rawText = await this.extractDocumentText(fileUrl)
    const response = await this.client.invoke(
      [
        { role: 'system', content: this.buildJsonSystem('现在给你一份作业/试卷文档的文字内容，其中包含若干道题目，可能包含学生作答与正确答案。') },
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
    const result = this.extractJson(response.content)
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

  private async keysToParts(imageKeys: string[]): Promise<ContentPart[]> {
    return Promise.all(
      imageKeys.map(async (key) => ({
        type: 'image_url' as const,
        image_url: { url: await this.storageService.getPublicUrl(key), detail: 'high' as const },
      })),
    )
  }

  async recognizeExam(subjectId: string, imageKeys: string[]): Promise<{ items: RecognizedItem[] }> {
    if (!imageKeys?.length) throw new BadRequestException('image_keys 不能为空')

    const imageParts = await this.keysToParts(imageKeys)
    const response = await this.client.invoke(
      [
        { role: 'system', content: this.buildJsonSystem('现在给你一张或多张作业/试卷图片，其中包含若干道题目，部分题目上有老师批改痕迹（如红叉、红勾、订正）。') },
        { role: 'user', content: [...imageParts, { type: 'text', text: '请识别图片中的全部题目、学生错误作答与批改后的正确答案，按题目顺序输出。' }] },
      ],
      { model: MODEL, temperature: 0.1 },
    )

    console.log('[ocr/exam] 模型原始返回:', response.content)
    const result = this.extractJson(response.content)
    result.items.forEach((it) => {
      void subjectId
    })
    return result
  }

  async recognizeExamByUrls(subjectId: string, urls: string[]): Promise<{ items: RecognizedItem[] }> {
    if (!urls?.length) throw new BadRequestException('urls 不能为空')
    void subjectId

    const imageParts: ContentPart[] = urls.map((url) => ({
      type: 'image_url' as const,
      image_url: { url, detail: 'high' as const },
    }))
    const response = await this.client.invoke(
      [
        { role: 'system', content: this.buildJsonSystem('现在给你一张或多张作业/试卷图片，其中包含若干道题目，部分题目上有老师批改痕迹（如红叉、红勾、订正）。') },
        { role: 'user', content: [...imageParts, { type: 'text', text: '请识别图片中的全部题目、学生错误作答与批改后的正确答案，按题目顺序输出。' }] },
      ],
      { model: MODEL, temperature: 0.1 },
    )

    console.log('[ocr/exam-url] 模型原始返回:', response.content)
    return this.extractJson(response.content)
  }

  async recognizePair(
    questionKeys: string[],
    answerKeys: string[],
  ): Promise<RecognizedItem> {
    if (!questionKeys?.length) throw new BadRequestException('question_image_keys 不能为空')

    const qParts = await this.keysToParts(questionKeys)
    const aParts = await this.keysToParts(answerKeys || [])

    const response = await this.client.invoke(
      [
        {
          role: 'system',
          content: this.buildJsonSystem(
            '用户将【题目图片】和【答案图片】分开上传。请把答案图片中的标准答案/解析，与题目图片中的题目自动关联匹配成一道题。只输出单题对象，JSON 结构为 {"items":[{...}]}（items 只含一个元素）。',
          ),
        },
        {
          role: 'user',
          content: [
            ...qParts,
            ...aParts,
            { type: 'text', text: `前面 ${questionKeys.length} 张是题目图片，后面 ${answerKeys.length} 张是对应答案图片，请识别并关联。` },
          ],
        },
      ],
      { model: MODEL, temperature: 0.1 },
    )

    console.log('[ocr/pair] 模型原始返回:', response.content)
    const result = this.extractJson(response.content)
    const item = result.items[0] || {
      question_content: '', wrong_answer: '', answer_content: '',
      solution: '', source: '', status: 'pending', question_image_keys: [],
    }
    item.question_image_keys = questionKeys
    return item
  }
}
