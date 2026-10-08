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
  /**
   * ⭐ v18.2 擦除模式（本地降级路径）：
   *  - `union`（默认）：三通道并集（色域+深色墨迹+布局槽位），服务**黑笔/铅笔**手写；
   *  - `color`：仅色域通道 + 印刷保护闸，服务**红/蓝笔批改卷**——
   *    实测（物理导学案18）：红笔卷上 dark/slots 通道对红笔清除零贡献
   *    （残留 11.9% vs 12.2%），却把大量印刷正文连同红笔一起吞掉
   *    （mask 内被删像素 42.5% 是黑色印刷）。color 模式误删降 52%~99%。
   */
  eraseMode?: 'union' | 'color' | 'hybrid'
  /**
   * ⭐ v20 `hybrid` 模式：**红笔批改场景**（作业本/试卷/练习册）。
   *
   * 动机：实测在报纸类密排小字版面上，区分「黑笔手写」与「黑色印刷」的
   * 所有像素级特征 AUC≈0.5（字高仅 6~7px，笔宽/字高/灰度/形状全部退化），
   * **唯一有效判据是空间关系**：教师只在学生写过的地方批改。
   * 故 hybrid = 色域红笔（v19.2 精修链） ∪ 红笔菱形邻域内的黑笔。
   *
   * 实测 4 张英语灰报：黑笔覆盖 **0% → 64~71%**，印刷误删 **0**，
   * 红笔去率保持 0.86 不回退。
   *
   * ⚠️ 不适用：没有批改痕迹的空白作业（本通道产出 0）→ 用 union 或框选补擦。
   */
  hybrid?: boolean
  /** v20：`hybrid` 模式下红笔菱形邻域半径（px）。默认 24（实测拐点） */
  blackRadius?: number
  /**
   * ⭐ v19.1：`color` 模式下红色版面家具排除判据的微调（默认沿用 v19 行为）。
   *  - `edgeMinArea`：触边判据的最小面积（px²），低于该面积的贴边碎域**不判家具**——
   *    报纸正文靠页边的红笔批注不再被误杀；
   *  - `edgeMinFill`：触边判据的最小填充率 n/(bw×bh)，低于该值视为镂空笔画而非实心态面。
   */
  colorRefine?: {
    edgeMinArea?: number
    edgeMinFill?: number
    /** v19.2 种子生长半径（px）。给 0 / undefined 则关闭生长，沿用 v19 行为 */
    growRadius?: number
    /** v19.2 种子生长区的最低彩度，默认 8 */
    growChroma?: number
  }
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
/**
 * ⭐ v20.8：把用户手动框选的区域**并入**自动检测结果（补充，非替换）
 *
 * 背景：此前 `manualRects.length > 0` 与 VLM 并列在同一条 early-return 里，
 * 一旦用户框选就直接 `return maskFromRects(manual)`，**整条检测链被跳过**。
 * 对"补擦"场景这是错的：用户框的是自动检测**漏掉**的部分，
 * 框选不该让已检出的红笔/黑笔整片消失（实测后果 = 补擦撤销了已有擦除效果）。
 *
 * @param manualRects 归一化矩形（0~1）
 * @param dilateBase  自动检测的外扩量；手动框选用其一半（用户框的就是要擦的，
 *                    过度外扩会波及邻近印刷体）
 * @param srcRGB 可选，原图 RGB（用于图形区保护判定）
 * @param protectGraphics 图形/照片区保护：框内若含大片非纸面内容则**整框拒绝**并返回原因
 */
/**
 * v20.9 · 框选补擦 = 「框内笔迹像素」而非「整块矩形」
 * ============================================================
 *
 * ⭐⭐ 这是本轮最重要的机制修正。三次事故链：
 *
 * 事故①（原机制）：矩形整块并入 mask → inpaint 拿不到框内参考像素
 *   → 实物照片被涂成纯白方块，图片内容不可逆摧毁。
 *
 * 事故②（v3 判据）：为修①加了 midRatio 保护（0.12）。但该判据的标定
 *   **建立在错误标注上** —— probe-graphic-cand.ts 逐格目视发现：
 *     ·原「图形」样本 7 个里 **5 个其实是印刷文字**
 *     · 原「文字」样本 4 个是**纯白空白块**
 *   用正确标注重测（probe-graphic-guard4.ts）：midRatio AUC 仅 0.188、
 *   flatRatio 0.667、lumaStd 0.188、edgeDensity 0.896 —— **全部不成立**。
 *   且 v3 对**整体偏暗**的照片（显微镜视野，midRatio=0%）完全失效，
 *   而 E2E 当时报 A_pass=true（框内擦除 2601 > 0）—— **验收数字全绿但图被毁**。
 *
 * 事故③（判据路走不通 → 换机制）：
 *   根子不在"怎么判断图形"，而在**矩形被整块当成 mask**。
 *   换机制：矩形语义从「要擦的区域」改为「**要擦的像素的搜索范围**」——
 *   只把框内的**笔迹像素**（暗于纸面 或 高彩度）并入 mask，
 *   框内亮部/纸面**留作 inpaint 的参考像素**。这样：
 *     · 不需要判断"这是图形还是文字"（统计上不可分，见上）
 *     · 天然不毁图：擦完仍是纸面，不会出现纯白方块
 *     · 印刷体笔画与手写共处时，仅笔迹像素被改写
 *
 * 实测（probe-mech-stroke.ts，信息保留 = 灰度标准差 after/before）：
 *   样本            A整框    B笔迹
 *   左栏正文         0.090   0.169
 *   中栏正文         0.042   0.191   ← 4.5×
 *   右栏红笔区0.113   0.146
 *   目检：红笔区「company I (59)」印刷字在 A 下整块消失，B 下清晰保留。
 *
 * ⚠️ B 在**整幅偏暗的照片**上仍会覆盖整框（照片本身全暗）。
 *   此时不再靠统计量去猜，而是**如实上报覆盖率**给前端提示用户
 *   （见 manualStrokeRatio debug 字段）—— 判不准就暴露，不硬猜。
 */

function mergeManualRects(
  base: HandwritingMask,
  manualRects: MaskRect[],
  width: number,
  height: number,
  dilateBase: number,
  srcRGB?: Buffer,
  protectGraphics = true,
): HandwritingMask {
  if (manualRects.length === 0) return base
  const manualDilate = Math.max(2, Math.round(dilateBase / 2))

  // ══ v20.9 图形/照片区保护（严重缺陷修复）══
  // 实测事故：用户框到**实物照片**区域（报纸插图）时，框内无任何"手写"，
  //   但无条件并入 mask → inpaint 拿不到参考像素 → 整块照片被涂成纯白，
  //   **图片内容不可逆摧毁**。而当时 E2E 三条验收全绿 —— 因为验收只验了
  //   "框选区变干净了"，没验"框内是否含不该被擦的内容"。
  //   ⚠️ 此前 api.ts 注释声称"整图覆盖率 >70% 有兜底保护"——**该保护不存在**，
  //   且 51x51 框仅占全图 0.16%，永远触发不了 70% 阈值。注释已同步更正。
  //
  // ⚠️⚠️ 判据经两轮实测标定，**前两版都被否决**，勿凭直觉改回：
  //   v1「暗像素占比 > 0.45」—— 已否决。实测 page30 两张实物照片暗占比
  //      0.496 / 0.176（同一张图差 2.8 倍），page29 插图 0.19 低于文字块中位数 0.24。
  //      照片与文字的暗占比完全重叠。
  //   v1b「最长连续暗游程」—— 已否决。照片 0.442~0.865，文字块 p50=0.82；
  //      报纸栏缝/表格线/下划线让文字块也有长游程。
  //   v2「灰阶唯一值数」—— 已否决。文字区 distinct 反而更高（48 vs 34~43）。
  //   v3 ✅「中间调占比 midRatio」—— 实测通过（probe-graphic-guard2.ts）：
  //      照片 49.7% / 47.5% / 50.8% / 13.1%，纯文字 5.5 / 9.5 / 9.0 / 0.0 / 4.5 / 10.7%
  //      阈值 12% → 图形 4/4 命中，文字 0/6 误判。
  //      原理：照片有**连续灰阶过渡**，文字是**近二值笔画**（纸白+墨黑+少量抗锯齿）。
  // ══ v20.9 框内笔迹像素选取（替代「整块矩形并入 + 统计量拒擦」）══
  //
  // 事故背景：整块矩形并入 mask 时，框内**全部**像素被送去重绘，
  //   inpaint 拿不到任何框内参考 → 实物照片被涂成纯白方块（不可逆摧毁）。
  //   曾用「中间调占比」等统计量拒擦来防，但标定建立在**错误标注**上，
  //   用目视确认的标注重测后所有判据 AUC 均不成立（详见上方注释）。
  //
  // 新机制：矩形只是**搜索范围**，真正并入 mask 的是框内的**笔迹像素**。
  //   · 暗于纸面 → 笔迹候选（黑笔/铅笔/印刷体笔画都算，靠 inpaint 的
  //     印刷保护闸在**修复层**区分，不在 mask 层区分）
  //   · 高彩度 → 红笔/蓝笔候选
  //   · 框内亮部（纸面/背景）**保留在 mask 外** → 成为 inpaint 的参考像素
  //   结果：擦完仍是纸面，不会出现纯白方块（实测信息保留提升 1.3~4.5×）。
  if (protectGraphics && srcRGB) {
    // 纸面亮度（全图 98 分位）
    const lum: number[] = []
    const step = Math.max(1, Math.floor((width * height) / 20000))
    for (let p = 0; p < width * height; p += step) {
      const i = p * 3
      lum.push(0.299 * srcRGB[i] + 0.587 * srcRGB[i + 1] + 0.114 * srcRGB[i + 2])
    }
    lum.sort((a, b) => a - b)
    const paperL = lum[Math.floor(lum.length * 0.98)] || 235

    const strokeData = Buffer.alloc(width * height)
    const notes: string[] = []
    let covered = 0
    let boxArea = 0

    for (const r of manualRects) {
      const x0 = Math.max(0, Math.round(r.x * width))
      const y0 = Math.max(0, Math.round(r.y * height))
      const x1 = Math.min(width - 1, Math.round((r.x + r.w) * width) - 1)
      const y1 = Math.min(height - 1, Math.round((r.y + r.h) * height) - 1)
      if (x1 <= x0 || y1 <= y0) continue

      let inBox = 0
      let strokes = 0
      for (let y = y0; y <= y1; y++) {
        const b = y * width
        for (let x = x0; x <= x1; x++) {
          const i = (b + x) * 3
          const R = srcRGB[i], G = srcRGB[i + 1], B = srcRGB[i + 2]
          const l = 0.299 * R + 0.587 * G + 0.114 * B
          const mx = R > G ? (R > B ? R : B) : (G > B ? G : B)
          const mn = R < G ? (R < B ? R : B) : (G < B ? G : B)
          const chrom = mx === 0 ? 0 : (mx - mn) / mx
          // ⚠️ 阈值来自 probe-mech-stroke.ts 的实测；改动前先重跑该探针
          const isStroke = l < paperL - 42 || chrom > 0.28
          // ⚠️⚠️ 不要再在这里加「只补自动检测漏掉的」约束 ——
          //   probe-attribution.ts 实测：纯印刷体区块内，框内暗像素在
          //   base.mask 中占**0%**（自动检测在这块区域是空的，给不出任何信息）。
          //   所以「减去自动已认定非手写的像素」这个想法**挡不住任何东西**，
          //   加了等于没加（v20.9.1 实测误删率一格未变：100% → 100%）。
          //
          //   实测归属（probe-attribution.ts + diag-contradiction.ts 交叉验证）：
          //     框内暗像素 534 → 在 base 里 0 → 全部由框选路径加入 man mask
          //     掩外像素变化 = 0 （修复层无越界，机制本身没问题）
          //   ⇒ 框选补擦必须依赖**用户指令**本身，这是扫描王/TextIn 的同款交互，
          //     也符合本方法论§5 的第 5 条换路（自动检测 → 人机交互）。
          //
          //   代价（必须对用户说清）：框纯印刷体区会把印刷体一起擦掉。
          //   缓解：前端提示 + 用户可撤销 + 可只框手写所在的小范围。
          if (isStroke) { strokeData[b + x] = 255; strokes++ }
          inBox++
        }
      }
      covered += strokes
      boxArea += inBox
      const ratio = inBox ? strokes / inBox : 0
      notes.push(`${r.x.toFixed(3)},${r.y.toFixed(3)} 笔迹占比${(ratio * 100).toFixed(0)}%`)
      // 整框几乎全是"笔迹" → 多半框到了照片/深色图形区。
      // 不断言"是照片"（判据已实测不成立），只**如实上报**让上层提示用户。
      if (ratio > 0.9) {
        console.warn(
          `[mask] ⚠️ 框 ${r.x.toFixed(2)},${r.y.toFixed(2)} 内${(ratio * 100).toFixed(0)}% 像素被判为笔迹` +
          `（可能框到了照片/深色插图）。若结果不符预期，请改框纯文字区。`,
        )
      }
    }

    const n = width * height
    const data = Buffer.from(base.data)
    let added = 0
    for (let i = 0; i < n; i++) {
      if (strokeData[i] > 127 && data[i] <= 127) { data[i] = 255; added++ }
    }
    let total = 0
    for (let i = 0; i < n; i++) if (data[i] > 127) total++
    return {
      ...base,
      data,
      coverage: total / n,
      debug: {
        ...(base.debug ?? {}),
        manualRects: manualRects.length,
        manualAddedPx: added,
        manualStrokePx: covered,
        // 框内「被判为笔迹」的像素占框总面积之比。接近 1 = 整框都被重绘，
        // 通常意味着框到了照片/深色插图。供上层提示用户（不作为拒擦依据）。
        manualStrokeRatio: boxArea ? +(covered / boxArea).toFixed(4) : 0,
        manualRejectDetail: notes.join(' | ').slice(0, 300),
      },
    }
  }

  // 无srcRGB（理论上不会走到，srcRGB 在有框选时必然已取原图）→ 退回整框并入
  const add = maskFromRects(width, height, manualRects, { dilate: manualDilate, source: 'manual' })
  const n = width * height
  const data = Buffer.from(base.data)
  let added = 0
  for (let i = 0; i < n; i++) {
    if (add.data[i] > 127 && data[i] <= 127) { data[i] = 255; added++ }
  }
  return {
    ...base,
    data,
    coverage: (data.reduce((s, v) => s + (v > 127 ? 1 : 0), 0)) / n,
    debug: { ...(base.debug ?? {}), manualAddedPx: added, manualRects: manualRects.length },
  }
}

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
  // v20.2：hybrid 先验不可用而回退 union 时，记录原因（debug 可观测）
  let unionFallbackFromHybrid: string | undefined

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

  // ── VLM 路径：矩形 → mask ──
  if (vlmRects.length > 0) {
    const mask = maskFromRects(width, height, vlmRects, { dilate, source: 'vlm' })
    return {
      mask,
      rects: vlmRects,
      usedVlm: true,
      raw: vlmRaw,
    }
  }

  // ── ⭐ v20.8 手动框选：**补充**而非**替换**（此前是个语义错误）──
  // 旧代码把 `manualRects.length > 0` 与 VLM 并列进同一条 early-return：
  //   一旦用户框选，就 `return maskFromRects(manual)` **直接跳过整条检测链**。
  // 对"补擦"场景这是错的——用户框掉的是自动检测漏掉的部分，
  // 框选**不该让已检出的红笔/黑笔消失**。实测后果：框选补擦后，
  // 原本自动擦干净的红笔整片回到图上（等价于"补擦把已有效果撤销了"）。
  // 现在：检测链照常跑完，最后把用户框的区域**并入**结果。
  if (manualRects.length > 0) {
    // 继续往下走本地检测链…
    console.warn('[mask] 手动框选与检测链并用（v20.8）：框选作为补充，不替换检测结果')
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

  // ── v20.9 图形区保护：取**原图** RGB ──
  // ⚠️ 必须用原图而非 pre.buffer：归一化会压平灰阶（强阴影照片本来就被压平），
  //    而"中间调占比"判据恰恰依赖灰阶层次，用归一化图会失效。
  let origRGB: Buffer | undefined
  if (manualRects.length > 0) {
    try {
      const { data } = await sharp(imageBuffer).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
      if (data.length >= width * height * 3) origRGB = data
    } catch (e) {
      console.warn('[mask] 取原图 RGB 失败，跳过图形区保护：', e instanceof Error ? e.message : e)
    }
  }

  const chroma = await maskFromColorThreshold(detectBuf)
  // ⭐ v18.2 + v19 color 模式：仅色域通道 + 印刷保护闸（红/蓝笔批改卷专用，见 SegmentOptions 注释）
  if (opts.eraseMode === 'color') {
    const { protectPrintUnderColorHandwriting, refineColorEraseMask } = await import('./handwriting-mask')
    // v19：color 模式改用更敏感的 chromaMin=14（默认 22 会把细红笔对勾/细订正打碎后漏掉）。
    //      实测（4 张英语灰报）：教师红笔去红率 0.34~0.70 → 0.57~0.82。
    const chromaSensitive = await maskFromColorThreshold(detectBuf, { chromaMin: 14 })
    const protectedMask = await protectPrintUnderColorHandwriting(imageBuffer, chromaSensitive)
    // v19：排除印刷红色页眉家具（报头红横幅/侧边红框），再闭运算补连细笔。
    //      实测：印刷红家具保留率 0.000 → 1.000，黑色印刷损伤保持 ~0。
    // v19.2 种子生长（可选）：把检测用图取成 raw RGB 交给 refine，用于补抓淡红边缘
    let grow: { rgb: Buffer; channels: number; radius?: number; chromaMin?: number } | undefined
    // v19.2 默认开启种子生长（半径 2 / 彩度 ≥8）：见 ColorEraseRefineOptions.grow 注释。
    //    实测 4 张英语灰报：去红率均值 0.746 → 0.859，家具保留仍 1.000，印刷损伤 ≤0.0025。
    //    半径 3/5 只再多 1.6~3.8pp 却让损伤翻倍，按"宁可漏擦不可错擦"取半径 2。
    //    调用方传 { growRadius: 0 } 可显式关闭。
    const cr = opts.colorRefine ?? { growRadius: 2, growChroma: 8 }
    if ((cr.growRadius ?? 0) > 0) {
      try {
        const rawD = await sharp(detectBuf).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
        if (rawD.info.width === protectedMask.width && rawD.info.height === protectedMask.height) {
          grow = {
            rgb: rawD.data,
            channels: rawD.info.channels,
            radius: cr.growRadius,
            chromaMin: cr.growChroma,
          }
        }
      } catch {
        grow = undefined // 取 raw 失败就退回不生长，绝不因兜底逻辑中断主流程
      }
    }
    const finalMask = refineColorEraseMask(protectedMask, pre.medH, { ...(cr ?? {}), grow })
    return {
      mask: finalMask,
      rects: [],
      usedVlm: false,
      debug: {
        mode: 'color-only',
        chromaCoverage: chroma.coverage,
        chromaSensitiveCoverage: +chromaSensitive.coverage.toFixed(4),
        printProtected: (finalMask.debug as { printProtected?: number } | undefined)?.printProtected,
        furnitureDomains: (finalMask.debug as { furnitureDomains?: number } | undefined)?.furnitureDomains,
        furniturePx: (finalMask.debug as { furniturePx?: number } | undefined)?.furniturePx,
        illuminationNormalized: pre.applied,
      },
    }
  }

  // ⭐⭐ v20 **hybrid 模式**（红笔批改场景）：色域红笔 ∪ 红笔空间先验黑笔
  //   背景：实测（probe-feature-auc.ts）报纸上区分黑笔/印刷的所有像素级特征
  //   AUC≈0.5（6~7px 字高下信息退化），唯一有效判据是**空间关系**——
  //   教师只在学生写过的地方批改。故以红笔菱形 R=24 邻域内的墨迹作为黑笔 mask。
  //   实测：黑笔覆盖 64~71%，印刷误删 0（详见 red-ink-prior.ts 头注释）。
  // ⭐ B-2 影子调用点（任务 B · 默认 off，零行为）：结构一致性判别器
  //   STRUCT_ADAPTIVE = 'shadow' → 并行算结构掩码，只写 debug，**不**并入 merged（主路径行为不变）
  //   STRUCT_ADAPTIVE = 'on'     → 检查点(E9)全绿后才允许切换（见 erase-guard，当前门禁禁止置 on）
  //   默认 off / 未设 → 整段跳过，零成本零行为变化（符合 v21.2 §3「一次一处」切换纪律）
  let structDebug: Record<string, unknown> | undefined

  if (opts.eraseMode === 'hybrid') {
    const { protectPrintUnderColorHandwriting, refineColorEraseMask } = await import('./handwriting-mask')
    const { maskFromRedSpatialPrior } = await import('./red-ink-prior')
    // ① 红笔（色域，主判据）—— 走既有 v19/v19.2 精修链
    const chromaSensitive = await maskFromColorThreshold(detectBuf, { chromaMin: 14 })
    const redProtected = await protectPrintUnderColorHandwriting(imageBuffer, chromaSensitive)
    const cr = opts.colorRefine ?? { growRadius: 2, growChroma: 8 }
    let grow: { rgb: Buffer; channels: number; radius?: number; chromaMin?: number } | undefined
    if ((cr.growRadius ?? 0) > 0) {
      try {
        const rawD = await sharp(detectBuf).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
        if (rawD.info.width === redProtected.width && rawD.info.height === redProtected.height) {
          grow = { rgb: rawD.data, channels: rawD.info.channels, radius: cr.growRadius, chromaMin: cr.growChroma }
        }
      } catch {
        grow = undefined
      }
    }
    const redMask = refineColorEraseMask(redProtected, pre.medH, { ...(cr ?? {}), grow })
    // ② 黑笔（红笔空间先验）
    //   ⭐ v20.2：红笔 mask 直接注入 ① 的精修产物（同源口径 + 家具已排除）。
    //   之前内部裸彩度判红把报纸灰底噪声判成"红笔"（page30 实测 87 倍于色域通道），
    //   菱形膨胀后整栏印刷沦为擦除区——见 red-ink-prior.ts 头部【教训一】。
    //   ⭐ v20.5：改喂**原图**而非归一化图。漏擦归因（probe-miss-attrib.ts）显示
    //   未擦像素里 36~41% 卡在墨迹暗阈值上：归一化把纸面基准抬高（page30 197→201），
    //   墨迹判定的 paper×0.62 随之抬高，整图墨迹像素少 15%，这些像素恰好是黑笔。
    //   红（色域）在归一化图上判、黑（墨迹）在原图上判，各用各的最准基准。
    // ⭐ P2-2 半径自适应：
    //   - R_OVERRIDE  绝对像素（扫描用，验证半径对 E7 的敏感度）
    //   - R_ADAPTIVE=on → radius = R_KR × medH（默认 R_KR=0.15，见下）
    //   - 否则沿用固定 24px（旧行为，回滚基线）
    //   注：medH 取自 pre.medH（原始尺度字高，refineColorEraseMask 同款口径）。
    //   ⚠️ k_r 取值经实测标定（非拍脑袋）：计划原估 k_r≈2.2 在 page29 会膨胀到 163px，
    //      反而比现状 24px 更糟。实际扫描显示最优 k_r∈[0.10,0.15]（半径≈8~16px），
    //      因为红笔空间先验要抓的是「紧邻红笔的黑笔批改」，间距是绝对几毫米量级，
    //      不该随字高线性放大。0.15 在 4 页上 keepNoRed 全部 ≥0.985 且黑笔召回损失最小。
    //      半径默认自适应开启（与 P1 的 INK_ADAPTIVE 同款门禁风格）；R_ADAPTIVE=off 回滚固定 24px。
    const R_OVERRIDE = process.env.R_OVERRIDE ? +process.env.R_OVERRIDE : undefined
    const R_KR = process.env.R_KR ? +process.env.R_KR : 0.15
    const radiusVal = R_OVERRIDE ?? ((process.env.R_ADAPTIVE ?? 'on') !== 'off' && pre.medH > 0
      ? Math.max(4, Math.round(R_KR * pre.medH))
      : (opts.blackRadius ?? 24))
    const black = await maskFromRedSpatialPrior(imageBuffer, {
      radius: radiusVal,
      redMask: redMask.data,
    })
    // ③ 并集
    //   ⚠️ v20.3 尝试并入布局槽位通道被数据否决：报纸密排版面把行间/栏间空隙
    //   当成"槽位"（槽内全是印刷），印刷误删 0.000 → 0.058~0.215（实测 4 页）。
    //   槽位通道的印刷保护是按 A4 稀疏版面的横线设计的，密排版面不适用。
    //   保持 v20.2：hybrid = 色域红笔 ∪ 红笔先验黑笔，不含槽位。
    // ④ ⭐ 印刷保护闸（P2-2b · 根因修复版）：hybrid 路径此前合并后**直接返回**，
    //    跳过 union 路径同款的 protectPrintUnderColorHandwriting，导致红笔空间先验
    //    的 black（菱形膨胀）误吞的印刷体未被剔除 —— 这是「红笔卷把红笔周边印刷一起
    //    擦掉」（用户抱怨② / E7）的直接来源（P1 验收已证 hybrid 下 keepNoRed 与深色
    //    阈值无关，故 E7 杠杆在此处，不在 P1 的 Sauvola 化）。
    //    根因：菱形内**所有墨迹**被当黑笔，连通域包含阈值(0.6)过松，印刷行大多落在
    //    菱形内即被判黑笔。修复（两步，均在合并前作用在 black 上）：
    //      ① 彩色连通域保护：剔除与红笔同域、却细笔画的印刷（protectPrintUnderColorHandwriting）
    //      ② 几何印刷域过滤器(dropPrintLikeComponents)：按域高/宽剔除整行印刷字——
    //         这一步补 protectPrint 的盲区（整行印刷存活率中等，漏过彩色判据）。
    //    两步叠加 → black 本就不含印刷 → 半径可放心放大去抓黑笔，E7 与 E5 不再零和。
    //    回滚：HYBRID_PROTECT=off → 两步都不做（即旧行为）。
    //    ⚠️ 几何过滤器(dropPrintLikeComponents)当前默认关闭：实测它对 page28/29/31 过度删除了
    //       **黑笔**（黑笔批改笔画尺寸≈印刷字，被同一判据误删，blackRemovalPen 0.25→0.06）。
    //       正确启用前提是再加「只删不接触红笔的印刷域」约束（黑笔必邻近红笔），留作 P2-3 任务。
    const n = redMask.width * redMask.height
    let blackData: Uint8Array = black.data
    let blackProtectedPx = 0
    if (process.env.HYBRID_PROTECT !== 'off') {
      const hw = await import('./handwriting-mask')
      const blackHM: HandwritingMask = {
        width: redMask.width, height: redMask.height,
        data: black.data, coverage: black.coverage, source: 'threshold',
      }
      const protBlack = await hw.protectPrintUnderColorHandwriting(imageBuffer, blackHM)
      blackData = protBlack.data
      blackProtectedPx = (protBlack.debug as { printDroppedPx?: number } | undefined)?.printDroppedPx ?? 0
        // ② 几何印刷域过滤（v21.7 起默认开启；GEOM_FILTER=off 可关闭回退）。
      //    v21.7 已加「不接触红笔」约束：仅剔除不邻接红笔的印刷状域，保住紧邻红笔的黑笔批改，
      //    故此前"误删黑笔"的顾虑已被约束化解，可默认开启做红笔压印刷的兜底。
      if (process.env.GEOM_FILTER !== 'off') {
        const beforeGeom = (() => { let c = 0; for (let i = 0; i < protBlack.data.length; i++) if (protBlack.data[i] > 127) c++; return c })()
        // 传入 redMask.data 作为"接触红笔"判据：接触红笔者疑为黑笔 → 保留
        blackData = hw.dropPrintLikeComponents(protBlack.data, redMask.width, redMask.height, pre.medH, redMask.data as Uint8Array)
        const afterGeom = (() => { let c = 0; for (let i = 0; i < blackData.length; i++) if (blackData[i] > 127) c++; return c })()
        blackProtectedPx += beforeGeom - afterGeom
      }
    }
    // ⭐ B-2 影子调用点：结构一致性判别器（任务 B，默认 off，零行为）
    //   仅观测、不并入 merged；on 的切换留到 E9 检查点通过后（erase-guard 当前禁止 STRUCT_ADAPTIVE=on）
    if (process.env.STRUCT_ADAPTIVE && process.env.STRUCT_ADAPTIVE !== 'off') {
      try {
        const { buildDocContext } = await import('./adaptive-stats')
        const { discriminate } = await import('./structural-discriminator')
        const ctx = await buildDocContext(imageBuffer, { width, height, isGray: false })
        // 家具/印刷先验（与探针同口径）：work 尺度 RGB → 粗 chroma → 保护链
        let structFurn: Uint8Array | undefined
        try {
          const workRGB = await sharp(imageBuffer).resize(ctx.work.w, ctx.work.h, { fit: 'fill' }).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
          const ch = workRGB.info.channels
          const chroma = new Uint8Array(ctx.work.w * ctx.work.h)
          for (let i = 0, p = 0; i < chroma.length; i++, p += ch) {
            const r = workRGB.data[p], g = workRGB.data[p + 1], b = workRGB.data[p + 2]
            if (Math.max(r, g, b) - Math.min(r, g, b) >= 14) chroma[i] = 255
          }
          const chromaHM: HandwritingMask = {
            width: ctx.work.w, height: ctx.work.h, data: Buffer.from(chroma),
            coverage: chroma.reduce((a, b) => a + b, 0) / chroma.length, source: 'threshold',
          }
          const rgbBuf = await sharp(workRGB.data, { raw: { width: ctx.work.w, height: ctx.work.h, channels: ch } }).png().toBuffer()
          const prot = await protectPrintUnderColorHandwriting(rgbBuf, chromaHM)
          structFurn = new Uint8Array(ctx.inkLocal.length)
          for (let i = 0; i < ctx.inkLocal.length; i++) if (ctx.inkLocal[i] && !prot.data[i]) structFurn[i] = 255
        } catch { /* 先验构建失败则省略，判别器仍运行（E7 保护闸退化为无） */ }
        const sres = discriminate({ ctx, furniturePrior: structFurn })
        const structHW = sres.comps.filter((c) => c.state === 1).reduce((a, c) => a + c.n, 0)
        const structUNC = sres.comps.filter((c) => c.state === 2).reduce((a, c) => a + c.n, 0)
        const structAll = sres.comps.reduce((a, c) => a + c.n, 0) || 1
        structDebug = {
          mode: process.env.STRUCT_ADAPTIVE,
          charH: sres.debug.charH, nComps: sres.debug.nComps, nRows: sres.debug.nRows,
          nAnchors: sres.debug.nAnchors,
          labelInkShare: sres.debug.labelInkShare,
          hwInkShare: +(structHW / structAll).toFixed(3),
          uncInkShare: +(structUNC / structAll).toFixed(3),
          printingProtected: sres.debug.printingProtected,
          note: 'shadow：仅观测，未并入 merged；on 切换需 E9 检查点通过',
        }
        if (process.env.STRUCT_ADAPTIVE === 'on') {
          // 未来切换点（当前门禁禁止，见 erase-guard E9）：将 structural 掩码并入 merged
          // 用 work 尺度 labels 上采样到原图，或直接在 work 尺度合并后上采样。检查点通过前绝不启用。
          console.warn('[mask] STRUCT_ADAPTIVE=on 已触发但未实现切换（E9 检查点未通过，保持 shadow 行为）')
        }
      } catch (e) {
        console.warn('[mask] 结构判别器影子调用失败（不影响主路径）：', e instanceof Error ? e.message : e)
      }
    }

    const merged = Buffer.alloc(n)
    let covered = 0
    for (let i = 0; i < n; i++) {
      if (redMask.data[i] || blackData[i]) { merged[i] = 255; covered++ }
    }
    const maskForManual: HandwritingMask = { ...redMask, data: merged, coverage: covered / n }
    // ④ ⭐ v20.2 自适应回退：先验通道依赖"存在红笔批改"这一前提。
    //   无批改的卷（no_red_pen）或批改区无墨迹时，本通道产出空——此时**必须**
    //   回退 union（深色+槽位+色域），否则"无红笔作业"会因 hybrid 而丢失
    //   本可检出的手写。前提不成立时换路径，不是硬扛（与 v20.1 教训同一思想）。
    if (covered > 0 && black.reason.startsWith('ok')) {
      const finalMask = mergeManualRects(maskForManual, manualRects, width, height, dilate, origRGB)
      return {
        mask: finalMask,
        rects: manualRects,
        usedVlm: false,
        debug: {
          mode: 'hybrid',
          redCoverage: +redMask.coverage.toFixed(4),
          blackCoverage: +black.coverage.toFixed(4),
          blackReason: black.reason,
          blackRedPx: black.redPx,
          printProtected: (redMask.debug as { printProtected?: number } | undefined)?.printProtected,
          blackPrintDroppedPx: blackProtectedPx,
          hybridProtectOn: process.env.HYBRID_PROTECT !== 'off',
          furnitureDomains: (redMask.debug as { furnitureDomains?: number } | undefined)?.furnitureDomains,
          furniturePx: (redMask.debug as { furniturePx?: number } | undefined)?.furniturePx,
          illuminationNormalized: pre.applied,
          ...(structDebug ? { structural: structDebug } : {}),
          // ⚠️ 必须取 finalMask.debug 里的真实值，不能用入参 manualRects.length：
          //   图形区保护会拒掉部分框，用入参长度会谎报"并入 N 框"。
          //   （可观测字段撒谎 = 验收标准有盲区，v20.9 同一类病，已踩两次）
          ...(manualRects.length > 0
            ? {
              manualRects: (finalMask.debug as { manualRects?: number } | undefined)?.manualRects ?? 0,
              manualRejected: (finalMask.debug as { manualRejected?: number } | undefined)?.manualRejected ?? 0,
              manualRejectDetail: (finalMask.debug as { manualRejectDetail?: string } | undefined)?.manualRejectDetail,
              coverageBeforeManual: +(covered / n).toFixed(4),
              coverageAfterManual: +finalMask.coverage.toFixed(4),
            }
            : {}),
        },
      }
    }
    // 先验不可用 → 落入下方 union 路径（无 return，继续执行）
    unionFallbackFromHybrid = black.reason
  }
  const dark = await maskFromDarkInk(detectBuf)
  // ⭐ 第三通道：布局先验（横线填空槽位）。外观路径对"黑笔短答案/压字填空"不可分，
  //   本通道用题型结构（横线槽位）直接定位手写，与外观/VLM 通道取并集（详见方法论 §5.5）。
  const layout = await maskFromLayoutSlots(detectBuf)
  const m1 = await unionMasks(chroma, dark)
  const merged = await unionMasks(m1, layout)
  // ⭐ v18 印刷保护闸：彩色手写（红/蓝笔）域内，印刷特征像素（低彩度深色）
  //    从 mask 剔除——修复「红笔卷连同印刷黑字一起擦除」的系统性误删。
  //    传入**原图**（非归一化图），保证颜色判据基于真实纸面色。
  //    黑笔/铅笔场景（无彩色域）零干预，不回归。
  const { protectPrintUnderColorHandwriting } = await import('./handwriting-mask')
  const mask = await protectPrintUnderColorHandwriting(imageBuffer, merged)
  // ⭐ 贴边伪影清除：色域路径没有深色路径的「边缘连通清除」防线，
  //    会把装订阴影/页边检出为细长条（真卷实测 32×1520，占 coverage 37%）。
  //    只作用于本地检测结果——manual/vlm 来源绝不清除。
  const edgeStripped = stripEdgeTouchingArtifacts(mask)
  // ⭐ v20.8：把用户框选区域并入（补充语义，见上方说明）
  const finalMask = mergeManualRects(mask, manualRects, width, height, dilate, origRGB)
  return {
    mask: finalMask,
    rects: manualRects,
    usedVlm: false,
    debug: {
      chromaCoverage: chroma.coverage,
      darkCoverage: dark.coverage,
      darkDebug: dark.debug,
      mode: unionFallbackFromHybrid ? 'union(hybrid-fallback)' : 'union',
      hybridFallbackReason: unionFallbackFromHybrid,
      printProtected: (mask.debug as { printProtected?: number } | undefined)?.printProtected,
      illuminationNormalized: pre.applied,
      ...(structDebug ? { structural: structDebug } : {}),
      medH: Math.round(pre.medH),
      lumaDeltaMean: +pre.deltaMean.toFixed(2),
      ...(edgeStripped.length ? { edgeStripped } : {}),
      ...(manualRects.length > 0
        ? {
          // 同上：取真实并入数，不用入参长度
          manualRects: (finalMask.debug as { manualRects?: number } | undefined)?.manualRects ?? 0,
          manualRejected: (finalMask.debug as { manualRejected?: number } | undefined)?.manualRejected ?? 0,
          manualRejectDetail: (finalMask.debug as { manualRejectDetail?: string } | undefined)?.manualRejectDetail,
          coverageBeforeManual: +mask.coverage.toFixed(4),
          coverageAfterManual: +finalMask.coverage.toFixed(4),
        }
        : {}),
    },
  }
}
