import { useCallback, useRef, useState } from 'react'

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
 * ## 三、对外契约
 *   1. 光标位置记在 ref 里，不参与日常渲染，用户怎么打字都不干预；
 *   2. 只有**程序化插入**（数学符号、识别结果回填）时才 request(pos) 一次性定位，
 *      由紧随其后的第一次 onInput 消费掉；
 *   3. 插入位置取自最近一次真实输入/失焦事件的 cursor，越界自动退化为文本末尾。
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
    const valid = typeof cursor === 'number' && cursor >= 0
    if (valid) live.current = cursor
    const len = typeof valueLen === 'number' ? valueLen : -1

    if (pendingRef.current) {
      // 优先用事件给的真实光标；事件没带（部分输入法/标点会这样）就用长度差推算
      let target = valid ? (cursor as number) : -1
      if (target < 0 && len >= 0 && lenRef.current >= 0) {
        const grown = len - lenRef.current
        target = Math.min(len, Math.max(0, shotRef.current + grown))
      }
      // ⚠️ 消费掉标记后**绝不**把 cursor 落回 -1（见文件头第二节）。
      // target 仍 < 0 说明这一拍拿不到任何位置信息 —— 宁可保持原值不动，
      // 也不能写 -1（那等于命令微信"把光标移到末尾"）。
      pendingRef.current = false
      if (target >= 0) applyShot(target)
    }
    if (len >= 0) lenRef.current = len
  }, [applyShot])

  const request = useCallback((pos: number, valueLen?: number) => {
    const p = pos >= 0 ? pos : 0
    live.current = p
    pendingRef.current = true
    if (typeof valueLen === 'number' && valueLen >= 0) lenRef.current = valueLen
    applyShot(p)
  }, [applyShot])

  const refocus = useCallback(() => {
    setFocused(false)
    // 30ms：等这一次 value 更新的 setData 落地，再做 true 的边沿
    setTimeout(() => setFocused(true), 30)
  }, [])

  const blur = useCallback(() => setFocused(false), [])

  const position = useCallback((len: number) => {
    const p = live.current
    if (p < 0) return len
    return Math.min(p, len)
  }, [])

  return { cursor: shot, focus: focused, track, request, refocus, blur, position }
}
