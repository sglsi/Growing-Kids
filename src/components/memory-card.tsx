import { View, Text, Image } from '@tarojs/components'
import { Camera, Music, Film, Ellipsis } from 'lucide-react-taro'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { CheckDot } from '@/components/selection-bar'
import { getSubjectColor, formatDate } from '@/types'
import {
  type Memory, type MemoryMedia,
  MEMORY_CATEGORIES, getMemoryCategoryLabel, getMemoryMoodLabel, getMemoryMoodEmoji,
} from '@/services/memory'

interface Props {
  memory: Memory
  /** 第一张媒体（详情页传 media[0]；列表页通过 thumbUrl 拿到 cover） */
  media?: MemoryMedia[]
  /** 选择态：显示勾选圈 */
  selecting?: boolean
  checked?: boolean
  onClick?: (memory: Memory) => void
  onLongPress?: (memory: Memory) => void
  onMore?: (memory: Memory) => void
}

/**
 * 记忆卡（公用组件）
 * - 紧凑模式：列表项（标题 + 内容截断 + 媒体预览行 + 标签 + 操作）
 * - 内容 3 行截断；媒体 1-4 张图片预览 / 音频行 / 视频角标
 */
export default function MemoryCard({
  memory, media, selecting = false, checked = false,
  onClick, onLongPress, onMore,
}: Props) {
  const subjectName = memory.subject?.name || ''
  const subjectColor = getSubjectColor(memory.subject?.color)
  const categoryLabel = getMemoryCategoryLabel(memory.category)
  const moodEmoji = getMemoryMoodEmoji(memory.mood)
  const moodLabel = getMemoryMoodLabel(memory.mood)
  const time = formatDate(memory.occurredAt || memory.createdAt || '')

  // 媒体预览：图片优先首张；视频/音频显示角标
  const firstImage = media?.find((m) => m.kind === 'image')
  const cover = memory.thumbUrl
    || memory.coverUrl
    || firstImage?.url
    || firstImage?.thumbUrl
    || ''
  const imageMediaCount = media?.filter((m) => m.kind === 'image').length ?? 0
  const audioMediaCount = media?.filter((m) => m.kind === 'audio').length ?? 0
  const videoMediaCount = media?.filter((m) => m.kind === 'video').length ?? 0

  // 内容（3 行截断）
  const contentText = (memory.content || memory.title || '').trim()
  const content = contentText.length > 120 ? `${contentText.slice(0, 120)}…` : contentText

  const moreBtn = onMore && !selecting ? (
    <View
      className="w-8 h-8 flex items-center justify-center -mr-2"
      onClick={(e) => { e.stopPropagation?.(); onMore(memory) }}
    >
      <Ellipsis size={18} color="#9A948A" />
    </View>
  ) : null

  return (
    <Card
      className={`rounded-2xl border-border ${checked ? 'border-primary' : ''}`}
      onClick={() => onClick?.(memory)}
      onLongPress={() => onLongPress?.(memory)}
    >
      <View className="flex flex-row">
        {selecting && (
          <View className="pl-3 flex items-center">
            <CheckDot checked={!!checked} size={20} />
          </View>
        )}
        {/* 学习类记忆显示学科色条 */}
        {memory.category === 'study' && subjectName ? (
          <View className={`w-2 self-stretch ${subjectColor.bar}`} />
        ) : (
          <View className="w-2 self-stretch bg-primary opacity-50" />
        )}
        <View className="flex-1 p-4">
          {/* 第一行：日期 + 分类 + 心情 + 更多 */}
          <View className="flex flex-row items-center justify-between mb-2">
            <View className="flex flex-row items-center gap-2 flex-1 min-w-0">
              <Text className="block text-xs text-muted-foreground shrink-0">{time}</Text>
              <Badge variant="outline" className="bg-muted text-foreground border rounded-full px-2 py-0 text-xs">
                {categoryLabel}
              </Badge>
              {memory.category === 'study' && subjectName && (
                <Badge variant="outline" className={`${subjectColor.badge} border rounded-full px-2 py-0 text-xs`}>
                  {subjectName}
                </Badge>
              )}
              {moodEmoji && (
                <Text className="block text-sm shrink-0">
                  {moodEmoji}
                  {moodLabel ? (
                    <Text className="block text-xs text-muted-foreground inline ml-1">{moodLabel}</Text>
                  ) : null}
                </Text>
              )}
            </View>
            {moreBtn}
          </View>

          {/* 内容 */}
          {content ? (
            <Text className="block text-sm text-foreground leading-relaxed mb-2">
              {content}
            </Text>
          ) : null}

          {/* 媒体预览 */}
          {cover ? (
            <View className="flex flex-row gap-1.5 mb-2">
              <View className="w-24 h-24 rounded-lg overflow-hidden bg-muted">
                <Image src={cover} mode="aspectFill" style={{ width: '100%', height: '100%' }} />
              </View>
              {imageMediaCount > 1 && (
                <View className="w-24 h-24 rounded-lg bg-muted bg-opacity-40 flex items-center justify-center">
                  <Text className="block text-sm text-muted-foreground">+{imageMediaCount - 1} 张</Text>
                </View>
              )}
              {videoMediaCount > 0 && (
                <View className="w-24 h-24 rounded-lg bg-muted bg-opacity-40 flex items-center justify-center gap-1">
                  <Film size={20} color="#6B635C" />
                  <Text className="block text-xs text-muted-foreground">{videoMediaCount}</Text>
                </View>
              )}
              {audioMediaCount > 0 && (
                <View className="w-24 h-24 rounded-lg bg-muted bg-opacity-40 flex items-center justify-center gap-1">
                  <Music size={20} color="#6B635C" />
                  <Text className="block text-xs text-muted-foreground">{audioMediaCount}</Text>
                </View>
              )}
            </View>
          ) : null}

          {/* 标签 + 媒体计数 */}
          <View className="flex flex-row items-center justify-between flex-wrap gap-1">
            <View className="flex flex-row items-center gap-1 flex-wrap">
              {memory.tags.slice(0, 3).map((t) => (
                <Text key={t} className="block text-xs text-muted-foreground">#{t}</Text>
              ))}
            </View>
            <View className="flex flex-row items-center gap-2 text-muted-foreground">
              {memory.mediaCount > 0 && !cover && (
                <View className="flex flex-row items-center gap-1">
                  <Camera size={12} color="#9A948A" />
                  <Text className="block text-xs">{memory.mediaCount}</Text>
                </View>
              )}
              {memory.audioDuration ? (
                <View className="flex flex-row items-center gap-1">
                  <Music size={12} color="#9A948A" />
                  <Text className="block text-xs">{formatDurationShort(memory.audioDuration)}</Text>
                </View>
              ) : null}
            </View>
          </View>
        </View>
      </View>
    </Card>
  )
}

/** 时长显示：92 → "1:32" */
function formatDurationShort(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

// 导出分类列表给页面级 SegmentedTabs 使用
export { MEMORY_CATEGORIES }