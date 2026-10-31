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
   * 由官方 `onKeyboardCompositionStart/End`（微信 2.25.0+，项目基线 3.17.4）驱动，
   * 交给 `useCaret().setComposing` —— 组词期间记录的 live 光标不是最终位置。
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
  value: valueProp,
  onInput,
  ...props
}, ref) => {
  const [isFocused, setIsFocused] = React.useState(false)
  const autoHeight = !!(props as any).autoHeight

  /**
   * ⚠️ 这里**不做回声吸收**（2026-10-31 第五版试过，真机上输入直接失效：
   * 中文英文都打不进、内容不显示，见 `工程教训录` L25 的订正）。
   *
   * 现在就是标准受控：`value` 老实下发，光标的稳定交给 `useCaret` ——
   * 它每次都把**文本差值算出来的**正确位置与 value 同批写进 `cursor`。
   * 关键分野：`detail.cursor` 不可信（社区实证中间输入时报错位），
   * 而"上次文本 → 这次文本"的差值是确定的。
   */

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
        // 标准受控：value 照常下发（不下发的方案在真机上会让输入失效），
        // 光标由 useCaret 与它同批写进 cursor 抵消"value 一变光标甩末尾"。
        value={valueProp}
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
          onComposingChange?.(true)
          onKeyboardCompositionStart?.(e)
        }}
        onKeyboardCompositionEnd={(e) => {
          onComposingChange?.(false)
          onKeyboardCompositionEnd?.(e)
        }}
        onInput={(e) => {
          // 直接交给页面：让页面 setQContent 与 useCaret.track（内部 setShot）
          // 尽量落进同一批渲染 ⇒ value 与 cursor 同批下发。
          onInput?.(e)
        }}
        {...props}
      />
    </View>
  )
})
Textarea.displayName = "Textarea"

export { Textarea }
