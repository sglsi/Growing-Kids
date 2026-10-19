/**
 * 错因区域语义分离（P1-9）
 * ------------------------------------------------------------------
 * P0 落库时 `wrong_answer` 恒为空串、`stem` 直接等于区域全文（技术文档 §2.7 局限 ①⑦），
 * 原因是"一个切块内的题干 / 学生作答 / 教师批改揉在同一段 OCR 文本里，没法分"。
 *
 * 本模块用**颜色 + OCR 置信度**两条廉价证据把它们分开，全程本地规则、零大模型：
 *
 *   ① 彩色笔迹检测：复用已标定的 `maskFromColorThreshold`（就是去手写那条通道），
 *      一次性对整张路面图层出"非黑笔"掩膜，**不对每个切块重复跑**（N 块 → 1 次）；
 *   ② 红黑判别：对掩膜命中的像素统计 `R - max(G,B)` 的均值，超过阈值即判为红笔；
 *      - 彩色 & 偏红  → **教师批改/订正**（红笔是批改通道的强先验）；
 *      - 彩色 & 非红  → **学生作答**（蓝/黑水性笔写答案）；
 *   ③ 高清体表 suppress：非彩色且 OCR 置信度高 → **印刷题干**。
 *
 * ⚠️ 刻意保守 —— `question_content` **保持区域全文不变**，只把分离出来的信息
 *    **增量**填进 `stem` / `wrong_answer` / `solution`：
 *      · question_content = 全文（不丢信息，用户仍可在前端编辑）
 *      · stem            = 纯净印刷题干（用于列表搜索与展示）
 *      · wrong_answer    = 学生作答文本
 *      · solution        = 教师红笔订正文本（有实质内容才填）
 *    宁可分离不干净让用户在前端改，也不能因为激进裁剪把题干内容删掉。
 */
import sharp from 'sharp'
import { maskFromColorThreshold } from '../image/handwriting-mask'
import type { LocalOcrTextRegion } from './ocr.types'

/** 单个文本区域的色彩分类证据 */
export interface RegionColorEvidence {
  /** 该区域内彩色笔迹像素占比 [0,1] */
  colorRatio: number
  /** 彩色像素的平均 "红度" = R - max(G,B)，非彩色区域为 0 */
  redness: number
  /** 判定结果 */
  kind: 'print' | 'handwriting' | 'red-mark'
}

export interface BlockSemantics {
  /** 印刷题干（剔除彩色笔迹行） */
  stem: string
  /** 学生手写作答 */
  wrongAnswer: string
  /** 教师红笔订正 / 批改文字 */
  correction: string
  /** 是否真的分出了东西（false 表示整块都是印刷体，无作答无批改） */
  separated: boolean
  /** 诊断：各类行计数 */
  counts: { print: number; handwriting: number; red: number }
}

export interface SemanticsOptions {
  /** 色域彩度阈值（与 detectRedMarks 一致的 14：再高会漏细红笔） */
  chromaMin?: number
  /** 判定为"该行是彩色笔迹"所需的最低彩色像素占比 */
  colorRatioMin?: number
  /** 判定为红笔所需的平均红度 */
  rednessMin?: number
  /** 低于此 OCR 置信度且非彩色 → 疑似手写（手写字识别置信度通常明显偏低） */
  lowScoreMax?: number
}

const DEFAULTS = {
  chromaMin: 14,
  colorRatioMin: 0.12,
  rednessMin: 18,
  lowScoreMax: 0.75,
}

function regionBox(r: LocalOcrTextRegion) {
  const [a, b, c, d] = r.box || [0, 0, 0, 0]
  return {
    x0: Math.max(0, Math.min(a, c)),
    y0: Math.max(0, Math.min(b, d)),
    x1: Math.max(a, c),
    y1: Math.max(b, d),
  }
}

/**
 * 对一张图**整幅**出一次彩色笔迹掩膜 + RGB，供该图所有切块复用。
 * 返回 null 表示这张图整体色偏（不属于笔迹），此时只能退化为"全是印刷体"。
 */
export async function buildColorEvidenceSource(
  imgBuf: Buffer,
  opts: SemanticsOptions = {},
): Promise<{ rgb: Buffer; channels: number; width: number; height: number; mask: Buffer | null; coverage: number } | null> {
  const o = { ...DEFAULTS, ...opts }
  try {
    const { data, info } = await sharp(imgBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const cm = await maskFromColorThreshold(imgBuf, {
      chromaMin: o.chromaMin,
      // 默认 maxCoverage=0.15 是"去手写"场景的取值（宁可不擦也不能擦坏）；
      // 此处只做分类，整页大面积涂色也应算笔迹，故放宽到 0.35。
      // 真被护栏拦下时 mask 为空 → 退化为"全是印刷体"，安全。
      maxCoverage: 0.35,
    })
    return {
      rgb: data,
      channels: info.channels,
      width: info.width,
      height: info.height,
      mask: cm.coverage > 0 ? cm.data : null,
      coverage: cm.coverage,
    }
  } catch (e) {
    console.warn('[semantic] 彩色笔迹掩膜构建失败，退化为全部印刷体：', (e as Error)?.message ?? e)
    return null
  }
}

/** 计算单个文本区域的色彩证据 */
export function regionColorEvidence(
  src: { rgb: Buffer; channels: number; width: number; height: number; mask: Buffer | null },
  region: LocalOcrTextRegion,
  opts: SemanticsOptions = {},
): RegionColorEvidence {
  const o = { ...DEFAULTS, ...opts }
  const { rgb, channels, width, height, mask } = src
  const b = regionBox(region)
  const x0 = Math.max(0, Math.min(b.x0, width - 1))
  const x1 = Math.max(x0, Math.min(b.x1, width - 1))
  const y0 = Math.max(0, Math.min(b.y0, height - 1))
  const y1 = Math.max(y0, Math.min(b.y1, height - 1))

  if (!mask) return { colorRatio: 0, redness: 0, kind: 'print' }

  let total = 0
  let colored = 0
  let rednessSum = 0
  for (let y = y0; y <= y1; y++) {
    const rowBase = y * width
    const rowPx = y * width * channels
    for (let x = x0; x <= x1; x++) {
      total++
      if (!mask[rowBase + x]) continue
      colored++
      const p = rowPx + x * channels
      const r = rgb[p]
      const g = rgb[p + 1]
      const bl = rgb[p + 2]
      rednessSum += r - Math.max(g, bl)
    }
  }
  if (!total) return { colorRatio: 0, redness: 0, kind: 'print' }
  const colorRatio = colored / total
  const redness = colored > 0 ? rednessSum / colored : 0

  let kind: RegionColorEvidence['kind'] = 'print'
  if (colorRatio >= o.colorRatioMin) kind = redness >= o.rednessMin ? 'red-mark' : 'handwriting'
  return { colorRatio, redness, kind }
}

/**
 * 把一个切块内的若干文本区域，按 "印刷 / 手写 / 红笔" 分离成三段文本。
 *
 * @param src    `buildColorEvidenceSource` 的产物（整幅共享）
 * @param regions 落在该切块内的文本区域（绝对坐标）
 */
export function splitBlockRegions(
  src: { rgb: Buffer; channels: number; width: number; height: number; mask: Buffer | null } | null,
  regions: LocalOcrTextRegion[],
  opts: SemanticsOptions = {},
): BlockSemantics {
  const o = { ...DEFAULTS, ...opts }
  const printLines: string[] = []
  const handLines: string[] = []
  const redLines: string[] = []
  const counts = { print: 0, handwriting: 0, red: 0 }

  const ordered = [...regions].sort((a, b) => {
    const A = regionBox(a)
    const B = regionBox(b)
    if (Math.abs(A.y0 - B.y0) > 8) return A.y0 - B.y0
    return A.x0 - B.x0
  })

  for (const r of ordered) {
    const text = (r.text || '').trim()
    if (!text) continue
    let kind: RegionColorEvidence['kind'] = 'print'
    if (src) {
      const ev = regionColorEvidence(src, r, o)
      if (ev.kind === 'handwriting' || ev.kind === 'red-mark') {
        kind = ev.kind
      } else if (typeof r.score === 'number' && r.score < o.lowScoreMax) {
        // 非彩色但 OCR 明显没把握：写字大题场景里大概率是学生笔迹
        //（印刷体识别置信度通常 ≥0.9，手写会掉到 0.6~0.8）
        kind = 'handwriting'
      }
    }
    if (kind === 'red-mark') { redLines.push(text); counts.red++ }
    else if (kind === 'handwriting') { handLines.push(text); counts.handwriting++ }
    else { printLines.push(text); counts.print++ }
  }

  const stem = printLines.join('\n').trim()
  const wrongAnswer = handLines.join('\n').trim()
  const correction = redLines.join('\n').trim()

  return {
    stem,
    wrongAnswer,
    correction,
    separated: (wrongAnswer.length > 0 || correction.length > 0) && stem.length > 0,
    counts,
  }
}
