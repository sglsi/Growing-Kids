import { BadRequestException } from '@nestjs/common'
import type { QuotaService } from '../quota/quota.service'
import type { WrongqBlock } from './wrongq.types'

/**
 * ⑧ 单次错题提取的切块数硬上限：防止失控的 N 块 ingest 打爆存储/配额（技术文档 §2.7 ⑧）
 */
export const MAX_EXTRACT_BLOCKS = 60

/** 按"切块总面积占原图比例"估算总入库字节，再加每块约 1KB 的 PNG 头开销 */
export function estimateIngestBytes(
  blocks: WrongqBlock[],
  srcBuffer: Buffer,
  ctx: { w: number; h: number },
): number {
  const srcArea = ctx.w * ctx.h
  const blockArea = blocks.reduce(
    (s, b) => s + (b.box.x1 - b.box.x0 + 1) * (b.box.y1 - b.box.y0 + 1),
    0,
  )
  const areaRatio = srcArea > 0 ? Math.min(1, blockArea / srcArea) : 1
  return Math.ceil(srcBuffer.length * areaRatio) + blocks.length * 1024
}

/**
 * ⑧ 配额预检 + 切块数上限（技术文档 §2.7 ⑧）。
 *
 * 此前逐块 `ingest` 走 `IngestService.ingest`，完全绕过 `upload.controller` 的 `checkUpload`，
 * 导致 `QUOTA_MODE=block` 时切块入库仍不拦截。此处入库前补一次预检：
 * 仅当 block 模式且已超限才真正拦截（其余模式 `checkUpload` 内部只记日志，与上传行为一致）。
 *
 * 设计取舍（契合"尽量不依赖大模型"原则，纯本地、零外部依赖）：
 *  - 不引入新的外部调用；`checkUpload` 在 off/shadow/warn 下不阻断，只有 block 才硬拦。
 *  - 块数上限兜底，避免极端情况下 N 块串行 ingest 把存储/配额打爆。
 */
export async function guardExtractQuota(params: {
  blocksToUse: WrongqBlock[]
  srcBuffer: Buffer
  ctx: { w: number; h: number }
  userId: string
  quotaService: QuotaService
}): Promise<{ mode: string; allowed: boolean; estIngestBytes: number }> {
  if (params.blocksToUse.length > MAX_EXTRACT_BLOCKS) {
    throw new BadRequestException(
      `单次错题提取最多切 ${MAX_EXTRACT_BLOCKS} 块，当前 ${params.blocksToUse.length} 块；` +
      `请拆成多张图片分别提取。`,
    )
  }
  const estIngestBytes = estimateIngestBytes(params.blocksToUse, params.srcBuffer, params.ctx)
  const decision = await params.quotaService.checkUpload(params.userId, estIngestBytes)
  if (!decision.allowed) {
    throw new BadRequestException(
      `错题提取超出存储配额（${decision.code}）：已用 ` +
      `${decision.usage.usedBytes}/${decision.usage.quotaBytes} 字节，` +
      `请清理后重试或联系管理员提升配额。`,
    )
  }
  return { mode: decision.mode, allowed: decision.allowed, estIngestBytes }
}
