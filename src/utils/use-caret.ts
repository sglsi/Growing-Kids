import { useCallback, useRef, useState } from 'react'
import { decideCursor, diffCursor } from './caret-decision'

/**
 * 输入框光标的「庇护所」（思傅 2026-10-26 起，2026-10-31 第三次重写）
 *
 * ## 一、这个 hook 现在**不**做什么（重要，前两版都错在这）
 * 它**不在用户输入期间写 `cursor` 属性**。连报四次事故后确认：
 * 小程序 textarea 是半受控组件，setData 里出现 value 就把光标重置到末尾；
 * 而受控 value 的回写是跨帧链，连续操作时必然过期 ⇒ 每次回写都是一次跳末尾的机会。
 * `detail.cursor` 在文本中间输入时本身不可信，钉它钉不准。
 * 正解是 **`components/ui/textarea.tsx` 的回声吸收**：输入期间不下发 value，
 * 原生组件自己管文本和光标。字母、标点、连续删除、拼音组词全部零干预。
 *
 * ## 二、这个 hook 还做什么
 * 1. **记录真实光标 `live`**（供"数学符号插哪"用）：
 *    用 `diffCursor(prev, next)` 从两次文本差值算 —— 不信 detail.cursor；
 *    文本没变时（focus 事件：手指点选换位）才退回事件给的 cursor。
 * 2. **程序化插入的定位 `request(pos, value)`**：页面 setState 新文本后调用，
 *    cursor 与 value 由 ui/textarea 保证落进同一批 setData；
 *    目标值与当前属性值相同时先落相邻位、20ms 后归位（Taro 的 diff 不把
 *    "没变的 cursor" 放进这批 setData，必须制造一次真实变化）。
 * 3. **失焦时写下真实光标 `blur(cursor)`**：唯一还会写光标的时机 ——
 *    让重新聚焦时 caret 停在用户离开的位置。输入期间绝不用它。
 *
 * ## 三、对外契约
 *   1. `track(cursor?, value?)`：onInput / onFocus 里调用，**只记录，绝不写属性**；
 *   2. `request(pos, value?)`：程序化插入后调用，value 是插入后的完整文本；
 *   3. `blur(cursor?)`：onBlur 里调用，记录 + 写下真实光标 + 落下受控 focus；
 *   4. `position(len)`：当前可用的插入位置（未记录/越界时退化为 len）；
 *   5. `setComposing(v)`：组词期间不更新 live（那时文本是拼音串，差值算出来的是拼音位置）。
 */

export interface Caret {
  /** 传给 Textarea 的 cursor；-1 = 不指定（原生按自己的规则走） */
  cursor: number
  /** 传给 Textarea  focus：插入符号后要把输入态还回去，否则得再点一次输入框 */
  focus: boolean
  /**
   * onInput / onFocus 里调用：记录真实光标（diff 优先），并**绝不写 cursor 属性**。
   * @param cursor 事件 detail 里的光标位置（可能没有，也不一定可信）
   * @param value  本次输入后的完整文本（给了才能用差值推算；不给视为纯光标移动）
   */
  track: (cursor?: number, value?: string) => void
  /** 程序化插入文本后调用：请求把光标定位到 pos（与页面 setState 同批下发） */
  request: (pos: number, value?: string) => void
  /**
   * 程序化插入后重新聚焦（思傅 2026-10-29「插完符号就退出输入状态」）。
   *
   * 微信原生 textarea 的 `focus` 是**边沿触发**：值一直是 true 时再设 true 不会做事。
   * 所以这里先落成 false、下一拍再置 true，制造一次真正的「重新聚焦」。
   * 同时 `cursor` 只有**聚焦中**才会被采信，两步必须一起做。
   */
  refocus: () => void
  /**
   * onBlur 里调用：记录离开时的真实光标、把它写进 cursor 属性（重新聚焦才落得对）、
   * 并让受控 focus 落下（否则状态与原生不一致，用户收不起键盘）。
   */
  blur: (cursor?: number) => void
  /**
   * 标记「输入法正在组词」（拼音/手写中间态）。
   * 组词期间不更新 live —— 那时的文本是拼音串，差值算出来的位置不是最终光标。
   * 绑到 Textarea 的 `onKeyboardCompositionStart` / `onKeyboardCompositionEnd`（微信 2.25.0+）。
   */
  setComposing: (v: boolean) => void
  /** 当前可用的插入位置（未记录/越界时退化为 len） */
  position: (len: number) => number
}

export function useCaret(): Caret {
  /** 最近一次真实光标位置（-1 = 未知） */
  const live = useRef(-1)
  /** 当前下发给 `cursor` 属性的值（-1 = 不指定） */
  const shotRef = useRef(-1)
  /** 上一次已知的完整文本（差值推算用；null = 未知） */
  const prevValueRef = useRef<string | null>(null)
  /** 输入法是否正在组词 */
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

  const track = useCallback((cursor?: number, value?: string) => {
    if (typeof value === 'string') {
      if (!composingRef.current) {
        // 差值优先：detail.cursor 在文本中间输入时不可信（社区实证），
        // 而"上一次文本 → 这一次文本"的差值是确定的。
        const diffed = prevValueRef.current !== null ? diffCursor(prevValueRef.current, value) : null
        if (diffed !== null) live.current = diffed
        else if (typeof cursor === 'number' && cursor >= 0) live.current = cursor
      }
      // 组词期也更新基准：整段组词会被下一次差值当成一次编辑，位置依然算得对
      prevValueRef.current = value
      return
    }
    // 只给了光标没给文本（focus 事件：手指点选换位，文本没变）
    if (!composingRef.current && typeof cursor === 'number' && cursor >= 0) {
      live.current = cursor
    }
    // ⚠️ 绝不在此处写 cursor 属性 —— 输入期间原生光标就是对的（见 caret-decision 规则 A）
  }, [])

  const request = useCallback((pos: number, value?: string) => {
    const p = pos >= 0 ? pos : 0
    live.current = p
    if (typeof value === 'string') prevValueRef.current = value
    if (p === shotRef.current) {
      /**
       * 目标位置与当前属性值相同时，Taro 的 diff 认为 `cursor` 没变、**不会把它放进
       * 这一批 setData**，于是这一批只有 value 变化 ⇒ 微信按自己的规则把光标甩到末尾。
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
     * 而此后再没有 cursor 变化去纠正它。多等 30ms 是给长文本 autoHeight 重排留余量。
     */
    setTimeout(() => setFocused(true), 60)
  }, [])

  const blur = useCallback((cursor?: number) => {
    setFocused(false)
    if (composingRef.current) return
    if (typeof cursor === 'number' && cursor >= 0) live.current = cursor
    // 失焦是唯一还会写光标的时机：写下真实位置，重新聚焦才落在用户离开处
    const next = decideCursor('blur', live.current >= 0 ? live.current : undefined)
    if (next !== null) applyShot(next)
  }, [applyShot])

  const setComposing = useCallback((v: boolean) => {
    composingRef.current = v
  }, [])

  const position = useCallback((len: number) => {
    const p = live.current
    if (p < 0) return len
    return Math.min(p, len)
  }, [])

  return { cursor: shot, focus: focused, track, request, refocus, blur, setComposing, position }
}
