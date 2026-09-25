import { View, Text, ScrollView } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useState } from 'react'
import { FileSearch, Trash2, FolderMinus } from 'lucide-react-taro'
import { Skeleton } from '@/components/ui/skeleton'
import ReviewItemCard from '@/components/review-item-card'
import FilterHeader, {
  TagFilterBar, EmptyCard, BottomActionBar, ActionBtn,
} from '@/components/filter-header'
import { confirmDelete, useSelection } from '@/lib/use-selection'
import {
  fetchSubjects, fetchTimeline, batchDeleteTimeline, removeFromReviewBook, combineToPdf,
  type Subject, type TimelineItem,
} from '@/services/api'
import { openStorageFile } from '@/services/net'

const PAGE_SIZE = 20

export default function SubjectPage() {
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [activeSubject, setActiveSubject] = useState('')
  const [keyword, setKeyword] = useState('')
  const [activeTag, setActiveTag] = useState('')
  const [items, setItems] = useState<TimelineItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const sel = useSelection()

  // 从当前页数据里汇总出现过的标签，供筛选
  const tagPool = Array.from(new Set(items.flatMap((it) => it.tags || []))).slice(0, 12)

  const load = async (opts: { subjectId: string; keyword: string; tag: string; page: number; append?: boolean }) => {
    const { subjectId, keyword: kw, tag, page: p, append } = opts
    if (append) setLoadingMore(true)
    else setLoading(true)
    try {
      const res = await fetchTimeline({
        scope: 'review',
        subjectId: subjectId || undefined,
        keyword: kw || undefined,
        tag: tag || undefined,
        page: p,
        pageSize: PAGE_SIZE,
      })
      setItems((prev) => (append ? [...prev, ...res.list] : res.list))
      setTotal(res.total)
      setPage(res.page)
    } catch (e) {
      console.error('加载复习本失败', e)
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }

  const init = async () => {
    try {
      if (subjects.length === 0) {
        const subs = await fetchSubjects()
        setSubjects(subs)
      }
    } catch (e) {
      console.error('加载学科失败', e)
    }
    const preset = Taro.getStorageSync('filter_subject_id') || ''
    if (preset) Taro.removeStorageSync('filter_subject_id')
    setActiveSubject(preset)
    setKeyword('')
    setActiveTag('')
    sel.exit()
    await load({ subjectId: preset, keyword: '', tag: '', page: 1 })
  }

  useDidShow(() => {
    init()
  })

  const resetAndLoad = (patch: Partial<{ subjectId: string; keyword: string; tag: string }>) => {
    const next = {
      subjectId: patch.subjectId !== undefined ? patch.subjectId : activeSubject,
      keyword: patch.keyword !== undefined ? patch.keyword : keyword,
      tag: patch.tag !== undefined ? patch.tag : activeTag,
    }
    if (patch.subjectId !== undefined) setActiveSubject(patch.subjectId)
    if (patch.keyword !== undefined) setKeyword(patch.keyword)
    if (patch.tag !== undefined) setActiveTag(patch.tag)
    sel.exit()
    load({ ...next, page: 1 })
  }

  const handleOpen = (item: TimelineItem) => {
    if (sel.selecting) { sel.toggle(item.id); return }
    if (item.kind === 'image') {
      Taro.previewImage({ current: item.url || '', urls: [item.url || ''] })
      return
    }
    Taro.navigateTo({ url: `/pages/detail/index?id=${item.id}` })
  }

  const handleRemoveFromReview = async () => {
    if (sel.isEmpty) return
    setBusy(true)
    try {
      await removeFromReviewBook(Array.from(sel.selected))
      Taro.showToast({ title: '已移出复习本', icon: 'success' })
      sel.exit()
      load({ subjectId: activeSubject, keyword, tag: activeTag, page: 1 })
    } catch (e) {
      console.error(e)
      Taro.showToast({ title: '操作失败', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (sel.isEmpty) return
    const ok = await confirmDelete(sel.count, '条')
    if (!ok) return
    setBusy(true)
    try {
      await batchDeleteTimeline(Array.from(sel.selected))
      Taro.showToast({ title: '已删除', icon: 'success' })
      sel.exit()
      load({ subjectId: activeSubject, keyword, tag: activeTag, page: 1 })
    } catch (e) {
      console.error(e)
      Taro.showToast({ title: '删除失败', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  const handleCombinePdf = async () => {
    const imageIds = items.filter((it) => sel.selected.has(it.id) && it.kind === 'image').map((it) => it.id)
    if (!imageIds.length) {
      Taro.showToast({ title: '请选择图片资料', icon: 'none' })
      return
    }
    setBusy(true)
    try {
      const res = await combineToPdf(imageIds)
      openStorageFile(res.url, true)
    } catch (e) {
      console.error('合成 PDF 失败', e)
      Taro.showToast({ title: '合成失败，请确认所选为图片', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  const canLoadMore = items.length < total
  const goRecognize = () => Taro.navigateTo({ url: '/pages/recognize/index' })

  return (
    <View className="bg-background" style={{ position: 'relative', height: '100vh' }}>
      {/* 固定顶部：学科 + 搜索 + 标签 + 操作 */}
      <View style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 50, backgroundColor: '#fff', borderBottom: '1px solid #ecefe3' }}>
        <FilterHeader
          subjects={subjects}
          activeSubject={activeSubject}
          onSubjectChange={(id) => resetAndLoad({ subjectId: id })}
          keyword={keyword}
          onKeywordChange={(kw) => setKeyword(kw)}
          onSearch={() => resetAndLoad({ keyword: keyword })}
          countText={`复习本 · 共 ${total} 条`}
          placeholder="搜索题干 / 答案关键词，回车确认"
          right={
            !sel.selecting ? (
              <Text className="block text-sm text-primary" onClick={sel.enter}>批量选择</Text>
            ) : (
              <View className="flex flex-row items-center gap-3">
                {sel.count > 0 && (
                  <>
                    <Text className="block text-sm text-foreground">已选 {sel.count}</Text>
                    <Text className="block text-sm text-muted-foreground" onClick={sel.clear}>清空</Text>
                  </>
                )}
                <Text className="block text-sm text-primary" onClick={sel.exit}>取消</Text>
              </View>
            )
          }
        >
          <TagFilterBar tags={tagPool} active={activeTag} onChange={(t) => resetAndLoad({ tag: t })} />
        </FilterHeader>
      </View>

      <ScrollView
        scrollY
        style={{ height: '100vh', paddingTop: 168 }}
        onScrollToLower={() => {
          if (canLoadMore && !loadingMore && !loading) {
            load({ subjectId: activeSubject, keyword, tag: activeTag, page: page + 1, append: true })
          }
        }}
      >
        <View className="px-4 pb-28 pt-3">
          {loading ? (
            <View className="space-y-3">
              <Skeleton className="h-24 w-full rounded-2xl" />
              <Skeleton className="h-24 w-full rounded-2xl" />
              <Skeleton className="h-24 w-full rounded-2xl" />
            </View>
          ) : items.length ? (
            <>
              <View className="space-y-3">
                {items.map((it) => (
                  <ReviewItemCard
                    key={it.id}
                    item={it}
                    selecting={sel.selecting}
                    checked={sel.selected.has(it.id)}
                    onOpen={handleOpen}
                    onLongPress={(x) => sel.longPress(x.id)}
                    timeField="added_to_review_at"
                  />
                ))}
              </View>
              <View className="py-4 flex items-center justify-center">
                <Text className="block text-xs text-muted-foreground">
                  {loadingMore ? '加载中…' : canLoadMore ? `上拉加载更多（${items.length}/${total}）` : '已经到底啦'}
                </Text>
              </View>
            </>
          ) : (
            <EmptyCard
              title="复习本还是空的"
              hint="到收件箱长按选择题目，点「加入复习本」即可归档到这里"
              actionLabel="去拍照识别"
              onAction={goRecognize}
            />
          )}
        </View>
      </ScrollView>

      {sel.selecting && (
        <BottomActionBar>
          <View style={{ flex: 1 }}>
            <ActionBtn
              icon={<FileSearch size={16} color="#fff" />}
              label="合成PDF"
              disabled={sel.isEmpty || busy}
              onClick={handleCombinePdf}
            />
          </View>
          <View style={{ flex: 1 }}>
            <ActionBtn
              icon={<FolderMinus size={16} color="#fff" />}
              label="移出复习本"
              disabled={sel.isEmpty || busy}
              onClick={handleRemoveFromReview}
            />
          </View>
          <View style={{ flex: 1 }}>
            <ActionBtn
              icon={<Trash2 size={16} color="#fff" />}
              label="删除"
              danger
              disabled={sel.isEmpty || busy}
              onClick={handleDelete}
            />
          </View>
        </BottomActionBar>
      )}
    </View>
  )
}
