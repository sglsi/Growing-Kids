import { useEffect, useState, useCallback, useRef } from 'react'
import { View, Text, Image, ScrollView, Video } from '@tarojs/components'
import Taro, { useDidShow, useDidHide } from '@tarojs/taro'
import { Pencil, Trash2, Music, Play as PlayIcon, Pause } from 'lucide-react-taro'
import { Button } from '@/components/ui/button'
import {
  fetchMemoryDetail, deleteMemory, deleteMemoryMedia,
  type Memory, type MemoryMedia,
  MEMORY_CATEGORIES, getMemoryCategoryLabel, getMemoryMoodLabel, getMemoryMoodEmoji,
} from '@/services/memory'
import { cacheGet, cacheSet } from '@/services/cache'
import { getSubjectColor, formatDate } from '@/types'
import { BRAND, BRAND_TEXT, BRAND_FOREGROUND, DANGER } from '@/lib/theme'

/** 秒 → "1:32" */
function formatSec(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`
}

/**
 * 视频展示高度：按宽高比换算（卡片可用宽约 340px），夹在 160~440 之间。
 * `<Video>` 在小程序里**必须有确定高度**，给 `width:100%` 不带高度等于 0 高 ⇒ 看起来"没有视频"。
 */
function videoHeight(m: MemoryMedia): number {
  const w = m.width || 0
  const h = m.height || 0
  if (w > 0 && h > 0) return Math.min(Math.max(Math.round((340 * h) / w), 160), 440)
  return 220
}

export default function MemoryDetailPage() {
  const [params] = useState(() => Taro.getCurrentInstance().router?.params || {})
  const id = (params.id as string) || ''
  const [memory, setMemory] = useState<Memory | null>(null)
  const [media, setMedia] = useState<MemoryMedia[]>([])
  const [loading, setLoading] = useState(true)
  /** 正在播放的媒体 id（null=没在播） */
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [playPos, setPlayPos] = useState(0)
  const audioCtxRef = useRef<Taro.InnerAudioContext | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    // SWR（思傅 2026-10-21）：先读缓存铺首帧，再后台刷新；写操作已失效 mem 域
    const itemKey = `mem:item:${id}`
    const cached = cacheGet<{ memory: Memory; media: MemoryMedia[] }>(itemKey)
    if (cached) {
      setMemory(cached.memory || null)
      setMedia(cached.media || [])
      setLoading(false)
    } else {
      setLoading(true)
    }
    try {
      // service 层已解包 + 驼峰化
      const data = await fetchMemoryDetail(id)
      setMemory(data.memory as Memory)
      setMedia((data.media || []) as MemoryMedia[])
      cacheSet(itemKey, { memory: data.memory, media: data.media || [] })
    } catch (e) {
      Taro.showToast({ title: '加载失败', icon: 'none' })
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  /**
   * 从编辑页返回时**必须重新拉一次**（2026-11-02 思傅反馈）：
   * 详情页挂在页面栈里，navigateBack 回来不会重新 mount ⇒ useEffect 不跑 ⇒
   * 改完标题/正文/媒体，返回来还是旧内容，必须切到别的页面再进来才刷新。
   */
  const firstShowRef = useRef(true)
  useDidShow(() => {
    if (firstShowRef.current) {
      firstShowRef.current = false
      return
    }
    void load()
  })

  // ---------- 音频播放 ----------
  // ⚠️ 原来用的是原生 `<audio controls>` 标签：Taro 只把小写标签当自定义元素下发，
  //    小程序渲染层没有对应组件 ⇒ 点播放**没有任何反应**（思傅反馈）。
  //    正解是小程序原生能力 `InnerAudioContext`，配自绘播放/暂停按钮。
  const stopAudio = useCallback(() => {
    const ctx = audioCtxRef.current
    audioCtxRef.current = null
    setPlayingId(null)
    setPlayPos(0)
    if (!ctx) return
    try {
      ctx.stop()
      ctx.destroy()
    } catch (e) {
      console.warn('[memory] 释放音频实例失败', e)
    }
  }, [])

  const toggleAudio = useCallback((m: MemoryMedia) => {
    if (!m.url) {
      Taro.showToast({ title: '音频地址缺失', icon: 'none' })
      return
    }
    // 再点同一个：暂停并释放（避免多实例叠着播）
    if (playingId === m.id) {
      stopAudio()
      return
    }
    stopAudio()
    const ctx = Taro.createInnerAudioContext()
    ctx.src = m.url
    ctx.onPlay(() => setPlayingId(m.id))
    ctx.onEnded(() => { setPlayingId(null); setPlayPos(0) })
    ctx.onTimeUpdate(() => setPlayPos(Math.floor(ctx.currentTime || 0)))
    ctx.onError((err) => {
      console.warn('[memory] 音频播放失败', err)
      Taro.showToast({ title: '播放失败，试试重新进入', icon: 'none' })
      setPlayingId(null)
    })
    audioCtxRef.current = ctx
    ctx.play()
  }, [playingId, stopAudio])

  // 离开页面就释放实例（否则退出后声音还在响）
  // ⚠️ 用 useDidHide 而不是 useUnloadEffect：后者不在 @tarojs/taro 的类型导出里，
  //    且 navigateBack 时页面先 hide、真卸载要等 Taro 回收，光靠卸载时机太晚。
  useDidHide(() => { stopAudio() })
  useEffect(() => () => { stopAudio() }, [stopAudio])

  const onEdit = useCallback(() => {
    Taro.navigateTo({ url: `/pages/memory/edit?id=${id}` })
  }, [id])

  const onDelete = useCallback(() => {
    Taro.showModal({
      title: '删除记忆',
      content: '确定要删除这条记忆吗？此操作无法撤销。',
      confirmText: '删除',
      confirmColor: BRAND_TEXT,
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
      confirmColor: BRAND_TEXT,
      success: async (r) => {
        if (r.confirm) {
          try {
            // 正在播这条就先停掉，否则声音会继续响而卡片已消失
            if (playingId === mid) stopAudio()
            await deleteMemoryMedia(id, mid)
            setMedia((prev) => prev.filter((m) => m.id !== mid))
            Taro.showToast({ title: '已删除', icon: 'success' })
          } catch (e) {
            Taro.showToast({ title: '删除失败', icon: 'none' })
          }
        }
      },
    })
  }, [id, playingId, stopAudio])

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
                    <View
                      className="flex flex-row items-center gap-3 rounded-xl px-4 py-3"
                      style={{ backgroundColor: playingId === m.id ? '#D9E9E0' : '#EFEAE2' }}
                    >
                      <View
                        className="w-11 h-11 rounded-full flex items-center justify-center"
                        style={{ backgroundColor: BRAND }}
                        onClick={() => toggleAudio(m)}
                      >
                        {playingId === m.id
                          ? <Pause size={18} color={BRAND_FOREGROUND} />
                          : <PlayIcon size={18} color={BRAND_FOREGROUND} />}
                      </View>
                      <View className="flex-1">
                        <View className="flex flex-row items-center gap-2">
                          <Music size={13} color="#6B635C" />
                          <Text className="block text-sm text-foreground">
                            录音{m.durationSec ? ` · ${formatSec(m.durationSec)}` : ''}
                          </Text>
                        </View>
                        <Text className="block text-xs text-muted-foreground mt-1">
                          {playingId === m.id
                            ? `播放中 ${formatSec(playPos)}${m.durationSec ? ` / ${formatSec(m.durationSec)}` : ''}`
                            : '点击左侧按钮播放'}
                        </Text>
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
                      {/* ⚠️ 必须用 @tarojs/components 的 <Video>：原生小写 <video> 在小程序端
                          不会被渲染成播放器 ⇒ 视频"看不到"（思傅反馈） */}
                      <Video
                        src={m.url || ''}
                        poster={m.thumbUrl || ''}
                        controls
                        showCenterPlayBtn
                        objectFit="contain"
                        style={{ width: '100%', height: `${videoHeight(m)}px`, borderRadius: '16px' }}
                      />
                      <View className="flex flex-row items-center justify-between mt-1">
                        <Text className="block text-xs text-muted-foreground">
                          {m.durationSec ? `视频 · ${formatSec(m.durationSec)}` : '视频'}
                        </Text>
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
          className="w-full h-12 rounded-xl border-destructive"
          onClick={onDelete}
        >
          <Trash2 size={16} color={DANGER} />
          <Text className="block text-sm text-destructive ml-2">删除记忆</Text>
        </Button>
      </View>
    </ScrollView>
  )
}

// 避免 lint 警告：预留常量导出（页面用到 MEMORY_CATEGORIES 时此处引用）
void MEMORY_CATEGORIES