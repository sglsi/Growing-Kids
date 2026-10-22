import { useState } from 'react'
import { View, Text, Textarea, Image as TaroImage } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { Plus, Trash2, Crop, Globe, FileText, Check, X } from 'lucide-react-taro'
import ImageEditor from '@/components/image-editor'
import MaterialPicker from '@/components/material-picker'
import { uploadImage, uploadFile, searchAnswer, saveAnswer } from '@/services/api'
import type { AnswerAttachment, TimelineItem } from '@/types'
import type { AnswerSearchResult } from '@/services/api'

/**
 * 题目答案编辑区（思傅 2026-10-21）
 *
 * 设计依据见「题目答案功能-设计方案.md」：
 *  - 答案支持 **图片 / 文档 / 文本** 三类；
 *  - 图片可裁剪（复用 ImageEditor 的 cropOnly）；
 *  - **答案与题目一一对应**：答案内嵌在题目 content 里，且所有写入都按 `item.id`
 *    定位，编辑器顶部常驻「答案将存入：…」目标锚，杜绝裁给错的题。
 *  - 「联网搜答案」的结果**不自动入库**，必须用户点「采纳」（安全阀）。
 */

interface Props {
  item: TimelineItem
  /** 保存成功后回调（用于刷新页面 state / 列表） */
  onSaved?: (item: TimelineItem) => void
}

/** 答案将存入的目标锚：优先题号标签，否则题干前 16 字（item 为空时返回「本题」，绝不抛） */
function targetLabel(item: TimelineItem | null | undefined): string {
  const c = item?.content || {}
  const label = c.question_label || ''
  if (label) return label
  const q = (c.question || item?.title || '').trim()
  return q ? `${q.slice(0, 16)}${q.length > 16 ? '…' : ''}` : '本题'
}

function newId(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export default function AnswerEditor({ item, onSaved }: Props) {
  // ⚠️ item 可能为 null（调用方未等数据到位就挂载时会走到）——全部可选链，
  //    保证永不因空 item 崩渲染（2026-10-22 详情页打不开的直接崩溃点）。
  const [text, setText] = useState(item?.content?.answer || '')
  const [atts, setAtts] = useState<AnswerAttachment[]>(item?.content?.answer_attachments || [])
  const [saving, setSaving] = useState(false)
  const [searching, setSearching] = useState(false)
  const [candidate, setCandidate] = useState<AnswerSearchResult | null>(null)
  // 裁剪：进入编辑器前先记住目标，确认后写回**同一条** item
  const [cropSrc, setCropSrc] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)

  const label = targetLabel(item)

  /** 写库：文本 / 附件 / 来源**一次调用**提交（后端按 content 字段合并，不会清掉题干） */
  const persist = async (nextAtts: AnswerAttachment[], nextText?: string) => {
    setSaving(true)
    try {
      const updated = await saveAnswer(item.id, {
        answer: nextText ?? text,
        solution: item.content?.solution,
        attachments: nextAtts,
        source: nextAtts.length ? 'manual' : (item.content?.answer_source || 'manual'),
        refs: item.content?.answer_refs,
      })
      onSaved?.(updated)
    } catch (e) {
      console.error('保存答案失败', e)
      Taro.showToast({ title: '保存失败，请重试', icon: 'none' })
    } finally {
      setSaving(false)
    }
  }

  const saveText = () => void persist(atts, text)

  const addAttachment = async (a: AnswerAttachment) => {
    const next = [...atts, a]
    setAtts(next)
    await persist(next, text)
  }

  const removeAttachment = async (id: string) => {
    const next = atts.filter((x) => x.id !== id)
    setAtts(next)
    await persist(next, text)
  }

  // ---------- 图片：拍照/相册 → 裁剪 → 上传 ----------
  const pickImage = async () => {
    try {
      const res = await Taro.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['camera', 'album'] })
      const p = res.tempFiles?.[0]?.tempFilePath
      if (p) setCropSrc(p)
    } catch {
      /* 用户取消 */
    }
  }

  const handleCropConfirm = async (tempPath: string) => {
    setCropSrc('')
    Taro.showLoading({ title: '上传中' })
    try {
      const up = await uploadImage(tempPath, { purpose: 'attach' })
      await addAttachment({
        id: newId(),
        type: 'image',
        file_key: up.key,
        thumb_key: up.thumb_key,
        source: 'manual',
        created_at: new Date().toISOString(),
      })
      Taro.showToast({ title: '已加入答案', icon: 'success' })
    } catch (e) {
      console.error('答案图片上传失败', e)
      Taro.showToast({ title: '上传失败', icon: 'none' })
    } finally {
      Taro.hideLoading()
    }
  }

  // ---------- 文档：会话选文件 → 上传 ----------
  const pickDoc = async () => {
    try {
      const res = await Taro.chooseMessageFile({ count: 1 })
      const f = res.tempFiles?.[0]
      if (!f?.path) return
      Taro.showLoading({ title: '上传中' })
      const up = await uploadFile(f.path, { purpose: 'attach' })
      await addAttachment({
        id: newId(),
        type: 'doc',
        file_key: up.key,
        name: f.name || '附件',
        size: f.size,
        source: 'manual',
        created_at: new Date().toISOString(),
      })
      Taro.showToast({ title: '已加入答案', icon: 'success' })
    } catch (e) {
      console.error('答案文档上传失败', e)
      Taro.showToast({ title: '上传失败', icon: 'none' })
    } finally {
      Taro.hideLoading()
    }
  }

  // ---------- 资料库 ----------
  const handlePickLibrary = async (doc: { id: string; name: string; file_key: string; mime_type?: string | null; size_bytes?: number | null }) => {
    setPickerOpen(false)
    await addAttachment({
      id: newId(),
      type: (doc.mime_type || '').startsWith('image/') ? 'image' : 'doc',
      file_key: doc.file_key,
      name: doc.name,
      size: doc.size_bytes ?? undefined,
      source: 'library',
      ref_id: doc.id,
      created_at: new Date().toISOString(),
    })
    Taro.showToast({ title: '已加入答案', icon: 'success' })
  }

  // ---------- 联网搜答案 ----------
  const handleSearch = async () => {
    setSearching(true)
    setCandidate(null)
    try {
      const res = await searchAnswer(item.id)
      setCandidate(res)
      if (res.source === 'none') {
        Taro.showToast({ title: res.note || '未能搜到答案', icon: 'none' })
      }
    } catch (e) {
      console.error('搜答案失败', e)
      Taro.showToast({ title: '搜题失败，请稍后重试', icon: 'none' })
    } finally {
      setSearching(false)
    }
  }

  const handleAdopt = async () => {
    if (!candidate) return
    setSaving(true)
    try {
      const updated = await saveAnswer(item.id, {
        answer: candidate.answer,
        solution: candidate.solution,
        attachments: atts,
        refs: candidate.refs,
        source: candidate.source === 'search' ? 'search' : 'mixed',
      })
      setText(candidate.answer)
      setCandidate(null)
      onSaved?.(updated)
      Taro.showToast({ title: '已采纳', icon: 'success' })
    } catch (e) {
      console.error('采纳失败', e)
      Taro.showToast({ title: '采纳失败', icon: 'none' })
    } finally {
      setSaving(false)
    }
  }

  const btn = 'flex flex-row items-center gap-1 px-2 py-1 rounded-lg border border-border'

  return (
    <View className="mb-4">
      {/* 目标锚：常驻提示，防止把答案加错题 */}
      <View className="flex flex-row items-center justify-between mb-2">
        <Text className="block text-xs text-muted-foreground">正确答案</Text>
        <Text className="block text-[10px]" style={{ color: '#BE3E2D' }}>
          答案将存入：{label}
        </Text>
      </View>

      <Textarea
        className="w-full rounded-xl border border-border p-3 text-sm"
        style={{ minHeight: 72, backgroundColor: '#fff' }}
        placeholder="输入正确答案（或点下方按钮添加图片 / 文档）"
        value={text}
        onInput={(e) => setText(e.detail.value)}
      />

      {/* 附件列表 */}
      {atts.length ? (
        <View className="flex flex-row flex-wrap gap-2 mt-2">
          {atts.map((a) => {
            const shown = (a as AnswerAttachment & { url?: string; thumb_url?: string })
            const src = shown.thumb_url || shown.url
            return (
              <View key={a.id} className="relative" style={{ width: 76 }}>
                <View className="w-full rounded-lg overflow-hidden border border-border" style={{ height: 76 }}>
                  {a.type === 'image' && src ? (
                    <TaroImage
                      src={src}
                      mode="aspectFill"
                      style={{ width: '100%', height: '100%' }}
                      onClick={() => Taro.previewImage({ urls: [src], current: src })}
                    />
                  ) : a.type === 'text' ? (
                    <View className="w-full h-full p-1 flex items-center justify-center bg-muted">
                      <Text className="block text-[10px] text-center" style={{ fontSize: 9 }}>
                        {(a.text || '').slice(0, 20)}
                      </Text>
                    </View>
                  ) : (
                    <View className="w-full h-full flex flex-col items-center justify-center bg-muted">
                      <FileText size={18} color="#BE3E2D" />
                      <Text className="block text-[9px] mt-1 px-1 text-center" numberOfLines={1}>
                        {a.name || '文档'}
                      </Text>
                    </View>
                  )}
                </View>
                <View
                  className="absolute"
                  style={{ right: -4, top: -4 }}
                  onClick={() => void removeAttachment(a.id)}
                >
                  <Trash2 size={14} color="#BE3E2D" />
                </View>
              </View>
            )
          })}
        </View>
      ) : null}

      {/* 操作按钮 */}
      <View className="flex flex-row flex-wrap gap-2 mt-2">
        <View className={btn} onClick={() => void pickImage()}>
          <Plus size={12} color="#BE3E2D" />
          <Text className="block text-[11px]">图片</Text>
          <Crop size={10} color="#9A948A" />
        </View>
        <View className={btn} onClick={() => void pickDoc()}>
          <Plus size={12} color="#BE3E2D" />
          <Text className="block text-[11px]">文档</Text>
        </View>
        <View className={btn} onClick={() => setPickerOpen(true)}>
          <FileText size={12} color="#BE3E2D" />
          <Text className="block text-[11px]">资料库</Text>
        </View>
        <View className={btn} onClick={() => void handleSearch()}>
          <Globe size={12} color="#BE3E2D" />
          <Text className="block text-[11px]">{searching ? '搜题中…' : '联网搜答案'}</Text>
        </View>
        <View
          className="flex flex-row items-center gap-1 px-3 py-1 rounded-lg"
          style={{ backgroundColor: saving ? '#E8E2D9' : '#BE3E2D' }}
          onClick={() => { if (!saving) saveText() }}
        >
          <Text className="block text-[11px]" style={{ color: '#fff' }}>{saving ? '保存中' : '保存'}</Text>
        </View>
      </View>

      {/* 搜到的候选答案：必须「采纳」才入库 */}
      {candidate && candidate.source !== 'none' ? (
        <View className="mt-3 rounded-xl border p-3" style={{ borderColor: candidate.verified ? 'rgba(190,62,45,0.35)' : '#E8A33D', backgroundColor: candidate.verified ? 'rgba(190,62,45,0.04)' : 'rgba(232,163,61,0.08)' }}>
          <View className="flex flex-row items-center justify-between mb-1">
            <Text className="block text-xs font-semibold" style={{ color: candidate.verified ? '#BE3E2D' : '#B4761F' }}>
              {candidate.verified ? `搜到参考答案（联网 · ${candidate.refs.length} 条来源）` : '⚠️ 未联网核实（模型推理）'}
            </Text>
            <X size={14} color="#9A948A" onClick={() => setCandidate(null)} />
          </View>
          {candidate.answer ? (
            <Text className="block text-sm mb-1">{candidate.answer.slice(0, 300)}</Text>
          ) : null}
          {candidate.solution ? (
            <Text className="block text-xs text-muted-foreground mb-2">{candidate.solution.slice(0, 200)}</Text>
          ) : null}
          {candidate.note ? (
            <Text className="block text-[10px] text-muted-foreground mb-2">{candidate.note}</Text>
          ) : null}
          <View className="flex flex-row gap-2">
            <View
              className="flex flex-row items-center gap-1 px-3 py-1 rounded-lg"
              style={{ backgroundColor: '#BE3E2D' }}
              onClick={() => void handleAdopt()}
            >
              <Check size={12} color="#fff" />
              <Text className="block text-[11px]" style={{ color: '#fff' }}>采纳</Text>
            </View>
            <View
              className="px-3 py-1 rounded-lg border border-border"
              onClick={() => setCandidate(null)}
            >
              <Text className="block text-[11px] text-muted-foreground">放弃</Text>
            </View>
          </View>
        </View>
      ) : null}

      {/* 裁剪编辑器：cropTargetLabel 明示目标，防止裁给错的题 */}
      <ImageEditor
        visible={!!cropSrc}
        src={cropSrc}
        cropOnly
        enableSaveToInbox={false}
        confirmText="用作答案图"
        cropTargetLabel={`答案将存入：${label}`}
        onCancel={() => setCropSrc('')}
        onConfirm={(p) => void handleCropConfirm(p)}
      />

      <MaterialPicker
        visible={pickerOpen}
        title="从资料库选为答案"
        onClose={() => setPickerOpen(false)}
        onSelect={(d) => void handlePickLibrary(d)}
      />
    </View>
  )
}
