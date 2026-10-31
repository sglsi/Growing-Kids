/**
 * 受控输入框的「回声判定」（零 import 纯函数，由 `components/ui/textarea.tsx` 调用）
 *
 * ## 这个文件存在的唯一原因
 *
 * 微信 `textarea` 的 `value` 一旦被 setData，原生文本就按它重建、**光标落到末尾**；
 * 而 `cursor` 的官方定义是「**指定 focus 时的光标位置**」，输入过程中写它无效。
 * 所以"受控输入框每打一个字就把 value 回灌一次"这件事，在本平台上是**不可救的**：
 * 光标必然每次落末尾，且没有任何生效的纠正手段。
 *
 * ## 2026-10-31 第八轮：为什么"回声吸收"（第七轮）反而把输入搞坏了
 *
 * 第七轮以为「value 属性没变 ⇒ Taro 不会 setData」，于是回声分支下发"上一次的值"。
 * 真机上文本被打回旧值、打不进字。原因在 Taro 的 props diff：
 *
 * ```js
 * // @tarojs/react/dist/react.esm.js:364
 * const isFormElement = dom instanceof FormElement
 * for (i in newProps) {
 *   if (oldProps[i] !== newProps[i] || (isFormElement && i === 'value')) { ... }
 * }
 * ```
 *
 * **表单元素的 `value` 无条件进 setData，跟值变没变毫无关系。**
 * 于是"下发一个不变的值"既救不了光标，还会把用户刚打的字覆盖回旧值。
 *
 * ## 于是治法变成：**让这次渲染根本不要发生**
 *
 * Taro 的 setData 只在 `commitUpdate` 里产生，而 `commitUpdate` 只在元素被更新时执行。
 * 如果父组件重渲染时给的是**同一个 React 元素引用**，React 直接 bailout 整棵子树 ——
 * 不重算、不 diff、不 setData。`ui/textarea` 用 `useMemo` 缓存元素实现这一点。
 *
 * 本文件负责的判定只有一句话：**这次 props.value 的变化，是用户输入的回声，还是外部写入？**
 *   - 回声     ⇒ 不重建元素（连值都不用换，原生本来就是对的）
 *   - 外部写入 ⇒ bump 令牌，重建一次元素，把新值（连同 cursor/focus）下发
 *
 * ## 安全性
 * 放行时下发的**永远是当下最新的 props.value**，所以哪怕某次意外重渲染发生，
 * 最坏也只是退化成"光标可能落末尾"，**绝不会出现文本被旧值覆盖、打不进字**。
 */

export interface EchoState {
  /** 原生真实文本（`onInput` 里同步记录，永远等于用户看到的内容） */
  native: string
}

/** 一次状态推进：`native` = 用户输入事件，`prop` = 渲染时收到的受控值 */
export type EchoStep = { kind: 'native'; value: string } | { kind: 'prop'; value: string }

export interface EchoResult {
  /** 推进后的状态（调用方应写回 ref） */
  state: EchoState
  /** true = 这次是外部写入，必须重建元素把新值下发下去 */
  push: boolean
}

/** 初始状态：原生内容就是首帧传入的受控值（挂载时本来就会下发一次） */
export function initEcho(initial: string): EchoState {
  return { native: initial }
}

/**
 * 推进一次回声状态。
 *
 * `native` 步（onInput）：只记原生真相，永不 push —— 用户打的字原生已经有了，
 * 再下发一次只会把光标甩到末尾。
 *
 * `prop` 步（渲染）：页面值等于原生真相 ⇒ 是回声 ⇒ 不 push；
 * 不等 ⇒ 是外部写入（插入符号 / OCR 回填 / 清空 / 数据加载）⇒ push 一次。
 */
export function reduceEcho(state: EchoState, step: EchoStep): EchoResult {
  if (step.kind === 'native') {
    if (state.native === step.value) return { state, push: false }
    return { state: { native: step.value }, push: false }
  }
  if (step.value === state.native) return { state, push: false }
  return { state: { native: step.value }, push: true }
}
