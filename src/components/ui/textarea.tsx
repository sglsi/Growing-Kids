import * as React from "react"
import { Textarea as TaroTextarea, View } from "@tarojs/components"

import { cn } from "@/lib/utils"
import { initDisplay, resolveDisplayText, type DisplayState } from "@/utils/textarea-echo"

/**
 * 多行输入框（Taro 版 shadcn Textarea）
 *
 * 这一层除了样式壳，还负责把「微信原生 textarea 的默认值」调成用户熟悉的手感：
 *  - `cursorSpacing`：光标与键盘的间距。原生默认 0 = 光标紧贴键盘顶沿，
 *    编辑屏幕下半部分的几行时几乎看不见自己在打什么。微信自己的输入框都留了空隙。
 *  - `showConfirmBar`：键盘上方那条带「完成」的横栏。原生默认是 true，但被某些
 *    上层覆盖后容易丢，这里显式声明 —— 收键盘靠它，比点空白更符合手机习惯。
 *  - `adjustPosition`：键盘弹起时页面自动上推，保证输入框不被挡住。
 *  - `autoHeight`：随内容长高。**固定高度 + 内部滚动**是"选择文字很不方便"的主因：
 *    选区超出可视区时，拖动选择手柄会在原生组件内部滚，手柄和文字对不上。
 *    开启后整框随内容撑开，滚动交给外层页面，长按选择就和微信聊天框一致了。
 *    注意：`autoHeight` 时 `height` 不生效，只能靠 `minHeight` 保底，
 *    所以传了 `style={{minHeight}}` 的调用方要把同一个值也写给内层（见下）。
 *
 * ⚠️ 不要给外壳加 `onTouchStart` 之类的触摸处理（2026-10-31 移除此前的 setState）：
 *    每次触摸都触发一次渲染会让小程序 setData，长按选择文字时正好打断系统选区菜单，
 *    表现就是"选不中/一选就没了"。聚焦态一律用 CSS 的 `focus-within` 维护 ——
 *    **本组件内部一个 state 都没有**，就是为了不自己制造 setData。
 */

/**
 * ## 光标 / 吃字问题的最终定性（2026-10-31 第十轮，连报九次后）
 *
 * 前九轮全部失败，因为它们都在回答同一个错误的问题："输入框该下发什么值的 value"。
 * 真正的原因是**两条平台规则叠在一起**，其中一条根本不在这个组件里：
 *
 * 1. `@tarojs/react/dist/react.esm.js:372`
 *    ```js
 *    if (oldProps[i] !== newProps[i] || (isFormElement && i === 'value'))
 *    ```
 *    表单元素只要**发生一次 commit**，`value` 就必然进 setData，值变没变都一样。
 * 2. 微信 `textarea` 是原生组件：页面 setData 时按虚拟 DOM 的 `value` **重新应用文本**，
 *    **光标落到末尾**。
 *
 * ⇒ 页面在 `onInput` 里 `setState`，就是"每打一个字 setData 一次、光标重置一次"。
 *   这是页面层的行为，**改组件永远治不到**（第十轮终于承认这一点）。
 *
 * ⇒ 而且如果为了"不下发 value"让这个属性停在旧值（第 7 版）或空串（第 8 版），
 *   每次 setData 都会用旧值**覆盖原生文本**：真机表现就是"打不进字"。
 *
 * ## 所以现在的契约是两条，缺一不可
 *
 * - **页面**：输入期间实时文本只写 ref、**不 setState**（失焦 / 程序化写入时才同步）；
 * - **组件**（本文件）：下发的 `value` **永远等于用户眼前的文本** —— 用户打字同步写进
 *   `displayRef`，外部写入才采纳页面值（判定见 `utils/textarea-echo.ts`）。
 *
 * 于是最坏情况退化成"某次 commit 让光标落到末尾"（烦），**绝不会出现丢字（不能用）**。
 * 这条失败方向是刻意设计的：连报九次之后，宁可光标偶尔跳，也不能再吃掉用户的输入。
 */
export interface TextareaProps
  extends React.ComponentPropsWithoutRef<typeof TaroTextarea> {
  className?: string
  autoFocus?: boolean
}

const INNER_CLASS =
  "w-full self-stretch bg-transparent text-base text-foreground placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm selection:bg-selection selection:text-selection-foreground"

const SHELL_CLASS =
  "flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 ring-offset-background focus-within:border-ring focus-within:ring-4 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background"

const Textarea = React.forwardRef<
  React.ElementRef<typeof TaroTextarea>,
  TextareaProps
>((props, ref) => {
  const {
    className,
    autoFocus,
    focus,
    cursor,
    style,
    value: valueProp,
    onInput,
    onFocus,
    onBlur,
    // 微信输入习惯的三件套：给默认值，调用方显式传则覆盖
    cursorSpacing = 24,
    showConfirmBar = true,
    adjustPosition = true,
    // 去掉 iOS 原生内边距：壳已经给了 px-3 py-2，再叠一层原生 padding 会让
    // 文字起点与选区手柄位置对不上（"选字时手柄偏一截"的成因之一）
    disableDefaultPadding = true,
    ...rest
  } = props

  const controlled = typeof valueProp === "string"
  const focusedProp = !!(autoFocus || focus)
  // ⚠️ 只在真正要定位时才把 cursor 传下去：`-1` 在微信里的语义是"置于末尾"，
  //    不是"不指定"。写 -1 等于主动把光标甩到结尾。
  const cursorProp = typeof cursor === "number" && cursor >= 0 ? cursor : null

  /**
   * 用户眼前的文本。只由两件事改变：
   *   ① 用户输入（onInput 同步写，早于页面可能到来的下一次渲染）；
   *   ② 可信的外部写入（失焦时装载/OCR 回填；或 cursor 变化 = 程序化插入）。
   * 页面 state **不直接驱动**它 —— 判定规则见 utils/textarea-echo.ts。
   */
  const displayRef = React.useRef<DisplayState>(initDisplay(controlled ? valueProp : undefined))
  const focusedRef = React.useRef(false)
  const prevCursorRef = React.useRef<number | null>(null)

  const cursorChanged = cursorProp !== null && cursorProp !== prevCursorRef.current
  prevCursorRef.current = cursorProp

  displayRef.current = resolveDisplayText(displayRef.current, {
    value: controlled ? (valueProp as string) : undefined,
    focused: focusedRef.current,
    cursorChanged,
  })

  /**
   * 回调必须走 ref：组件的 props 会被下一次渲染更新，但 onInput 里读到的
   * 必须是**当前**这一份回调，否则页面拿到的是旧闭包。
   */
  const cb = React.useRef({ onInput, onFocus, onBlur })
  cb.current = { onInput, onFocus, onBlur }

  const autoHeight = !!(rest as { autoHeight?: boolean }).autoHeight
  /**
   * 内层原生 textarea 的尺寸：**跟外层同一份 height / minHeight**。
   * 只把 style 给外层还不够 —— 微信 textarea 是原生组件，
   * 它自己不留高度就会用默认值（约 150px）把外层撑开；给了 height 又容易和外层不一致。
   * 所以按同一份数值写两遍（外层决定占位、内层决定绘制区），永远不会「里面比外面大」。
   * 例外：`autoHeight` 时 height 由内容决定，只保底 minHeight（否则框会永远短一行）。
   */
  const innerStyle = React.useMemo<React.CSSProperties>(() => {
    const css = (style || {}) as React.CSSProperties
    if (autoHeight) return { width: "100%", alignSelf: "stretch", ...(css.minHeight ? { minHeight: css.minHeight } : null) }
    return {
      width: "100%",
      alignSelf: "stretch",
      ...(css.height ? { height: css.height } : null),
      ...(css.minHeight ? { minHeight: css.minHeight } : null),
    }
  }, [style, autoHeight])

  return (
    <View
      /**
       * ⚠️ `style` 必须落在**这层壳**上，不能透传给里面的原生 textarea（思傅 2026-10-29）。
       *
       * 原来 `style` 混在 `{...props}` 里给了 TaroTextarea，而壳是死的 `h-20`（80px）：
       * 记忆页传 `style={{height:'160px'}}` ⇒ 原生 textarea 变 160px、壳还是 80px，
       * 多出来的 80px **溢出到壳外面**（原生组件不裁剪），正好压住下方的
       * 「图片 / 录音 / 视频」按钮 ⇒ 点按钮命中透明输入区，
       * 表现为「点按钮没反应、光标却跑进内容栏」。
       *
       * 同理 `h-20` 改 `min-h-20`：高度该由调用方给（或内容撑开），
       * 壳固定死高度只会制造「里面比外面大」的溢出。
       */
      style={style}
      className={cn(SHELL_CLASS, className)}
    >
      <TaroTextarea
        ref={ref}
        // ⚠️ 默认不限长（思傅 2026-10-26）：微信 textarea 的 maxlength 默认值是 **140**，
        //    不显式给 -1 就会静默截断——答案/解析/题干这类长文本全被砍在第 140 字。
        //    放在 {...rest} 之前：调用方显式传 maxlength 时仍以调用方为准。
        maxlength={-1}
        cursorSpacing={cursorSpacing}
        showConfirmBar={showConfirmBar}
        adjustPosition={adjustPosition}
        disableDefaultPadding={disableDefaultPadding}
        /**
         * ⚠️ `value` 是**用户眼前的文本**（不是页面 state）：任何一次 commit 都会把
         * 它塞进 setData，所以它必须永远是对的 —— 这样最坏只是光标落末尾，绝不会丢字。
         * 非受控调用方（没传 value）时压根不出现这个键。
         *
         * ⚠️ `cursor` 只在 >= 0 时出现：`-1` 在微信里是"置于末尾"，等于主动甩光标。
         */
        {...(controlled ? { value: displayRef.current.text } : undefined)}
        {...(cursorProp !== null ? { cursor: cursorProp } : undefined)}
        className={INNER_CLASS}
        placeholderClass="text-muted-foreground"
        style={innerStyle}
        focus={focusedProp}
        onFocus={(e) => {
          focusedRef.current = true
          cb.current.onFocus?.(e)
        }}
        onBlur={(e) => {
          focusedRef.current = false
          cb.current.onBlur?.(e)
        }}
        onInput={(e) => {
          // 先记"用户眼前的文本"：这是本次 commit 之后要下发的值，
          // 也保证任何一帧意外 commit 都不会拿旧值覆盖刚打的字。
          const value = typeof e?.detail?.value === "string" ? e.detail.value : ""
          displayRef.current = { text: value }
          cb.current.onInput?.(e)
        }}
        {...rest}
      />
    </View>
  )
})

Textarea.displayName = "Textarea"

export { Textarea }
