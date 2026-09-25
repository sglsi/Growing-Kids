import { View, Text, Image } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { Check, Image as ImageIcon } from 'lucide-react-taro'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { getSubjectColor, itemStatus, truncate, formatDate } from '@/types'
import type { TimelineItem } from '@/types'

interface Props {
  item: TimelineItem
  showSubject?: boolean
  /** 选择态：显示勾选圈，点击为切换选择 */
  selecting?: boolean
  checked?: boolean
  onOpen?: (item: TimelineItem) => void
  onLongPress?: (item: TimelineItem) => void
  /** 复习本里展示「加入时间」而非创建时间 */
  timeField?: 'created_at' | 'added_to_review_at'
}

/**
 * 统一条目卡片：同时适配 kind=question 与 kind=image
 * 替换旧的 QuestionCard（旧组件仅支持题目）
 */
export default function ReviewItemCard({
  item, showSubject = true, selecting = false, checked = false,
  onOpen, onLongPress, timeField = 'created_at',
}: Props) {
  const color = getSubjectColor(item.subjects?.color)
  const subjectName = item.subjects?.name || '未分类'
  const status = itemStatus(item)

  const handleClick = () => {
    if (selecting) {
      onOpen?.(item)
      return
    }
    onOpen?.(item)
  }

  const goDetail = () => Taro.navigateTo({ url: `/pages/detail/index?id=${item.id}` })
  const open = onOpen || (() => goDetail())

  const time = formatDate((timeField === 'added_to_review_at' ? item.added_to_review_at : item.created_at) || '')

  // ---------- 图片条目：缩略图卡片 ----------
  if (item.kind === 'image') {
    const thumb = item.thumb_url || item.url || ''
    return (
      <Card
        className={`rounded-2xl border-border overflow-hidden ${checked ? 'border-primary' : ''}`}
        onClick={handleClick}
        onLongPress={() => onLongPress?.(item)}
      >
        <View className="flex flex-row">
          {selecting && (
            <View className="pl-3 flex items-center">
              <View className={`w-5 h-5 rounded-full border flex items-center justify-center ${checked ? 'bg-primary border-primary' : 'border-muted-foreground'}`}>
                {checked && <Check size={13} color="#fff" />}
              </View>
            </View>
          )}
          <View className={`w-2 self-stretch ${color.bar}`} />
          <View className="flex-1 p-3 flex flex-row gap-3">
            <View className="w-20 h-24 flex-shrink-0 overflow-hidden rounded-lg bg-muted">
              {thumb ? (
                <Image src={thumb} mode="aspectFill" style={{ width: '100%', height: '100%' }} />
              ) : (
                <View className="w-full h-full flex items-center justify-center">
                  <ImageIcon size={22} color="#aaa" />
                </View>
              )}
            </View>
            <View className="flex-1 min-w-0">
              <View className="flex flex-row items-center gap-2 mb-1">
                {showSubject && (
                  <Badge variant="outline" className={`${color.badge} border rounded-full px-2 py-0 text-xs`}>
                    {subjectName}
                  </Badge>
                )}
                {item.in_review_book && (
                  <Badge className="bg-primary text-primary-foreground border border-primary rounded-full px-2 py-0 text-xs">
                    复习本
                  </Badge>
                )}
              </View>
              <Text className="block text-sm text-foreground leading-relaxed">
                {truncate(item.title || '图片资料', 24)}
              </Text>
              <Text className="block text-xs text-muted-foreground mt-1">{time}</Text>
            </View>
          </View>
        </View>
      </Card>
    )
  }

  // ---------- 题目条目：学科色条 + 题干 + 答案摘要 ----------
  const c = item.content || {}
  return (
    <Card
      className={`rounded-2xl border-border overflow-hidden ${checked ? 'border-primary' : ''}`}
      onClick={handleClick}
      onLongPress={() => onLongPress?.(item)}
    >
      <View className="flex flex-row">
        {selecting && (
          <View className="pl-3 flex items-center">
            <View className={`w-5 h-5 rounded-full border flex items-center justify-center ${checked ? 'bg-primary border-primary' : 'border-muted-foreground'}`}>
              {checked && <Check size={13} color="#fff" />}
            </View>
          </View>
        )}
        <View className={`w-2 self-stretch ${color.bar}`} />
        <View className="flex-1 p-4">
          <View className="flex flex-row items-center justify-between mb-2">
            <View className="flex flex-row items-center gap-2">
              {showSubject && (
                <Badge variant="outline" className={`${color.badge} border rounded-full px-2 py-0 text-xs`}>
                  {subjectName}
                </Badge>
              )}
              {status === 'pending' && (
                <Badge className="bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-2 py-0 text-xs">
                  待找答案
                </Badge>
              )}
              {item.mastered && (
                <Badge className="bg-emerald-600 text-emerald-50 border border-emerald-600 rounded-full px-2 py-0 text-xs">
                  已掌握
                </Badge>
              )}
              {item.in_review_book && timeField === 'created_at' && (
                <Badge className="bg-primary text-primary-foreground border border-primary rounded-full px-2 py-0 text-xs">
                  复习本
                </Badge>
              )}
            </View>
            <Text className="block text-xs text-muted-foreground shrink-0">{time}</Text>
          </View>

          <Text className="block text-sm text-foreground leading-relaxed mb-2">
            {truncate(c.question || '', 80) || '（图片题目）'}
          </Text>

          {c.answer ? (
            <View className="flex flex-row items-start gap-2 bg-muted bg-opacity-60 rounded-lg p-2">
              <Text className="block text-xs font-medium shrink-0 pt-1" style={{ color: '#BE3E2D' }}>正确答案</Text>
              <Text className="block flex-1 text-xs leading-relaxed" style={{ color: '#BE3E2D' }}>
                {truncate(c.answer, 60)}
              </Text>
            </View>
          ) : null}

          {open !== goDetail && item.image_urls?.length ? (
            <Text className="block text-xs text-muted-foreground mt-2">含 {item.image_urls.length} 张图片</Text>
          ) : null}
        </View>
      </View>
    </Card>
  )
}
