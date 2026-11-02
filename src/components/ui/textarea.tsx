import * as React from "react"
import { Textarea as TaroTextarea, View } from "@tarojs/components"
import { flushSync } from "@tarojs/react"

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
 * ## 第十三轮：真正的病根在「Taro 恢复受控值的时机」（2026-11-02 晚，模拟器稳定复现）
 *
 * 思傅反馈：中文已经好了，**英文逐字符输入时光标依旧跳到末尾**。用调试协议在模拟器里
 * 能稳定重现 —— 16 个字母、15ms 间隔，最后一数只剩 13 个字符，光标在末尾。
 *
 * 读 `@tarojs/react` 源码就能看见完整链条：
 *   1. 事件结束 → `finishEventHandler()` → **`TaroReconciler.flushSync()`** →
 *      `restoreStateIfNeeded()`（第 757~767 行）；
 *   2. 恢复时走 `updateWrapper` → `setNodeValue(node, event.detail.value, props.value)`，
 *      判据是 `if (value != null && oldValue !== toString(value)) node.value = value`
 *      —— 也就是「**事件里的文本 ≠ fiber 上的 props.value 就把原生文本改回去**」；
 *   3. 而 React 18 对事件回调里的 setState 是**批处理**的，页面那次 `setContent(...)`
 *      在 `flushSync()` 真正刷出来之前，`props.value` 还停在**上一拍**。
 *      ⇒ `oldValue !== props.value` 成立 ⇒ 把刚打的字改回上一拍的文本 ⇒ 光标甩末尾。
 *
 * 中文为什么侥幸没事：一次上屏只发一次 input，两拍之间隔得远，props.value 早就跟上了。
 * 英文逐字符输入时每拍都可能撞上，所以必然复现（也是"连删"必现的同一个原因）。
 *
 * ⇒ 治法：**在 input 事件里当场把这次更新同步刷出去**（`flushSync()`）。
 *   刷完 `props.value` 就等于本次事件的文本，与 `oldValue` 相同 ⇒ 不恢复 ⇒
 *   文本不动、光标不动、不丢字。这不是"让值更准"，而是**让恢复逻辑判定为"不需要恢复"**。
 *
 * ## 第十四轮：`flushSync` 只解决了一半，另一半在 setData 的时序（2026-11-02 晚）
 *
 * 思傅复测："中文好了，英文故障依旧"。模拟器里重新跑 16 字连打，**又只剩 11 个**。
 * 用调试协议把「谁改了原生 value」的调用栈抓出来（`scripts/tmp-write-stack.mjs`），
 * 再在 `setNodeValue` 里打点，才看清完整链条：
 *
 *   1. `flushSync()` **是生效的** —— 打点显示每次 input 回调结束时
 *      `props.value` 已经从 `a` 变成 `ab`（所以第十三轮的方向是对的）；
 *   2. 真正把字冲掉的是**视图层晚到的 setData**：逻辑层每次提交都会把 `value`
 *      塞进 payload，视图层（`WAWebview` 的 `defaultValueChange` → `updateValue`）
 *      应用有延迟，后到的旧值把用户刚打的字覆盖掉、光标甩末尾；
 *   3. 还有一条**每次 input 都多出来的 setData**：`FormElement.dispatchEvent`
 *      在 INPUT 事件里执行 `this.value = val`，而 `setAttribute` 不做相等判断，
 *      无条件 `enqueueUpdate`。打字越快，这条回声越容易晚一步到。
 *
 * ⇒ 两处补丁（`patches/@tarojs__react@4.1.9.patch`、`patches/@tarojs__runtime@4.1.9.patch`）：
 *   · `getUpdatePayload`：表单元素的 `value` 若与元素当前值相同，就从 payload 里**摘掉**；
 *     ⚠️ 但 payload **不能返回 null** —— `commitUpdate` 会提前返回，元素上的
 *     `__reactProps$` 就不更新，Taro 恢复受控值时读到旧值 ⇒ 把整段文本写成空串
 *     （实测连打 16 字最终长度 0）。返回空数组 `[]` 才是对的。
 *   · `FormElement.dispatchEvent`：INPUT 分支改成 `this.props.value = val`，
 *     只同步内部状态，不再额外发一次 setAttribute（setData）。
 *
 * ⇒ 组件这一侧还要**丢掉没有文本的 input 事件**：视图层应用 `value` 之后微信会
 *   回抛一次 `detail` 里没有 value 的 input，照常上抛就是 `setContent('')` ⇒ 清空。
 *
 * ⚠️ 试过但**被实测否掉**的几条路（别再走一遍）：
 *    · **把 onInput 延迟上抛**（"打字期间不 commit"）：属性值停在旧串 ⇒ 恢复逻辑照样把文本
 *      改回旧串 ⇒ 模拟器里打「甲乙丙」变「甲丙」，连打 16 字只剩 1~2 个。
 *    · **完全不传 value**（想做成非受控）：Taro 的 textarea 直接**打不进字**；
 *      传 `undefined` 等价于下发空串，会把内容清空。
 *    · **运行时改写 `FormElement[Symbol.hasInstance]`**：会连带打断 Babel 的
 *      `_classCallCheck`（它内部就是 `instanceof`），整个小程序白屏。
 *    · **把值从 payload 里 `continue` 掉、不摘除**：payload 变 null ⇒ 见上，清空文本。
 *
 * ## 两条纪律
 * 1. 页面：`onInput` 里照常 `setState`（不要自己再防抖）—— 同步刷新由本组件负责。
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
   * input 事件到达时立刻写入（同步，一个字都不丢）—— 它就是"下发给原生的值"。
   */
  const latestRef = React.useRef<string | null>(null)
  /** 是否处于聚焦态（不触发渲染，只用来判断该不该听页面的话） */
  const focusRef = React.useRef(false)
  /** 最新的 onInput：同步渲染里要用"这一次 render 的那一个"，不能闭包住旧的 */
  const onInputRef = React.useRef<typeof onInput>(onInput)
  onInputRef.current = onInput

  const handleInput = React.useCallback(
    (e: { detail?: { value?: string; cursor?: number } } & Record<string, unknown>) => {
      const next = e?.detail?.value
      /**
       * ⚠️ 没有文本的 input 事件一律丢掉。
       *
       * 视图层把 `value` 应用到原生 textarea 之后，微信还会回抛一次 input，
       * 但那次事件的 `detail` 里**没有 value**（它不是用户输入）。若照常上抛，
       * 页面收到的是空串 ⇒ `setContent('')` ⇒ 下一次提交下发 `value: ''`
       * ⇒ **把用户刚打的字整段清空**（第十四轮实测：连打 16 字最终长度 0）。
       */
      if (typeof next !== 'string') return
      // ① 同步记最新文本：下发的值用它，绝不会落后于"逻辑层已知的最新"
      latestRef.current = next
      // ② 快照：Taro / 微信会复用事件对象，后续再读 `e.detail.value` 可能已被清空
      const snapshot = {
        detail: {
          value: next,
          cursor: typeof e?.detail?.cursor === 'number' ? e.detail.cursor : undefined,
        },
      }
      /**
       * ③ **同步渲染**（`flushSync`）—— 这是不打字丢字的关键。
       *
       * Taro 处理完 input 事件后会 `TaroReconciler.flushSync()` 再走
       * `restoreStateIfNeeded`（`@tarojs/react` 的 `finishEventHandler`）：
       * 那里拿 **fiber 上的 props.value** 和本次事件的文本比，不等就把原生文本改回去。
       *
       * 而 React 18 对事件里的 setState 是批处理的，页面那次 setState 尚未落地时
       * `props.value` 还停在上一拍 —— 于是"改回上一拍文本"，用户看到的就是
       * **光标跳到末尾、偶尔还丢字**（英文逐字符输入时必然发生）。
       *
       * 在这里强制同步渲染一次，能让 `props.value` 在 Taro 恢复之前就变成
       * "本次事件的文本"，两边一致 ⇒ 不重建、不动光标、不丢字。
       * 中英文都走这一条路径，不再区分输入法。
       */
      const emit = () => onInputRef.current?.(snapshot as never)
      emit()
      try {
        // 先把页面 setState 排上，再强制把这次更新刷出（空回调也能冲出 pending 更新）
        flushSync()
      } catch {
        // 某些时机（render 期间）不允许同步刷新，退化为普通上抛
      }
    },
    [],
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
   * - 用户正在这个框里打字（聚焦中）且**没有新的定位请求** ⇒ 页面给的只可能是
   *   一拍前的 state，一律不听；只有原生才是真相。
   * - 失焦时（页面加载/切换题目），或调用方**刚刚**带着 `cursor` 要求定位
   *   （插数学符号 / OCR 回填 / 清空）⇒ 以页面为准。
   *
   * ⚠️ `cursor` 必须是**变化的那一刻**才算请求：`useCaret` 会把上次定位的值一直挂着，
   *    若把"cursor 非空"当成请求，打字全程都会被判定为"听页面的"，滞后值就会回写。
   */
  const lastCursorRef = React.useRef<number | null>(null)
  const cursorChanged = cursorProp !== null && cursorProp !== lastCursorRef.current
  lastCursorRef.current = cursorProp
  const trustPage = !focusRef.current || cursorChanged
  if (typeof value === "string" && (latestRef.current === null || trustPage)) {
    latestRef.current = value
  }
  /**
   * 下发给原生的文本。
   * ⚠️ 这个键**永远不能省**（见文件顶部：省掉等于下发 `value: null`）。
   */
  const displayValue = latestRef.current ?? value
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
