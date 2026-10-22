import { View, Text, ScrollView } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useState, useRef } from 'react'
import { FileSearch, Trash2, FolderMinus } from 'lucide-react-taro'
import { Skeleton } from '@/components/ui/skeleton'
import ReviewItemCard from '@/components/review-item-card'
import ImageEditor from '@/components/image-editor'
import AnswerSheet from '@/components/answer-sheet'
import FilterHeader, {
  TagFilterBar, EmptyCard, BottomActionBar, ActionBtn,
} from '@/components/filter-header'
import SelectionBar from '@/components/selection-bar'
import RangePicker, { getSinceFromRange, type RangeValue } from '@/components/range-picker'
import { confirmDelete, useSelection } from '@/lib/use-selection'
import {
  fetchSubjects, fetchTimeline, batchDeleteTimeline, removeFromReviewBook, combineToPdf,
  updateQuestion, uploadImage, replaceTimelineImage,
  type Subject, type TimelineItem, type Paged, type ImageAction,
} from '@/services/api'
import { cacheGet, cacheSet, cacheListKey } from '@/services/cache'
import { openStorageFile } from '@/services/net'

const PAGE_SIZE = 20

export default function SubjectPage() {
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [activeSubject, setActiveSubject] = useState('')
  const [keyword, setKeyword] = useState('')
  const [activeTag, setActiveTag] = useState('')
  const [range, setRange] = useState<RangeValue>('all')
  const [latestTimestamp, setLatestTimestamp] = useState<string | undefined>(undefined)
  const [items, setItems] = useState<TimelineItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const sel = useSelection()
  // 图片编辑器状态（思傅 2026-10-22：复习本与首页同一套规则——点图片可直接编辑）
  const [editorItem, setEditorItem] = useState<TimelineItem | null>(null)
  // 答案面板的目标题目（思傅 2026-10-21）
  const [answerItem, setAnswerItem] = useState<TimelineItem | null>(null)
  const [editorSrc, setEditorSrc] = useState('')
  const [editorAction, setEditorAction] = useState<ImageAction | null>(null)
  const [editorTarget, setEditorTarget] = useState<'item' | 'questionImage'>('item')
  const [editorIndex, setEditorIndex] = useState(0)
  const [savingEdit, setSavingEdit] = useState(false)
  // 列表滚动位置（思傅 2026-10-21 / 2026-10-22 增强：与首页同一规则，按 id 锚回原题）
  const [scrollTop, setScrollTop] = useState(0)
  const scrollRef = useRef(0)
  const restoredRef = useRef(false)
  /** 待恢复的题目 id（仅「从详情返回」路径写入；列表内操作不写 → 不会误滚） */
  const pendingRestoreIdRef = useRef<string>('')
  /** 离开本页去详情前，记录点的是哪道题，回来时按 id 锚回原题 */
  const restoreItemIdRef = useRef<string>('')

  /** 按题目 id 把列表滚到该题顶部附近（Taro 受控 scrollTop：值不变不触发滚动，故先偏移再归位） */
  const scrollToItemById = (id: string, extra = 0) => {
    const q = Taro.createSelectorQuery()
    q.select('#list-scroll').scrollOffset()
    q.select('#list-scroll').boundingClientRect()
    q.select(`#tl-item-${id}`).boundingClientRect()
    q.exec((res: any) => {
      const so = res[0] as { scrollTop: number } | null
      const sv = res[1] as { top: number } | null
      const it = res[2] as { top: number } | null
      if (!so || !sv || !it) return
      const target = Math.max(0, so.scrollTop + (it.top - sv.top) - extra)
      setScrollTop(target - 1)
      setTimeout(() => setScrollTop(target), 40)
    })
  }

  // 从当前页数据里汇总出现过的标签，供筛选
  const tagPool = Array.from(new Set(items.flatMap((it) => it.tags || []))).slice(0, 12)

  const load = async (opts: { subjectId: string; keyword: string; tag: string; page: number; since?: string; append?: boolean }) => {
    const { subjectId, keyword: kw, tag, page: p, since, append } = opts
    if (append) setLoadingMore(true)
    else setLoading(true)
    // SWR（思傅 2026-10-21）：只对「第一页、非追加」查询读缓存——
    // 分页追加的中间页缓存意义小且 key 会膨胀；写操作已在 api.ts 失效 tl 域。
    const listKey = append
      ? ''
      : cacheListKey('tl', { scope: 'review', subjectId, keyword: kw, tag, since: since || '', page: p, pageSize: PAGE_SIZE })
    const cached = listKey ? cacheGet<Paged<TimelineItem>>(listKey) : null
    if (cached && !append) {
      setItems(cached.list)
      setTotal(cached.total)
      setPage(cached.page)
      if (cached.list[0]) {
        const ts = cached.list[0].added_to_review_at || cached.list[0].created_at
        if (ts) setLatestTimestamp(ts)
      }
      setLoading(false)
    }
    try {
      const res = await fetchTimeline({
        scope: 'review',
        subjectId: subjectId || undefined,
        keyword: kw || undefined,
        tag: tag || undefined,
        since,
        page: p,
        pageSize: PAGE_SIZE,
      })
      setItems((prev) => (append ? [...prev, ...res.list] : res.list))
      setTotal(res.total)
      setPage(res.page)
      if (listKey) cacheSet(listKey, res)
      // 记录当前结果中最新一条的时间，作为"自动"模式的锚点
      if (!append && res.list[0]) {
        const ts = res.list[0].added_to_review_at || res.list[0].created_at
        if (ts) setLatestTimestamp(ts)
      }
    } catch (e) {
      console.error('加载复习本失败', e)
    } finally {
      setLoading(false)
      setLoadingMore(false)
      // 列表已渲染出来（loading 结束）→ 按 id 锚回原题（双帧 + 先偏移再归位强制 Taro 触发滚动）
      const rid = pendingRestoreIdRef.current
      if (rid) {
        pendingRestoreIdRef.current = ''
        setTimeout(() => scrollToItemById(rid, 8), 60)
      }
    }
  }

  const init = async () => {
    try {
      if (subjects.length === 0) {
        const cachedSubs = cacheGet<Subject[]>('subj:list')
        if (cachedSubs) setSubjects(cachedSubs)
        const subs = await fetchSubjects()
        setSubjects(subs)
        if (subs.length) cacheSet('subj:list', subs)
      }
    } catch (e) {
      console.error('加载学科失败', e)
    }
    const preset = Taro.getStorageSync('filter_subject_id') || ''
    if (preset) Taro.removeStorageSync('filter_subject_id')
    setActiveSubject(preset)
    setKeyword('')
    setActiveTag('')
    setRange('all')
    setLatestTimestamp(undefined)
    sel.exit()
    await load({ subjectId: preset, keyword: '', tag: '', page: 1 })
  }

  useDidShow(() => {
    // 从详情页返回：回到「同一道题」（按 id 锚定），只恢复一次
    if (!restoredRef.current && restoreItemIdRef.current) {
      pendingRestoreIdRef.current = restoreItemIdRef.current
      restoredRef.current = true
    }
    init()
  })

  const resetAndLoad = (patch: Partial<{ subjectId: string; keyword: string; tag: string; range: RangeValue }>) => {
    const nextRange = patch.range !== undefined ? patch.range : range
    const since = getSinceFromRange(nextRange, latestTimestamp)
    const next = {
      subjectId: patch.subjectId !== undefined ? patch.subjectId : activeSubject,
      keyword: patch.keyword !== undefined ? patch.keyword : keyword,
      tag: patch.tag !== undefined ? patch.tag : activeTag,
    }
    if (patch.subjectId !== undefined) setActiveSubject(patch.subjectId)
    if (patch.keyword !== undefined) setKeyword(patch.keyword)
    if (patch.tag !== undefined) setActiveTag(patch.tag)
    if (patch.range !== undefined) {
      setRange(patch.range)
      // 切到自动时清空锚点，由下次请求首条重新确定
      if (patch.range !== 'auto') setLatestTimestamp(undefined)
    }
    sel.exit()
    load({ ...next, page: 1, since })
  }

  /**
   * 打开图片编辑器（思傅 2026-10-22：与首页同一规则——点图片 = 直接打开并可编辑）。
   * @param target 'item' = 图片条目本身；'questionImage' = 题目条目的题面图
   */
  const openEditor = (
    item: TimelineItem,
    action: ImageAction | 'crop',
    target: 'item' | 'questionImage' = 'item',
    index = 0,
    srcOverride?: string,
  ) => {
    const src = srcOverride || (target === 'questionImage'
      ? (item.question_image_urls || [])[index] || ''
      : (item.url || item.thumb_url || ''))
    setEditorItem(item)
    setEditorSrc(src)
    setEditorAction(action === 'crop' ? null : action)
    setEditorTarget(target)
    setEditorIndex(index)
  }

  /** 点列表里的图片 → 直接打开该图片（可编辑），与首页一致 */
  const handleTapImage = (item: TimelineItem, url: string, index: number, kind: 'item' | 'questionImage') => {
    if (sel.selecting) { sel.toggle(item.id); return }
    openEditor(item, 'crop', kind, index, url)
  }

  // ---------- 填答案（思傅 2026-10-21）：与首页同一套规则 ----------
  const openAnswer = (item: TimelineItem) => setAnswerItem(item)
  const closeAnswer = () => setAnswerItem(null)
  const handleAnswerSaved = (updated: TimelineItem) => {
    setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
  }

  /** 编辑器返回：保存并原位替换原图（与首页 handleEditorConfirm 同规则） */
  const handleEditorConfirm = async (tempFilePath: string) => {
    const item = editorItem
    const target = editorTarget
    const index = editorIndex
    setEditorItem(null)
    setEditorSrc('')
    if (!item) return
    setSavingEdit(true)
    Taro.showLoading({ title: '保存中…', mask: true })
    try {
      if (target === 'questionImage') {
        const up = await uploadImage(tempFilePath, { purpose: 'attach' })
        const keys = item.content?.question_images || []
        const nextKeys = keys.map((k, i) => (i === index ? up.key : k))
        await updateQuestion(item.id, { question_images: nextKeys })
        Taro.hideLoading()
        Taro.showToast({ title: '图片已更新', icon: 'success' })
      } else {
        // replaceTimelineImage 内部会同步换 thumb_key（否则列表仍显示旧缩略图）
        await replaceTimelineImage({ id: item.id, subject_id: item.subject_id }, tempFilePath)
        Taro.hideLoading()
        Taro.showToast({ title: '已更新该资料', icon: 'success' })
      }
      const since = getSinceFromRange(range, latestTimestamp)
      await load({ subjectId: activeSubject, keyword, tag: activeTag, page: 1, since })
    } catch (e) {
      Taro.hideLoading()
      console.error('保存编辑结果失败', e)
      const msg = e instanceof Error && e.message ? e.message : '保存失败，请重试'
      Taro.showToast({ title: msg, icon: 'none' })
    } finally {
      setSavingEdit(false)
    }
  }

  const handleOpen = (item: TimelineItem) => {
    if (sel.selecting) { sel.toggle(item.id); return }
    // 思傅 2026-10-22：复习本与首页同一规则——点卡片任意区域都进题目详情，
    // 只有点图片才走编辑器（见 handleTapImage）。旧行为「图片条目只预览不进详情」已废弃。
    // 记录点的是哪道题，回来时按 id 锚回原题（而非像素偏移 → 列表重排也不跑偏）
    restoreItemIdRef.current = item.id
    restoredRef.current = false
    Taro.navigateTo({ url: `/pages/detail/index?id=${item.id}` })
  }

  const handleRemoveFromReview = async () => {
    if (sel.isEmpty) return
    setBusy(true)
    try {
      await removeFromReviewBook(Array.from(sel.selected))
      Taro.showToast({ title: '已移出复习本', icon: 'success' })
      sel.exit()
      const since = getSinceFromRange(range, latestTimestamp)
      load({ subjectId: activeSubject, keyword, tag: activeTag, page: 1, since })
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
      const since = getSinceFromRange(range, latestTimestamp)
      load({ subjectId: activeSubject, keyword, tag: activeTag, page: 1, since })
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
      openStorageFile(res.url, true, res.key)
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
          right={<SelectionBar selection={sel} enterLabel="批量选择" countPrefix="已选" />}
        >
          <TagFilterBar tags={tagPool} active={activeTag} onChange={(t) => resetAndLoad({ tag: t })} />
          <View className="mt-2">
            <RangePicker value={range} onChange={(v) => resetAndLoad({ range: v })} />
          </View>
        </FilterHeader>
      </View>

      <ScrollView
        id="list-scroll"
        scrollY
        scrollTop={scrollTop}
        onScroll={(e) => { scrollRef.current = (e as any)?.detail?.scrollTop || 0 }}
        style={{ height: '100vh', paddingTop: 168 }}
        onScrollToLower={() => {
          if (canLoadMore && !loadingMore && !loading) {
            const since = getSinceFromRange(range, latestTimestamp)
            load({ subjectId: activeSubject, keyword, tag: activeTag, page: page + 1, since, append: true })
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
                  <View id={`tl-item-${it.id}`} key={it.id}>
                    <ReviewItemCard
                      item={it}
                      selecting={sel.selecting}
                      checked={sel.selected.has(it.id)}
                      onOpen={handleOpen}
                      onTapImage={handleTapImage}
                      onLongPress={(x) => sel.longPress(x.id)}
                      timeField="added_to_review_at"
                      onAnswer={openAnswer}
                    />
                  </View>
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

      {/* 图片编辑器（思傅 2026-10-22：复习本与首页同一套规则，点图片即可编辑并原位替换） */}
      <ImageEditor
        visible={!!editorSrc}
        src={editorSrc}
        autoAction={editorAction}
        enableSaveToInbox={false}
        confirmText="保存并替换原图"
        onCancel={() => { setEditorItem(null); setEditorSrc('') }}
        onConfirm={(p) => void handleEditorConfirm(p)}
      />

      {/* 填答案面板（复习本条目旁「＋填答案」拉起，与首页同一套规则） */}
      <AnswerSheet
        visible={!!answerItem}
        item={answerItem}
        onClose={closeAnswer}
        onSaved={handleAnswerSaved}
      />
      {savingEdit ? (
        <View style={{ position: 'fixed', left: 0, top: 0, right: 0, bottom: 0, zIndex: 300 }} />
      ) : null}
    </View>
  )
}
