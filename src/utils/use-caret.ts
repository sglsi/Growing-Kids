import { useCallback, useRef, useState } from 'react'
import { decideCursor } from './caret-decision'

/**
 * 输入框光标的「庇护所」（思傅 2026-10-26 起，2026-10-31 重写）
 *
 * ## 一、为什么不能让 `cursor` 逐字更新
 * 每敲一个字都把 `cursor` 属性重新绑到 Textarea 上（onInput 里 setState），
 * 微信原生 textarea 收到 cursor **变化** 就会按这个值重新定位光标，于是：
 *   · 中文输入法组词过程中事件里的 cursor 与原生真实位置不一致 → 光标被拽走；
 *   · 事件里没带 cursor（部分输入法/部分标点会这样）→ 退化成 -1 → 光标飞到末尾。
 *
 * ## 二、为什么 `cursor` 也不能「用完就落回 -1」（思傅 2026-10-31 报的 bug）
 * 症状：在答案/题干框里插入一个数学符号（×、√、²…）后，接着敲**英文逗号**，
 *      光标立刻跳到全文末尾；敲句号却没有。**只跳第一次，之后一直正常。**
 *
 * 病因就是这个「落回 -1」：
 *   插入符号 → request(pos) 把 cursor 从 -1 变成 pos（这是必要的，否则定位不了）；
 *   用户敲下第一个字符 → onInput → track() 为了撤销一次性定位，又把 cursor 设回 -1。
 *   微信对「-1」的处理是**默认值 = 置于文本末尾**（见 Taro Textarea `cursor` 默认 -1），
 *   于是一次「pos → -1」的属性变化 = 一次「把光标移到末尾」的指令。
 *   为什么只有逗号、没有句号？因为**撤销只发生一次**：第一个字符（逗号）已经把
 *   cursor 落成 -1 了，之后句号再来时 cursor 没有再变化，自然不跳。
 *   同理也解释了「连续打字正常、只在插入符号后的第一个字跳」。
 *
 * 治法（本次）：
 *   撤销一次性定位时，把 cursor 设成**用户当前的真实光标**（onInput 的 detail.cursor，
 *   拿不到时用文本长度差推算），而不是 -1。属性值确实变了，但变到的是"原地"，
 *   微信据此重新定位的结果就是不动 —— 既撤销了定位，也不会把光标甩走。
 *
 * ## 三、为什么删除时也必须同步 cursor（思傅 2026-10-31 报的第二个 bug）
 * 症状：**连续按退格删前面的字**，删到一半光标突然跳到全文末尾，之后删的是末尾的字。
 *
 * 病因不是我们的 cursor，而是受控 `value` 的**回写时序**：
 *   onInput → setState → React 渲染 → Taro 组 DOM 差异 → `setData(value)`。
 *   这条链要跨若干个微任务/帧，而用户连续退格时原生文本**一直在变**。
 *   于是这一次 setData 落地的 value 往往已经落后于原生当前文本
 *   （用户又删掉了 1~2 个字），微信收到「value 被赋值」就把光标置到末尾。
 *   打字时不易察觉（每次只增一个字、节奏慢），连续删时几乎必然撞上。
 *   只在「删除」出现，还因为它让文本**变短**：变短意味着这次回写一定与
 *   原生当前内容不一致 —— 增字时回写常常恰好等于原生值，等于没变化。
 *
 * 治法：删除（本次长度 < 上次长度）时，**同一次 setData 里把 cursor 一起下发**，
 * 值取事件报告的真实光标。这样即使 value 被回写成落后值，微信按 cursor 重新定位，
 * 光标仍在原处。注意这**不会加重干扰**：每次 onInput 本来就已经在 setData(value)，
 * 只是同一批数据里多一个字段，不会额外多一次打断（长按连续退格照常）。
 *
 * ## 四、对外契约
 *   1. 光标位置记在 ref 里，不参与日常渲染，用户怎么打字都不干预；
 *   2. 只有**程序化插入**（数学符号、识别结果回填）时才 request(pos) 一次性定位，
 *      由紧随其后的第一次 onInput 消费掉；
 *   3. 插入位置取自最近一次真实输入/失焦事件的 cursor，越界自动退化为文本末尾；
 *   4. **每次输入都把真实光标钉住**（规则见 utils/caret-decision 规则 3），
 *      唯一的例外是输入法组词中 —— 由 `setComposing` 标记（binding
 *      `onKeyboardCompositionStart/End` 得到），组词期间完全不碰 cursor。
 */

export interface Caret {
  /** 传给 Textarea 的 cursor；-1 = 不指定（原生按自己的规则走） */
  cursor: number
  /** 传给 Textarea 的 focus：插入符号后要把输入态还回去，否则得再点一次输入框 */
  focus: boolean
  /**
   * onInput / onFocus / onBlur 里调用：记录真实光标，并消费掉待生效的一次性定位。
   * @param cursor   事件 detail 里的光标位置（可能没有）
   * @param valueLen 本次输入后的文本长度（用于事件没带 cursor 时推算新位置）
   */
  track: (cursor?: number, valueLen?: number) => void
  /** 程序化插入文本后调用：请求把光标定位到 pos（一次性） */
  request: (pos: number, valueLen?: number) => void
  /**
   * 程序化插入后重新聚焦（思傅 2026-10-29「插完符号就退出输入状态」）。
   *
   * 微信原生 textarea 的 `focus` 是**边沿触发**：值一直是 true 时再设 true 不会做事。
   * 所以这里先落成 false、下一拍再置 true，制造一次真正的「重新聚焦」。
   * 同时 `cursor` 只有**聚焦中**才会被采信，两步必须一起做。
   */
  refocus: () => void
  /** 真实失焦时调用：让受控 focus 与原生状态保持一致，避免用户收不起键盘 */
  blur: () => void
  /**
   * 标记「输入法正在组词」（拼音/手写中间态）。
   * 组词期间不碰 cursor —— 事件给的 cursor 是拼音串里的位置，写下去会把组词光标拽走。
   * 绑到 Textarea 的 `onKeyboardCompositionStart` / `onKeyboardCompositionEnd`（微信 2.25.0+）。
   */
  setComposing: (v: boolean) => void
  /** 当前可用的插入位置（未记录/越界时退化为 len） */
  position: (len: number) => number
}

export function useCaret(): Caret {
  /** 最近一次真实输入事件报告的光标位置 */
  const live = useRef(-1)
  /** 一次性定位：只有它会被写进 cursor 属性 */
  const shotRef = useRef(-1)
  /** 一次性定位是否还没被用户的下一次输入消费掉 */
  const pendingRef = useRef(false)
  /** 上一次已知的文本长度（事件没带 cursor 时用来推算新光标） */
  const lenRef = useRef(-1)
  /** 输入法是否正在组词（组词期间一律不碰 cursor，见 caret-decision 规则 1） */
  const composingRef = useRef(false)
  const [shot, setShot] = useState(-1)
  /** 受控聚焦态（见 Caret.refocus 的说明） */
  const [focused, setFocused] = useState(false)

  /** 写 cursor 属性时先比对镜像值：相同则不动，避免白发一次 setData */
  const applyShot = useCallback((pos: number) => {
    if (pos < 0 || pos === shotRef.current) return
    shotRef.current = pos
    setShot(pos)
  }, [])

  const track = useCallback((cursor?: number, valueLen?: number) => {
    // 生效前先算：决策要用「上一拍」的 live / prevLen（见 utils/caret-decision 的规则）
    const next = decideCursor(
      {
        prevLen: lenRef.current,
        shot: shotRef.current,
        live: live.current,
        pending: pendingRef.current,
        composing: composingRef.current,
      },
      { cursor, valueLen },
    )
    if (typeof cursor === 'number' && cursor >= 0) live.current = cursor
    if (pendingRef.current) pendingRef.current = false
    // next === null 表示「这一拍不改动」（绝不等于写 -1，见 caret-decision 规则 2）
    if (next !== null) applyShot(next)
    if (typeof valueLen === 'number' && valueLen >= 0) lenRef.current = valueLen
  }, [applyShot])

  const setComposing = useCallback((v: boolean) => {
    composingRef.current = v
  }, [])

  const request = useCallback((pos: number, valueLen?: number) => {
    const p = pos >= 0 ? pos : 0
    live.current = p
    pendingRef.current = true
    if (typeof valueLen === 'number' && valueLen >= 0) lenRef.current = valueLen
    if (p === shotRef.current) {
      /**
       * 目标位置与当前属性值相同时，Taro 的 diff 认为 `cursor` 没变、**不会把它放进
       * 这一批 setData**，于是这一批只有 value 变化 ⇒ 微信按自己的规则把光标甩到末尾
       * （「插入数学符号后光标跳到最后」，思傅 2026-10-31）。
       * 先落到相邻位置、20ms 后归位，制造一次真实变化 —— 相邻一格的位移用户看不见。
       */
      const stagger = p > 0 ? p - 1 : 1
      shotRef.current = stagger
      setShot(stagger)
      setTimeout(() => {
        // 期间用户若已经输入过（applyShot 改过值），就不要抢回控制权
        if (shotRef.current === stagger) {
          shotRef.current = p
          setShot(p)
        }
      }, 20)
      return
    }
    applyShot(p)
  }, [applyShot])

  const refocus = useCallback(() => {
    setFocused(false)
    /**
     * 60ms 才做 true 的边沿（原为 30ms）。
     *
     * 顺序必须是「value 的 setData 落地 → 再聚焦」：`cursor` 是"focus 时的光标位置"，
     * 聚焦时微信按它定位；若 value 的 setData 晚于这次聚焦到达，光标又会被甩到末尾，
     * 而此后再没有 cursor 变化去纠正它（思傅 2026-10-31「输入数学符号后光标跳到最后」）。
     * 插入路径本身在 `request()` 里已经做了「相邻位 → 目标位」的强制变化，
     * 这里多等 30ms 是给长文本 autoHeight 重排留余量。
     */
    setTimeout(() => setFocused(true), 60)
  }, [])

  const blur = useCallback(() => setFocused(false), [])

  const position = useCallback((len: number) => {
    const p = live.current
    if (p < 0) return len
    return Math.min(p, len)
  }, [])

  return { cursor: shot, focus: focused, track, request, refocus, blur, setComposing, position }
}
