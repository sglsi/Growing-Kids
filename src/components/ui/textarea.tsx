import * as React from "react"
import { Textarea as TaroTextarea, View } from "@tarojs/components"

import { cn } from "@/lib/utils"

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
 * ⚠️ 不要给外壳加 `onTouchStart` 之类的触摸处理：
 *    每次触摸都触发一次渲染会让小程序 setData，长按选择文字时正好打断系统选区菜单，
 *    表现就是"选不中/一选就没了"。聚焦态一律用 CSS 的 `focus-within` 维护 ——
 *    **本组件内部一个 state 都没有**，就是为了不自己制造 setData。
 */

/**
 * ## 光标 / 吃字问题的最终定性（2026-10-31 第十一轮，在微信开发者工具里实测得出）
 *
 * 前九轮都在回答"输入框该下发什么 value"，第十轮又发明了"回声吸收"和"渲染阻断"，
 * 全都没治住，因为**前提判断错了**。这一轮不再推理，直接用 Chromium 调试协议
 * 接进微信开发者工具的模拟器（`server/scripts/ide-caret-test.mjs`）做真实输入实验：
 *
 * 实验 1（`ide-samevalue.mjs`）：把 textarea.value 重新赋成**同样的字符串** ——
 *   光标**纹丝不动**；赋成**不同的字符串** —— 光标**立刻跳到末尾**。
 * 实验 2（`ide-stack.mjs`）：抓 `value` 被改写的调用栈，确认改写来自
 *   Taro 的 commit → 微信 `defaultValueChange` → `updateValue`。
 *
 * ⇒ 结论不是"setData 带 value 就跳"，而是**"下发的值和原生当前文本不一致才跳"**。
 *   于是解法变得极简：**让下发的 value 永远等于用户眼前的文本**。
 *   页面在 onInput 里 setState（实时同步），组件把 `props.value` 原样下发 ——
 *   每次 commit 下发的都是刚刚那个文本，与原生相同 ⇒ 不重建、不跳光标、不丢字。
 *
 * ⇒ 反过来，"不让 value 变化"（第 7/8/10 版）才是最危险的做法：属性一旦停在旧值，
 *   任何一次 commit 都会把用户刚打的字**覆盖回旧值** —— 那就是"打不进字"。
 *
 * ## 第十一轮结论的补丁（2026-11-02，真机仍有残留故障后重做定性）
 *
 * 第十一轮的定性没错（值≠原生的那一刻光标就被甩到末尾），但**漏了一半**：
 * 它假定"每次 commit 下发的 value 一定是最新的那一个文本"。这个假设在真机上不成立 ——
 * Taro 的 `getUpdatePayload` 对表单元素是**无条件重发 value**
 * （`if (oldProps[i] !== newProps[i] || (isFormElement && i === 'value'))`），
 * 而 React 的 setState 会批处理、逻辑层到渲染层还有延迟。于是只要有**任何**一次 commit
 * 落在"用户已经多敲了一下"之后，下发的就是旧文本 ⇒ 微信把文本改回旧值、光标甩到末尾
 * ⇒ 下一个 input 事件再把文本补回来。净效果正是用户看到的：
 * **文本对了，光标却跑到结尾**。
 *
 * 对应两个真机必现场景（思傅 2026-11-02 复现）：
 *   · 按住删除键连删 —— input 事件密集，state 追不上；
 *   · 输入法组合态直接上屏标点（不选候选）—— 组合期间 detail.value 比原生文本旧。
 *
 * 治法：**下发的值永远取"已知最新的那份文本"，而不是页面的 state**。
 *   `onInput` 一来就把文本记进 `latestRef`（同一个事件里，比 setState 早），
 *   渲染时 `displayValue = latestRef ?? value`。这样即使 commit 是由**上一拍**的
 *   setState 触发的，下发的也是刚打出来的最新文本 —— 与原生一致 ⇒ 不动光标。
 *   页面主动改值（插符号、回填、清空）时，`value` 既不是我们上次交出去的、也不等于
 *   `latestRef`，于是反过来以页面为准（见下面 render 里的判定）。
 *
 * ⚠️ 试过但**被实测否掉**的方案：把 onInput 延迟 120ms 再上抛（"打字期间不 commit"）。
 *    模拟器里打「甲乙丙」直接变成「甲丙」—— 延迟让 state 更旧，而 commit 照样发生，
 *    于是下发的是更旧的文本，连字都被覆盖。见 `server/scripts/ide-value-writes.mjs` 的
 *    `same:false` 记录。**只要还有 commit，value 就必须是最新的，不能靠"拖"**。
 *
 * ⚠️ 也不能用"把 value 从 props 里删掉"来实现"不下发"：Taro 的 payload 会把缺失的键
 *    记成 `[key, null]`，等于主动下发 `value: null` —— 那正是第 7/8/10 版"打不进字"。
 *
 * ## 两条纪律
 * 1. 页面：`onInput` 里必须 `setState` 实时同步（state 仍要跟上，只是不作为下发来源）。
 * 2. 组件：`value` / `cursor` / `focus` 只在**有明确含义时**出现 ——
 *    `cursor={-1}` 在微信里是"置于末尾"，`focus={false}` 是"强制失焦"，
 *    写成 `undefined` 也仍会留下键（Taro 的 diff 走 `for (i in newProps)`），
 *    所以一律用**条件展开**。
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
    value,
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

  /**
   * 用户在原生里打出来的**最新**文本。
   * input 事件到达时立刻写入 —— 比页面的 setState 早一拍，这就是它能救命的原因：
   * 由上一拍 setState 触发的那次 commit，下发的会是它，而不是更旧的 state。
   */
  const latestRef = React.useRef<string | null>(null)
  /** 上一次交给原生的 value：用来判断"页面这次给的值是不是新东西" */
  const appliedRef = React.useRef<string | null>(null)
  /** 是否处于聚焦态（不触发渲染，只用来判断该不该听页面的话） */
  const focusRef = React.useRef(false)

  const handleInput = React.useCallback(
    (e: { detail?: { value?: string } } & Record<string, unknown>) => {
      const next = e?.detail?.value
      if (typeof next === 'string') latestRef.current = next
      // 立即上抛：页面的 state 必须保持实时（它还要用来判断空态/脏标记/保存）
      onInput?.(e as never)
    },
    [onInput],
  )

  const handleFocus = React.useCallback(
    (e: unknown) => {
      focusRef.current = true
      onFocus?.(e as never)
    },
    [onFocus],
  )

  const handleBlur = React.useCallback(
    (e: unknown) => {
      focusRef.current = false
      onBlur?.(e as never)
    },
    [onBlur],
  )

  /**
   * ⚠️ 只在真正要定位时才把 cursor 传下去：`-1` 在微信里的语义是"置于末尾"，
   *    不是"不指定"。写 -1 等于主动把光标甩到结尾。
   */
  const cursorProp = typeof cursor === "number" && cursor >= 0 ? cursor : null

  /**
   * 该不该听页面给的 `value`？
   *
   * - 用户正在这个框里打字（聚焦中）且没有要求定位光标 ⇒ 页面给的只可能是
   *   **滞后的 state**（哪怕它看起来"变了"），一律不听；只有 native 才是真相。
   * - 失焦时，或调用方带着 `cursor` 明确要求定位（插符号 / 回填 / 清空）⇒ 以页面为准。
   *
   * 这条判定就是整个补丁的核心：它让"下发的值"永远是**原生当前文本**，
   * 而不是"上一次 setState 留下的旧文本"。
   */
  const trustPage = !focusRef.current || cursorProp !== null
  if (typeof value === "string") {
    if (latestRef.current === null || (trustPage && value !== appliedRef.current)) {
      latestRef.current = value
    }
  }
  /**
   * 下发给原生的文本。
   * ⚠️ 这个键**永远不能省**（见文件顶部：省掉等于下发 `value: null`）。
   */
  const displayValue = latestRef.current ?? value
  if (typeof displayValue === "string") appliedRef.current = displayValue
  /**
   * ⚠️ `focus` 同理：`false` 在微信里是"**强制失焦**"（会收键盘），
   *    不是"不指定"。用户正在打字时每帧下发一次 false，表现就是"一打字就退出输入"。
   *    所以只有确实要聚焦时才把这个属性放出去。
   */
  const focusProp = !!(autoFocus || focus)

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
         * ⚠️ `value` 必须**一直出现**（非受控调用方则整键不出现）。
         * 省掉这个键 = Taro 下发 `value: null` = 清空用户刚打的字。
         * `displayValue` 优先取输入事件里记下的最新文本，见上。
         */
        {...(typeof displayValue === "string" ? { value: displayValue } : undefined)}
        {...(cursorProp !== null ? { cursor: cursorProp } : undefined)}
        {...(focusProp ? { focus: true } : undefined)}
        onInput={handleInput as never}
        onFocus={handleFocus as never}
        onBlur={handleBlur as never}
        className={INNER_CLASS}
        placeholderClass="text-muted-foreground"
        style={innerStyle}
        {...rest}
      />
    </View>
  )
})

Textarea.displayName = "Textarea"

export { Textarea }
