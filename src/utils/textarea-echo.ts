/**
 * 输入框「该显示什么文本」的判定（零 import 纯函数，由 `components/ui/textarea.tsx` 调用）
 *
 * ## 为什么需要这个文件（2026-10-31 第十轮，连报九次之后的最终定性）
 *
 * 前九轮全在改「输入框组件怎么把 value 钉住 / 怎么不下发 value」，都失败了。
 * 真正的原因有一半**不在输入框里，而在页面上**：
 *
 * 1. Taro 对小程序表单元素有一条无条件规则（`@tarojs/react/dist/react.esm.js:372`）：
 *    `if (oldProps[i] !== newProps[i] || (isFormElement && i === 'value'))`
 *    —— 表单元素只要**发生一次 commit**，`value` 就一定会进 setData，与值变没变无关。
 * 2. 微信 `textarea` 是**原生组件**：页面 setData 时，它按虚拟 DOM 里的 `value`
 *    属性重新应用一次 —— 文本被重建，**光标落到末尾**。
 *
 * 于是「页面在 onInput 里 setState」= 每打一个字页面 setData 一次 = 每打一个字
 * 光标被重置一次。这是**页面层**的行为，改组件永远治不到。
 *
 * 更糟的是第 7、8 版为了"不下发 value"让这个属性**停在旧值**（甚至空串）：
 * 每次 setData 都拿旧值覆盖原生文本 ⇒ **打不进字**。两版把"烦"升级成了"不能用"。
 *
 * ## 结论：两条必须同时成立
 *
 * - 页面在输入期间**不许 setState**（实时文本放 ref，失焦/程序化写入时才同步 state）；
 * - 输入框要下发的 `value` **必须永远等于用户眼前的文本**（哪怕这帧真的要 commit，
 *   也只是"光标落末尾"，绝不会丢字）。
 *
 * 本文件负责第二条：决定"这一帧显示的文本"是听原生（用户刚打的），还是听外部写入。
 *
 * 判定规则（保守优先，宁可少采纳一次，也绝不用可能的旧值覆盖用户输入）：
 *   ① 非受控（没有 value）        → 原样
 *   ② 与当前显示完全一致          → 原样（最常见：回声）
 *   ③ cursor 变了（程序化定位）    → **采纳**（插入符号 / OCR 回填 / 采纳搜题）
 *   ④ 未聚焦（装载数据/失焦同步）  → **采纳**
 *   ⑤ 其余（正在输入）            → 原样（此刻的 value 可能是回声或滞后一帧的旧值）
 */

export interface DisplayState {
  /** 最近一次真正显示在原生输入框里的文本 = 用户眼前看到的内容 */
  text: string
}

export interface DisplayInputs {
  /** 渲染时收到的受控值（页面 state）；非受控时 undefined */
  value?: string
  /** 这一帧是否处于聚焦中 */
  focused: boolean
  /** 这一帧 `cursor` 属性是否发生了变化（程序化写入的可靠信号） */
  cursorChanged: boolean
}

export function resolveDisplayText(state: DisplayState, input: DisplayInputs): DisplayState {
  if (typeof input.value !== 'string') return state
  if (input.value === state.text) return state
  if (input.cursorChanged) return { text: input.value }
  if (!input.focused) return { text: input.value }
  return state
}

/** 初始状态：首帧显示受控值（挂载时本来就会下发一次） */
export function initDisplay(value?: string): DisplayState {
  return { text: typeof value === 'string' ? value : '' }
}
