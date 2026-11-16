/**
 * P-034 / D-074（题干图文混排）：把题干文本里的 `[图N]` 占位符换成真图，
 * 产出 rich-text 组件可直接吃的 HTML。**零依赖单文件**（与 question-locate.ts 同口径），
 * 便于后端断言与 dynamic-tests 用 tsc 转译后真实执行。
 *
 * 背景（为什么是占位符而不是富文本编辑器）：
 *   微信 `<textarea>` 是原生组件，框内塞不了 `<img>`。所以编辑态保留可见的 `[图N]` 文本，
 *   展示态用本函数把标记换成图——既不碰已修好的光标补丁，又能做到图文穿插。
 *
 * 安全/降级（fail-closed，与 D-020「错图比没图更糟」同口径）：
 *   - `[图N]` 找不到对应 slot 或没有 URL ⇒ 原样显示 `[图N]` 文字，**绝不猜图、不拿邻图顶替**；
 *   - 题干里的 `<` `&` `"` 先转义，不能破坏 rich-text 节点树；
 *   - URL 里的引号/空白剥掉，避免属性注入。
 */

export interface InlineFigForRender {
  slot: number
  /** 签名后的可匿名 GET URL；缺省/空 = 该槽位降级成文字 */
  url?: string
}

/** rich-text 节点的 HTML 转义（与 answer-editor 的 escapeHtml 同口径） */
export function escapeRichHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br/>')
}

/**
 * 把题干文本里的 `[图N]` 换成 `<img>`，产出 rich-text 可直接吃的 HTML。
 * @param text 题干原文（含 `[图N]` 标记）
 * @param figs 内嵌图列表（slot + url）；同 slot 取第一个有 url 的
 */
export function questionRichHtml(text: string, figs: InlineFigForRender[]): string {
  const urlBySlot = new Map<number, string>()
  for (const f of figs || []) {
    if (f?.url && !urlBySlot.has(f.slot)) urlBySlot.set(f.slot, f.url)
  }
  const re = /\[图(\d+)\]/g
  const src = String(text ?? '')
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    out += escapeRichHtml(src.slice(last, m.index))
    const url = urlBySlot.get(Number(m[1]))
    out += url
      ? `<img src="${url.replace(/"/g, '%22').replace(/\s/g, '')}" style="display:block;max-width:100%;margin:8px 0;" />`
      : escapeRichHtml(m[0])
    last = m.index + m[0].length
  }
  out += escapeRichHtml(src.slice(last))
  return out
}

/** 题干是否含内嵌图标记（用于 UI 决定要不要渲染预览区） */
export function hasFigureMarker(text: string): boolean {
  return /\[图\d+\]/.test(String(text ?? ''))
}

/**
 * 删掉某个 slot 的标记（家长点「移除图N」时用）。
 * 只删 `[图N]` 全等匹配，不动其它文字、不误删 `[图1]` 之外的 `[图10]`（锚点带完整数字）。
 */
export function removeFigureMarker(text: string, slot: number): string {
  return String(text ?? '').split(`[图${slot}]`).join('')
}
