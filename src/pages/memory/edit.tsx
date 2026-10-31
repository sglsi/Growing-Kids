import { useEffect, useState, useRef, useCallback } from 'react'
import { View, Text, Image, ScrollView, Picker } from '@tarojs/components'
import Taro from '@tarojs/taro'
import {
  Camera, Music, Film, X as XIcon, Check, Loader,
} from 'lucide-react-taro'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  fetchMemoryDetail, createMemory, updateMemory,
  addMemoryMedia, deleteMemoryMedia,
  type Memory, type MemoryCategory, type MemoryMood, type MemoryKind,
  MEMORY_CATEGORIES, MEMORY_MOODS,
} from '@/services/memory'
import {
  fetchSubjects, uploadFile,
} from '@/services/api'
import type { Subject } from '@/types'
import { INK, BRAND_FOREGROUND } from '@/lib/theme'
import { guardPrivacy, reportChooseFail } from '@/utils/privacy'
import { guardPolicy } from '@/services/policy-gate'

interface DraftMedia {
  /** 临时标识（用于本地 key + 上传后映射） */
  localKey: string
  /** 临时本地路径 / dataUrl（H5 用 base64） */
  tempPath: string
  kind: MemoryKind
  /** 上传中 / 已上传 */
  status: 'pending' | 'uploading' | 'done' | 'failed'
  /** 上传后的 server key（成功后回填） */
  serverKey?: string
  thumbKey?: string
  mimeType: string
  sizeBytes?: number
  width?: number
  height?: number
  durationSec?: number
  /** 是否已有 media.id（编辑模式时携带） */
  serverMediaId?: string
}

const DRAFT_KEY_PREFIX = 'memory_edit_draft_'
const DRAFT_DEBOUNCE_MS = 5000

export default function MemoryEditPage() {
  const isEdit = false as never
  // 兼容旧代码（下方 hooks 不要使用 isEdit）
  void isEdit

  // ---------- 模式 ----------
  const [params] = useState(() => Taro.getCurrentInstance().router?.params || {})
  const editId = (params.id as string) || ''

  // ---------- 表单状态 ----------
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  /**
   * 输入中的实时文本（思傅 2026-10-31 第十轮，见 工程教训录 L29）
   *
   * 打字时**不能 setState**：Taro 对表单元素无条件把 value 塞进 setData
   * （react.esm.js:372），而微信 textarea 是原生组件 —— 页面一 setData，
   * 它就按 value 重建文本、光标落末尾。实时文本放 ref，失焦/保存时再同步。
   */
  const contentRef = useRef('')
  const [category, setCategory] = useState<MemoryCategory>('life')
  const [mood, setMood] = useState<MemoryMood | ''>('')
  const [subjectId, setSubjectId] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [occurredAt, setOccurredAt] = useState(() => {
    const d = new Date()
    return formatDateTimeLocal(d)
  })

  const [media, setMedia] = useState<DraftMedia[]>([])
  /**
   * 编辑模式下**服务端已有的媒体 id**（加载时快照）。
   * 用途：① 保存时跳过这些项，否则会对已有媒体再 `addMemoryMedia` 一遍（每次编辑翻倍）；
   *      ② 用户在编辑页删掉的那些，保存时调 `deleteMemoryMedia` 真正删除
   *      （原实现 `removeMedia` 只改本地 state，保存后图还在）。
   */
  const initialMediaIdsRef = useRef<Set<string>>(new Set())

  // ---------- 元数据 ----------
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [recording, setRecording] = useState(false)
  const [recordSec, setRecordSec] = useState(0)
  const recorderRef = useRef<Taro.RecorderManager | null>(null)

  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(0) // 进行中的上传数量

  // ---------- 加载 ----------
  useEffect(() => {
    let alive = true
    fetchSubjects().then((s) => { if (alive) setSubjects(s) }).catch(() => undefined)
    if (editId) {
      // service 层已解包 + 驼峰化（原双重解包拿到的仍是 snake_case，导致时间框 NaN）
      fetchMemoryDetail(editId).then((data) => {
        if (!alive || !data) return
        const mem = data.memory as Memory
        setTitle(mem.title || '')
        contentRef.current = mem.content || ''
        setContent(mem.content || '')
        setCategory(mem.category || 'life')
        setMood(mem.mood || '')
        setSubjectId(mem.subjectId || '')
        setTags(mem.tags || [])
        setOccurredAt(formatDateTimeLocal(new Date(mem.occurredAt)))
        const existing: Media[] = (data.media || []) as Media[]
        initialMediaIdsRef.current = new Set(existing.map((m) => m.id))
        setMedia(existing.map((m) => ({
          localKey: m.id,
          tempPath: m.url || '',
          kind: m.kind,
          status: 'done',
          serverKey: m.fileKey,
          thumbKey: m.thumbKey || undefined,
          mimeType: m.mimeType,
          sizeBytes: m.sizeBytes || undefined,
          width: m.width || undefined,
          height: m.height || undefined,
          durationSec: m.durationSec || undefined,
          serverMediaId: m.id,
        })))
      }).catch(() => Taro.showToast({ title: '加载失败', icon: 'none' }))
    } else {
      // 草稿恢复
      const draft = Taro.getStorageSync(`${DRAFT_KEY_PREFIX}new`)
      if (draft && typeof draft === 'object') {
        Taro.showModal({
          title: '发现草稿',
          content: '检测到上次未保存的草稿，是否恢复？',
          success: (r) => {
            if (r.confirm) {
              setTitle(draft.title || '')
              contentRef.current = draft.content || ''
              setContent(draft.content || '')
              setCategory(draft.category || 'life')
              setMood(draft.mood || '')
              setSubjectId(draft.subjectId || '')
              setTags(draft.tags || [])
              setOccurredAt(draft.occurredAt || formatDateTimeLocal(new Date()))
            }
          },
        })
      }
    }
    return () => { alive = false }
  }, [editId])

  // ---------- 自动保存草稿 ----------
  useEffect(() => {
    if (editId) return
    const timer = setInterval(() => {
      if (!title && !content) return
      Taro.setStorageSync(`${DRAFT_KEY_PREFIX}new`, {
        title, content, category, mood, subjectId, tags, occurredAt,
      })
    }, DRAFT_DEBOUNCE_MS)
    return () => clearInterval(timer)
  }, [editId, title, content, category, mood, subjectId, tags, occurredAt])

  // ---------- 添加媒体：图片 ----------
  const onPickImages = useCallback(async () => {
    // GK-23-24：监护人同意（业务）→ 平台授权（基础库），两道闸门都要过
    if (!(await guardPolicy('选择图片'))) return
    if (!(await guardPrivacy('选择图片'))) return
    try {
      const env = Taro.getEnv()
      if (env === Taro.ENV_TYPE.WEB) {
        // H5：手动构造 file input
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'image/*'
        input.multiple = true
        input.onchange = () => {
          const files = input.files
          if (!files || !files.length) return
          const arr = Array.from(files).map((f) => ({
            localKey: `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            tempPath: URL.createObjectURL(f),
            kind: 'image' as MemoryKind,
            status: 'pending' as const,
            mimeType: f.type || 'image/jpeg',
            sizeBytes: f.size,
          }))
          setMedia((prev) => [...prev, ...arr])
        }
        input.click()
        return
      }
      const res = await Taro.chooseMedia({
        count: 9 - media.filter((m) => m.kind === 'image').length,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
      })
      const arr = res.tempFiles.map((f) => ({
        localKey: `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        tempPath: f.tempFilePath,
        kind: 'image' as MemoryKind,
        status: 'pending' as const,
        mimeType: 'image/jpeg',
        sizeBytes: f.size,
        width: f.width,
        height: f.height,
      }))
      setMedia((prev) => [...prev, ...arr])
    } catch (e) {
      reportChooseFail(e, '选择图片')
    }
  }, [media])

  // ---------- 添加媒体：视频 ----------
  const onPickVideo = useCallback(async () => {
    // GK-23-24：监护人同意（业务）→ 平台授权（基础库），两道闸门都要过
    if (!(await guardPolicy('选择视频'))) return
    if (!(await guardPrivacy('选择视频'))) return
    try {
      const env = Taro.getEnv()
      if (env === Taro.ENV_TYPE.WEB) {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'video/*'
        input.onchange = () => {
            const f = input.files?.[0]
            if (!f) return
            setMedia((prev) => [...prev, {
              localKey: `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              tempPath: URL.createObjectURL(f),
              kind: 'video',
              status: 'pending',
              mimeType: f.type || 'video/mp4',
              sizeBytes: f.size,
            }])
          }
        input.click()
        return
      }
      const res = await Taro.chooseMedia({
        count: 1,
        mediaType: ['video'],
        sourceType: ['album'],
        maxDuration: 60,
      })
      const f = res.tempFiles[0]
      setMedia((prev) => [...prev, {
        localKey: `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        tempPath: f.tempFilePath,
        kind: 'video',
        status: 'pending',
        mimeType: 'video/mp4',
        sizeBytes: f.size,
        width: f.width,
        height: f.height,
        durationSec: f.duration,
      }])
    } catch (e) {
      reportChooseFail(e, '选择视频')
    }
  }, [])

  // ---------- 录音 ----------
  const onStartRecord = useCallback(async () => {
    const env = Taro.getEnv()
    if (env !== Taro.ENV_TYPE.WEAPP && env !== Taro.ENV_TYPE.TT) {
      Taro.showModal({
        title: '请在小程序中录音',
        content: 'H5 端暂不支持录音，请在微信小程序中体验',
        showCancel: false,
      })
      return
    }
    // 录音（RecorderManager.start）在微信隐私清单里属「访问你的麦克风」，
    // 未授权时 start 不报错也不出声 —— 必须先过闸门。
    // GK-23-24：监护人同意（业务）→ 平台授权（基础库），两道闸门都要过
    if (!(await guardPolicy('录音'))) return
    if (!(await guardPrivacy('录音'))) return
    try {
      const r = Taro.getRecorderManager()
      recorderRef.current = r
      setRecordSec(0)
      const tick = setInterval(() => setRecordSec((s) => s + 1), 1000)
      r.onStop((res) => {
        clearInterval(tick)
        setRecording(false)
        setRecordSec(0)
        recorderRef.current = null
        if (res.tempFilePath && res.duration) {
          setMedia((prev) => [...prev, {
            localKey: `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            tempPath: res.tempFilePath,
            kind: 'audio',
            status: 'pending',
            mimeType: 'audio/mpeg',
            durationSec: Math.round(res.duration / 1000),
          }])
        }
      })
      r.onError(() => {
        clearInterval(tick)
        setRecording(false)
        setRecordSec(0)
        recorderRef.current = null
        Taro.showToast({ title: '录音失败', icon: 'none' })
      })
      r.start({ format: 'mp3', maxDuration: 60 } as any)
      setRecording(true)
    } catch (e) {
      Taro.showToast({ title: '无法启动录音', icon: 'none' })
    }
  }, [])

  const onStopRecord = useCallback(() => {
    if (recorderRef.current) recorderRef.current.stop()
  }, [])

  // ---------- 移除媒体 ----------
  const removeMedia = useCallback(async (idx: number) => {
    const m = media[idx]
    if (!m) return
    if (m.status === 'uploading') {
      Taro.showToast({ title: '该媒体正在上传', icon: 'none' })
      return
    }
    setMedia((prev) => prev.filter((_, i) => i !== idx))
  }, [media])

  // ---------- 上传单个媒体 ----------
  const uploadOne = useCallback(async (m: DraftMedia): Promise<DraftMedia> => {
    setMedia((prev) => prev.map((x) => x.localKey === m.localKey ? { ...x, status: 'uploading' } : x))
    setUploading((c) => c + 1)
    try {
      const data = await uploadFile(m.tempPath, { purpose: 'memory' } as any)
      return {
        ...m,
        status: 'done',
        serverKey: (data as any).key,
        thumbKey: (data as any).thumb_key,
        mimeType: m.mimeType || (data as any).type || m.mimeType,
      }
    } catch (e) {
      return { ...m, status: 'failed' }
    } finally {
      setUploading((c) => Math.max(0, c - 1))
    }
  }, [])

  // ---------- 触发上传（用户点保存时调用） ----------
  const uploadAll = useCallback(async (): Promise<DraftMedia[]> => {
    const pending = media.filter((m) => m.status === 'pending')
    if (!pending.length) return media
    const uploaded = await Promise.all(pending.map(uploadOne))
    // 合并
    const map = new Map(uploaded.map((m) => [m.localKey, m]))
    return media.map((m) => map.get(m.localKey) || m)
  }, [media, uploadOne])

  // ---------- 标签输入 ----------
  // 直接复用 onConfirm/addTag；不再单独提供 onTagKeyDown

  const addTag = useCallback((t: string) => {
    const v = t.replace(/^#/, '').trim()
    if (!v || tags.includes(v)) return
    setTags([...tags, v])
    setTagInput('')
  }, [tags])

  const removeTag = useCallback((t: string) => {
    setTags(tags.filter((x) => x !== t))
  }, [tags])

  // ---------- 保存 ----------
  const onSave = useCallback(async () => {
    if (!contentRef.current.trim() && !title.trim() && media.length === 0) {
      Taro.showToast({ title: '请至少写点内容或添加媒体', icon: 'none' })
      return
    }
    // GK-23-24：成长记忆是孩子最私密的内容，写入前必须已同意隐私政策
    if (!(await guardPolicy('保存成长记忆'))) return
    setSaving(true)
    try {
      const uploaded = await uploadAll()
      const failed = uploaded.filter((m) => m.status === 'failed')
      if (failed.length) {
        Taro.showToast({ title: `${failed.length} 个媒体上传失败`, icon: 'none' })
        setSaving(false)
        return
      }
      // 🔴 编辑必须走 update（2026-10-29 分模块测试发现并修复，缺陷 P1-D）：
      // 原实现无条件 `createMemory`，`editId` 只用于加载 ⇒ 每次编辑都多出一条
      // 一模一样的记忆，原条目永远不变。
      const payload = {
        title: title.trim() || undefined,
        content: contentRef.current.trim() || undefined,
        category,
        mood: mood || undefined,
        subject_id: category === 'study' ? (subjectId || undefined) : undefined,
        tags: tags.length ? tags : undefined,
        occurred_at: new Date(occurredAt).toISOString(),
      }
      const mem = editId
        ? await updateMemory(editId, payload as any)
        : await createMemory(payload as any)
      const memId = (mem as any)?.id || editId
      if (!memId) throw new Error('保存后未取到记忆 id')

      // 编辑模式下：用户在页面上删掉的媒体要真正删掉（否则保存后图还在）
      if (editId) {
        const kept = new Set(
          uploaded.map((m) => m.serverMediaId).filter(Boolean) as string[],
        )
        for (const oldId of Array.from(initialMediaIdsRef.current)) {
          if (kept.has(oldId)) continue
          await deleteMemoryMedia(memId, oldId).catch((e) =>
            console.error('[memory] 删除已有媒体失败', oldId, e),
          )
        }
      }

      // 追加媒体：只追加本轮新上传的（已有 serverMediaId 的跳过，否则每次保存翻倍）
      let sort = 0
      for (const m of uploaded) {
        if (!m.serverKey) continue
        if (m.serverMediaId) continue
        await addMemoryMedia(memId, {
          kind: m.kind,
          file_key: m.serverKey,
          thumb_key: m.thumbKey,
          mime_type: m.mimeType,
          width: m.width,
          height: m.height,
          size_bytes: m.sizeBytes,
          duration_sec: m.durationSec,
          sort_order: sort++,
        } as any)
      }
      Taro.removeStorageSync(`${DRAFT_KEY_PREFIX}new`)
      Taro.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => Taro.navigateBack(), 600)
    } catch (e) {
      Taro.showToast({ title: '保存失败', icon: 'none' })
    } finally {
      setSaving(false)
    }
  }, [content, title, media, category, mood, subjectId, tags, occurredAt])

  // ---------- 渲染 ----------
  const imageCount = media.filter((m) => m.kind === 'image').length
  const audioMedia = media.filter((m) => m.kind === 'audio')
  const videoMedia = media.filter((m) => m.kind === 'video')
  const canPickImage = imageCount < 9
  const canPickAudio = audioMedia.length < 5
  const canPickVideo = videoMedia.length < 3

  return (
    <ScrollView scrollY className="flex-1 bg-background" enhanced>
      {/* 时间 + 分类 + 心情 */}
      <View className="px-4 pt-4">
        <Text className="block text-xs text-muted-foreground mb-1">发生时间</Text>
        <View className="bg-muted rounded-xl px-4 py-3 flex flex-row items-center gap-2">
          <Text className="block text-sm">📅</Text>
          <View className="flex-1">
            {Taro.getEnv() === Taro.ENV_TYPE.WEB ? (
              <input
                type="datetime-local"
                value={occurredAt}
                onChange={(e) => setOccurredAt(e.currentTarget.value)}
                className="w-full text-sm bg-transparent outline-none"
                style={{ background: 'transparent', border: 'none', outline: 'none' }}
              />
            ) : (
              <View className="flex flex-row gap-2">
              <Picker
                mode="date"
                value={occurredAt.slice(0, 10)}
                onChange={(e) => {
                  const t = occurredAt.slice(11) || '12:00'
                  setOccurredAt(`${e.detail.value} ${t}`)
                }}
              >
                <View className="bg-muted rounded-lg px-3 py-2">
                  <Text className="block text-sm text-foreground">{occurredAt.slice(0, 10)}</Text>
                </View>
              </Picker>
              <Picker
                mode="time"
                value={occurredAt.slice(11, 16)}
                onChange={(e) => {
                  const d = occurredAt.slice(0, 10)
                  setOccurredAt(`${d} ${e.detail.value}`)
                }}
              >
                <View className="bg-muted rounded-lg px-3 py-2">
                  <Text className="block text-sm text-foreground">{occurredAt.slice(11, 16) || '12:00'}</Text>
                </View>
              </Picker>
            </View>
            )}
          </View>
        </View>

        <Text className="block text-xs text-muted-foreground mb-1 mt-3">分类</Text>
        <View className="flex flex-row gap-2 flex-wrap">
          {MEMORY_CATEGORIES.map((c) => {
            const active = category === c.value
            return (
              <View
                key={c.value}
                className={`rounded-full border px-4 py-2 ${active ? 'bg-brand-soft border-brand-line' : 'bg-background border-border'}`}
                onClick={() => setCategory(c.value)}
              >
                <Text className={`block text-sm ${active ? 'text-brand-text' : 'text-foreground'}`}>{c.label}</Text>
              </View>
            )
          })}
        </View>

        <Text className="block text-xs text-muted-foreground mb-1 mt-3">心情</Text>
        <View className="flex flex-row gap-2 flex-wrap">
          {MEMORY_MOODS.map((m) => {
            const active = mood === m.value
            return (
              <View
                key={m.value}
                className={`flex flex-row items-center gap-1 rounded-full border px-3 py-2 ${active ? 'bg-brand-soft border-brand-line' : 'bg-background border-border'}`}
                onClick={() => setMood(active ? '' : m.value)}
              >
                <Text className="block text-base">{m.emoji}</Text>
                <Text className={`block text-xs ${active ? 'text-brand-text' : 'text-muted-foreground'}`}>{m.label}</Text>
              </View>
            )
          })}
        </View>

        {category === 'study' && (
          <>
            <Text className="block text-xs text-muted-foreground mb-1 mt-3">学科</Text>
            <View className="flex flex-row gap-2 flex-wrap">
              <View
                className={`rounded-full border px-4 py-2 ${!subjectId ? 'bg-brand-soft border-brand-line' : 'bg-background border-border'}`}
                onClick={() => setSubjectId('')}
              >
                <Text className={`block text-sm ${!subjectId ? 'text-brand-text' : 'text-foreground'}`}>不限</Text>
              </View>
              {subjects.map((s) => {
                const a = subjectId === s.id
                return (
                  <View
                    key={s.id}
                    className={`rounded-full border px-4 py-2 ${a ? 'bg-brand-soft border-brand-line' : 'bg-background border-border'}`}
                    onClick={() => setSubjectId(s.id)}
                  >
                    <Text className={`block text-sm ${a ? 'text-brand-text' : 'text-foreground'}`}>{s.name}</Text>
                  </View>
                )
              })}
            </View>
          </>
        )}
      </View>

      {/* 标题 + 内容 */}
      <View className="px-4 pt-4">
        <Label className="block text-xs text-muted-foreground mb-1">标题（可选）</Label>
        <Input
          className="bg-muted rounded-xl px-4 h-10 text-sm"
          placeholder="给这次记忆起个名字"
          value={title}
          onInput={(e) => setTitle(e.detail.value)}
          maxlength={64}
        />

        <Label className="block text-xs text-muted-foreground mb-1 mt-3">内容</Label>
        {/*
          ⚠️ 「点图片/录音/视频没反应、光标却跑进内容栏」的真凶不在这一行的 style，
          而在 `ui/textarea` 的壳：它原来把壳固定成 h-20（80px），却把 `style` 透传给
          里面的**原生** textarea。这里传 height:160 ⇒ 原生层 160px、壳 80px，
          多出的 80px 溢出到壳外（原生组件不裁剪），正好压住下面的媒体按钮。
          已在组件里修掉（style 落壳、内层同步同一份高度、壳改 min-h-20）。
          这里保持显式高度是**故意**的：内容框固定 160px，页面滚动范围稳定。
        */}
        <Textarea
          value={content}
          placeholder="写下今天的小发现 / 心得 / 感悟"
          maxlength={2000}
          // ⚠️ 打字只写 ref、不 setState（每打一个字 setData 一次 ⇒ 光标落末尾）
          onInput={(e) => { contentRef.current = e.detail.value }}
          onBlur={(e) => setContent(e.detail.value)}
          className="bg-muted rounded-xl p-3 text-sm"
          style={{ width: '100%', height: '160px' }}
        />
      </View>

      {/* 媒体 */}
      <View className="px-4 pt-4">
        <Text className="block text-xs text-muted-foreground mb-2">媒体（图片 / 音频 / 视频）</Text>
        <View className="flex flex-row gap-2 flex-wrap">
          {media.map((m, idx) => (
            <View key={m.localKey} className="w-24 h-24 rounded-xl bg-muted overflow-hidden relative">
              {m.kind === 'image' ? (
                <Image src={m.tempPath} mode="aspectFill" style={{ width: '100%', height: '100%' }} />
              ) : m.kind === 'audio' ? (
                <View className="w-full h-full flex items-center justify-center flex-col gap-1">
                  <Music size={26} color="#6B635C" />
                  <Text className="block text-xs text-muted-foreground">{m.durationSec ? `${m.durationSec}s` : '录音'}</Text>
                </View>
              ) : (
                <View className="w-full h-full flex items-center justify-center flex-col gap-1">
                  <Film size={26} color="#6B635C" />
                  <Text className="block text-xs text-muted-foreground">视频</Text>
                </View>
              )}
              {m.status === 'uploading' && (
                <View className="absolute inset-0 bg-black bg-opacity-40 flex items-center justify-center">
                  <Loader size={20} color="#fff" />
                </View>
              )}
              <View
                className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black bg-opacity-60 flex items-center justify-center"
                onClick={() => removeMedia(idx)}
              >
                <XIcon size={14} color="#fff" />
              </View>
            </View>
          ))}
        </View>

        {/* 添加按钮 */}
        <View className="flex flex-row gap-2 mt-3 flex-wrap">
          {canPickImage && (
            <Button variant="outline" className="rounded-xl h-10" onClick={onPickImages}>
              <Camera size={16} color={INK} />
              <Text className="block text-sm text-foreground ml-1">图片 ({imageCount}/9)</Text>
            </Button>
          )}
          {canPickAudio && (
            <Button
              variant="outline"
              className={`rounded-xl h-10 ${recording ? 'border-primary' : ''}`}
              onClick={recording ? onStopRecord : onStartRecord}
            >
              <Music size={16} color={INK} />
              <Text className="block text-sm text-foreground ml-1">
                {recording ? `录音中 ${recordSec}s 点击停止` : `录音 (${audioMedia.length}/5)`}
              </Text>
            </Button>
          )}
          {canPickVideo && (
            <Button variant="outline" className="rounded-xl h-10" onClick={onPickVideo}>
              <Film size={16} color={INK} />
              <Text className="block text-sm text-foreground ml-1">视频 ({videoMedia.length}/3)</Text>
            </Button>
          )}
        </View>
      </View>

      {/* 标签 */}
      <View className="px-4 pt-4 pb-8">
        <Text className="block text-xs text-muted-foreground mb-2">标签</Text>
        <View className="flex flex-row gap-2 flex-wrap mb-2">
          {tags.map((t) => (
            <View key={t} className="flex flex-row items-center gap-1 rounded-full bg-muted px-3 py-1" onClick={() => removeTag(t)}>
              <Text className="block text-xs text-foreground">#{t}</Text>
              <XIcon size={12} color={INK} />
            </View>
          ))}
        </View>
        <View className="flex flex-row items-center gap-2">
          <Input
            className="flex-1 bg-muted rounded-xl px-3 h-9 text-sm"
            placeholder="输入标签后回车（例：课堂）"
            value={tagInput}
            onInput={(e) => setTagInput(e.detail.value)}
            onConfirm={(e) => addTag(e.detail.value)}
            maxlength={20}
          />
          <Button variant="outline" className="rounded-xl h-9" onClick={() => addTag(tagInput)}>
            <Text className="block text-sm text-foreground">添加</Text>
          </Button>
        </View>
      </View>

      {/* 底部保存按钮 */}
      <View style={{ padding: '12px 16px', paddingBottom: '24px' }}>
        <Button
          className="w-full h-12 rounded-xl bg-brand"
          onClick={onSave}
          disabled={saving || uploading > 0}
        >
          <Check size={16} color={BRAND_FOREGROUND} />
          <Text className="block text-sm text-brand-foreground ml-2">
            {saving ? '保存中…' : uploading > 0 ? `上传中 ${uploading}…` : '保存'}
          </Text>
        </Button>
      </View>
    </ScrollView>
  )
}

/** 格式化 Date → yyyy-MM-ddThh:mm（兼容 picker / input[type=datetime-local]） */
function formatDateTimeLocal(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 辅助空类型（确保本文件中 Media 接口仅用于本地）
interface Media {
  id: string; memoryId: string; kind: MemoryKind; fileKey: string
  thumbKey?: string | null; mimeType: string; width?: number | null
  height?: number | null; sizeBytes?: number | null; durationSec?: number | null
  url?: string; thumbUrl?: string; transcript?: string | null; sortOrder: number
}

// 占位引用，防止 addTag 被移除后报错