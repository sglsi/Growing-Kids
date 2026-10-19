/**
 * 错题区域提取 · 编排器（路径 B：VLM 出题块粗框 + 本地证据校验收紧）
 *
 * 流水线：①版面上下文(三栏+栏内行) → ③红笔标记 → ②④题块构建 → ⑤判定/融合 → ⑥裁图
 *
 * 判定内核双路径（#128 P0 重建 / #129 P1 结构加固）：
 *   - **单元优先路径**（有全页 OCR → 有题目单元）：红墨分组 → 订正词判别 →
 *     题号锚点评分归属 → 仅"有订正词证据的单元"产 wrong 块（wrongq-evidence）。
 *     单元切分经 analyzeQuestionUnits（#129）：大节/小类区间树 + 编号规则 +
 *     序列自纠，两节编号不串扰、缺号/误读/重号清零。
 *     替代 v6「有书写簇即判错」（对勾链聚成簇误判、订正词并进巨簇漏报，
 *     实测基线正面 4/5、背面 0/3）。
 *   - **簇兜底路径**（无 OCR，如离线脚本）：保持 v6 行为（书写簇建块 + decideLocal），
 *     供报纸密排等无题号版面与回归对照。
 *
 * ⚠️ VLM 状态：本环境凭证未配置，调用 fail-open 返回 used=false，
 *    全流程由本地证据层独立产出（blocks.source='local'，confidence 刻意压低 + 提示语）。
 *    配置了 COZE_API_TOKEN 后，只需传 imageUrl（公网可达）即自动启用融合。
 */
import { buildLayoutContext, type LayoutContext } from './wrongq-layout'
import { detectRedMarks, groupWritingClusters } from './wrongq-mark'
import { buildBlocks } from './wrongq-block'
import { analyzeQuestionUnits } from './wrongq-structure'
import { buildEvidenceBlocks } from './wrongq-evidence'
import { decideLocal, fuseVlm } from './wrongq-decide'
import { vlmQuestionBlocks } from './wrongq-vlm'
import type { WrongqOptions, WrongqPageResult, WrongqBlock } from './wrongq.types'
import type { LocalOcrTextRegion } from '../ocr/ocr.types'

export async function extractWrongQuestions(
  buf: Buffer,
  opts: WrongqOptions = {},
  /** 已构建好的版面上下文（服务层产裁图时复用，避免重复 straighten） */
  prebuiltCtx?: LayoutContext,
  /**
   * 阶段 A 输入：全页 OCR 的 text_regions（侧车返回，坐标须处于 ctx.flatBuf 像素空间）。
   * 提供则先做"题号定界的整题框"切分，供阶段 B 把红笔锚点映射到整题满框；
   * 不提供（如离线测试脚本）则回落到行对齐紧框兜底（旧行为）。
   */
  regions?: LocalOcrTextRegion[],
  /**
   * ②（#141）结构增强输入：3.x 版面模型（PP-StructureV3）的标题类块
   * （paragraph_title/doc_title/header）。与 regions 同坐标系（原图/ctx.flatBuf 空间）。
   * 提供则 analyzeQuestionUnits 以保守融合（只增不删）补出文本规则识别不了的
   * 大节/小类标题（英语作业册 "Unit1…"/"Section B…" 实测全空，见 #141）。
   * 不提供则走纯文本规则路径（旧行为，零回归）。
   */
  layoutBlocks?: Array<{ type: string; box: number[]; text?: string }>,
): Promise<WrongqPageResult> {
  const ctx: LayoutContext = prebuiltCtx ?? (await buildLayoutContext(buf))
  const red = await detectRedMarks(ctx.flatBuf, ctx, { chromaMin: opts.chromaMin ?? 14 })
  // 语义层：邻近红笔笔画聚成"书写簇"（簇兜底路径的锚点；单元优先路径不使用）。
  // 仍算入返回值以保持 API 形状不变（debug/回归对照可用）。
  const clusters = groupWritingClusters(red.marks, ctx.medH, {
    gapRatio: opts.clusterGap ?? 0.5,
    minParts: opts.clusterMinParts ?? 3,
    minInkRatio: opts.clusterMinInk ?? 0.8,
  })
  // 阶段 A：用全页 OCR 的题号行切出题目单元（整题满框）。
  // P1（#129）：走 analyzeQuestionUnits——大节/小类区间树 + 编号规则判定 +
  // 序列自纠（罗马标题防伪单元、缺号补认、误读修正），二遍重切保证注入单元
  // 的盒与锚点由同一套平铺逻辑产出。无 OCR 时回落簇兜底路径（不变）。
  // ②（#141）：layoutBlocks（3.x 版面标题块）作结构层先验传入，保守融合。
  const analyzed =
    regions && regions.length ? analyzeQuestionUnits(ctx, regions, layoutBlocks) : undefined
  const units = analyzed?.units
  // 阶段 B：判定内核二选一（#128）
  //   - 有单元 → 单元优先：仅订正词证据产 wrong 块（P0 主路径）
  //   - 无单元 → v6 簇兜底：书写簇建块 + decideLocal（无 OCR 场景）
  let blocks: WrongqBlock[]
  if (units && units.length) {
    blocks = buildEvidenceBlocks(red.marks, units, ctx, ctx.medH, analyzed?.structure)
  } else {
    blocks = buildBlocks(red.marks, ctx, opts.mergeIoU ?? 0.85, clusters, undefined)
    // 传入 medH 以启用"批阅符号尺寸闸门"，过滤红笔连笔被拆出的碎片
    decideLocal(blocks, red.marks, ctx.medH, clusters)
  }

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
