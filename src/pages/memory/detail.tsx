import { useEffect, useState, useCallback } from 'react'
import { View, Text, Image, ScrollView } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { Pencil, Trash2, Music, Play as PlayIcon } from 'lucide-react-taro'
import { Button } from '@/components/ui/button'
import {
  fetchMemoryDetail, deleteMemory, deleteMemoryMedia,
  type Memory, type MemoryMedia,
  MEMORY_CATEGORIES, getMemoryCategoryLabel, getMemoryMoodLabel, getMemoryMoodEmoji,
} from '@/services/memory'
import { getSubjectColor, formatDate } from '@/types'

export default function MemoryDetailPage() {
  const [params] = useState(() => Taro.getCurrentInstance().router?.params || {})
  const id = (params.id as string) || ''
  const [memory, setMemory] = useState<Memory | null>(null)
  const [media, setMedia] = useState<MemoryMedia[]>([])
  const [loading, setLoading] = useState(true)
  const [currentAudio, setCurrentAudio] = useState<MemoryMedia | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    try {
      const res = await fetchMemoryDetail(id)
      const data = (res as any).data?.data || (res as any).data || res
      setMemory(data.memory as Memory)
      setMedia((data.media || []) as MemoryMedia[])
    } catch (e) {
      Taro.showToast({ title: '加载失败', icon: 'none' })
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  const onEdit = useCallback(() => {
    Taro.navigateTo({ url: `/pages/memory/edit?id=${id}` })
  }, [id])

  const onDelete = useCallback(() => {
    Taro.showModal({
      title: '删除记忆',
      content: '确定要删除这条记忆吗？此操作无法撤销。',
      confirmText: '删除',
      confirmColor: '#BE3E2D',
      success: async (r) => {
        if (r.confirm) {
          try {
            await deleteMemory(id)
            Taro.showToast({ title: '已删除', icon: 'success' })
            setTimeout(() => Taro.navigateBack(), 600)
          } catch (e) {
            Taro.showToast({ title: '删除失败', icon: 'none' })
          }
        }
      },
    })
  }, [id])

  const onRemoveMedia = useCallback((mid: string) => {
    Taro.showModal({
      title: '删除媒体',
      content: '从记忆中删除此媒体？',
      confirmText: '删除',
      confirmColor: '#BE3E2D',
      success: async (r) => {
        if (r.confirm) {
          try {
            await deleteMemoryMedia(id, mid)
            setMedia((prev) => prev.filter((m) => m.id !== mid))
            Taro.showToast({ title: '已删除', icon: 'success' })
          } catch (e) {
            Taro.showToast({ title: '删除失败', icon: 'none' })
          }
        }
      },
    })
  }, [id])

  const previewImage = useCallback((m: MemoryMedia) => {
    if (!m.url) return
    Taro.previewImage({ current: m.url, urls: media.filter((x) => x.kind === 'image').map((x) => x.url).filter(Boolean) as string[] })
  }, [media])

  if (loading) {
    return (
      <View className="px-4 pt-12 flex items-center justify-center">
        <Text className="block text-sm text-muted-foreground">加载中…</Text>
      </View>
    )
  }
  if (!memory) {
    return (
      <View className="px-4 pt-12 flex items-center justify-center">
        <Text className="block text-sm text-muted-foreground">记忆不存在或已删除</Text>
      </View>
    )
  }

  const catLabel = getMemoryCategoryLabel(memory.category)
  const moodEmoji = getMemoryMoodEmoji(memory.mood)
  const moodLabel = getMemoryMoodLabel(memory.mood)
  const subjectName = memory.subject?.name || ''
  const subjectColor = getSubjectColor(memory.subject?.color)
  const dateLabel = formatDate(memory.occurredAt || memory.createdAt)

  return (
    <ScrollView scrollY className="flex-1 bg-background" enhanced>
      {/* 顶部操作区 */}
      <View className="flex flex-row items-center justify-end gap-2 px-4 pt-3">
        <Button variant="outline" className="rounded-xl h-9 px-3" onClick={onEdit}>
          <Pencil size={14} color="#2A2825" />
          <Text className="block text-sm text-foreground ml-1">编辑</Text>
        </Button>
      </View>

      {/* 头部：分类 + 时间 + 心情 + 学科 */}
      <View className="px-4 pt-4 pb-3 border-b border-border">
        <Text className="block text-xs text-muted-foreground">{dateLabel}</Text>
        <View className="flex flex-row items-center gap-2 mt-2 flex-wrap">
          <View className="bg-muted rounded-full px-3 py-1">
            <Text className="block text-xs text-foreground">{catLabel}</Text>
          </View>
          {memory.category === 'study' && subjectName && (
            <View className={`rounded-full border px-3 py-1 ${subjectColor.badge}`}>
              <Text className="block text-xs">{subjectName}</Text>
            </View>
          )}
          {moodEmoji && (
            <View className="flex flex-row items-center gap-1 bg-muted rounded-full px-3 py-1">
              <Text className="block text-sm">{moodEmoji}</Text>
              <Text className="block text-xs text-muted-foreground">{moodLabel}</Text>
            </View>
          )}
        </View>
        {memory.title ? (
          <Text className="block text-xl font-semibold text-foreground mt-3">{memory.title}</Text>
        ) : null}
      </View>

      {/* 内容 */}
      {memory.content ? (
        <View className="px-4 pt-4">
          <Text className="block text-base text-foreground leading-relaxed whitespace-pre-wrap">
            {memory.content}
          </Text>
        </View>
      ) : null}

      {/* 媒体 */}
      {media.length > 0 ? (
        <View className="px-4 pt-4">
          <Text className="block text-xs text-muted-foreground mb-2">媒体</Text>
          <View className="flex flex-col gap-3">
              {media.map((m) => (
                <View key={m.id}>
                  {m.kind === 'image' ? (
                    <View className="rounded-2xl overflow-hidden bg-muted">
                      <Image
                        src={m.url || ''}
                        mode="widthFix"
                        style={{ width: '100%' }}
                        onClick={() => previewImage(m)}
                      />
                    </View>
                  ) : m.kind === 'audio' ? (
                    <View className="flex flex-row items-center gap-3 bg-muted rounded-xl px-4 py-3">
                      <View
                        className="w-10 h-10 rounded-full bg-primary flex items-center justify-center"
                        onClick={() => setCurrentAudio(m)}
                      >
                        <PlayIcon size={18} color="#fff" />
                      </View>
                      <View className="flex-1">
                        <View className="flex flex-row items-center gap-2">
                          <Music size={14} color="#6B635C" />
                          <Text className="block text-sm text-foreground">
                            录音 · {m.durationSec ? `${m.durationSec}s` : ''}
                          </Text>
                        </View>
                        {currentAudio?.id === m.id && m.url && (
                          <audio
                            src={m.url}
                            controls
                            autoPlay
                            className="mt-2 w-full"
                          />
                        )}
                      </View>
                      <View
                        className="w-8 h-8 rounded-full flex items-center justify-center"
                        onClick={() => onRemoveMedia(m.id)}
                      >
                        <Trash2 size={14} color="#9A948A" />
                      </View>
                    </View>
                  ) : (
                    <View>
                      <video
                        src={m.url || ''}
                        controls
                        className="w-full rounded-2xl bg-black"
                        style={{ width: '100%' }}
                      />
                      <View className="flex flex-row items-center justify-end mt-1">
                        <View
                          className="px-3 py-1 rounded-full bg-muted"
                          onClick={() => onRemoveMedia(m.id)}
                        >
                          <Text className="block text-xs text-muted-foreground">删除媒体</Text>
                        </View>
                      </View>
                    </View>
                  )}
                </View>
              ))}
            </View>
        </View>
      ) : null}

      {/* 标签 */}
      {memory.tags.length > 0 ? (
        <View className="px-4 pt-4">
          <Text className="block text-xs text-muted-foreground mb-2">标签</Text>
          <View className="flex flex-row gap-2 flex-wrap">
            {memory.tags.map((t) => (
              <View key={t} className="bg-muted rounded-full px-3 py-1">
                <Text className="block text-xs text-foreground">#{t}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {/* 时间戳 */}
      <View className="px-4 pt-4 pb-8">
        <Text className="block text-xs text-muted-foreground">记录于 {formatDate(memory.createdAt)}</Text>
      </View>

      {/* 底部删除按钮 */}
      <View style={{ padding: '12px 16px', paddingBottom: '32px' }}>
        <Button
          variant="outline"
          className="w-full h-12 rounded-xl border-red-200"
          onClick={onDelete}
        >
          <Trash2 size={16} color="#BE3E2D" />
          <Text className="block text-sm text-primary ml-2">删除记忆</Text>
        </Button>
      </View>
    </ScrollView>
  )
}

// 避免 lint 警告：预留常量导出（页面用到 MEMORY_CATEGORIES 时此处引用）
void MEMORY_CATEGORIES