import { View, Text, ScrollView } from '@tarojs/components'

export type RangeValue = 'auto' | 'day1' | 'day2' | 'day3' | 'week' | 'month' | 'all'

export interface RangeOption {
  value: RangeValue
  label: string
}

export const RANGE_OPTIONS: RangeOption[] = [
  { value: 'auto', label: '自动' },
  { value: 'day1', label: '近 1 天' },
  { value: 'day2', label: '近 2 天' },
  { value: 'day3', label: '近 3 天' },
  { value: 'week', label: '近一周' },
  { value: 'month', label: '近一月' },
  { value: 'all', label: '全部' },
]

/**
 * 根据 RangeValue + 当前列表最新时间算出 since（ISO）。
 * - 'all' 或 'auto' 无最新数据 → undefined
 * - 'auto' + 最新时间 → 自适应选 1/3/7/30 天覆盖
 */
export function getSinceFromRange(
  v: RangeValue,
  latestTimestamp?: string | null,
): string | undefined {
  if (v === 'all') return undefined
  if (v === 'auto') {
    if (!latestTimestamp) return undefined
    const last = new Date(latestTimestamp)
    const ms = Date.now() - last.getTime()
    if (ms < 0) return new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const diffDays = Math.ceil(ms / (24 * 3600 * 1000))
    if (diffDays <= 1) return new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    if (diffDays <= 3) return new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString()
    if (diffDays <= 7) return new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
    if (diffDays <= 30) return new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
    return undefined
  }
  const days =
    v === 'day1' ? 1
    : v === 'day2' ? 2
    : v === 'day3' ? 3
    : v === 'week' ? 7
    : 30
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()
}

interface Props {
  value: RangeValue
  onChange: (v: RangeValue) => void
}

/**
 * 时间段筛选器（横向滚动 chip 行）。
 * 视觉沿用学科胶囊样式：未选用 bg-background + border-border + 圆点色（无），
 * 选用 bg-primary + border-primary + 白字。
 */
export default function RangePicker({ value, onChange }: Props) {
  return (
    <ScrollView scrollX className="whitespace-nowrap" enhanced showScrollbar={false}>
      <View className="flex flex-row gap-2">
        {RANGE_OPTIONS.map((o) => {
          const active = o.value === value
          return (
            <View
              key={o.value}
              className={`flex flex-row items-center rounded-full border px-3 py-1 ${
                active ? 'bg-primary border-primary' : 'bg-background border-border'
              }`}
              onClick={() => onChange(o.value)}
            >
              <Text
                className={`block text-xs whitespace-nowrap ${
                  active ? 'text-primary-foreground' : 'text-foreground'
                }`}
              >
                {o.label}
              </Text>
            </View>
          )
        })}
      </View>
    </ScrollView>
  )
}