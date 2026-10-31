import { useCallback, useRef, useState } from 'react'
import { decideBlurCursor, decideInputCursor } from './caret-decision'

/**
 * 输入框光标的「庇护所」（思傅 2026-10-26 起，2026-10-31 第五次重写）
 *
 * ## 这一版的核心变化
 * 前四版要么「钉一个不可信的值」（第 2~4 版，钉 `detail.cursor`），
 * 要么「干脆不下发 value」（第 5 版，真机上输入直接失效）。现在的口径：
 *
 *   1. **value 照常受控下发**（不下发的话真机表现完全不可控）；
 *   2. **每次输入把 `cursor` 一起下发**，与 `value` 同批 —— 抵消"value 一变
 *      渲染层就把光标甩到末尾"；
 *   3. 这个 cursor **必须自己算**：`diffCursor(上一次文本, 这一次文本)`。
 *      `detail.cursor` 不可信（社区实证：中间输入时它报的就是错位置），
 *      而文本差值是确定的 —— "公共前缀之后、公共后缀之前"就是本次编辑点。
 *   4. **组词期间一个字都不写**（那时文本是拼音串，差值算的是拼音位置）。
 *
 * ## 对外契约
 *   1. `track(cursor?, value?)`：onInput / onFocus 里调用。给了 value 就按差值
 *      算光标并下发；只给 cursor（focus 事件、手指点选换位）时只记录不发。
 *   2. `request(pos, value?)`：程序化插入后调用（插入数学符号 / OCR 回填）。
 *   3. `blur(cursor?)`：onBlur 里调用 —— 记录并把真实光标写下去，
 *      让重新聚焦落在用户离开的位置。
 *   4. `position(len)`：当前可用的插入位置。
 *   5. `setComposing(v)`：组词标记，组词期间不下发 cursor。
 */

export interface Caret {
  /** 传给 Textarea 的 cursor；-1 = 不指定（原生按自己的规则走） */
  cursor: number
  /** 传给 Textarea 的 focus：插入符号后要把输入态还回去，否则得再点一次输入框 */
  focus: boolean
  /**
   * onInput / onFocus 里调用。
   * @param cursor 事件 detail 里的光标位置（只在差值算不出时兜底）
   * @param value  本次输入后的完整文本（给了才按差值算光标）
   */
  track: (cursor?: number, value?: string) => void
  /** 程序化插入文本后调用：请求把光标定位到 pos（与页面 setState 同批下发） */
  request: (pos: number, value?: string) => void
  /**
   * 程序化插入后重新聚焦（思傅 2026-10-29「插完符号就退出输入状态」）。
   *
   * 微信原生 textarea 的 `focus` 是**边沿触发**：值一直是 true 时再设 true 不会做事。
   * 所以这里先落成 false、下一拍再置 true，制造一次真正的「重新聚焦」。
   */
  refocus: () => void
  /**
   * onBlur 里调用：记录离开时的真实光标、把它写进 cursor 属性（重新聚焦才落得对）、
   * 并让受控 focus 落下（否则状态与原生不一致，用户收不起键盘）。
   */
  blur: (cursor?: number) => void
  /**
   * 标记「输入法正在组词」（拼音/手写中间态）。
   * 绑到 Textarea 的 `onKeyboardCompositionStart` / `onKeyboardCompositionEnd`（微信 2.25.0+）。
   */
  setComposing: (v: boolean) => void
  /** 当前可用的插入位置（未记录/越界时退化为 len） */
  position: (len: number) => number
}

export function useCaret(): Caret {
  /** 最近一次算出来的真实光标位置（-1 = 未知） */
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

  /**
   * 把光标位置下发给 `cursor` 属性。
   *
   * ⚠️ **目标值与当前值相同时必须制造一次真实变化**：Taro 的 props diff 只把
   * "变了的属性"放进 setData（`dist/taro.js` 的 prepareUpdate），cursor 值不变
   * 就不会被下发 —— 而这一批里 value 变了，光标照样被甩到末尾，于是"中间插入一个字
   * 后光标跳到末尾"。所以先落到相邻位置，20ms 后归位；相邻一格用户看不见。
   */
  const applyShot = useCallback((pos: number, len?: number) => {
    let p = Math.round(pos)
    if (typeof len === 'number' && len >= 0) p = Math.min(p, len)
    p = Math.max(0, p)

    if (p === shotRef.current) {
      const stagger = p > 0 ? p - 1 : 1
      shotRef.current = stagger
      setShot(stagger)
      setTimeout(() => {
        // 期间用户若已经输入过（别的调用改过 shotRef），就不要抢回控制权
        if (shotRef.current === stagger) {
          shotRef.current = p
          setShot(p)
        }
      }, 20)
      return
    }
    shotRef.current = p
    setShot(p)
  }, [])

  const track = useCallback((cursor?: number, value?: string) => {
    // 只给了光标没给文本：focus 事件（手指点选换位，文本没变）。
    // 只记录，不下发 —— 原生光标本来就是用户点的那儿，写反而可能写错。
    if (typeof value !== 'string') {
      if (!composingRef.current && typeof cursor === 'number' && cursor >= 0) {
        live.current = cursor
      }
      return
    }

    const prev = prevValueRef.current
    // 组词期也更新基准：整段组词会被下一次差值当成一次编辑，位置依然算得对
    prevValueRef.current = value

    const next = decideInputCursor(prev, value, cursor, live.current, composingRef.current)
    // next === null：组词中 / 文本没变 / 无任何可用信息 —— 这一拍不动 cursor
    if (next === null) return
    live.current = next
    applyShot(next, value.length)
  }, [applyShot])

  const request = useCallback((pos: number, value?: string) => {
    const p = pos >= 0 ? pos : 0
    live.current = p
    if (typeof value === 'string') prevValueRef.current = value
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
    // 失焦也要写：写下真实位置，重新聚焦才落在用户离开处
    const next = decideBlurCursor(live.current >= 0 ? live.current : undefined)
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
