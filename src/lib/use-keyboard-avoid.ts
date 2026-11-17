import Taro from '@tarojs/taro'
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 键盘避让（2026-11-02 思傅反馈：题目详情页「答案与解题过程」在最下端，
 * 手机弹出输入法后文本框被盖住，看不清也改不了）。
 *
 * ## 为什么原生的 `adjustPosition` 没救到
 *
 * 微信 textarea 的 `adjustPosition`（默认 true）语义是「**上推页面**」，
 * 它只会让**页面级滚动（page scroll）**发生位移。
 * 而本项目的列表/详情页都是 `<ScrollView style={{height:'100vh'}}>` 内部滚动，
 * 页面本身一像素都不动 ⇒ 原生上推落空 ⇒ 底部输入框被键盘整片盖住。
 *
 * ## 这个 hook 做什么
 *
 * 1. 监听 `onKeyboardHeightChange` 拿到**真实键盘高度**；
 * 2. 输入框聚焦后（等键盘动画结束）量一次它的位置，
 *    算出「底边越过键盘上沿多少」⇒ 把这段距离**加进 ScrollView 的 scrollTop**，
 *    输入框就正好浮到键盘上方（而不是光标贴着键盘边）；
 * 3. 同时把键盘高度作为**额外底部留白**返回给页面：
 *    scroll-view 不能滚过内容末尾，没有这段留白，滚到底也还差一截。
 *
 * ## 用法（三步，缺一不可）
 *
 * ```tsx
 * const kb = useKeyboardAvoid()
 * <ScrollView scrollTop={kb.scrollTop} onScroll={kb.onScroll} ...>
 *   <View style={{ paddingBottom: kb.bottomPadding }}>
 *     ...
 *     <View id="answer-box">
 *       <Textarea onFocus={() => kb.reveal('#answer-box')} ... />
 *     </View>
 * ```
 *
 * ⚠️ 两条纪律：
 * - `reveal()` 传的是**包裹输入框的容器**（不是 textarea 本身）：
 *   原生 textarea 是原生组件，`boundingClientRect` 拿到的位置在部分机型上
 *   是「原生层坐标」，而容器是 WebView 层坐标，用容器量更稳。
 * - 同时只有一个 hook 实例管一个滚动容器；同一个页面有两个滚动容器时，
 *   只给**装着输入框的那个**接。
 */

/** 键盘上沿与输入框底边之间留的空隙（px）——不留就会被键盘顶边压住一行 */
const GAP = 16
/** 等键盘弹出的时间：微信键盘动画约 250~300ms，太早量到的是「没有键盘」的位置 */
const WAIT_KEYBOARD_MS = 320

interface KeyboardChange {
  height: number
}

export interface KeyboardAvoid {
  /** 交给 ScrollView 的受控滚动位置 */
  scrollTop: number
  /** 交给 ScrollView 的 onScroll（用来记住用户当前滚到哪，增量才好算） */
  onScroll: (e: { detail?: { scrollTop?: number } }) => void
  /** 内容区底部留白：键盘高度 + 安全余量。没它 scroll-view 滚不到那么深 */
  bottomPadding: number
  /** 当前键盘高度（0 = 收起） */
  keyboardHeight: number
  /** 输入框聚焦时调用：参数是包裹输入框的容器选择器，如 `#answer-box` */
  reveal: (selector: string) => void
  /** 主动把 ScrollView 滚到指定位置（删除列表项后原位补偿用） */
  scrollTo: (top: number) => void
}

export function useKeyboardAvoid(basePadding = 0): KeyboardAvoid {
  const [scrollTop, setScrollTop] = useState(0)
  const [keyboardHeight, setKeyboardHeight] = useState(0)
  /** 用户/我们最后一次已知的滚动位置（受控值不一定等于真实值，以事件为准） */
  const scrollTopRef = useRef(0)
  const kbRef = useRef(0)

  useEffect(() => {
    const onChange = (res: KeyboardChange) => {
      const h = Math.max(0, res?.height || 0)
      kbRef.current = h
      setKeyboardHeight(h)
    }
    // `onKeyboardHeightChange` 在 H5 端不存在，可选调用避免直接崩
    Taro.onKeyboardHeightChange?.(onChange)
    return () => {
      Taro.offKeyboardHeightChange?.(onChange)
    }
  }, [])

  const onScroll = useCallback((e: { detail?: { scrollTop?: number } }) => {
    scrollTopRef.current = e?.detail?.scrollTop || 0
  }, [])

  const reveal = useCallback((selector: string) => {
    // 键盘动画结束后再量：太早量到的是「键盘还没起来」的位置，算出来的位移是 0
    setTimeout(() => {
      const query = Taro.createSelectorQuery()
      query.select(selector).boundingClientRect()
      query.exec((res: unknown[]) => {
        const rect = res?.[0] as { top?: number; bottom?: number; height?: number } | null
        if (!rect || typeof rect.bottom !== 'number') return
        const info = Taro.getWindowInfo?.() || Taro.getSystemInfoSync()
        const windowHeight = info?.windowHeight || 0
        if (!windowHeight) return
        // 键盘收起时（高度 0）不做任何事：用户可能只是点了下框又收起来
        const kb = kbRef.current
        const visibleBottom = windowHeight - kb
        const overflow = rect.bottom - visibleBottom + GAP
        if (overflow <= 0) return
        const next = scrollTopRef.current + overflow
        scrollTopRef.current = next
        setScrollTop(next)
      })
    }, WAIT_KEYBOARD_MS)
  }, [])

  const scrollTo = useCallback((top: number) => {
    const next = Math.max(0, top)
    scrollTopRef.current = next
    setScrollTop(next)
  }, [])

  return {
    scrollTop,
    onScroll,
    keyboardHeight,
    // 键盘高度已经够让内容滚到输入框露出来；再加 basePadding（页面原本的 pb）
    bottomPadding: basePadding + keyboardHeight,
    reveal,
    scrollTo,
  }
}
