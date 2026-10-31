import * as React from "react"
import { Textarea as TaroTextarea, View } from "@tarojs/components"

import { cn } from "@/lib/utils"
import { initEcho, reduceEcho, type EchoState } from "@/utils/textarea-echo"

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
 *    表现就是"选不中/一选就没了"。聚焦态一律用 onFocus / onBlur + CSS 维护。
 */

/**
 * ## 光标问题的最终解法（2026-10-31 第八轮，连报七次后定性）
 *
 * ### 平台规则（两条官方定义叠加，都是死路）
 * 1. 微信 `textarea` 的 `value` 被 setData ⇒ 原生文本重建、**光标落到末尾**；
 * 2. `cursor` 的官方定义是「**指定 focus 时的光标位置**」⇒ 输入过程中写它**无效**。
 *
 * ### Taro 那一层还有一条更狠的
 * ```js
 * // @tarojs/react/dist/react.esm.js:364
 * const isFormElement = dom instanceof FormElement
 * for (i in newProps) {
 *   if (oldProps[i] !== newProps[i] || (isFormElement && i === 'value')) { ... }
 * }
 * ```
 * **表单元素的 `value` 无条件进 setData，跟值变没变无关。**
 * 所以"受控输入框"在 Taro 小程序端 = 每帧都重建原生文本 = 光标每帧落末尾，无解。
 *
 * 第七轮因此试过"回声吸收"（下发一个不变的值，指望 Taro 跳过它）：既救不了光标
 * （Taro 照发不误），还把用户刚打的字覆盖回旧值 —— 真机表现就是**打不进字**。
 *
 * ### 所以治法不在"发什么值"，而在"**别让这次渲染发生**"
 * setData 只在 `commitUpdate` 里产生，而 `commitUpdate` 只在元素被更新时执行。
 * 父组件重渲染时若交出**同一个 React 元素引用**，React 直接 bailout 整棵子树：
 * 不重算、不 diff、不 setData，光标完全由平台自己维护 ⇒ 任何输入法都不会跳。
 *
 * 实现就是下面的 `useMemo`：把 `props.value` **排除在依赖之外**，只在下面这些
 * "必须打扰原生"的时刻重建元素：
 *   - 外部写入（插入符号 / OCR 回填 / 清空 / 数据加载）⇒ `pushToken` 变；
 *   - 程序化定位光标（`useCaret.request`）⇒ `cursor` 变；
 *   - 聚焦边沿（`useCaret.refocus` / 失焦）⇒ `focus` 变；
 *   - 样式/属性本身变了 ⇒ `styleKey` / `restKey` / `className` 变。
 *
 * 用户打字只是页面 state 变，以上四类全都不变 ⇒ **一次 setData 都不会发生**。
 *
 * ### 为什么这版不会再出现"打不进字"
 * 重建时下发的**永远是当下最新的 `props.value`**（不是"上一次的值"）。
 * 哪怕某次意外重渲染绕过了缓存，最坏也只是退化成"光标可能落末尾"，
 * 文本永远与页面一致 —— 不可能被旧值覆盖。
 */
export interface TextareaProps
  extends React.ComponentPropsWithoutRef<typeof TaroTextarea> {
  className?: string
  autoFocus?: boolean
}

const INNER_CLASS =
  "w-full self-stretch bg-transparent text-base text-foreground placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm selection:bg-selection selection:text-selection-foreground"

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

  /** 原生真实文本 + 是否该放行（见 utils/textarea-echo.ts 的说明） */
  const echoRef = React.useRef<EchoState>(
    initEcho(controlled ? (valueProp as string) : "")
  )
  /** 放行令牌：+1 表示"下一页请重建元素、把新值下发下去" */
  const [pushToken, setPushToken] = React.useState(0)
  const [isFocused, setIsFocused] = React.useState(false)

  /**
   * 回调必须走 ref。
   * 元素被缓存复用后，里面绑定的闭包永远是**创建它那一帧**的 props ——
   * 直接绑 `props.onInput` 会让页面写到过时的 state 上（表现为"输入了但存不上"）。
   * 渲染相位写 ref 是安全的：它同步生效、不参与 React 调度。
   */
  const cb = React.useRef({ onInput, onFocus, onBlur })
  cb.current = { onInput, onFocus, onBlur }

  /**
   * 只有**外部写入**才放行。
   * 用户输入的每一次 setState 都会走到这里，但那时 `props.value` 恒等于原生真相
   * （`onInput` 里已同步记进 ref）⇒ 判定为回声 ⇒ 不动令牌 ⇒ 元素不重建。
   */
  React.useEffect(() => {
    if (!controlled) return
    const r = reduceEcho(echoRef.current, {
      kind: "prop",
      value: valueProp as string,
    })
    echoRef.current = r.state
    if (r.push) setPushToken((t) => t + 1)
  }, [controlled, valueProp])

  // 这些 key 决定"要不要重建元素"；注意 `valueProp` 故意不在其中。
  const restKey = safeKey(rest)
  const styleKey = safeKey(style || {})

  const node = React.useMemo(() => {
    /**
     * 内层原生 textarea 的尺寸：**跟外层同一份 height / minHeight**。
     * 只把 style 给外层还不够 —— 微信 textarea 是原生组件，
     * 它自己不留高度就会用默认值（约 150px）把外层撑开；给了 height 又容易和外层不一致。
     * 所以按同一份数值写两遍（外层决定占位、内层决定绘制区），永远不会「里面比外面大」。
     * 例外：`autoHeight` 时 height 由内容决定，只保底 minHeight（否则框会永远短一行）。
     */
    const css = (style || {}) as React.CSSProperties
    const autoHeight = !!(rest as { autoHeight?: boolean }).autoHeight
    const innerStyle: React.CSSProperties = {
      width: "100%",
      alignSelf: "stretch",
      ...(autoHeight
        ? css.minHeight
          ? { minHeight: css.minHeight }
          : null
        : {
            ...(css.height ? { height: css.height } : null),
            ...(css.minHeight ? { minHeight: css.minHeight } : null),
          }),
    }

    const handleInput = (e: { detail: { value: string } }) => {
      // 先记"原生真相"（同步，早于页面 setState 引起的下一次渲染），
      // 页面把同值传回来时会被判定为回声、不触发重建。
      const value = typeof e?.detail?.value === "string" ? e.detail.value : ""
      echoRef.current = reduceEcho(echoRef.current, {
        kind: "native",
        value,
      }).state
      cb.current.onInput?.(e as never)
    }

    return (
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
         * ⚠️ `value` 与 `cursor` 都用**条件展开**，而不是传 undefined/-1：
         *    - Taro 只遍历 newProps 里出现的 key，写成 `value={undefined}` 会让
         *      "value" 这个键存在 ⇒ 每帧下发 undefined ⇒ 文本被清空；
         *    - `cursor: -1` 在微信里是"置于末尾"，等于主动把光标甩到结尾。
         * 非受控（调用方没传 value）时压根不出现这两个键。
         */
        {...(controlled ? { value: valueProp as string } : undefined)}
        {...(cursorProp !== null ? { cursor: cursorProp } : undefined)}
        className={INNER_CLASS}
        placeholderClass="text-muted-foreground"
        style={innerStyle}
        focus={focusedProp}
        onFocus={(e) => {
          setIsFocused(true)
          cb.current.onFocus?.(e)
        }}
        onBlur={(e) => {
          setIsFocused(false)
          cb.current.onBlur?.(e)
        }}
        onInput={handleInput}
        {...rest}
      />
    )
    // ⚠️ 依赖里**故意没有 valueProp**：这正是"用户打字不触发原生更新"的机关。
    //    放行时 useMemo 会重新执行工厂函数，读到的是当次渲染最新的 valueProp，
    //    所以下发值永远正确，不会出现旧值覆盖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pushToken,
    focusedProp,
    cursorProp,
    className,
    styleKey,
    restKey,
    ref,
    cursorSpacing,
    showConfirmBar,
    adjustPosition,
    disableDefaultPadding,
  ])

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
      className={cn(
        "flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 ring-offset-background focus-within:border-ring focus-within:ring-4 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background",
        isFocused && "border-ring ring-4 ring-ring ring-offset-2 ring-offset-background",
        className
      )}
    >
      {node}
    </View>
  )
})

/**
 * 把一组透传属性压成一个稳定字符串，用作"要不要重建元素"的判据。
 *
 * 用 JSON 而不是引用比较：调用方几乎都是内联对象/内联箭头函数，
 * 引用每帧都不同，按引用比等于每帧都重建（等于什么都没做）。
 * 函数会被 JSON 丢掉 —— 正好，回调已经统一走 `cb` ref，不该触发重建。
 */
function safeKey(v: unknown): string {
  try {
    return JSON.stringify(v) ?? ""
  } catch {
    return ""
  }
}

Textarea.displayName = "Textarea"

export { Textarea }
