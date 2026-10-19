import { View, Text } from '@tarojs/components'
import type { ReactNode } from 'react'
import { getSubjectColor } from '@/types'

interface Props {
  /** 学科名（如「数学」）；为空时显示「未分类」 */
  name: string
  /** 学科 color 值（如 'blue-500'），与 src/types 的 SUBJECT_COLOR_MAP 对齐 */
  color?: string
  /** 选中态（深色填充），用于学科筛选条 */
  active?: boolean
  /** 显示 › 表示该项可点击切换；用于「最近题目」里的手动改分类 */
  showArrow?: boolean
  size?: 'sm' | 'md'
  /** 右侧附加内容：例如数字、勾选、tag 等 */
  trailing?: ReactNode
  onClick?: () => void
}

/**
 * 学科胶囊：统一全站学科标签的视觉
 * - 非选中：浅色背景 + 学科色小点 + 学科文字
 * - 选中：深色背景（primary）+ 白色文字
 * - size=sm 用于列表卡片内（review-item-card），md 用于学科筛选行
 */
export default function SubjectBadge({
  name, color, active = false, showArrow = false, size = 'md', trailing, onClick,
}: Props) {
  const c = getSubjectColor(color)
  const paddingClass = size === 'sm' ? 'px-2 py-1' : 'px-3 py-2'
  const textClass = 'text-xs'

  if (active) {
    return (
      <View
        className={`flex flex-row items-center gap-2 rounded-full border bg-primary border-primary ${paddingClass}`}
        onClick={onClick}
      >
        <Text className={`block ${textClass} text-primary-foreground`}>{name}</Text>
        {trailing}
      </View>
    )
  }

  return (
    <View
      className={`flex flex-row items-center gap-2 rounded-full border ${c.badge} ${paddingClass}`}
      onClick={onClick}
    >
      <View className={`w-2 h-2 rounded-full ${c.dot}`} />
      <Text className={`block ${textClass}`}>{name}</Text>
      {showArrow ? <Text className={`block ${textClass} opacity-60`}>›</Text> : null}
      {trailing}
    </View>
  )
}