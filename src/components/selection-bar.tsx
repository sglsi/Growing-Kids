import { View, Text } from '@tarojs/components'
import { Check } from 'lucide-react-taro'
import type { Selection } from '@/lib/use-selection'

interface CheckDotProps {
  checked: boolean
  size?: number
}

/** 选中状态圆点：复用 document / library / review-item-card 中的勾选圈样式 */
export function CheckDot({ checked, size = 20 }: CheckDotProps) {
  return (
    <View
      className={`flex-shrink-0 rounded-full border flex items-center justify-center ${
        checked ? 'bg-primary border-primary' : 'border-muted-foreground'
      }`}
      style={{ width: `${size}px`, height: `${size}px` }}
    >
      {checked ? <Check size={Math.round(size * 0.65)} color="#fff" /> : null}
    </View>
  )
}

interface SelectionBarProps {
  selection: Selection
  /** 未进入选择态时右侧按钮文案，默认「批量选择」 */
  enterLabel?: string
  /** 选择态时文案前缀，默认「已选」 */
  countPrefix?: string
  /** 选择态时「清空」按钮文案，默认「清空」 */
  clearLabel?: string
  /** 选择态时是否显示「全选」按钮（可选用，使用方提供 handler） */
  onSelectAll?: () => void
  /** 「全选」按钮文案，默认「全选」 */
  selectAllLabel?: string
}

/**
 * 批量选择状态条：统一「未选 → 已选 X | 清空 | 取消」的视觉。
 * 在 document / library / subject / index 顶部右侧共用。
 */
export default function SelectionBar({
  selection, enterLabel = '批量选择', countPrefix = '已选', clearLabel = '清空',
  onSelectAll, selectAllLabel = '全选',
}: SelectionBarProps) {
  if (!selection.selecting) {
    return (
      <Text className="block text-sm text-primary" onClick={selection.enter}>{enterLabel}</Text>
    )
  }
  return (
    <View className="flex flex-row items-center gap-3">
      <Text className="block text-sm text-foreground">{countPrefix} {selection.count}</Text>
      {onSelectAll ? (
        <Text className="block text-sm text-muted-foreground" onClick={onSelectAll}>{selectAllLabel}</Text>
      ) : null}
      {selection.count > 0 ? (
        <Text className="block text-sm text-muted-foreground" onClick={selection.clear}>{clearLabel}</Text>
      ) : null}
      <Text className="block text-sm text-primary" onClick={selection.exit}>取消</Text>
    </View>
  )
}