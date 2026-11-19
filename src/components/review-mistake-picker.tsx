/**
 * P-034 §3.4 / §3.6：点「做错了」之后的错因四选一弹窗（可跳过）。
 * ------------------------------------------------------------------
 * 为什么独立成文件而不是塞进 review-queue：
 *   ① M73 A6 断言锁死「复习作答卡不得出现 error_analysis / 答案 / 解析」——
 *      这是 L2「无提示」的物理保证：作答同屏能看到错因，就能"看着提示点做对"。
 *      错因只准在**点完做错之后**出现，故放在独立组件、作答卡不引用其字段。
 *   ② 采集点纪律（思傅 2026-11-19 拍板）：只对做错的题问一次、可跳过、
 *      做对不弹、跳过也能记对错——不阻塞作答是硬要求。
 *
 * B5 当场反馈：若该题已有错因（历史录入），在选项上方显示，
 * 让家长当场讲一遍（GK-SRS-24 §4.3 话术：把"你怎样"换成"这一步怎样"），
 * 而不是拖到下次打开——跨度太长，反馈就失效了。
 */
import { View, Text } from '@tarojs/components'
import { Button } from '@/components/ui/button'
import { MISTAKE_LABELS } from '@/services/api'
import type { ErrorAnalysis } from '@/types'
import { BRAND_TEXT, DANGER } from '@/lib/theme'

export interface MistakeChoice {
  type: ErrorAnalysis['type']
  confidence?: 'high' | 'low'
}

interface Props {
  /** 该题历史错因的展示名（若有）——当场反馈用，不是本次作答的提示 */
  existingLabel?: string
  onPick: (choice: MistakeChoice | null) => void
  busy?: boolean
}

/** 家长可快速点的五个高频错因；跳过由调用方的 null 表达 */
const QUICK: ErrorAnalysis['type'][] = [
  'concept-mix',
  'method-step',
  'careless-calc',
  'misread',
  'careless-sign',
]

export default function ReviewMistakePicker({ existingLabel, onPick, busy }: Props) {
  return (
    <View className="rounded-2xl border border-border p-4 mb-4">
      <Text className="block text-sm font-medium text-foreground mb-2">这次卡在哪一步？</Text>
      <Text className="block text-xs text-muted-foreground mb-3">
        选一个大概原因，方便以后回看；不好判断就跳过，不影响记对错。
      </Text>

      {/* B5 当场反馈：历史错因只在这里（点错之后）出现，作答同屏始终看不到 */}
      {existingLabel ? (
        <View className="rounded-xl bg-muted px-3 py-2 mb-3">
          <Text className="block text-xs text-muted-foreground">上次这题记的是：{existingLabel}</Text>
          <Text className="block text-xs text-muted-foreground mt-1">
            先让孩子讲一遍「这一步为什么成立」，讲不出就是真还没会。
          </Text>
        </View>
      ) : null}

      <View className="flex flex-row flex-wrap gap-2 mb-3">
        {QUICK.map((t) => (
          <Button
            key={t}
            variant="outline"
            className="h-9 rounded-lg px-3"
            disabled={busy}
            onClick={() => onPick({ type: t })}
          >
            <Text className="block text-xs" style={{ color: BRAND_TEXT }}>
              {MISTAKE_LABELS[t] ?? t}
            </Text>
          </Button>
        ))}
      </View>

      <View className="flex flex-row gap-2">
        <Button variant="outline" className="h-9 rounded-lg flex-1" disabled={busy} onClick={() => onPick(null)}>
          <Text className="block text-xs text-muted-foreground">跳过</Text>
        </Button>
      </View>
      <Text className="block text-xs mt-2" style={{ color: DANGER }}>
        选的是「这次做错的原因」，不是给孩子贴标签——别说「你怎么又粗心」。
      </Text>
    </View>
  )
}
