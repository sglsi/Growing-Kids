import * as React from "react"
import { Textarea as TaroTextarea, View } from "@tarojs/components"

import { cn } from "@/lib/utils"

/**
 * 多行输入框（Taro 版 shadcn Textarea，2026-10-31 按微信输入习惯校准）
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
export interface TextareaProps
  extends React.ComponentPropsWithoutRef<typeof TaroTextarea> {
  className?: string
  autoFocus?: boolean
  /**
   * 输入法组词状态变化（拼音/手写中间态）。
   *
   * 为什么要透出来（思傅 2026-10-31「输入字母后打标点，光标跑到结尾」）：
   * 受控 textarea 的正解是**每次输入都把 `cursor` 跟着 value 同一批下发**，
   * 否则微信按自己的规则把光标甩到末尾。但组词期间事件给的 `cursor` 是拼音串里的
   * 位置，写下去会把组词光标拽走 —— 所以必须知道"现在是组词中吗"。
   * 用官方 `onKeyboardCompositionStart/End`（微信基础库 2.25.0+，项目基线 3.17.4）判定，
   * 交给 `useCaret().setComposing`。
   */
  onComposingChange?: (composing: boolean) => void
}

const Textarea = React.forwardRef<
  React.ElementRef<typeof TaroTextarea>,
  TextareaProps
>(({
  className, autoFocus, focus, onFocus, onBlur, style,
  // 微信输入习惯的三件套：给默认值，调用方显式传则覆盖
  cursorSpacing = 24,
  showConfirmBar = true,
  adjustPosition = true,
  // 去掉 iOS 原生内边距：壳已经给了 px-3 py-2，再叠一层原生 padding 会让
  // 文字起点与选区手柄位置对不上（"选字时手柄偏一截"的成因之一）
  disableDefaultPadding = true,
  // 组词状态要转给 useCaret（见 TextareaProps.onComposingChange）
  onComposingChange,
  onKeyboardCompositionStart,
  onKeyboardCompositionEnd,
  onInput,
  ...props
}, ref) => {
  const [isFocused, setIsFocused] = React.useState(false)
  const autoHeight = !!(props as any).autoHeight
  /**
   * 光标自托管（思傅 2026-10-31「输入字母后打标点，光标跑到结尾」）。
   *
   * 小程序 textarea 是半受控组件：**value 一变，渲染层就把光标重置到末尾**，
   * 只有 `cursor` 能把它钉回去。所以「受控 value + 不动 cursor」这个组合本身就有坑 ——
   * 之前只有详情页接了 `useCaret`，其余页面（记忆、识别、资料库、聊天管理）的框全是裸受控。
   *
   * 这里做一层兜底：**调用方没有自己传 `cursor` 时**，组件内部把每次输入的真实光标
   * 写回 `cursor`（组词期间除外），让所有输入框自动获得正确的光标行为。
   * 调用方传了 `cursor` 就完全交给它（详情页那条 `useCaret` 链路参与插入符号定位）。
   */
  const hasOwnCursor = Object.prototype.hasOwnProperty.call(props, 'cursor')
  const [innerCursor, setInnerCursor] = React.useState(-1)
  const composingRef = React.useRef(false)

  React.useEffect(() => {
    if (autoFocus || focus) setIsFocused(true)
  }, [autoFocus, focus])
  /**
   * 内层原生 textarea 的尺寸：**跟外层同一份 height / minHeight**。
   * 只把 style 给外层还不够 —— 微信 textarea 是原生组件，
   * 它自己不留高度就会用默认值（约 150px）把外层撑开；给了 height 又容易和外层不一致。
   * 所以按同一份数值写两遍（外层决定占位、内层决定绘制区），永远不会「里面比外面大」。
   * 例外：`autoHeight` 时 height 由内容决定，只保底 minHeight（否则框会永远短一行）。
   */
  const css = (style || {}) as React.CSSProperties
  const innerStyle: React.CSSProperties = {
    width: '100%',
    alignSelf: 'stretch',
    ...(autoHeight
      ? (css.minHeight ? { minHeight: css.minHeight } : null)
      : {
        ...(css.height ? { height: css.height } : null),
        ...(css.minHeight ? { minHeight: css.minHeight } : null),
      }),
  }
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
      <TaroTextarea
        // ⚠️ 默认不限长（思傅 2026-10-26）：微信 textarea 的 maxlength 默认值是 **140**，
        //    不显式给 -1 就会静默截断——答案/解析/题干这类长文本全被砍在第 140 字。
        //    放在 {...props} 之前：调用方显式传 maxlength 时仍以调用方为准。
        maxlength={-1}
        cursorSpacing={cursorSpacing}
        showConfirmBar={showConfirmBar}
        adjustPosition={adjustPosition}
        disableDefaultPadding={disableDefaultPadding}
        // 自托管光标（调用方没自己接管时才生效，见 managedCursor 注释）
        {...(hasOwnCursor ? null : { cursor: innerCursor })}
        className="w-full self-stretch bg-transparent text-base text-foreground placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm selection:bg-selection selection:text-selection-foreground"
        placeholderClass="text-muted-foreground"
        style={innerStyle}
        ref={ref}
        focus={autoFocus || focus}
        onFocus={(e) => {
          setIsFocused(true)
          onFocus?.(e)
        }}
        onBlur={(e) => {
          setIsFocused(false)
          onBlur?.(e)
        }}
        // 组词边界：只在"开始/结束"两个边沿通知，中间态不用逐字更新
        onKeyboardCompositionStart={(e) => {
          composingRef.current = true
          onComposingChange?.(true)
          onKeyboardCompositionStart?.(e)
        }}
        onKeyboardCompositionEnd={(e) => {
          composingRef.current = false
          onComposingChange?.(false)
          onKeyboardCompositionEnd?.(e)
        }}
        // 自托管光标：每次输入把真实光标写回 cursor，抵消 value 回写把光标甩到末尾
        onInput={(e) => {
          if (!hasOwnCursor && !composingRef.current) {
            const c = (e.detail as { cursor?: number } | undefined)?.cursor
            if (typeof c === 'number' && c >= 0) setInnerCursor(c)
          }
          onInput?.(e)
        }}
        {...props}
      />
    </View>
  )
})
Textarea.displayName = "Textarea"

export { Textarea }
