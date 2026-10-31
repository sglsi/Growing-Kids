/**
 * 受控输入框的「回声吸收」判定（零 import 纯函数，由 `components/ui/textarea.tsx` 调用）
 *
 * ## 为什么必须吸收回声（2026-10-31 第七轮，连报六次后由复现脚本定位）
 *
 * 微信 `textarea` 是**半受控**组件，官方给两个属性的定义本身就是规则：
 *   - `value`  ：文本内容。被 setData 就按它重建原生文本，**光标随之落到末尾**；
 *   - `cursor` ：**「指定 focus 时的光标位置」**。只在聚焦那一拍生效。
 *
 * 于是受控输入框陷入死循环：页面 state 跟着用户输入走 ⇒ 每次输入 `props.value`
 * 都在变 ⇒ 每次都下发 ⇒ 每次都重置光标；而输入过程中写 `cursor` **不管用**
 * （没有 focus 边沿）。末尾打字看不出来，因为在末尾"重置到末尾"恰好是正确位置。
 *
 * 这解释了此前所有互相矛盾的现象：
 *   - 为什么"中间打标点/空格"必跳、末尾打不跳（复现脚本 `repro-caret.mjs` 有对照表）；
 *   - 为什么"快速删除有时好有时坏"（末尾删看不出、中间删必跳）；
 *   - 为什么"插入数学符号"从第一轮起就正常 —— 那条路径调了 `refocus()`，
 *     凭空造出一个 focus 边沿，cursor 于是被采纳。
 *
 * ## 治法
 * 让 `value` 在用户输入期间**保持不变**：页面 state 照常更新（保存、插入定位都不受影响），
 * 只是不把它回灌给原生 —— 原生文本本来就是用户打的，不需要我们重新设置。
 * 只有**程序化写入**（符号插入 / OCR 回填 / 清空 / 外部数据加载）才放行。
 *
 * ## 与 2026-10-31 第五版的区别（那版让真机输入彻底失效）
 * 那版用 `useState` 跟踪 native/pushed 两个量，并在渲染相位 setState 放行 + useEffect 兜底。
 * 后果是两个 state 的更新时机不确定，`pushed` 可能停留在初值 `''`，
 * 于是把空字符串下发给原生 ⇒ 文本被清空、内容不显示。
 * **本版全用 ref**（同步、不参与渲染调度），下发值永远是确定字符串，不可能发出空串。
 */

export interface EchoState {
  /** 原生真实文本（`onInput` 里同步记录，永远等于用户看到的内容） */
  native: string
  /** 最近一次真正下发给原生的值（用户输入期间它一直不动） */
  last: string
}

export interface EchoResult {
  /** 这一帧要传给原生 textarea 的 `value` */
  value: string
  /** 更新后的状态（调用方应写回 ref） */
  state: EchoState
  /** true = 这一帧是"用户输入的回声"，已吸收（不下发） */
  echo: boolean
}

/**
 * 决定这一帧给原生 textarea 下发什么值。
 *
 * @param state    上一帧的状态（首次用 `{ native: 初始值, last: 初始值 }`）
 * @param incoming 页面传下来的受控值（`props.value`）
 */
export function resolveEchoValue(state: EchoState, incoming: string): EchoResult {
  // 页面值与原生真实文本一致 ⇒ 页面在把用户刚打的字"回声"回来。
  // 丢掉它，继续给原生上一次真正下发的值：属性不变 ⇒ Taro 不会 setData
  // ⇒ 原生文本不动、光标由平台自己维护（任何输入法、任何操作序列都不会跳）。
  if (incoming === state.native) {
    return { value: state.last, state, echo: true }
  }
  // 否则是**程序化写入**（符号插入 / OCR 回填 / 清空 / 数据加载）⇒ 必须放行，
  // 并把 native 一起推进到新值：这一刻原生确实会变成它。
  return { value: incoming, state: { native: incoming, last: incoming }, echo: false }
}

/** 记录一次原生输入（`onInput` 里调用，只推进 native，不动 last） */
export function recordNativeInput(state: EchoState, native: string): EchoState {
  if (state.native === native) return state
  return { native, last: state.last }
}
