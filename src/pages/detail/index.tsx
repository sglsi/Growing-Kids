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
  fetchSimilar, markReviewed,
  type Subject, type TimelineItem,
} from '@/services/api'
import { getSubjectColor, formatTime, formatDate, truncate, type SimilarItem, type ReviewPlan } from '@/types'
import { openStorageFile } from '@/services/net'

/** P2-18 艾宾浩斯间隔（与后端 timeline/review.ts 保持一致） */
const EBBINGHAUS_INTERVALS = [1, 2, 4, 7, 15, 30]
/** 前端现算复习计划（纯本地，避免跨端引后端模块） */
function computePlan(createdAt?: string, reviewCount = 0): ReviewPlan {
  const base = createdAt ? new Date(createdAt) : new Date()
  const total = EBBINGHAUS_INTERVALS.length
  const count = Math.max(0, Math.min(total, Math.floor(reviewCount) || 0))
  const schedule = EBBINGHAUS_INTERVALS.map((day, i) => {
    const d = new Date(base)
    d.setDate(d.getDate() + day)
    return { stage: i + 1, day, date: d.toISOString(), done: i < count }
  })
  const next = schedule.find((s) => !s.done)
  return {
    review_count: count,
    total_stages: total,
    completed: count >= total,
    next_review_at: next ? next.date : null,
    schedule,
  }
}

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
  // P2-18 复习计划
  const [plan, setPlan] = useState<ReviewPlan | null>(null)
  const [reviewing, setReviewing] = useState(false)
  // P2-17 相似题
  const [similar, setSimilar] = useState<SimilarItem[]>([])
  const [similarOpen, setSimilarOpen] = useState(false)
  const [similarLoading, setSimilarLoading] = useState(false)

  const load = async () => {
    const [it, subs] = await Promise.all([fetchTimelineDetail(id), fetchSubjects()])
    setItem(it)
    setSubjects(subs)
    setSubjectId(it.subject_id || '')
    setQContent(it.content?.question || '')
    setAContent(it.content?.answer || '')
    setSolution(it.content?.solution || '')
    setMastered(it.mastered)
    setPlan(computePlan(it.created_at, it.content?.review_count))
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

  // P2-18 标记本次复习完成：更新计数并刷新复习计划
  const handleReview = async () => {
    if (!item) return
    setReviewing(true)
    try {
      const { review_count, plan: newPlan } = await markReviewed(item.id)
      setPlan(newPlan)
      setItem({ ...item, content: { ...item.content, review_count } })
      Taro.showToast({ title: '已记录本次复习', icon: 'success' })
    } catch (e) {
      console.error(e)
      Taro.showToast({ title: '操作失败', icon: 'none' })
    } finally {
      setReviewing(false)
    }
  }

  // P2-17 展开相似题：按需拉取（基于用户自建错题历史）
  const toggleSimilar = async () => {
    const next = !similarOpen
    setSimilarOpen(next)
    if (next && !similar.length && item) {
      setSimilarLoading(true)
      try {
        const list = await fetchSimilar(item.id, 5)
        setSimilar(list)
      } catch (e) {
        console.error(e)
        Taro.showToast({ title: '相似题加载失败', icon: 'none' })
      } finally {
        setSimilarLoading(false)
      }
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

        <View className="flex flex-row items-center justify-between mb-2">
          <Text className="block text-sm font-semibold text-foreground">题目</Text>
          {item?.content?.question_label ? (
            <View style={{ backgroundColor: 'rgba(190,62,45,0.08)', borderRadius: 6, paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 2 }}>
              <Text className="block text-xs" style={{ color: '#BE3E2D' }}>{item.content.question_label}</Text>
            </View>
          ) : null}
        </View>
        <Card className="rounded-2xl border-border p-4 mb-4">
          <Textarea
            className="min-h-32 border-0 ring-0 focus-within:ring-0 rounded-xl"
            value={qContent}
            placeholder="题目内容"
            maxlength={3000}
            onInput={(e) => setQContent(e.detail.value)}
          />
        </Card>

        {item?.question_image_urls?.length ? (
          <View className="mb-4">
            <Text className="block text-xs text-muted-foreground mb-2">题面图</Text>
            <View className="flex flex-row flex-wrap gap-2">
              {item.question_image_urls.map((u) => (
                <View key={u} className="w-24 h-24 rounded-lg overflow-hidden border border-border">
                  <Image
                    src={u}
                    mode="aspectFill"
                    style={{ width: '100%', height: '100%' }}
                    onClick={() => Taro.previewImage({ current: u, urls: item.question_image_urls || [u] })}
                  />
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {item?.answer_image_urls?.length ? (
          <View className="mb-4">
            <Text className="block text-xs text-muted-foreground mb-2">答题卡图</Text>
            <View className="flex flex-row flex-wrap gap-2">
              {item.answer_image_urls.map((u) => (
                <View key={u} className="w-24 h-24 rounded-lg overflow-hidden border border-border">
                  <Image
                    src={u}
                    mode="aspectFill"
                    style={{ width: '100%', height: '100%' }}
                    onClick={() => Taro.previewImage({ current: u, urls: item.answer_image_urls || [u] })}
                  />
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {!item?.question_image_urls?.length && !item?.answer_image_urls?.length && item?.image_urls?.length ? (
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

        {/* P2-16 错因分析 */}
        {item?.content?.error_analysis?.label && (
          <Card className="rounded-2xl border p-4 mb-4" style={{ borderColor: 'rgba(190,62,45,0.25)', backgroundColor: 'rgba(190,62,45,0.04)' }}>
            <Text className="block text-sm font-semibold mb-1" style={{ color: '#BE3E2D' }}>错因分析</Text>
            <Text className="block text-sm font-medium text-foreground mb-1">{item.content.error_analysis.label}</Text>
            {item.content.error_analysis.reason && (
              <Text className="block text-xs text-muted-foreground mb-1">{item.content.error_analysis.reason}</Text>
            )}
            {item.content.error_analysis.suggestion && (
              <Text className="block text-xs text-muted-foreground">{item.content.error_analysis.suggestion}</Text>
            )}
          </Card>
        )}

        {/* P2-18 艾宾浩斯复习计划 */}
        {item && plan && (
          <Card className="rounded-2xl border-border p-4 mb-4">
            <View className="flex flex-row items-center justify-between mb-2">
              <Text className="block text-sm font-semibold text-foreground">复习计划（艾宾浩斯）</Text>
              <Text className="block text-xs text-muted-foreground">已复习 {plan.review_count}/{plan.total_stages}</Text>
            </View>
            <View className="flex flex-row items-center gap-1 flex-wrap mb-3">
              {plan.schedule.map((s) => (
                <View key={s.stage} className="flex flex-col items-center px-1">
                  <View
                    className={`w-6 h-6 rounded-full flex items-center justify-center ${s.done ? 'border-0' : 'bg-muted border border-border'}`}
                    style={s.done ? { backgroundColor: '#BE3E2D' } : undefined}
                  >
                    <Text className={`text-[10px] ${s.done ? '' : 'text-muted-foreground'}`} style={s.done ? { color: '#fff' } : undefined}>
                      {s.done ? '✓' : s.stage}
                    </Text>
                  </View>
                  <Text className="block text-[10px] text-muted-foreground mt-1">第{s.day}天</Text>
                </View>
              ))}
            </View>
            <View className="flex flex-row items-center justify-between">
              <Text className="block text-xs text-muted-foreground">
                {plan.completed ? '已全部完成复习阶段 🎉' : `下次复习：${plan.next_review_at ? formatDate(plan.next_review_at) : '—'}`}
              </Text>
              {!plan.completed && (
                <Button variant="outline" className="h-8 rounded-lg px-3" onClick={handleReview} disabled={reviewing}>
                  <Text className="block text-xs">{reviewing ? '记录中…' : '今天复习了 ✓'}</Text>
                </Button>
              )}
            </View>
          </Card>
        )}

        {/* P2-17 相似 / 变式题（基于用户自建错题历史） */}
        <View className="mb-4">
          <Text className="block text-sm font-semibold text-foreground mb-2" onClick={toggleSimilar}>
            相似 / 变式题 {similarOpen ? '▾' : '▸'}
          </Text>
          {similarOpen && (
            similarLoading ? (
              <Text className="block text-xs text-muted-foreground">加载中…</Text>
            ) : similar.length ? (
              <View className="flex flex-col gap-2">
                {similar.map((s) => (
                  <View key={s.id} className="rounded-xl border border-border p-3">
                    <Text className="block text-xs text-foreground mb-1">{truncate(s.question || '（无题面文本）', 80)}</Text>
                    <View className="flex flex-row items-center justify-between">
                      <View className="flex flex-row gap-1 flex-wrap">
                        {s.shared_tags.map((t) => (
                          <Text key={t} className="block text-[10px]" style={{ color: '#BE3E2D', backgroundColor: 'rgba(190,62,45,0.1)' }}>
                            {t}
                          </Text>
                        ))}
                      </View>
                      <Text className="block text-[10px] text-muted-foreground">相似度 {Math.round(s.score * 100)}%</Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <Text className="block text-xs text-muted-foreground">暂无相似错题（多在「最近题目」里多攒几道同知识点题后会显现）</Text>
            )
          )}
        </View>

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
