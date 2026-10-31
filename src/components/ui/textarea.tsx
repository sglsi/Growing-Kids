import * as React from "react"
import { Textarea as TaroTextarea, View } from "@tarojs/components"

import { cn } from "@/lib/utils"
import { recordNativeInput, resolveEchoValue, type EchoState } from "@/utils/textarea-echo"

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
  value: valueProp,
  onInput,
  ...props
}, ref) => {
  const [isFocused, setIsFocused] = React.useState(false)
  const autoHeight = !!(props as any).autoHeight

  /**
   * 回声吸收（2026-10-31 第七轮，由 `server/scripts/repro-caret.mjs` 复现并定位）
   *
   * ## 平台事实
   * 微信 `textarea` 的 `value` 被 setData 就重建原生文本、**光标落到末尾**；
   * 而 `cursor` 的官方定义是「**指定 focus 时的光标位置**」—— 输入过程中写它无效。
   *
   * 于是标准受控写法必然出事：页面 state 跟着输入走 ⇒ 每次输入 `props.value` 都变
   * ⇒ 每次都下发 ⇒ 每次都重置光标，且没有任何生效的纠正手段。
   * 末尾打字看不出来（重置到末尾恰好正确），只有**中间编辑**才暴露 ——
   * 这就是"标点/空格/中间删除跳末尾、从句尾删却正常"的全部由来。
   *
   * ## 做法
   * 用户输入期间**根本不下发 value**：页面 state 照常更新（保存、插入定位都不受影响），
   * 只是不把它回灌给原生。原生文本本来就是用户打的，不需要我们重新设置。
   * 只有程序化写入（符号插入 / OCR 回填 / 清空 / 数据加载）才放行。
   *
   * ## 为什么这次不会像第五版那样把输入搞坏
   * 第五版用 `useState` 跟踪 native/pushed 两个量、渲染相位 setState 放行 + useEffect 兜底。
   * 两个 state 的更新时机不确定，`pushed` 可能停在初值 `''` ⇒ 把空串下发给原生
   * ⇒ 文本被清空、内容不显示。
   * 本版**全用 ref**（同步、不参与渲染调度），下发值永远是确定字符串，不可能发出空串；
   * 且回声分支直接返回"上一次下发过的值"，属性不变就不 setData，失败模式只剩
   * "退化成普通受控"（= 本轮修复前的表现），绝不会让文本消失。
   */
  const controlled = typeof valueProp === "string"
  const incoming = controlled ? (valueProp as string) : ""
  const echoRef = React.useRef<EchoState>({ native: incoming, last: incoming })
  // 渲染中写 ref 是安全的（不参与 React 调度）；resolveEchoValue 幂等，
  // 重复渲染（如严格模式双调用）第二次会落到 echo 分支，结果一致。
  const resolved = controlled ? resolveEchoValue(echoRef.current, incoming) : null
  if (resolved) echoRef.current = resolved.state
  const outValue = resolved ? resolved.value : valueProp

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
        // 受控值经回声吸收后下发：用户输入期间它是"上一次真正下发的值"（不变），
        // 只有程序化写入才变成页面新值。属性不变 ⇒ 不 setData ⇒ 光标零干预。
        value={outValue}
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
        onInput={(e) => {
          // 先记录"原生真相"（同步，早于页面 setState 触发的渲染），
          // 再交给页面。页面回声回来的同值会被 resolveEchoValue 判为回声吸收掉。
          if (controlled) {
            echoRef.current = recordNativeInput(echoRef.current, e.detail.value)
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
