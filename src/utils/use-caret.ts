import { useCallback, useRef, useState } from 'react'

/**
 * 输入框光标的「庇护所」（思傅 2026-10-26 修「编辑时光标跳到最末尾」）
 *
 * 病因：此前每敲一个字都把 `cursor` 属性重新绑到 Textarea 上（onInput 里 setState）。
 * 微信原生 textarea 收到 cursor 变化会按这个值重新定位光标，于是——
 *   · 中文输入法处于组词过程时，事件里给的 cursor 与原生真实位置不一致 → 光标被拽走；
 *   · 回车、在段落末尾输入、事件里根本没带 cursor（退化成 -1）等场景，
 *     原生把它当成「定位到末尾」处理 → 光标直接跳到全文最后。
 *
 * 治法：
 *   1. 光标位置记在 ref 里，不再触发重渲染，也不再每帧改 cursor 属性 —— 用户怎么打字都不干预；
 *   2. 只有**程序化插入**（数学符号、识别结果回填）时才 request(pos) 一次性定位，
 *      插入完立刻把这次定位消费掉，恢复「不指定光标」；
 *   3. 插入位置取自最近一次真实输入事件的 cursor，越界自动退化为文本末尾。
 */
export interface Caret {
  /** 传给 Textarea 的 cursor；-1 = 不指定（原生按自己的规则走） */
  cursor: number
  /** 传给 Textarea 的 focus：插入符号后要把输入态还回去，否则得再点一次输入框 */
  focus: boolean
  /** onInput 里调用：只记录位置，不重渲染 */
  track: (cursor?: number) => void
  /** 程序化插入文本后调用：请求把光标定位到 pos（一次性） */
  request: (pos: number) => void
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
  /** 一次性定位的镜像（用于在 track 里判断是否需要撤销，不依赖 state 闭包） */
  const shotRef = useRef(-1)
  /** 一次性定位：只有它会被写进 cursor 属性 */
  const [shot, setShot] = useState(-1)
  /** 受控聚焦态（见 Caret.refocus 的说明） */
  const [focused, setFocused] = useState(false)

  const track = useCallback((cursor?: number) => {
    if (typeof cursor === 'number' && cursor >= 0) live.current = cursor
    // 用户自己继续输入了 ⇒ 上次的程序化定位已过期，撤销它
    // （不撤的话，旧位置会在后续渲染里把光标又拽回去，越写越乱）
    if (shotRef.current >= 0) {
      shotRef.current = -1
      setShot(-1)
    }
  }, [])

  const request = useCallback((pos: number) => {
    const p = pos >= 0 ? pos : 0
    live.current = p
    shotRef.current = p
    setShot(p)
  }, [])

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
