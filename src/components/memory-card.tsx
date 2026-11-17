import { View, Text, Image } from '@tarojs/components'
import { Camera, Music, Film, Ellipsis, Play } from 'lucide-react-taro'
import { Card } from '@/components/ui/card'
import { CheckDot } from '@/components/selection-bar'
import { formatDate } from '@/types'
import {
  type Memory, type MemoryMedia,
  getMemoryMoodLabel, getMemoryMoodEmoji,
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

/** 缩略图右下角的小角标（数量 / 时长）：半透明黑底白字，压在图上也看得清 */
const BADGE_STYLE = {
  position: 'absolute',
  right: '4px',
  bottom: '4px',
  height: '18px',
  padding: '0 6px',
  borderRadius: '9px',
  backgroundColor: 'rgba(0,0,0,0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
} as const

/**
 * 记忆卡（公用组件）
 * - 紧凑模式：列表项（标题 + 内容截断 + 媒体预览行 + 标签 + 操作）
 * - 内容 3 行截断；媒体 1-4 张图片预览 / 音频行 / 视频角标
 */
export default function MemoryCard({
  memory, media, selecting = false, checked = false,
  onClick, onLongPress, onMore,
}: Props) {
  const moodEmoji = getMemoryMoodEmoji(memory.mood)
  const moodLabel = getMemoryMoodLabel(memory.mood)
  const time = formatDate(memory.occurredAt || memory.createdAt || '')

  // 媒体预览：图片封面 + 视频/音频格（2026-11-02 改）
  // ⚠️ 以前只用 `media` prop（只有详情页传），列表页**永远拿不到** ⇒ 无缩略图；
  //    现在服务端在列表里直接给 cover_thumb_url / media_kinds / media_counts。
  const firstImage = media?.find((m) => m.kind === 'image')
  const cover = memory.thumbUrl
    || memory.coverUrl
    || firstImage?.thumbUrl
    || firstImage?.url
    || ''
  const counts = memory.mediaCounts || {}
  const imageCount = media
    ? media.filter((m) => m.kind === 'image').length
    : (counts.image || (cover ? 1 : 0))
  const videoCount = media
    ? media.filter((m) => m.kind === 'video').length
    : (counts.video || 0)
  // 兜底：老后端只回 `audio_duration` / `media_count`，没有 media_counts。
  // 有音频时长就说明这条里有录音，至少画一格 —— 否则列表上看不出"这条是录音"。
  const audioCount = media
    ? media.filter((m) => m.kind === 'audio').length
    : (counts.audio || (memory.audioDuration ? 1 : 0))
  const videoDuration = memory.videoDuration || 0
  const hasMediaRow = !!cover || videoCount > 0 || audioCount > 0

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
      className={`rounded-2xl border-border ${checked ? 'border-brand-line' : ''}`}
      onClick={() => onClick?.(memory)}
      onLongPress={() => onLongPress?.(memory)}
    >
      <View className="flex flex-row">
        {selecting && (
          <View className="pl-3 flex items-center">
            <CheckDot checked={!!checked} size={20} />
          </View>
        )}
        {/* 思傅 2026-11-17：学科色条移除，统一用中性边线条（不抢层级） */}
        <View className="w-2 self-stretch bg-border" />
        <View className="flex-1 p-4">
          {/* 第一行：日期 + 心情 + 更多（分类/学科徽章 2026-11-17 移除） */}
          <View className="flex flex-row items-center justify-between mb-2">
            <View className="flex flex-row items-center gap-2 flex-1 min-w-0">
              <Text className="block text-xs text-muted-foreground shrink-0">{time}</Text>
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

          {/* 媒体预览：图片 / 视频 / 音频各一格，右下角叠数量 */}
          {hasMediaRow ? (
            <View className="flex flex-row gap-2 mb-2">
              {cover ? (
                <View className="w-24 h-24 rounded-xl overflow-hidden bg-muted" style={{ position: 'relative' }}>
                  <Image src={cover} mode="aspectFill" style={{ width: '100%', height: '100%' }} />
                  {imageCount > 1 ? (
                    <View style={BADGE_STYLE}>
                      <Text className="block text-xs" style={{ color: '#fff' }}>{`+${imageCount - 1}`}</Text>
                    </View>
                  ) : null}
                </View>
              ) : null}

              {videoCount > 0 ? (
                <View
                  className="w-24 h-24 rounded-xl overflow-hidden flex items-center justify-center"
                  style={{ position: 'relative', backgroundColor: '#211F1C' }}
                >
                  {/* 有首帧图就用它当封面，否则黑底 + 播放图标兜底 */}
                  {memory.videoThumbUrl ? (
                    <Image
                      src={memory.videoThumbUrl}
                      mode="aspectFill"
                      style={{ width: '100%', height: '100%' }}
                    />
                  ) : null}
                  <View
                    className="w-8 h-8 rounded-full flex items-center justify-center"
                    style={{
                      position: 'absolute',
                      backgroundColor: 'rgba(0,0,0,0.42)',
                    }}
                  >
                    <Play size={16} color="#fff" />
                  </View>
                  {videoDuration > 0 ? (
                    <View style={BADGE_STYLE}>
                      <Text className="block text-xs" style={{ color: '#fff' }}>{formatDurationShort(videoDuration)}</Text>
                    </View>
                  ) : null}
                </View>
              ) : null}

              {audioCount > 0 ? (
                <View
                  className="w-24 h-24 rounded-xl flex flex-col items-center justify-center gap-1"
                  style={{ position: 'relative', backgroundColor: '#E8F1EC' }}
                >
                  <Music size={22} color="#0B7A55" />
                  <Text className="block text-xs" style={{ color: '#0B7A55' }}>
                    {memory.audioDuration ? formatDurationShort(memory.audioDuration) : `录音 ${audioCount}`}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}

          {/* 标签 + 媒体计数（没有任何媒体格时才用纯计数兜底） */}
          <View className="flex flex-row items-center justify-between flex-wrap gap-1">
            <View className="flex flex-row items-center gap-1 flex-wrap">
              {memory.tags.slice(0, 3).map((t) => (
                <Text key={t} className="block text-xs text-muted-foreground">#{t}</Text>
              ))}
            </View>
            <View className="flex flex-row items-center gap-2 text-muted-foreground">
              {memory.mediaCount > 0 && !hasMediaRow && (
                <View className="flex flex-row items-center gap-1">
                  <Camera size={12} color="#9A948A" />
                  <Text className="block text-xs">{memory.mediaCount}</Text>
                </View>
              )}
              {hasMediaRow && videoCount > 0 ? (
                <View className="flex flex-row items-center gap-1">
                  <Film size={12} color="#9A948A" />
                  <Text className="block text-xs">{videoCount}</Text>
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
