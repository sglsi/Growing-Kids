/**
 * 错题区域提取 · ⑤ VLM 适配器（模式 2：报纸密排，数题 + 粗框 + 判定一次完成）
 *
 * ⚠️⚠️ 运行状态（实测，勿删）：
 *  本环境 **VLM 凭证未配置**——`new LLMClient()` 会抛
 *  `API key is required. Set COZE_API_TOKEN or provide apiKey in config.`
 *  因此本模块按 **fail-open** 设计：调用失败返回空结果 + error，
 *  **绝不抛错、绝不阻塞主流程**；本地证据层独立产出结果。
 *  真正生效需要运行时配置 COZE_API_TOKEN（与 OcrService 同源）。
 *
 *  解析函数 `parseVlmItems` 是纯函数，可用固定响应做**契约测试**——
 *  那验证的是"解析契约"，不是"VLM 真实能力"，两者不可混淆。
 */
import type { VlmItem } from './wrongq-decide'

const MODEL = 'doubao-seed-2-0-pro-260215'
const TIMEOUT_MS = 45_000

const SYSTEM = `你是报纸版试卷的批改判读助手。输入是报纸整版图像（多栏密排）。
你的任务：找出版面上全部带批改痕迹（红叉/红勾/半勾/红圈/问号/扣分/红笔订正）或未作答的题目，给出每题的粗略位置框与判定。`

const USER = (n: number) =>
  `输出 JSON：
{"items":[{"no":"26","box":[x,y,w,h],"verdict":"wrong|correct|blank|unknown","reason":"红叉在题号26处/未作答/...","confidence":0.0-1.0}]}
box 为归一化坐标（0~1，相对整图），只需框住该题的题号与作答区，允许略大。
宁可多报（把拿不准的也报出来），不要漏报。
${n > 0 ? `页面上大致有 ${n} 处批改痕迹区域，供参考。` : ''}`

/** 从模型返回中解析 items（纯函数，契约可测） */
export function parseVlmItems(content: string): VlmItem[] {
  if (!content || !content.trim()) return []
  let cleaned = content.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return []
  cleaned = cleaned.slice(start, end + 1)
  let parsed: { items?: unknown }
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return []
  }
  if (!Array.isArray(parsed.items)) return []
  const out: VlmItem[] = []
  for (const raw of parsed.items as Array<Record<string, unknown>>) {
    const boxRaw = raw.box
    let box: [number, number, number, number] | undefined
    if (Array.isArray(boxRaw) && boxRaw.length >= 4 && boxRaw.every((v) => typeof v === 'number')) {
      box = [boxRaw[0], boxRaw[1], boxRaw[2], boxRaw[3]]
    }
    out.push({
      no: typeof raw.no === 'string' ? raw.no : raw.no != null ? String(raw.no) : undefined,
      box,
      verdict: typeof raw.verdict === 'string' ? raw.verdict : undefined,
      reason: typeof raw.reason === 'string' ? raw.reason : undefined,
      confidence: typeof raw.confidence === 'number' ? raw.confidence : undefined,
    })
  }
  return out
}

export interface VlmResult {
  items: VlmItem[]
  used: boolean
  error?: string
}

/**
 * 调用 VLM 出题块（模式 2）。fail-open：任何异常都返回 used=false + error。
 * @param imageUrl 公网可达的图片 URL（VLM 只接受 URL，本地文件需先上传）
 */
export async function vlmQuestionBlocks(imageUrl: string, hintCount = 0): Promise<VlmResult> {
  if (!imageUrl) return { items: [], used: false, error: 'imageUrl 为空' }
  try {
    const { LLMClient } = await import('coze-coding-dev-sdk')
    const client = new LLMClient()
    const invokePromise = client.invoke(
      [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
            { type: 'text', text: USER(hintCount) },
          ],
        },
      ],
      { model: MODEL, temperature: 0.1 },
    )
    const response = await Promise.race([
      invokePromise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('VLM 超时')), TIMEOUT_MS)),
    ])
    const items = parseVlmItems(String(response?.content ?? ''))
    if (!items.length) return { items: [], used: false, error: 'VLM 返回无可解析 items' }
    return { items, used: true }
  } catch (e) {
    // fail-open：不阻塞主流程，交由本地证据层产出
    return { items: [], used: false, error: String((e as Error)?.message ?? e).slice(0, 200) }
  }
}
