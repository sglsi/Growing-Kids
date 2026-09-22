import { Injectable, BadRequestException } from '@nestjs/common'
import { LLMClient, type ContentPart } from 'coze-coding-dev-sdk'
import { StorageService } from '../storage/storage.service'
import type { RecognizedItem } from './ocr.types'

const MODEL = 'doubao-seed-2-0-pro-260215'

@Injectable()
export class OcrService {
  private readonly client: LLMClient

  constructor(private readonly storageService: StorageService) {
    this.client = new LLMClient()
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
    let cleaned = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim()
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1)
    const parsed = JSON.parse(cleaned)
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
      // 整卷模式下图片 key 不在前端回填单题图片
      void subjectId
    })
    return result
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
