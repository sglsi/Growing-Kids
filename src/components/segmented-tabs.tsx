import { View, Text } from '@tarojs/components'

interface Option<V extends string = string> {
  value: V
  label: string
}

interface Props<V extends string = string> {
  value: V
  onValueChange: (v: V) => void
  options: Option<V>[]
  className?: string
  /** 标签密度：compact 用于工具型切换（首页「资料库」入口）；default 用于主流程 */
  variant?: 'default' | 'compact'
}

/**
 * 分段切换器：替换页面里手搓的「flex bg-muted rounded-xl p-1 + shadow-sm」分段 Tab。
 * 统一视觉：墨色块 + 朱砂红指针（待 DESIGN.md 收敛后切换为更纯粹的纸感）。
 */
export default function SegmentedTabs<V extends string = string>({
  value, onValueChange, options, className = '', variant = 'default',
}: Props<V>) {
  const wrapperClass = variant === 'compact'
    ? 'flex flex-row bg-muted rounded-xl p-1 gap-1'
    : 'flex flex-row bg-muted rounded-xl p-1'

  return (
    <View className={`${wrapperClass} ${className}`}>
      {options.map((o) => {
        const active = value === o.value
        return (
          <View
            key={o.value}
            className={`flex-1 flex items-center justify-center h-9 rounded-lg ${active ? 'bg-background shadow-sm' : ''}`}
            onClick={() => onValueChange(o.value)}
          >
            <Text className={`block text-sm whitespace-nowrap ${active ? 'text-primary font-medium' : 'text-muted-foreground'}`}>
              {o.label}
            </Text>
          </View>
        )
      })}
    </View>
  )
}