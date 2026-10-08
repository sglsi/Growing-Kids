/**
 * 错题区域提取 · ⑥ 裁图产物渲染（raw / enhanced / clean）
 *
 * ⚠️ 两条沿用前期教训的硬约束：
 *  1. `clean` **强制 `eraseMode:'color'`**——《去手写功能-方法论与技术方案.md》§5.12 用
 *     "误删大量印刷内容"的代价换来的结论：错题裁图里既有学生黑笔作答又有教师红笔批改，
 *     union 模式的深色通道会连带吞掉印刷题干；color 模式误删降低 52%~99%。
 *  2. **小图增强必须降级**——`enhanceImage` 依赖 `estimateCharMetrics`，裁图只有一两行字时
 *     medH 度量会失败，参数错误会把图糊掉。短边 < 8×medH 或像素 < 20000 时跳过增强，
 *     宁可少一份产物，也不交付一张被错误参数毁掉的图。
 */
import sharp from 'sharp'
import { enhanceImage } from './image-superres'
import { detectMonoSource } from './image-doc-enhance'
import { inpaint, blendWithMask } from './handwriting-mask'
import { buildHandwritingMask } from './handwriting-segmenter'
import type { LayoutContext } from './wrongq-layout'
import type { WrongqBlock } from './wrongq.types'

export interface BlockAssets {
  raw: Buffer
  enhanced?: Buffer
  clean?: Buffer
  /** 降级说明（没产出的产物写明原因） */
  notes: string[]
}

export async function renderBlockAssets(
  flatBuf: Buffer,
  block: WrongqBlock,
  ctx: LayoutContext,
): Promise<BlockAssets> {
  const notes: string[] = []
  const { x0, y0, x1, y1 } = block.box
  const w = Math.max(1, x1 - x0 + 1)
  const h = Math.max(1, y1 - y0 + 1)
  const raw = await sharp(flatBuf).extract({ left: x0, top: y0, width: w, height: h }).png().toBuffer()

  const minSide = Math.min(w, h)
  const bigEnough = minSide >= 8 * ctx.medH && w * h >= 20000

  let enhanced: Buffer | undefined
  if (bigEnough) {
    try {
      const mono = await detectMonoSource(raw)
      const preset = mono.isMono ? 'bw' : 'enhance'
      const sr = await enhanceImage(raw, { preset, scale: 2 })
      enhanced = sr.buffer ?? undefined
      if (!enhanced) notes.push('enhanced: 增强未返回产物')
    } catch (e) {
      notes.push(`enhanced: 跳过（${String((e as Error)?.message ?? e).slice(0, 80)}）`)
    }
  } else {
    notes.push(`enhanced: 跳过（裁图过小 ${w}×${h}，短边需 ≥ ${Math.round(8 * ctx.medH)}px）`)
  }

  let clean: Buffer | undefined
  try {
    const seg = await buildHandwritingMask(raw, '', {}, { allowVlm: false, eraseMode: 'color' })
    const repaired = await inpaint(raw, 'adaptive', seg.mask)
    clean = await blendWithMask(raw, repaired, seg.mask)
  } catch (e) {
    notes.push(`clean: 失败（${String((e as Error)?.message ?? e).slice(0, 80)}）`)
  }

  return { raw, enhanced, clean, notes }
}
