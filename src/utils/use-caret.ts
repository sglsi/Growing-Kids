import { useCallback, useRef, useState } from 'react'
import { decideBlurCursor, diffCursor } from './caret-decision'

/**
 * 输入框光标的「庇护所」（思傅 2026-10-26 起；2026-10-31 第十次重写，定性）
 *
 * ## 定性结论（两条平台规则叠加，前九版全栽在这里）
 *
 * 1. 微信 `textarea` 是**原生组件**：页面 setData 时它按虚拟 DOM 的 `value`
 *    重新应用文本，**光标落到末尾**；
 * 2. Taro 对表单元素有一条无条件规则：`@tarojs/react/dist/react.esm.js:372`
 *    `if (oldProps[i] !== newProps[i] || (isFormElement && i === 'value'))`
 *    —— 只要发生一次 commit，`value` 就必然进 setData。
 *
 * ⇒ **页面在 onInput 里 setState，就是"每打一个字把光标重置一次"**。
 *   这是页面层的行为，改输入框组件永远治不到（前九轮的最大教训）。
 *   ⇒ 页面必须把实时文本放 ref、输入期间不 setState（detail 页已按此改）；
 *   ⇒ 组件保证下发的 value 永远等于用户眼前的文本（见 ui/textarea.tsx）。
 *
 * ## 本 hook 的职责：记录位置 + 程序化定位
 *   1. `track(cursor?, value?)`：onInput / onFocus 里调用。**只记录**光标，
 *      用 `diffCursor(上一次文本, 这一次文本)` 算（`detail.cursor` 在中间输入时不可信）。
 *      不下发 cursor —— 输入期间写它无效，且一写就等于要求一次 commit。
 *   2. `request(pos, value?)`：程序化插入后调用（插入数学符号 / OCR 回填）。
 *      cursor 变化同时是"外部写入"的可靠信号（见 resolveDisplayText）。
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
    // 但**只记录、不下发**：输入期间写 cursor 无效，而且它一变化就等于
    // 要求输入框 commit 一次（详情见本文件顶部定性）。
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
