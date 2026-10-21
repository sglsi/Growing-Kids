/**
 * erase-mask-policy.ts —— 最终擦除 mask 的合成策略（v21.5 · 疑罪从无）
 * ==========================================================================
 * 背景（用户 2026-10-06 质询）：「当前主要功能就是去手写，那擦除只应该擦除被明确
 * 检测为手写的部分，有疑虑的部分就应该被保留」。本模块把这条产品原则落成代码。
 *
 * 词级判别器给每个词打三态：`0=印刷 / 1=手写 / 2=疑虑`。
 *   · 只有 state===1（确信手写）才进最终 mask；
 *   · state===0（印刷）与 state===2（疑虑）一律丢弃 —— **疑罪从无**。
 *
 * 两种策略：
 *   - `word`（缺省默认）：最终 mask = 词通道确信手写。
 *     端到端实测（4 卷 / 44 手写框 / 16 插图框）：
 *       擦净 34/44(77%) ｜ 插图受损 6/16 ｜ 框外改动 90,881px   ← 框外损伤最低
 *   - `union_generic`（备选，用户可选）：hybrid 经**颜色无关印刷保护**
 *     （`protectPrintGeneric`，不依赖彩色笔，修掉旧 protectPrint 在黑笔场景的 no-op）
 *     后 ∪ 词通道确信手写。
 *       擦净 37/44(84%) ｜ 插图受损 7/16 ｜ 框外改动 95,783px   ← 召回更高
 *
 * ⚠️ 回滚：本模块是纯函数 + 单一接入点（`image.service.eraseV2`），
 *    删掉调用即回到旧 hybrid 行为，不牵动其他消费方。
 */
import sharp from 'sharp'
import { buildDocContext } from './adaptive-stats'
import { discriminateWords } from './word-level-discriminator'
import { protectPrintGeneric, type HandwritingMask } from './handwriting-mask'

export type ErasePolicy = 'word' | 'union_generic'

/** 把可能处于工作尺度的 mask 对齐到原图尺度（与 handwriting-mask 内 alignMask 同口径） */
async function alignToFull(
  data: Buffer, mw: number, mh: number, W: number, H: number,
): Promise<Buffer> {
  if (mw === W && mh === H) return data
  const out = await sharp(data, { raw: { width: mw, height: mh, channels: 1 } })
    .resize(W, H, { fit: 'fill' })
    .raw()
    .toBuffer()
  return Buffer.from(out)
}

/**
 * 按策略合成最终擦除 mask。
 * @param srcBuf   原图（PNG buffer）
 * @param baseMask 上游 `buildHandwritingMask` 产出的基础 mask（hybrid/color/union）
 * @param policy   'word' = 只擦确信手写；'union_generic' = 印刷保护后的 hybrid ∪ 确信手写
 */
export async function buildEraseMask(
  srcBuf: Buffer,
  baseMask: HandwritingMask,
  policy: ErasePolicy,
): Promise<HandwritingMask> {
  const meta = await sharp(srcBuf).metadata()
  const W = meta.width, H = meta.height
  if (!W || !H) return baseMask

  // ① 词级判别器：整词三态。只有 state===1 进 mask（疑罪从无）
  //    P0-5e 作用域隔离：仅本路径启用修正字高标尺（FIX+COORD+K=4），
  //    修正后的 charH 让图形域闸门 / 行切分 / Sauvola 窗口全部落到正确尺度，
  //    其余全局消费方仍走旧标尺（G13 门禁不倒退）。
  const ctx = await buildDocContext(srcBuf, { width: W, height: H, isGray: false }, { charHFix: true })
  const wres = discriminateWords({ ctx })
  const s = ctx.work.w / W
  const wl = new Uint8Array(W * H)
  for (let y = 0; y < ctx.work.h; y++) {
    const oy0 = Math.floor(y / s), oy1 = Math.min(H - 1, Math.floor((y + 1) / s))
    for (let x = 0; x < ctx.work.w; x++) {
      if (wres.labels[y * ctx.work.w + x] !== 1) continue
      const ox0 = Math.floor(x / s), ox1 = Math.min(W - 1, Math.floor((x + 1) / s))
      for (let oy = oy0; oy <= oy1; oy++) for (let ox = ox0; ox <= ox1; ox++) wl[oy * W + ox] = 1
    }
  }
  const charH = Number(wres.debug.charH) || 0

  // ② 合成
  const data = Buffer.alloc(W * H)
  let covered = 0
  let protectedPx = 0
  if (policy === 'word') {
    for (let i = 0; i < W * H; i++) if (wl[i]) { data[i] = 255; covered++ }
  } else {
    // union_generic：先对 hybrid 做颜色无关印刷保护，再 ∪ 词通道确信手写
    const prot = await protectPrintGeneric(srcBuf, baseMask, { charH })
    protectedPx = Number(prot.debug?.printGenericProtected ?? 0) || 0
    const base = await alignToFull(prot.data, prot.width, prot.height, W, H)
    for (let i = 0; i < W * H; i++) {
      if (base[i] > 127 || wl[i]) { data[i] = 255; covered++ }
    }
  }

  return {
    ...baseMask,
    width: W,
    height: H,
    data,
    coverage: covered / (W * H),
    source: policy,
    debug: {
      ...(baseMask.debug ?? {}),
      erasePolicy: policy,
      wordCharH: charH,
      wordStates: wres.debug.wordStateCount,
      mixedPrintProtected: wres.debug.mixedPrintProtected,
      printGenericProtected: protectedPx,
      note: 'v21.5 疑罪从无：仅擦词级 state===1（确信手写），印刷/疑虑一律保留',
    },
  }
}
