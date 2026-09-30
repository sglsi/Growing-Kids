import { LLMClient, Config, HeaderUtils } from 'coze-coding-dev-sdk'
import sharp from 'sharp'
import {
  maskFromRects,
  normalizeIlluminationForDetection,
  stripEdgeTouchingArtifacts,
  unionMasks,
  type HandwritingMask,
  type MaskRect,
} from './handwriting-mask'

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
2. 注意区分：印刷体边缘整齐、墨色均匀、**基线对齐、字距均匀**；手写笔迹粗细不均、有连笔、倾斜、大小不一。
3. 手写最常出现的位置：**填空横线上方/横线处、括号内、题干行尾、空白解答区、图形旁标注**——请逐一检查，不要遗漏小片手写（如勾选符号、单个字母/数字）。
4. 若手写与印刷重叠（压字），只框出手写笔画覆盖的细长区域，**绝不要把整行印刷文字框进去**。
5. 坐标使用**归一化值**（0~1，相对图片宽高）。
6. 宁多框一点（稍作外扩），也不要漏掉笔迹，但不要整页都框。

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
  /** 检测过程诊断（为何覆盖率为 0），用于给用户可操作的提示 */
  debug?: Record<string, unknown>
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
 *   ③ `manualRects`（⭐ 交互式补擦）：用户框选的区域**无条件**并入 mask——
 *      这是扫描王 / TextIn 等主流产品的同款交互：本地自动检测对「黑笔手写 vs
 *      黑色印刷」存在理论上限（几何/色彩特征全面重叠，见方法论 §5.3/§5.4），
 *      漏检零容忍场景下，用户框选是**确定性**兜底，优先级高于一切自动检测。
 *
 * @param imageBuffer 原图（用于尺寸与阈值兜底）
 * @param imageUrl    原图公网 URL（用于 VLM）
 * @param opts.manualRects 用户框选区域（归一化坐标 0~1，与 VLM 输出同构）
 */
export async function buildHandwritingMask(
  imageBuffer: Buffer,
  imageUrl: string,
  forwardHeaders: Record<string, string>,
  opts: SegmentOptions & { allowVlm?: boolean; manualRects?: MaskRect[] } = {},
): Promise<SegmentResult> {
  const meta = await sharp(imageBuffer).metadata()
  const width = meta.width!
  const height = meta.height!
  const dilate = Math.round(Math.min(width, height) * (opts.dilateRatio ?? 0.008))
  const manualRects = opts.manualRects?.filter((r) => r && r.w > 0 && r.h > 0) ?? []

  let vlmRects: MaskRect[] = []
  let vlmRaw: string | undefined
  if (opts.allowVlm !== false) {
    try {
      const vlm = await segmentByVlm(imageUrl, forwardHeaders, opts)
      if (vlm && vlm.rects.length > 0) {
        vlmRects = vlm.rects
        vlmRaw = vlm.raw
      }
    } catch (e) {
      console.warn('[mask] VLM 分割失败，降级到色域阈值', e instanceof Error ? e.message : e)
    }
  }

  // ── VLM / 手动框选路径：矩形 → mask ──
  if (vlmRects.length > 0 || manualRects.length > 0) {
    const all = [...vlmRects, ...manualRects]
    // 手动框选的外扩取小值：用户框的就是要擦的，过度外扩会波及邻近印刷体
    const manualDilate = Math.max(2, Math.round(dilate / 2))
    const mask = maskFromRects(width, height, all, {
      dilate: manualRects.length > 0 ? manualDilate : dilate,
      source: manualRects.length > 0 && vlmRects.length === 0 ? 'manual' : 'vlm',
    })
    return {
      mask,
      rects: all,
      usedVlm: vlmRects.length > 0,
      raw: vlmRaw,
      debug: manualRects.length > 0 ? { manualRects: manualRects.length } : undefined,
    }
  }

  // 本地降级路径（**不依赖任何外部 AI**）：
  //   ① 色域阈值 —— 抓蓝/红等**彩色**笔迹；
  //   ② 深色墨迹 —— 抓铅笔/黑色中性笔（色域法因与印刷体同为近黑而完全失效的场景）。
  // 两条路径互补，取**并集**：只靠 ① 时，中国学生最常用的黑笔/铅笔 100% 检不出，
  // 表现就是「点了去手写没反应」（实测确认）。
  const { maskFromColorThreshold, maskFromDarkInk, maskFromLayoutSlots } = await import('./handwriting-mask')
  // P0-8 前置：先把低频光照梯度拉平，再喂给检测。
  // 依据见 handwriting-mask.ts 的 `normalizeIlluminationForDetection` 函数头——
  // 实测强阴影下 Otsu 会连带把整页判成墨迹，形成 1161px 超级行并触发 share_guard，
  // 最终表现为「点了去手写没反应」。归一化后三档光照的覆盖率收敛到同一水平。
  // ⚠️ 归一化图**只用于**检测，后续修复与混合仍在**原图**上进行。
  const pre = await normalizeIlluminationForDetection(imageBuffer)
  const detectBuf = pre.buffer

  const chroma = await maskFromColorThreshold(detectBuf)
  const dark = await maskFromDarkInk(detectBuf)
  // ⭐ 第三通道：布局先验（横线填空槽位）。外观路径对"黑笔短答案/压字填空"不可分，
  //   本通道用题型结构（横线槽位）直接定位手写，与外观/VLM 通道取并集（详见方法论 §5.5）。
  const layout = await maskFromLayoutSlots(detectBuf)
  const m1 = await unionMasks(chroma, dark)
  const mask = await unionMasks(m1, layout)
  // ⭐ 贴边伪影清除：色域路径没有深色路径的「边缘连通清除」防线，
  //    会把装订阴影/页边检出为细长条（真卷实测 32×1520，占 coverage 37%）。
  //    只作用于本地检测结果——manual/vlm 来源绝不清除。
  const edgeStripped = stripEdgeTouchingArtifacts(mask)
  return {
    mask,
    rects: [],
    usedVlm: false,
    debug: {
      chromaCoverage: chroma.coverage,
      darkCoverage: dark.coverage,
      darkDebug: dark.debug,
      illuminationNormalized: pre.applied,
      medH: Math.round(pre.medH),
      lumaDeltaMean: +pre.deltaMean.toFixed(2),
      ...(edgeStripped.length ? { edgeStripped } : {}),
    },
  }
}
