import { View, Text } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { getSubjectColor, type QuestionWithSubject } from '@/types'

// 跨端截断（小程序对 line-clamp 支持不稳定，用 JS 截断）
function truncate(s: string, n: number) {
  if (!s) return ''
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function formatDate(iso: string) {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

interface Props {
  item: QuestionWithSubject
  showSubject?: boolean
}

export default function QuestionCard({ item, showSubject = true }: Props) {
  const color = getSubjectColor(item.subjects?.color || 'gray-500')
  const subjectName = item.subjects?.name || '未分类'
  const goDetail = () => {
    Taro.navigateTo({ url: `/pages/detail/index?id=${item.id}` })
  }

  return (
    <Card className="rounded-2xl border-border overflow-hidden" onClick={goDetail}>
      <View className="flex flex-row">
        {/* 学科色条 */}
        <View className={`w-2 self-stretch ${color.bar}`} />
        <View className="flex-1 p-4">
          <View className="flex flex-row items-center justify-between mb-2">
            <View className="flex flex-row items-center gap-2">
              {showSubject && (
                <Badge variant="outline" className={`${color.badge} border rounded-full px-2 py-0 text-xs`}>
                  {subjectName}
                </Badge>
              )}
              {item.status === 'pending' && (
                <Badge className="bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-2 py-0 text-xs">
                  待找答案
                </Badge>
              )}
            </View>
            <Text className="block text-xs text-muted-foreground">{formatDate(item.recognized_at)}</Text>
          </View>

          <Text className="block text-sm text-foreground leading-relaxed mb-2">
            {truncate(item.question_content, 80) || '（图片题目）'}
          </Text>

          {item.answer_content ? (
            <View className="flex flex-row items-start gap-2 bg-muted bg-opacity-60 rounded-lg p-2">
              <Text className="block text-xs font-medium shrink-0 pt-1" style={{ color: '#BE3E2D' }}>正确答案</Text>
              <Text className="block flex-1 text-xs leading-relaxed" style={{ color: '#BE3E2D' }}>
                {truncate(item.answer_content, 60)}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </Card>
  )
}
