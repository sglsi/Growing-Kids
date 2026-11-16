/**
 * P-034 扩展 / D-075：题干 `[图N]` 切段（服务端共用，零依赖）。
 *
 * 导出链（document.service A / pdf.service B）要把题干里的内嵌图**原位**嵌回文档，
 * 而不是像 question_images 那样统一后置。本函数把题干切成 text / figure 段序列，
 * 两条链各自把 figure 段的 ref 映射成 docx ImageRun：
 *   - A 链 resolve 返回 storage key（走 readObject 直读，避开 local 回环 404）；
 *   - B 链 resolve 返回签名 URL（listByIdsWithUrls 已带 question_inline_figure_urls）。
 *
 * 🔴 fail-closed（与 D-020 / D-074 同口径）：
 *   - 标记找不到对应槽位 / resolve 不给 ref ⇒ 该标记原样输出成 `[图N]` 文字，
 *     **绝不猜图、不拿邻图顶替**（错图比没图更糟）；
 *   - 只认 `[图N]` 全等标记，不吞 `[图10]` 的前缀；
 *   - 零依赖单文件，便于 dynamic-tests 用 tsc 转译后真实执行。
 *
 * 注意：本函数不改变 answer_cache 的 result 结构、不碰 question-match.ts，
 * 因此不触发 CACHE_VERSION bump（v17 不变）。
 */

export type InlineRun =
  | { kind: 'text'; text: string }
  | { kind: 'figure'; slot: number; ref: string }

/**
 * @param text  题干原文（含 `[图N]`）
 * @param resolve 槽位 → 图片引用（storage key 或签名 URL）；空串/undefined = 该槽位降级
 */
export function splitQuestionRuns(
  text: string,
  resolve: (slot: number) => string | undefined,
): InlineRun[] {
  const runs: InlineRun[] = []
  const src = String(text ?? '')
  const re = /\[图(\d+)\]/g
  let last = 0
  let m: RegExpExecArray | null
  const pushText = (s: string) => {
    if (!s) return
    const prev = runs[runs.length - 1]
    if (prev && prev.kind === 'text') prev.text += s
    else runs.push({ kind: 'text', text: s })
  }
  while ((m = re.exec(src)) !== null) {
    pushText(src.slice(last, m.index))
    const slot = Number(m[1])
    const ref = resolve(slot)
    if (ref) runs.push({ kind: 'figure', slot, ref })
    else pushText(m[0]) // fail-closed：无图就把标记原样留在文字里
    last = m.index + m[0].length
  }
  pushText(src.slice(last))
  return runs
}

/** 题干是否含内嵌图标记（供导出链决定要不要走切段路径） */
export function hasInlineFigure(text: string): boolean {
  return /\[图\d+\]/.test(String(text ?? ''))
}
