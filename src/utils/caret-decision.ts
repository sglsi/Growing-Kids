/**
 * 光标决策（零 import 纯函数，由 `utils/use-caret.ts` 调用）
 *
 * ## 版本史：同一个 bug 连报四次，方向换了三次
 * 1. 2026-10-26：逐字绑定 cursor 想"钉住" ⇒ 拽走输入法组词光标；
 * 2. 2026-10-31：撤销一次性定位时落回 -1 ⇒ -1 的语义是"置于末尾"，逗号跳末尾；
 * 3. 2026-10-31：改成"删除时才补 cursor" ⇒ 标点、连续删除照样跳（判断错了）；
 * 4. 2026-10-31（本版）：承认"把 cursor 钉准"这条路走不通 ——
 *    **输入期间根本不下发 value**，让原生组件自己管文本和光标。
 *
 * ## 平台事实（社区 + 官方文档 + 本项目四次事故，口径一致）
 * - 小程序 textarea 是半受控组件：**setData 里只要出现 value，渲染层就把光标重置到末尾**。
 *   而受控 `value` 的更新是一条跨帧链（onInput → setState → 渲染 → setData），
 *   连续操作时回写值几乎必然与原生当前文本不一致 ⇒ 每次回写都是一次"甩到末尾"的机会。
 *   （已核实：Taro 的 prepareUpdate 只 diff 出变化的属性，commitUpdate 只下发这些属性 ——
 *   所以"属性不变就不下发"是成立的，这正是本方案的立足点。）
 * - **`detail.cursor` 本身不可信**：在文本中间输入时它报告的就是错的值
 *   （社区实证："在文本中间输入文字后，cursor 就不对了"），标点/连续删除时尤甚。
 * - 官方文档对多行文本的原话：**不建议修改用户的输入**。
 *
 * ## 本版治法：回声吸收（实现在 `components/ui/textarea.tsx`）
 * 用户输入只更新页面 state，**不进 setData**（组件把回声吸收掉）；
 * 只有**程序化写入**（符号插入 / OCR 回填 / 清空）才放行 value，
 * 且与同时下发的 cursor 落进**同一批** setData —— 分两批时，
 * 后一批的 value 会把前一批定位好的光标重置到末尾（"插入符号后跳末尾"的成因之一）。
 *
 * ## 本函数剩下的职责
 * A. **输入事件 → 一律 null**：这次绝不下发 cursor（原生光标就是对的）；
 * B. **失焦事件 → 真实光标**：唯一还会写光标的时机，让重新聚焦落在用户离开的位置；
 * C. `diffCursor(prev, next)`：从两次文本的差值算真实插入点 —— **不信 detail.cursor**，
 *    供 useCaret 记录"数学符号该插在哪"（detail.cursor 说谎时插入点会跑偏）。
 */

/** 一次光标相关的事件类型：用户输入 / 输入框失焦 */
export type CaretEventKind = 'input' | 'blur'

/**
 * 从「上一次文本 → 这一次文本」的差值算出编辑后的真实光标位置。
 *
 * 为什么不直接用事件给的 `detail.cursor`：它在文本中间输入时本身不可信
 * （社区实证 + 本项目连续删除/标点跳末尾的表现）。文本差值是确定的：
 * 公共前缀之后、公共后缀之前那一截就是本次编辑发生的地方。
 *
 * @returns 编辑后的光标位置；`null` = 文本没变（纯光标移动，没有可推算的编辑）
 */
export function diffCursor(prev: string, next: string): number | null {
  if (prev === next) return null
  // 公共前缀
  let p = 0
  const min = Math.min(prev.length, next.length)
  while (p < min && prev.charCodeAt(p) === next.charCodeAt(p)) p++
  // 公共后缀（不与前缀交叠）
  let s = 0
  while (
    s < prev.length - p &&
    s < next.length - p &&
    prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)
  ) s++
  // 光标 = 前缀末尾 + 本次插入/替换进来的长度
  return p + (next.length - s - p)
}

/**
 * 决定这次事件之后 `cursor` 属性该取什么值。
 *
 * @param kind     'input' = 用户正在输入；'blur' = 输入框失焦
 * @param cursor   事件报告的光标位置（可能没有）
 * @param valueLen 当前文本长度（-1 = 未知，不钳制）
 * @returns 要写入的 cursor；`null` = 本次不要改（尤其不要写 -1）
 */
export function decideCursor(
  kind: CaretEventKind,
  cursor: number | undefined,
  valueLen = -1,
): number | null {
  // 规则 A（本版核心）：输入期间绝不下发 cursor。
  // 回声吸收之后原生文本根本不变、光标由平台自己维护，任何下发都是帮倒忙 ——
  // 写了可能把光标拽到（不可信的）detail.cursor 上，不写也绝不会被甩到末尾。
  if (kind === 'input') return null

  // 规则 B：失焦是唯一还会写光标的时机。
  // 不清零、不回落：让重新聚焦时 caret 停在用户离开的位置，与原生输入习惯一致。
  if (typeof cursor !== 'number' || !Number.isFinite(cursor) || cursor < 0) return null
  const len = typeof valueLen === 'number' && valueLen >= 0 ? valueLen : cursor
  return Math.max(0, Math.min(Math.round(cursor), len))
  // ⚠️ 任何分支都不得返回 -1：微信 textarea 的 cursor 默认值 -1 语义是
  //    「置于文本末尾」，写 -1 等于命令光标去末尾（2026-10-31 逗号事故）。
}
