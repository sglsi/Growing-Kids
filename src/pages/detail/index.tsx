import { View, Text, ScrollView, Picker, Image } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import {
  fetchTimelineDetail, fetchSubjects, updateQuestion, searchSolution, exportDocument,
  addToReviewBook, removeFromReviewBook, deleteTimeline,
  type Subject, type TimelineItem,
} from '@/services/api'
import { getSubjectColor, formatTime } from '@/types'
import { openStorageFile } from '@/services/net'

export default function DetailPage() {
  const router = useRouter()
  const id = router.params.id || ''
  const [item, setItem] = useState<TimelineItem | null>(null)
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [subjectId, setSubjectId] = useState('')
  const [qContent, setQContent] = useState('')
  const [aContent, setAContent] = useState('')
  const [solution, setSolution] = useState('')
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [searchHint, setSearchHint] = useState('')
  const [mastered, setMastered] = useState(false)

  const load = async () => {
    const [it, subs] = await Promise.all([fetchTimelineDetail(id), fetchSubjects()])
    setItem(it)
    setSubjects(subs)
    setSubjectId(it.subject_id || '')
    setQContent(it.content?.question || '')
    setAContent(it.content?.answer || '')
    setSolution(it.content?.solution || '')
    setMastered(it.mastered)
  }

  useEffect(() => {
    load()
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      const updated = await updateQuestion(id, {
        subject_id: subjectId,
        question_content: qContent,
        answer_content: aContent,
        solution,
        status: aContent ? 'answered' : 'pending',
        mastered,
      })
      setItem(updated)
      Taro.showToast({ title: '已保存', icon: 'success' })
    } catch (e) {
      console.error('保存失败', e)
      Taro.showToast({ title: '保存失败', icon: 'none' })
    } finally {
      setSaving(false)
    }
  }

  const handleSearch = async () => {
    if (!qContent) {
      Taro.showToast({ title: '题目为空，无法搜题', icon: 'none' })
      return
    }
    setSearching(true)
    setSearchHint('正在联网检索解题过程…')
    try {
      const res = await searchSolution(qContent)
      setAContent(res.answer)
      setSolution(res.solution)
      setSearchHint('已找到参考解答，请核对后保存')
    } catch (e) {
      console.error('搜题失败', e)
      setSearchHint('未检索到可靠答案，可手动填写')
    } finally {
      setSearching(false)
    }
  }

  const handlePrint = async () => {
    try {
      const res = await exportDocument({ subject_id: subjectId || undefined })
      openStorageFile(res.url, false)
    } catch (e) {
      console.error('导出失败', e)
      Taro.showToast({ title: '导出失败', icon: 'none' })
    }
  }

  // 加入 / 移出复习本
  const toggleReviewBook = async () => {
    if (!item) return
    try {
      if (item.in_review_book) {
        await removeFromReviewBook([item.id])
      } else {
        await addToReviewBook([item.id])
      }
      await load()
      Taro.showToast({ title: item.in_review_book ? '已移出复习本' : '已加入复习本', icon: 'success' })
    } catch (e) {
      console.error(e)
      Taro.showToast({ title: '操作失败', icon: 'none' })
    }
  }

  const handleDelete = async () => {
    const ok = await new Promise<boolean>((resolve) =>
      Taro.showModal({
        title: '确认删除',
        content: '删除后不可恢复，是否继续？',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      }),
    )
    if (!ok) return
    try {
      await deleteTimeline(id)
      Taro.showToast({ title: '已删除', icon: 'success' })
      setTimeout(() => Taro.navigateBack(), 700)
    } catch (e) {
      console.error(e)
      Taro.showToast({ title: '删除失败', icon: 'none' })
    }
  }

  const color = getSubjectColor(item?.subjects?.color)

  // 图片资料（kind=image）：只展示图片 + 归属学科，不做题目编辑
  if (item && item.kind === 'image') {
    return (
      <ScrollView scrollY className="h-full bg-background">
        <View className="px-4 pt-4 pb-32">
          <View className="flex flex-row items-center gap-2 mb-4">
            <View className={`flex flex-row items-center gap-2 rounded-full border px-3 py-1 ${color.badge}`}>
              <View className={`w-2 h-2 rounded-full ${color.dot}`} />
              <Text className="block text-xs">{item.subjects?.name || '未分类'}</Text>
            </View>
            <Text className="block text-xs text-muted-foreground">{formatTime(item.created_at)}</Text>
          </View>

          <Card className="rounded-2xl border-border overflow-hidden mb-4">
            <Image
              src={item.url || ''}
              mode="widthFix"
              style={{ width: '100%' }}
              onClick={() => Taro.previewImage({ current: item.url || '', urls: [item.url || ''] })}
            />
          </Card>

          <View className="flex flex-row items-center justify-between bg-muted rounded-xl px-4 py-3 mb-4">
            <View className="flex-1">
              <Text className="block text-sm font-medium text-foreground">归属学科</Text>
              <Text className="block text-xs text-muted-foreground">用于归档与筛选</Text>
            </View>
            <Picker
              mode="selector"
              range={subjects}
              rangeKey="name"
              value={Math.max(0, subjects.findIndex((s) => s.id === subjectId))}
              onChange={async (e) => {
                const sid = subjects[Number(e.detail.value)]?.id || subjectId
                setSubjectId(sid)
                try {
                  await updateQuestion(id, { subject_id: sid })
                } catch (err) {
                  console.error(err)
                }
              }}
            >
              <Text className="block text-sm text-primary">
                {subjects.find((s) => s.id === subjectId)?.name || '选择学科'}
              </Text>
            </Picker>
          </View>

          <View className="flex flex-row gap-3">
            <Button variant="outline" className="flex-1 h-11 rounded-xl" onClick={toggleReviewBook}>
              <Text className="block text-sm">{item.in_review_book ? '移出复习本' : '加入复习本'}</Text>
            </Button>
            <Button variant="outline" className="flex-1 h-11 rounded-xl" onClick={handleDelete}>
              <Text className="block text-sm" style={{ color: '#BE3E2D' }}>删除</Text>
            </Button>
          </View>
        </View>
      </ScrollView>
    )
  }

  return (
    <ScrollView scrollY className="h-full bg-background">
      <View className="px-4 pt-4 pb-32">
        {item && (
          <View className="flex flex-row items-center justify-between mb-4">
            <View className="flex flex-row items-center gap-2">
              <View className={`flex flex-row items-center gap-2 rounded-full border px-3 py-1 ${color.badge}`}>
                <View className={`w-2 h-2 rounded-full ${color.dot}`} />
                <Text className="block text-xs">{item.subjects?.name || '未分类'}</Text>
              </View>
              <Picker
                mode="selector"
                range={subjects}
                rangeKey="name"
                value={Math.max(0, subjects.findIndex((s) => s.id === subjectId))}
                onChange={(e) => setSubjectId(subjects[Number(e.detail.value)]?.id || subjectId)}
              >
                <Text className="block text-xs text-muted-foreground">切换学科</Text>
              </Picker>
            </View>
            <Text
              className="block text-xs text-primary"
              onClick={toggleReviewBook}
            >
              {item.in_review_book ? '★ 已加入复习本' : '☆ 加入复习本'}
            </Text>
          </View>
        )}

        <View className="flex flex-row items-center justify-between bg-muted rounded-xl px-4 py-3 mb-4">
          <View className="flex-1">
            <Text className="block text-sm font-medium text-foreground">已掌握</Text>
            <Text className="block text-xs text-muted-foreground">标记后默认不进入汇总，可在文档页开启开关重新纳入</Text>
          </View>
          <Switch checked={mastered} onCheckedChange={(v) => setMastered(v)} />
        </View>

        <Text className="block text-sm font-semibold text-foreground mb-2">题目</Text>
        <Card className="rounded-2xl border-border p-4 mb-4">
          <Textarea
            className="min-h-32 border-0 ring-0 focus-within:ring-0 rounded-xl"
            value={qContent}
            placeholder="题目内容"
            maxlength={3000}
            onInput={(e) => setQContent(e.detail.value)}
          />
        </Card>

        {item?.image_urls?.length ? (
          <View className="flex flex-row flex-wrap gap-2 mb-4">
            {item.image_urls.map((u) => (
              <View key={u} className="w-24 h-24 rounded-lg overflow-hidden border border-border">
                <Image
                  src={u}
                  mode="aspectFill"
                  style={{ width: '100%', height: '100%' }}
                  onClick={() => Taro.previewImage({ current: u, urls: item.image_urls || [u] })}
                />
              </View>
            ))}
          </View>
        ) : null}

        <View className="flex flex-row items-center justify-between mb-2">
          <Text className="block text-sm font-semibold" style={{ color: '#BE3E2D' }}>正确答案 / 解题过程</Text>
          <Text className="block text-xs text-primary" onClick={handleSearch}>
            {searching ? '检索中…' : '联网搜题'}
          </Text>
        </View>
        <Card className="rounded-2xl p-4 mb-2" style={{ borderColor: 'rgba(190,62,45,0.25)', backgroundColor: 'rgba(190,62,45,0.04)' }}>
          <Textarea
            className="min-h-24 border-0 ring-0 focus-within:ring-0 rounded-xl"
            value={aContent}
            placeholder="无答案时可点右上角联网搜题，或手动填写"
            maxlength={3000}
            onInput={(e) => setAContent(e.detail.value)}
          />
        </Card>

        <Text className="block text-xs text-muted-foreground mb-2 mt-4">详细解题过程</Text>
        <Card className="rounded-2xl border-border p-4 mb-2">
          <Textarea
            className="min-h-28 border-0 ring-0 focus-within:ring-0 rounded-xl"
            value={solution}
            placeholder="可粘贴或联网获取详细解析"
            maxlength={3000}
            onInput={(e) => setSolution(e.detail.value)}
          />
        </Card>
        {searchHint && <Text className="block text-xs text-muted-foreground mb-4">{searchHint}</Text>}

        <View className="mt-6">
          <Text className="block text-xs text-muted-foreground" onClick={handleDelete} style={{ color: '#BE3E2D' }}>
            删除这条记录
          </Text>
        </View>
      </View>

      <View style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        display: 'flex', flexDirection: 'row', gap: '12px',
        padding: '12px 16px', backgroundColor: '#fff', borderTop: '1px solid #ece8e0', zIndex: 100,
      }}
      >
        <Button variant="outline" className="flex-1 h-11 rounded-xl" onClick={handlePrint}>
          <Text className="block text-sm">导出打印</Text>
        </Button>
        <Button className="flex-1 h-11 rounded-xl" disabled={saving} onClick={handleSave}>
          <Text className="block text-sm">{saving ? '保存中…' : '保存修改'}</Text>
        </Button>
      </View>
    </ScrollView>
  )
}
