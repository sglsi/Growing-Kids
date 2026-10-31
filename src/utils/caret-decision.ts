/**
 * 光标决策（零 import 纯函数，由 `utils/use-caret.ts` 调用）
 *
 * ## 版本史：同一个 bug 连报五次，方向换了四次
 * 1. 10-26 逐字绑定 cursor 想"钉住" ⇒ 拽走输入法组词光标；
 * 2. 10-31 撤销一次性定位时落回 -1 ⇒ -1 的语义是"置于末尾"，逗号跳末尾；
 * 3. 10-31 改成"删除时才补 cursor" ⇒ 标点、连续删除照样跳（判断错了）；
 * 4. 10-31 每次输入都钉住 `detail.cursor` ⇒ 标点仍跳：**钉的那个值本身是错的**；
 * 5. 10-31 输入期间不下发 value（回声吸收）⇒ 真机上输入直接失效（内容不显示）。
 *
 * ## 从这五次得到的确定结论
 * - **`value` 必须下发**，否则真机上文本表现不可控（第 5 版教训）。所以做"标准受控"。
 * - **下发 value 就会把光标重置到末尾**，必须靠同批的 `cursor` 把它钉回去。
 * - **`detail.cursor` 不可信**（社区实证：中间输入时报错位）。钉它等于钉一个假值 ——
 *   这才是"标点跳、句号不跳、删着删着跳"反复治不好的真正原因。
 * - 可信的是**文本差值**：`上一次文本 → 这一次文本`，公共前缀之后、公共后缀之前
 *   那一截就是本次编辑的位置。光标 = 那个位置的末尾。这是纯字符串运算，没有平台口味。
 *
 * ## 本版治法
 * 输入时把 `diffCursor(...)` 算出的位置写进 `cursor`，与 `value` 同一批下发。
 *
 * **组词中不是整体跳过**，而是按位置分流（第 6 次反馈后的口径）：
 *  - 末尾追加（拼音串 / 候选上屏）= 平台光标本来就在末尾 ⇒ 不写，避免打断输入法；
 *  - 中间编辑（在已上屏文字中间打标点、空格）= 会被 `value` 甩到末尾 ⇒ 必须写。
 *    英文输入法的「空格/标点提交当前词」走的正是这条路，且 composition 边沿与
 *    input 的先后顺序不可预期 —— 所以这条判据**只看位置、不看标志**才可靠。
 */

/** 一次光标相关的事件类型：用户输入 / 输入框失焦 */
export type CaretEventKind = 'input' | 'blur'

/**
 * 从「上一次文本 → 这一次文本」的差值算出编辑后的真实光标位置。
 *
 * 为什么不直接用事件给的 `detail.cursor`：它在文本中间输入时本身不可信
 * （社区实证 + 本项目连续删除/标点跳末尾的表现）。文本差值是确定的。
 *
 * @param prev 上一次的文本（`null` = 没有基准，无法推算）
 * @param next 这一次的文本
 * @param hint 上一次已知的光标位置（只在"编辑点有歧义"时用来消歧，-1 = 未知）
 * @returns 编辑后的光标位置；`null` = 文本没变（没有可推算的编辑）
 */
export function diffCursor(prev: string, next: string, hint = -1): number | null {
  if (prev === next) return null
  const min = Math.min(prev.length, next.length)
  // 公共前缀
  let p = 0
  while (p < min && prev.charCodeAt(p) === next.charCodeAt(p)) p++
  // 公共后缀（不与前缀交叠）
  let s = 0
  while (
    s < prev.length - p &&
    s < next.length - p &&
    prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)
  ) s++
  // 光标 = 前缀末尾 + 本次插入/替换进来的长度
  const byDiff = next.length - s

  /**
   * 歧义：前缀把较短那串吃满了（典型是"aaaa"里删/插一个 a）。
   * 单纯靠差值无法确定编辑点在哪，此时用上一次的光标位置兜底：
   *  - 插入（变长）：编辑点最可能就在前缀末尾，光标落在 p + 新增长度；
   *  - 删除（变短）：从上次位置往前退掉删掉的字数。
   * 没有 hint 就退化为差值结果（至少落在合理区间内）。
   */
  if (p >= min && hint >= 0) {
    const delta = next.length - prev.length
    if (delta > 0) return Math.min(next.length, p + delta)
    return Math.max(0, Math.min(next.length, hint + delta))
  }
  return Math.max(0, Math.min(next.length, byDiff))
}

/**
 * 输入事件 → 该写进 `cursor` 属性的值。
 *
 * @param prev       上一次文本（`null` = 无基准）
 * @param next       这一次文本
 * @param eventCursor 事件报告的 `detail.cursor`（只在差值算不出时兜底，不优先信）
 * @param hint       上一次已知光标位置
 * @param composing  是否正在输入法组词
 * @returns 要下发的光标位置；`null` = 这一拍不要改 cursor
 */
export function decideInputCursor(
  prev: string | null,
  next: string,
  eventCursor: number | undefined,
  hint: number,
  composing: boolean,
): number | null {
  const diffed = prev === null ? null : diffCursor(prev, next, hint)

  /**
   * 组词中要分两种情形，不能一刀切跳过（第 6 次反馈的根因就在这里）。
   *
   * 为什么不能再整体 return null：英文输入法里**空格和标点是"提交当前英文词"的动作**，
   * 会带出 composition 事件；而 `compositionstart/end` 与 `input` 的先后顺序
   * 各家输入法不一致，input 到达时 `composing` 往往还是 true。
   *   - 中文拼音为什么没事：末尾追加，平台把光标重置到末尾恰好就是正确位置；
   *   - 英文选词上屏为什么没事：选完词 composition 已结束；
   *   - **英文打标点/空格为什么出事**：这一次被跳过 ⇒ cursor 不下发 ⇒
   *     value 把光标甩到末尾，而标点常常是收尾动作，此后再没有输入事件来纠正。
   *
   * 所以改成按"位置是否在末尾"分流：
   *  - 算出的位置 **≥ 文本长度**（末尾追加，组词常态：拼音串、候选上屏）
   *    ⇒ 不写。平台自己维护的光标就在末尾，写只是多一次 setData，反而可能打断输入法
   *    （第 1 版"拽走组词光标"就是这类多余写入）。
   *  - 算出的位置 **< 文本长度**（在已上屏的文字中间编辑）
   *    ⇒ **必须写**。这正是会被甩到末尾的位置，而且与 composing 标志的时序无关 ——
   *    不管输入法发不发、什么顺序发 composition，中间编辑都能被纠正。
   */
  if (composing) {
    if (diffed === null || diffed >= next.length) return null
    return diffed
  }

  if (diffed !== null) return diffed

  // 文本没变（纯光标移动）：不用下发，原生光标本来就是用户点的那儿。
  if (prev !== null && prev === next) return null

  // 没有基准（第一次输入）：只能用事件给的值兜底；越界钳到文本长度。
  if (typeof eventCursor === 'number' && eventCursor >= 0) {
    return Math.min(next.length, Math.round(eventCursor))
  }
  return null
}

/**
 * 失焦事件 → 该写进 `cursor` 属性的值。
 *
 * 失焦也要写：让重新聚焦时 caret 停在用户离开的位置（与原生输入习惯一致）。
 *
 * @returns 要写入的 cursor；`null` = 本次不要改
 */
export function decideBlurCursor(
  cursor: number | undefined,
  valueLen = -1,
): number | null {
  if (typeof cursor !== 'number' || !Number.isFinite(cursor) || cursor < 0) return null
  const len = typeof valueLen === 'number' && valueLen >= 0 ? valueLen : cursor
  return Math.max(0, Math.min(Math.round(cursor), len))
  // ⚠️ 任何分支都不得返回 -1：微信 textarea 的 cursor 默认值 -1 语义是
  //    「置于文本末尾」，写 -1 等于命令光标去末尾（2026-10-31 逗号事故）。
}
