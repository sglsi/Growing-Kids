/**
 * 错题区域提取 · 编排器（路径 B：VLM 出题块粗框 + 本地证据校验收紧）
 *
 * 流水线：①版面上下文(三栏+栏内行) → ③红笔标记 → ②④题块构建 → ⑤判定/融合 → ⑥裁图
 *
 * ⚠️ VLM 状态：本环境凭证未配置，调用 fail-open 返回 used=false，
 *    全流程由本地证据层独立产出（blocks.source='local'，confidence 刻意压低 + 提示语）。
 *    配置了 COZE_API_TOKEN 后，只需传 imageUrl（公网可达）即自动启用融合。
 */
import { buildLayoutContext, type LayoutContext } from './wrongq-layout'
import { detectRedMarks } from './wrongq-mark'
import { buildBlocks } from './wrongq-block'
import { decideLocal, fuseVlm } from './wrongq-decide'
import { vlmQuestionBlocks } from './wrongq-vlm'
import type { WrongqOptions, WrongqPageResult } from './wrongq.types'

export async function extractWrongQuestions(
  buf: Buffer,
  opts: WrongqOptions = {},
  /** 已构建好的版面上下文（服务层产裁图时复用，避免重复 straighten） */
  prebuiltCtx?: LayoutContext,
): Promise<WrongqPageResult> {
  const ctx: LayoutContext = prebuiltCtx ?? (await buildLayoutContext(buf))
  const red = await detectRedMarks(ctx.flatBuf, ctx, { chromaMin: opts.chromaMin ?? 14 })
  const blocks = buildBlocks(red.marks, ctx)
  decideLocal(blocks, red.marks)

  let vlmUsed = false
  let vlmError: string | undefined
  if (opts.allowVlm && opts.imageUrl) {
    const r = await vlmQuestionBlocks(opts.imageUrl, blocks.length)
    vlmUsed = r.used
    vlmError = r.error
    if (r.used && r.items.length) fuseVlm(blocks, r.items, ctx.w, ctx.h)
  } else if (opts.allowVlm && !opts.imageUrl) {
    vlmError = '未提供公网可访问的 imageUrl（VLM 仅接受 URL）'
  }

  return {
    medH: +ctx.medH.toFixed(1),
    cols: ctx.cols,
    marks: red.marks,
    blocks,
    vlmUsed,
    vlmError,
    debug: {
      inkRatio: +ctx.inkRatio.toFixed(4),
      furnitureCount: red.furnitureCount,
      redCoverage: +red.coverage.toFixed(4),
      colRowCounts: ctx.colRows.map((r) => r.length),
    },
  }
}

export { buildLayoutContext }
export type { LayoutContext }
