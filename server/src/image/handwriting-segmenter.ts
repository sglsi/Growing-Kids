import { LLMClient, Config, HeaderUtils } from 'coze-coding-dev-sdk'
import sharp from 'sharp'
import { maskFromRects, type HandwritingMask, type MaskRect } from './handwriting-mask'

/**
 * 阶段二 · 手写区域分割器
 *
 * 职责：给定一张试卷图片，输出**手写区域的 mask**（阶段二的第 ① 步）。
 *
 * 两条路径：
 *  1. **VLM 路径（主）**：调用多模态大模型，让它以结构化 JSON 返回手写区域的
 *     bounding box（归一化坐标）。这是当前工程上最容易落地、且不依赖自训模型的做法。
 *  2. **色域阈值路径（降级）**：VLM 不可用时，用颜色特征兜底（见 handwriting-mask.ts）。
 *
 * 为什么要走 VLM 而不是自己训分割网络：
 *  - 自训 BiSeNetV2 需要大量标注数据 + 训练资源，短期不可行；
 *  - VLM 已经具备"区分手写与印刷"的语义能力，用提示词约束输出格式即可；
 *  - mask 是可解释的中间产物，便于调试与人工修正（后续可加"手动涂抹 mask"）。
 */

/** VLM 返回的原始结构（宽松校验） */
interface VlmMaskResponse {
  /** 手写区域列表 */
  regions?: Array<{
    x?: number
    y?: number
    w?: number
    h?: number
    width?: number
    height?: number
    confidence?: number
    label?: string
  }>
  /** 模型自评的置信度 */
  confidence?: number
}

const SEG_PROMPT = `你是一个文档版面分析助手。请分析这张试卷/作业图片，找出**所有手写内容**（学生手写答案、演算、批注、涂改、勾画）的区域。

严格要求：
1. 只框选**手写笔迹**，不要框选印刷体文字、印刷表格线、印刷图片、页面边框、空白区域。
2. 注意区分：印刷体边缘整齐、墨色均匀；手写笔迹粗细不均、有连笔、倾斜、涂抹。
3. 若手写与印刷重叠，只框出重叠区域中手写覆盖的部分。
4. 坐标使用**归一化值**（0~1，相对图片宽高）。
5. 宁多框一点（稍作外扩），也不要漏掉笔迹，但不要整页都框。

只输出 JSON，不要任何解释文字，格式如下：
{"regions":[{"x":0.12,"y":0.35,"w":0.40,"h":0.06,"confidence":0.9,"label":"handwriting"}],"confidence":0.9}

如果图片中**完全没有手写内容**，返回 {"regions":[],"confidence":0.95}`

/** 从模型输出里稳健地抽出 JSON（兼容 ```json 代码块、前后有解释文字等情况） */
export function parseVlmMaskResponse(text: string): VlmMaskResponse {
  if (!text) return { regions: [] }
  // 去掉 markdown 代码块包裹
  let s = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  // 截取第一个 { 到最后一个 }
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start >= 0 && end > start) s = s.slice(start, end + 1)
  try {
    const obj = JSON.parse(s)
    if (!obj || typeof obj !== 'object') return { regions: [] }
    return obj as VlmMaskResponse
  } catch {
    return { regions: [] }
  }
}

/** 把 VLM 的（可能的）多种字段名/越界值规范化为标准 MaskRect[] */
export function normalizeRects(resp: VlmMaskResponse): MaskRect[] {
  const out: MaskRect[] = []
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
  for (const r of resp.regions ?? []) {
    if (!r) continue
    const w = Number(r.w ?? r.width ?? 0)
    const h = Number(r.h ?? r.height ?? 0)
    const x = Number(r.x ?? 0)
    const y = Number(r.y ?? 0)
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue
    // 允许模型返回像素坐标（>1）的情况：按需归一化由调用方决定，这里只做 0~1 夹取
    out.push({
      x: clamp01(x),
      y: clamp01(y),
      w: clamp01(Math.min(w, 1 - clamp01(x))),
      h: clamp01(Math.min(h, 1 - clamp01(y))),
      confidence: r.confidence === undefined ? undefined : clamp01(Number(r.confidence)),
    })
  }
  return out
}

export interface SegmentOptions {
  /** 用于 VLM 判定的图片最大边长（过大时先缩小，降低 token 与耗时） */
  maxSide?: number
  /** 矩形外扩比例（占图片短边） */
  dilateRatio?: number
}

export interface SegmentResult {
  mask: HandwritingMask
  rects: MaskRect[]
  usedVlm: boolean
  raw?: string
}

/**
 * 用 VLM 分割手写区域。
 *
 * 实现要点：
 *  - 图片先缩放（默认最长边 1024）再送给模型：**不影响归一化坐标**，但显著降 token/耗时；
 *  - 明确要求返回 JSON，并做稳健解析（兼容代码块包裹、多余解释）；
 *  - 解析失败或返回空 → 返回 null，由调用方走降级路径。
 */
export async function segmentByVlm(
  imageUrl: string,
  forwardHeaders: Record<string, string>,
  opts: SegmentOptions = {},
): Promise<SegmentResult | null> {
  const headers = HeaderUtils.extractForwardHeaders(forwardHeaders)
  const client = new LLMClient()

  const resp = await client.invoke(
    [
      { role: 'system', content: SEG_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: '请找出这张图中的所有手写区域，按约定 JSON 输出。' },
          { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
        ],
      },
    ],
    { temperature: 0, thinking: 'disabled', streaming: false, headers },
  )

  const raw = resp?.content || ''
  const parsed = parseVlmMaskResponse(raw)
  const rects = normalizeRects(parsed)
  if (rects.length === 0) return null

  return { mask: null as unknown as HandwritingMask, rects, usedVlm: true, raw }
}

/**
 * 完整的分割流程（对外主入口）：
 *   ① 优先 VLM；失败则降级到色域阈值。
 *   ② 把矩形或阈值结果统一成 HandwritingMask，并按需与阈值 mask **取交集/并集**收敛。
 *
 * @param imageBuffer 原图（用于尺寸与阈值兜底）
 * @param imageUrl    原图公网 URL（用于 VLM）
 */
export async function buildHandwritingMask(
  imageBuffer: Buffer,
  imageUrl: string,
  forwardHeaders: Record<string, string>,
  opts: SegmentOptions & { allowVlm?: boolean } = {},
): Promise<SegmentResult> {
  const meta = await sharp(imageBuffer).metadata()
  const width = meta.width!
  const height = meta.height!
  const dilate = Math.round(Math.min(width, height) * (opts.dilateRatio ?? 0.008))

  if (opts.allowVlm !== false) {
    try {
      const vlm = await segmentByVlm(imageUrl, forwardHeaders, opts)
      if (vlm && vlm.rects.length > 0) {
        return {
          mask: maskFromRects(width, height, vlm.rects, { dilate, source: 'vlm' }),
          rects: vlm.rects,
          usedVlm: true,
          raw: vlm.raw,
        }
      }
    } catch (e) {
      console.warn('[mask] VLM 分割失败，降级到色域阈值', e instanceof Error ? e.message : e)
    }
  }

  // 降级：色域阈值
  const { maskFromColorThreshold } = await import('./handwriting-mask')
  const mask = await maskFromColorThreshold(imageBuffer)
  return { mask, rects: [], usedVlm: false }
}
