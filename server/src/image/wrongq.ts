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
import { detectRedMarks, groupWritingClusters } from './wrongq-mark'
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
  // 语义层：邻近红笔笔画聚成"书写簇"= 教师手写订正处（判定与切块的新锚点）
  const clusters = groupWritingClusters(red.marks, ctx.medH, {
    gapRatio: opts.clusterGap ?? 0.5,
    minParts: opts.clusterMinParts ?? 3,
    minInkRatio: opts.clusterMinInk ?? 0.8,
  })
  // mergeIoU：收敛同列内纵向高度重叠的重复块（默认 0.85；opts 显式传 0 可关闭做回归对照）
  const blocks = buildBlocks(red.marks, ctx, opts.mergeIoU ?? 0.85, clusters)
  // 传入 medH 以启用"批阅符号尺寸闸门"，过滤红笔连笔被拆出的碎片
  decideLocal(blocks, red.marks, ctx.medH, clusters)

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
    clusters,
    blocks,
    vlmUsed,
    vlmError,
    debug: {
      inkRatio: +ctx.inkRatio.toFixed(4),
      furnitureCount: red.furnitureCount,
      redCoverage: +red.coverage.toFixed(4),
      colRowCounts: ctx.colRows.map((r) => r.length),
      orientSuspect: ctx.orientSuspect === true,
      orientMethod: ctx.orientMethod,
    },
  }
}

export { buildLayoutContext }
export type { LayoutContext }
