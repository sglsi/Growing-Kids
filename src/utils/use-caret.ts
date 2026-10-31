import { useCallback, useRef, useState } from 'react'
import { decideBlurCursor, diffCursor } from './caret-decision'

/**
 * 输入框光标的「庇护所」（思傅 2026-10-26 起；2026-10-31 第八次重写，终于定性）
 *
 * ## 定性结论（三条平台/框架规则叠加，前七版全栽在这里）
 *
 * 1. 微信 `textarea` 的 `value` 被 setData ⇒ 原生文本重建、**光标落到末尾**；
 * 2. `cursor` 的官方定义是「**指定 focus 时的光标位置**」⇒ 输入过程中写它**无效**；
 * 3. Taro 那层还有一条：`@tarojs/react/dist/react.esm.js:366`
 *    `if (oldProps[i] !== newProps[i] || (isFormElement && i === 'value'))`
 *    —— 表单元素的 `value` **无条件下发**，跟值变没变毫无关系。
 *
 * 所以"在输入时把 cursor 钉准"和"下发一个不变化的 value"都救不了：
 * 只要这次渲染发生，value 就一定被塞进 setData，光标就一定落末尾。
 *
 * 治法因此落在渲染层（见 `components/ui/textarea.tsx`）：
 * **用户输入期间根本不重建元素**（useMemo 缓存 ⇒ React bailout ⇒ 没有 commitUpdate
 * ⇒ 没有 setData），光标完全由平台维护。
 *
 * ## 于是本 hook 的职责收窄为「记录位置 + 程序化定位」
 *   1. `track(cursor?, value?)`：onInput / onFocus 里调用。**只记录**光标，
 *      用 `diffCursor(上一次文本, 这一次文本)` 算（`detail.cursor` 在中间输入时不可信）。
 *      不下发 cursor —— 输入期间写它无效，且一旦写它就等于要求重建元素。
 *   2. `request(pos, value?)`：程序化插入后调用（插入数学符号 / OCR 回填）。
 *      配合 `refocus()` 造出 focus 边沿，那时 cursor 才真正生效。
 *   3. `blur(cursor?)`：onBlur 里调用 —— 记录并把真实光标写下去，
 *      让重新聚焦落在用户离开的位置。
 *   4. `position(len)`：当前可用的插入位置。
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
   *
   * @param quiet 组词中用的安静模式：值没变就**什么都不做**（不制造 ±1 抖动）。
   *   组词期间每多一次 setData 都可能打断输入法候选，而那时平台自己维护的光标
   *   本来就是对的，没必要为"制造变化"付这个代价。
   */
  const applyShot = useCallback((pos: number, len?: number, quiet = false) => {
    let p = Math.round(pos)
    if (typeof len === 'number' && len >= 0) p = Math.min(p, len)
    p = Math.max(0, p)

    if (p === shotRef.current) {
      if (quiet) return
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
    // 记下来即可 —— 它是后续"插入符号插到哪儿"的依据。
    if (typeof value !== 'string') {
      if (typeof cursor === 'number' && cursor >= 0) live.current = cursor
      return
    }

    const prev = prevValueRef.current
    prevValueRef.current = value

    // 用文本差值算真实编辑点（`detail.cursor` 在中间输入时不可信），
    // 但**只记录、不下发**：value 现在不回灌原生（见 ui/textarea 的渲染阻断），
    // 光标由平台自己维护，写 cursor 只是白白要求重建一次元素、反而把光标甩到末尾。
    const diffed = prev === null ? null : diffCursor(prev, value, live.current)
    if (diffed !== null) live.current = diffed
    else if (typeof cursor === 'number' && cursor >= 0) live.current = cursor
  }, [])

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
    if (typeof cursor === 'number' && cursor >= 0) live.current = cursor
    // 失焦也要写：写下真实位置，重新聚焦才落在用户离开处
    const next = decideBlurCursor(live.current >= 0 ? live.current : undefined)
    if (next !== null) applyShot(next)
  }, [applyShot])

  const position = useCallback((len: number) => {
    const p = live.current
    if (p < 0) return len
    return Math.min(p, len)
  }, [])

  return { cursor: shot, focus: focused, track, request, refocus, blur, position }
}
