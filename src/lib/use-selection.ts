// ============================================================
// 批量选择 hook + 通用确认弹窗
// 各列表页（首页 / 复习本 / 资料库 / 文档）共用的选择逻辑
// ============================================================
import { useCallback, useMemo, useState } from 'react'
import Taro from '@tarojs/taro'

export interface Selection {
  selecting: boolean
  selected: Set<string>
  count: number
  isEmpty: boolean
  enter: () => void
  exit: () => void
  clear: () => void
  toggle: (id: string) => void
  /** 长按进入选择模式并选中该项 */
  longPress: (id: string) => void
}

export function useSelection(): Selection {
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const enter = useCallback(() => setSelecting(true), [])

  const exit = useCallback(() => {
    setSelecting(false)
    setSelected(new Set())
  }, [])

  const clear = useCallback(() => setSelected(new Set()), [])

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const longPress = useCallback(
    (id: string) => {
      setSelecting(true)
      setSelected((prev) => {
        const next = new Set(prev)
        next.add(id)
        return next
      })
    },
    [],
  )

  return useMemo(
    () => ({
      selecting,
      selected,
      count: selected.size,
      isEmpty: selected.size === 0,
      enter,
      exit,
      clear,
      toggle,
      longPress,
    }),
    [selecting, selected, enter, exit, clear, toggle, longPress],
  )
}

/** 删除确认弹窗；返回用户是否确认 */
export function confirmDelete(count: number, noun = '条'): Promise<boolean> {
  return new Promise((resolve) => {
    Taro.showModal({
      title: '确认删除',
      content: `确定删除选中的 ${count} ${noun}吗？删除后无法恢复。`,
      confirmColor: '#BE3E2D',
      success: (r) => resolve(!!r.confirm),
      fail: () => resolve(false),
    })
  })
}

export { formatTime, formatDate, truncate } from '@/types'
