import { View, Text, ScrollView } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useEffect, useState, useRef } from 'react'
import { FileSearch, FileText, Trash2, FolderMinus, BookmarkMinus, Crop, Wand, Sparkles, Tag, Ellipsis } from 'lucide-react-taro'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import ReviewItemCard from '@/components/review-item-card'
import ReviewQueue from '@/components/review-queue'
import ImageEditor from '@/components/image-editor'
import AnswerSheet from '@/components/answer-sheet'
import FilterHeader, {
  TagFilterBar, EmptyCard, BottomActionBar, ActionBtn,
} from '@/components/filter-header'
import SelectionBar, { CheckDot } from '@/components/selection-bar'
import SubjectBadge from '@/components/subject-badge'
import SegmentedTabs from '@/components/segmented-tabs'
import RenameDialog from '@/components/rename-dialog'
import RangePicker, { getSinceFromRange, type RangeValue } from '@/components/range-picker'
import { confirmDelete, useSelection } from '@/lib/use-selection'
import {
  fetchSubjects, fetchTimeline, batchDeleteTimeline, removeFromReviewBook, combineToPdf,
  updateTimeline, updateQuestion, uploadImage, replaceTimelineImage, fetchReviewSummary, saveQuestionAsImage,
  fetchDocuments, batchDeleteDocuments, deleteDocument, renameDocument,
  type Subject, type TimelineItem, type Paged, type ImageAction, type ReviewSummary, type DocItem,
} from '@/services/api'
import { cacheGet, cacheSet, cacheListKey } from '@/services/cache'
import { openStorageFile, isPdfFile } from '@/services/net'
import { DANGER, INK, BRAND, BRAND_TEXT, BRAND_FOREGROUND } from '@/lib/theme'
import { formatDate, formatTime } from '@/types'
import { hideLoadingSafe } from '@/lib/loading'

const PAGE_SIZE = 20

/**
 * P-033（D）单次复习队列上限。
 * GK-SRS-24 §4.2 建议一次 5–8 题；上限设 50 只为防止「攒了两个月」时
 * 一次拉太多卡住首帧，超出的题下次点「开始复习」再来（不丢，仍在本里到期）。
 */
const QUEUE_MAX = 50

/** 「更多操作」里可对图片执行的 AI 动作（与首页同一套，思傅 2026-10-23 对齐） */
const IMAGE_ACTIONS: { action: ImageAction | 'crop'; label: string; icon: any }[] = [
  { action: 'crop', label: '裁剪', icon: Crop },
  { action: 'auto', label: '自动调正', icon: Wand },
  { action: 'enhance', label: '智能高清', icon: Sparkles },
  // 去手写本版暂不接入（功能不完善），入口收起，实现保留
]

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
  /** 复习排程汇总（今日该复习 / 未排程 / 已毕业）—— C4 */
  const [sum, setSum] = useState<ReviewSummary | null>(null)
  /** 只看今天该复习（含逾期） */
  const [dueOnly, setDueOnly] = useState(false)
  /**
   * P-033（D）复习队列。null = 不在队列里（显示普通列表）；
   * 非 null = 队列快照，覆盖层一次一题作答。
   *
   * 为什么存快照而不是边答边拉：队列是「今天这一批」的概念，中途拉取会让
   * 已答对的题（推进档位后不再到期）从列表里消失、序号错乱。快照期间的写入
   * 已逐条落库，退出时统一刷新（`exitQueue`）。
   */
  const [queueItems, setQueueItems] = useState<TimelineItem[] | null>(null)
  const sel = useSelection()

  /**
   * 顶部两个可切换的视图（思傅 2026-11-04 要求）。
   *
   * 起因：导出资料原本藏在二级页「汇总导出」的第二个 tab 里，而它本质上是
   * **复习产物的归档**，跟复习本是一件事。要看一份上次打过的卷子，得先点
   * 「汇总导出」再切 tab，路径绕。现在提到复习本顶部，与「科目」并列。
   *
   * ⚠️ 两个视图**各持一套选择态**（sel / selDocs）：共用一套会把「已选 3 道题」
   * 的状态带进资料列表，于是「删除」按钮对着资料执行、却按题目的 id 数确认数量。
   */
  const [view, setView] = useState<'subject' | 'docs'>('subject')
  const [docs, setDocs] = useState<DocItem[]>([])
  const [docsLoading, setDocsLoading] = useState(false)
  const [docsLoaded, setDocsLoaded] = useState(false)
  const [docFilter, setDocFilter] = useState<'all' | 'docx' | 'pdf'>('all')
  const [docsBusy, setDocsBusy] = useState(false)
  const [renameDoc, setRenameDoc] = useState<DocItem | null>(null)
  const selDocs = useSelection()
  /**
   * 固定顶栏高度（实测，不写死）。
   *
   * 顶栏高度会变：①「科目 / 导出资料」两个视图的头不一样高；② 标签行
   * （TagFilterBar）只在 tagPool 非空时渲染。写死一个常量必然出现「要么压住
   * 第一张卡、要么顶上留一条白缝」——2026-11-04 实测同一份代码两次量到
   * 189 与 237 两个值，就是标签行迟到/早退造成的。
   */
  const [headerH, setHeaderH] = useState(192)
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
  // 「更多操作」弹层（思傅 2026-10-23：复习本条目也要有「…」——编辑/改分类/移出复习本/删除）
  const [moreItem, setMoreItem] = useState<TimelineItem | null>(null)
  // 学科选择弹层（「…」→ 修改分类）
  const [pickerItem, setPickerItem] = useState<TimelineItem | null>(null)

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

  /**
   * 加载复习本列表。
   * ⚠️ silent（思傅 2026-10-23 修「移出/加入复习本后跳到第 1 题」）：
   * 列表内写操作后缓存已被 api.ts 失效，非 silent 的 load 会 setLoading(true) →
   * 骨架屏替换整个列表 → ScrollView 内容塌缩 → 滚动位置被钳到顶部。
   * silent = 不置 loading、不显骨架，旧列表留屏，后台静默替换（与首页同规则）。
   */
  const load = async (opts: { subjectId: string; keyword: string; tag: string; page: number; since?: string; append?: boolean; silent?: boolean; due?: boolean }) => {
    const { subjectId, keyword: kw, tag, page: p, since, append, silent } = opts
    const due = opts.due ?? dueOnly
    if (append) setLoadingMore(true)
    else if (!silent) setLoading(true)
    // SWR（思傅 2026-10-21）：只对「第一页、非追加」查询读缓存——
    // 分页追加的中间页缓存意义小且 key 会膨胀；写操作已在 api.ts 失效 tl 域。
    const listKey = append
      ? ''
      : cacheListKey('tl', { scope: 'review', subjectId, keyword: kw, tag, since: since || '', due: due ? '1' : '', page: p, pageSize: PAGE_SIZE })
    const cached = listKey ? cacheGet<Paged<TimelineItem>>(listKey) : null
    if (cached && !append) {
      setItems(cached.list)
      setTotal(cached.total)
      setPage(cached.page)
      if (cached.list[0]) {
        const ts = cached.list[0].added_to_review_at || cached.list[0].created_at
        if (ts) setLatestTimestamp(ts)
      }
      if (!silent) setLoading(false)
    }
    try {
      const res = await fetchTimeline({
        scope: 'review',
        subjectId: subjectId || undefined,
        keyword: kw || undefined,
        tag: tag || undefined,
        since,
        due: due || undefined,
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
      if (!silent) setLoading(false)
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
    const preset = Taro.getStorageSync('filter_subject_id') || ''
    if (preset) Taro.removeStorageSync('filter_subject_id')
    setActiveSubject(preset)
    setKeyword('')
    setActiveTag('')
    setRange('all')
    setLatestTimestamp(undefined)
    sel.exit()

    /**
     * GK-23-20：学科 → 汇总 → 列表 三次网络往返原先**串行**，首屏等于「三段耗时相加」。
     * 三者互不依赖（列表只吃 subjectId 参数，不读 subjects 状态），并行后首屏≈最慢那段。
     * 失败互不影响：学科/汇总只影响胶囊与顶部横幅，列表才是主内容。
     */
    const subsTask = (async () => {
      if (subjects.length > 0) return
      const cachedSubs = cacheGet<Subject[]>('subj:list')
      if (cachedSubs) setSubjects(cachedSubs)
      const subs = await fetchSubjects()
      setSubjects(subs)
      if (subs.length) cacheSet('subj:list', subs)
    })().catch((e) => console.error('加载学科失败', e))
    const sumTask = fetchReviewSummary()
      .then(setSum)
      .catch((e) => console.error('加载复习排程失败', e))
    const listTask = load({ subjectId: preset, keyword: '', tag: '', page: 1 })
    await Promise.all([subsTask, sumTask, listTask])
  }

  // ---------- 导出资料（2026-11-04 从 /pages/summary 的第二个 tab 迁入）----------

  /**
   * 加载导出资料列表。
   * ⚠️ silent：导出/删除后缓存已失效，非 silent 会把列表换成骨架屏 →
   * ScrollView 内容塌缩 → 滚动位置被钳到顶部（与首页/资料库同一条规则）。
   */
  const loadDocs = async (opts: { silent?: boolean } = {}) => {
    // SWR：先读缓存，后台刷新回写
    const listKey = cacheListKey('doc', { pageSize: 100 })
    const cached = cacheGet<{ total: number; list: DocItem[] }>(listKey)
    if (cached) {
      setDocs(cached.list || [])
      setDocsLoading(false)
    } else if (!opts.silent) {
      setDocsLoading(true)
    }
    try {
      const res = await fetchDocuments({ pageSize: 100 })
      setDocs(res.list)
      setDocsLoaded(true)
      cacheSet(listKey, res)
    } catch (e) {
      console.error('[subject] 加载导出资料失败', e)
      // ⚠️ 不能静默：后端不通时列表显示「还没有导出过资料」，用户会以为资料丢了
      if (!opts.silent) Taro.showToast({ title: '加载失败，请下拉重试', icon: 'none' })
    } finally {
      setDocsLoading(false)
    }
  }

  const measureHeader = () => {
    Taro.createSelectorQuery()
      .select('#gk-topbar')
      .boundingClientRect()
      .exec((res) => {
        const r = (res && res[0]) as { height?: number } | null
        if (r && r.height) setHeaderH(Math.ceil(r.height) + 2)
      })
  }

  // 视图切换、标签行出现/消失、条数变化都会改变顶栏高度 ⇒ 每次都重新量
  useEffect(() => {
    const t = setTimeout(measureHeader, 60)
    return () => clearTimeout(t)
  }, [view, tagPool.length, total])

  /** 切视图：首次进「导出资料」才拉一次；切换时两侧选择态都退掉，避免误删 */
  const switchView = (v: 'subject' | 'docs') => {
    if (v === view) return
    sel.exit()
    selDocs.exit()
    setView(v)
    if (v === 'docs' && !docsLoaded) void loadDocs()
  }

  useDidShow(() => {
    // 从详情页返回：回到「同一道题」（按 id 锚定），只恢复一次
    if (!restoredRef.current && restoreItemIdRef.current) {
      pendingRestoreIdRef.current = restoreItemIdRef.current
      restoredRef.current = true
    }
    selDocs.exit()
    init()
    // 停在「导出资料」视图时回来（导出完成/看完文件），静默刷一下列表
    if (view === 'docs') void loadDocs({ silent: true })
  })

  const resetAndLoad = (patch: Partial<{ subjectId: string; keyword: string; tag: string; range: RangeValue; due: boolean }>) => {
    const nextRange = patch.range !== undefined ? patch.range : range
    const since = getSinceFromRange(nextRange, latestTimestamp)
    const nextDue = patch.due !== undefined ? patch.due : dueOnly
    const next = {
      subjectId: patch.subjectId !== undefined ? patch.subjectId : activeSubject,
      keyword: patch.keyword !== undefined ? patch.keyword : keyword,
      tag: patch.tag !== undefined ? patch.tag : activeTag,
    }
    if (patch.subjectId !== undefined) setActiveSubject(patch.subjectId)
    if (patch.keyword !== undefined) setKeyword(patch.keyword)
    if (patch.tag !== undefined) setActiveTag(patch.tag)
    if (patch.due !== undefined) setDueOnly(patch.due)
    if (patch.range !== undefined) {
      setRange(patch.range)
      // 切到自动时清空锚点，由下次请求首条重新确定
      if (patch.range !== 'auto') setLatestTimestamp(undefined)
    }
    sel.exit()
    load({ ...next, page: 1, since, due: nextDue })
  }

  /**
   * P-033（D）开始今日复习 —— 拉一批到期题进队列，一次一题作答。
   *
   * 为什么要快照：每答一题就写库，实时的「到期列表」会当场变化
   * （做对的推进档位后不再到期、毕业的出本），边答边拉会让序号错乱、
   * 甚至把刚答过的题又排到队首。故开工时取一张快照，答完统一刷新。
   */
  const startQueue = async () => {
    if (busy || queueItems) return
    setBusy(true)
    try {
      const res = await fetchTimeline({ scope: 'review', due: true, page: 1, pageSize: QUEUE_MAX })
      if (!res.list.length) {
        Taro.showToast({ title: '今天没有到期的题', icon: 'none' })
        return
      }
      setQueueItems(res.list)
    } catch (e) {
      console.error('加载今日待复习失败', e)
      Taro.showToast({ title: '加载失败，请重试', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  /** 退出队列：作答已逐条落库，这里只把列表与「今天该复习」数字重新对齐 */
  const exitQueue = () => {
    setQueueItems(null)
    load({ subjectId: activeSubject, keyword, tag: activeTag, page: 1, silent: true, due: dueOnly })
    fetchReviewSummary()
      .then(setSum)
      .catch((e) => console.error('刷新复习汇总失败', e))
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

  // ---------- 「…」更多操作（思傅 2026-10-23：复习本与首页同一套入口） ----------
  const openMore = (item: TimelineItem) => setMoreItem(item)
  const closeMore = () => setMoreItem(null)

  /** 「编辑」：图片条目编辑自身图；题目条目编辑第一张题面图 */
  const handleMoreEdit = () => {
    const item = moreItem
    if (!item) return
    const hasQuestionImg = (item.question_image_urls || []).length > 0
    if (item.kind === 'image') {
      openEditor(item, 'crop', 'item', 0)
      closeMore()
      return
    }
    if (hasQuestionImg) {
      openEditor(item, 'crop', 'questionImage', 0)
      closeMore()
      return
    }
    closeMore()
    Taro.showToast({ title: '该条目没有图片可编辑', icon: 'none' })
  }

  /** 「修改分类」：弹学科选择层 */
  const handleMoreSubject = () => {
    const item = moreItem
    closeMore()
    if (item) setPickerItem(item)
  }
  const closePicker = () => setPickerItem(null)
  const applySubject = async (sub: Subject | null) => {
    const item = pickerItem
    if (!item) return
    closePicker()
    try {
      await updateTimeline(item.id, { subject_id: sub ? sub.id : null })
      Taro.showToast({ title: sub ? `已归为「${sub.name}」` : '已设为未分类', icon: 'none' })
      const since = getSinceFromRange(range, latestTimestamp)
      await load({ subjectId: activeSubject, keyword, tag: activeTag, page: 1, since, silent: true })
    } catch (e) {
      console.error('改分类失败', e)
      const msg = e instanceof Error && e.message ? e.message : '更新失败，请重试'
      Taro.showToast({ title: msg, icon: 'none' })
    }
  }

  /** 「移出复习本」：复习本列表里逐条移出（与底部批量「移出复习本」同一接口） */
  const handleMoreRemoveReview = async () => {
    const item = moreItem
    closeMore()
    if (!item) return
    setBusy(true)
    try {
      await removeFromReviewBook([item.id])
      Taro.showToast({ title: '已移出复习本', icon: 'success' })
      const since = getSinceFromRange(range, latestTimestamp)
      await load({ subjectId: activeSubject, keyword, tag: activeTag, page: 1, since, silent: true })
    } catch (e) {
      console.error(e)
      Taro.showToast({ title: '操作失败', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  const handleMoreDelete = async () => {
    const item = moreItem
    closeMore()
    if (!item) return
    const ok = await confirmDelete(1, '条')
    if (!ok) return
    setBusy(true)
    try {
      await batchDeleteTimeline([item.id])
      Taro.showToast({ title: '已删除', icon: 'success' })
      const since = getSinceFromRange(range, latestTimestamp)
      await load({ subjectId: activeSubject, keyword, tag: activeTag, page: 1, since, silent: true })
    } catch (e) {
      console.error(e)
      Taro.showToast({ title: '删除失败', icon: 'none' })
    } finally {
      setBusy(false)
    }
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
        hideLoadingSafe()
        Taro.showToast({ title: '图片已更新', icon: 'success' })
      } else if (editorAction === 'enhance' || editorAction === 'auto') {
        // 智能高清 / 自动调正：结果另存为新图片，原图保留（见首页同款说明）
        const up = await uploadImage(tempFilePath, { purpose: 'save' })
        await saveQuestionAsImage(item.subject_id || '', up.key, up.url, up.timeline_id)
        hideLoadingSafe()
        Taro.showToast({ title: '已另存新图片，原图保留', icon: 'success' })
      } else {
        // replaceTimelineImage 内部会同步换 thumb_key（否则列表仍显示旧缩略图）
        await replaceTimelineImage({ id: item.id, subject_id: item.subject_id }, tempFilePath)
        hideLoadingSafe()
        Taro.showToast({ title: '已更新该资料', icon: 'success' })
      }
      const since = getSinceFromRange(range, latestTimestamp)
      await load({ subjectId: activeSubject, keyword, tag: activeTag, page: 1, since, silent: true })
    } catch (e) {
      hideLoadingSafe()
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
      load({ subjectId: activeSubject, keyword, tag: activeTag, page: 1, since, silent: true })
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
      load({ subjectId: activeSubject, keyword, tag: activeTag, page: 1, since, silent: true })
    } catch (e) {
      console.error(e)
      Taro.showToast({ title: '删除失败', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  /**
   * 合成导出：PDF = 多图拼页省纸，Word = 顺排可编辑（方便家长加批注再打印）。
   * 两者共用同一批选中的素材，由用户在弹层里选目标格式。
   *
   * 思傅 2026-10-26 修 #119：合成对象从「仅图片条目」放宽为
   * 「图片条目 + 带题面图的题目条目」——复习本里批量选题再合成是主用法，
   * 旧逻辑 kind==='image' 一刀切把题目全滤掉，必然误报「请选择图片资料」。
   * 题目条目的题面图由后端展开（pdf.service fetchImages），此处只传 id 并保持列表序。
   *
   * 思傅 2026-10-26：默认不带答案与解题过程（打给孩子做的练习卷）；
   * 「含答案」选项把本题 答案/解析/错误作答 一并合成（对答案用的版本）。
   */
  const handleCombine = async () => {
    const ids = items
      .filter((it) => sel.selected.has(it.id))
      .filter((it) => it.kind === 'image' || (it.kind === 'question' && (it.question_image_urls || []).length > 0))
      .map((it) => it.id)
    if (!ids.length) {
      Taro.showToast({ title: '请选择图片资料或含图片的题目', icon: 'none' })
      return
    }
    Taro.showActionSheet({
      itemList: [
        '练习卷 PDF（不含答案）',
        '练习卷 Word（不含答案）',
        '答疑解惑 PDF（含答案）',
        '答疑解惑 Word（含答案）',
      ],
      success: async (r) => {
        const format: 'pdf' | 'docx' = r.tapIndex === 1 || r.tapIndex === 3 ? 'docx' : 'pdf'
        const withAnswers = r.tapIndex >= 2
        setBusy(true)
        Taro.showLoading({ title: '合成中…' })
        try {
          const res = await combineToPdf(ids, format, withAnswers)
          hideLoadingSafe()
          openStorageFile(res.url, format === 'pdf', res.key)
        } catch (e) {
          hideLoadingSafe()
          console.error('合成失败', format, e)
          Taro.showToast({ title: '合成失败，请确认所选包含图片', icon: 'none' })
        } finally {
          setBusy(false)
        }
      },
      fail: () => {},
    })
  }

  // ---------- 导出资料的交互（迁自 /pages/summary 的 library tab）----------

  const filteredDocs = docs.filter((d) => docFilter === 'all' || d.type === docFilter)

  const handleDocOpen = (d: DocItem) => {
    if (selDocs.selecting) { selDocs.toggle(d.id); return }
    openStorageFile(d.url || '', isPdfFile(d.mime_type || d.type), d.file_key)
  }

  /** 卡片「⋯」→ 重命名 / 删除 */
  const handleDocMore = (d: DocItem) => {
    if (selDocs.selecting) return
    Taro.showActionSheet({ itemList: ['重命名', '删除'] })
      .then((res) => {
        if (res.tapIndex === 0) setRenameDoc(d)
        else if (res.tapIndex === 1) void handleDocSingleDelete(d)
      })
      .catch(() => { /* 用户取消 */ })
  }

  const handleDocSingleDelete = async (d: DocItem) => {
    const ok = await confirmDelete(1, '份资料')
    if (!ok) return
    try {
      await deleteDocument(d.id)
      Taro.showToast({ title: '已删除', icon: 'success' })
      void loadDocs({ silent: true })
    } catch (e) {
      console.error('[subject] 删除资料失败', e)
      Taro.showToast({ title: '删除失败', icon: 'none' })
    }
  }

  const handleDocRename = async (value: string) => {
    if (!renameDoc) return
    // ⚠️ 必须捕获：原 summary 页同类实现曾无 try/catch ⇒ 失败时弹层不关且无提示
    try {
      await renameDocument(renameDoc.id, value)
      setRenameDoc(null)
      Taro.showToast({ title: '已重命名', icon: 'success' })
      void loadDocs({ silent: true })
    } catch (e) {
      console.error('[subject] 重命名失败', e)
      Taro.showToast({ title: `重命名失败：${e instanceof Error ? e.message.slice(0, 30) : '请重试'}`, icon: 'none' })
    }
  }

  const handleDocsBatchDelete = async () => {
    if (selDocs.isEmpty) { Taro.showToast({ title: '请先选择资料', icon: 'none' }); return }
    const ok = await confirmDelete(selDocs.count, '份资料')
    if (!ok) return
    setDocsBusy(true)
    try {
      await batchDeleteDocuments(Array.from(selDocs.selected))
      Taro.showToast({ title: '已删除', icon: 'success' })
      selDocs.exit()
      void loadDocs({ silent: true })
    } catch (e) {
      console.error('[subject] 批量删除资料失败', e)
      Taro.showToast({ title: '删除失败', icon: 'none' })
    } finally {
      setDocsBusy(false)
    }
  }

  /**
   * 汇总生成（2026-11-02 从「文档」tab 移入复习本；2026-11-04 导出资料搬走后，
   * 二级页 /pages/summary 只剩这一件事，因此入口文案由「汇总导出」改为「汇总生成」）。
   *
   * 为什么不把汇总生成也塞成第三个 tab：它是一张「选时间段 + 选学科 + 开关」的
   * 表单，塞进本页会让主列表在顶部被压掉一屏；而且它是一次性动作，不是常驻视图。
   */
  const goSummary = () => Taro.navigateTo({ url: '/pages/summary/index' })

  const canLoadMore = items.length < total
  const goRecognize = () => Taro.navigateTo({ url: '/pages/recognize/index' })

  return (
    <View className="bg-background" style={{ position: 'relative', height: '100vh' }}>
      {/* 固定顶部：视图切换（科目 / 导出资料）+ 各自的筛选头 */}
      <View id="gk-topbar" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 50, backgroundColor: '#fff', borderBottom: '1px solid #ecefe3' }}>
        {/* 思傅 2026-11-04：把「导出资料」提到最上，与「科目」成为两个可切换的页面 */}
        <View style={{ padding: '8px 16px 4px' }}>
          <SegmentedTabs<'subject' | 'docs'>
            value={view}
            onValueChange={switchView}
            options={[
              { value: 'subject', label: '科目' },
              { value: 'docs', label: '导出资料' },
            ]}
          />
        </View>

        {view === 'subject' ? (
          <FilterHeader
            subjects={subjects}
            activeSubject={activeSubject}
            onSubjectChange={(id) => resetAndLoad({ subjectId: id })}
            keyword={keyword}
            onKeywordChange={(kw) => setKeyword(kw)}
            onSearch={() => resetAndLoad({ keyword: keyword })}
            // ⚠️ 清空必须显式传空串：不能复用 onSearch（它拿到的是旧 keyword 闭包值）
            onClear={() => { setKeyword(''); resetAndLoad({ keyword: '' }) }}
            countText={`复习本 · 共 ${total} 条`}
            placeholder="搜索题干 / 答案关键词，回车确认"
            right={(
              <View className="flex flex-row items-center gap-2">
                {!sel.selecting && (
                  <View
                    className="flex flex-row items-center gap-1 rounded-lg px-2 py-1"
                    style={{ border: `1px solid ${BRAND}`, backgroundColor: 'rgba(16, 185, 129, 0.06)' }}
                    onClick={goSummary}
                  >
                    <FileText size={13} color={BRAND_TEXT} />
                    <Text className="block text-sm" style={{ color: BRAND_TEXT }}>汇总生成</Text>
                  </View>
                )}
                <SelectionBar
                  selection={sel}
                  enterLabel="批量选择"
                  countPrefix="已选"
                  onSelectAll={() => sel.selectAll(items.map((x) => x.id))}
                />
              </View>
            )}
          >
            <TagFilterBar tags={tagPool} active={activeTag} onChange={(t) => resetAndLoad({ tag: t })} />
            <View className="mt-2">
              <RangePicker value={range} onChange={(v) => resetAndLoad({ range: v })} />
            </View>
          </FilterHeader>
        ) : (
          <View style={{ padding: '0 16px 8px' }}>
            <View className="flex flex-row items-center justify-between">
              <Text className="block text-sm text-muted-foreground">共 {filteredDocs.length} 份资料</Text>
              <SelectionBar
                selection={selDocs}
                enterLabel="批量选择"
                onSelectAll={() => selDocs.selectAll(filteredDocs.map((d) => d.id))}
              />
            </View>
            <View className="mt-2">
              <SegmentedTabs<'all' | 'docx' | 'pdf'>
                value={docFilter}
                onValueChange={(v) => { setDocFilter(v); selDocs.clear() }}
                options={[
                  { value: 'all', label: '全部' },
                  { value: 'docx', label: 'Word' },
                  { value: 'pdf', label: 'PDF' },
                ]}
              />
            </View>
          </View>
        )}
      </View>

      {view === 'subject' && (
        <ScrollView
          id="list-scroll"
          scrollY
          scrollTop={scrollTop}
          onScroll={(e) => { scrollRef.current = (e as any)?.detail?.scrollTop || 0 }}
          style={{ height: '100vh', paddingTop: headerH }}
          onScrollToLower={() => {
            if (canLoadMore && !loadingMore && !loading) {
              const since = getSinceFromRange(range, latestTimestamp)
              load({ subjectId: activeSubject, keyword, tag: activeTag, page: page + 1, since, append: true })
            }
          }}
        >
          <View className="px-4 pb-28 pt-3">
            {/**
              * C4 复习排程横幅：「今天该复习 N 题」是分散练习唯一需要推动用户行动的数字。
              * 只在复习本非空时出现；due_today = 0 时给一句明确的「今天没有到期的题」，
              * 避免用户以为排程坏了（空状态也要有话说）。
              * ⚠️ 点击区用 View 不用 Text —— Taro 4.1.9 下 Text 绑 onClick 不响应。
              */}
            {sum && sum.in_book > 0 && (
              <View
                className="rounded-2xl p-3 mb-3"
                style={{ backgroundColor: sum.due_today > 0 ? 'rgba(16, 185, 129, 0.08)' : '#F7F5EF' }}
              >
                <View className="flex flex-row items-center justify-between">
                  <Text className="block text-sm font-semibold text-foreground">
                    {sum.due_today > 0 ? `今天该复习 ${sum.due_today} 题` : '今天没有到期的题'}
                  </Text>
                  <View
                    className="px-2 py-1 rounded-lg"
                    style={dueOnly
                      ? { backgroundColor: BRAND }
                      : { border: `1px solid ${BRAND}` }}
                    onClick={() => resetAndLoad({ due: !dueOnly })}
                  >
                    <Text className="block text-xs" style={{ color: dueOnly ? BRAND_FOREGROUND : BRAND_TEXT }}>
                      {dueOnly ? '看全部' : '只看今天'}
                    </Text>
                  </View>
                </View>
                <Text className="block text-xs text-muted-foreground mt-1">
                  复习本共 {sum.in_book} 题
                  {sum.graduated > 0 ? ` · 已掌握 ${sum.graduated}` : ''}
                  {sum.next_due_at ? ` · 下次 ${formatDate(sum.next_due_at)}` : ''}
                </Text>
                {/**
                  * P-033（D）「开始复习」：把「今天该复习 N 题」这个数字变成一次点击。
                  * 此前只有数字、没有入口，家长要自己在列表里挑题、点进详情、
                  * 滚到复习区再点按钮——一次复习 5 步，这是执行率的结构性杀手。
                  */}
                {sum.due_today > 0 && (
                  <Button className="h-9 rounded-lg mt-2" onClick={startQueue} disabled={busy}>
                    <Text className="block text-xs" style={{ color: BRAND_FOREGROUND }}>
                      开始复习（{Math.min(sum.due_today, QUEUE_MAX)} 题）
                    </Text>
                  </Button>
                )}
              </View>
            )}
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
                        onMore={openMore}
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
      )}

      {/**
        * P-033（D）复习队列覆盖层。
        * 用 fixed 覆盖而不是替换列表内容：列表、筛选、选择态、滚动位置全部原样留着，
        * 退出队列即刻回到原处（不然中途退出会丢掉用户的筛选条件，比不进队列更烦）。
        * 列表模式**始终保留为兜底**——队列只是快路径，不是唯一路径。
        */}
      {queueItems && (
        <View
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            zIndex: 200, backgroundColor: '#FFFFFF',
          }}
        >
          <ScrollView scrollY style={{ height: '100vh', paddingTop: headerH }}>
            <ReviewQueue items={queueItems} onExit={exitQueue} />
          </ScrollView>
        </View>
      )}

      {view === 'docs' && (
        <ScrollView scrollY style={{ height: '100vh', paddingTop: headerH }}>
          <View className="px-4 pb-28 pt-3">
            {docsLoading ? (
              <View className="space-y-3">
                <Skeleton className="h-16 w-full rounded-2xl" />
                <Skeleton className="h-16 w-full rounded-2xl" />
              </View>
            ) : filteredDocs.length ? (
              <View className="space-y-2">
                {filteredDocs.map((d) => (
                  <View
                    key={d.id}
                    className={`flex flex-row items-center gap-3 rounded-2xl border p-4 ${selDocs.selected.has(d.id) ? 'border-brand-line bg-brand-soft' : 'border-border bg-card'}`}
                    onClick={() => handleDocOpen(d)}
                    onLongPress={() => selDocs.longPress(d.id)}
                  >
                    {selDocs.selecting && (
                      <CheckDot checked={selDocs.selected.has(d.id)} size={20} />
                    )}
                    <View className="w-11 h-11 flex-shrink-0 flex items-center justify-center rounded-lg bg-muted">
                      <FileText size={20} color={INK} />
                    </View>
                    <View className="flex-1 min-w-0">
                      <View className="flex flex-row items-center gap-2">
                        <View className="rounded px-2 py-1 flex-shrink-0 bg-muted">
                          <Text className="block text-xs font-medium text-foreground">
                            {d.type === 'pdf' ? 'PDF' : 'Word'}
                          </Text>
                        </View>
                        <Text className="block text-sm font-medium text-foreground truncate">{d.title}</Text>
                      </View>
                      <Text className="block text-xs text-muted-foreground mt-1">{formatTime(d.created_at)}</Text>
                    </View>
                    {!selDocs.selecting && (
                      <View className="p-2" onClick={(e) => { e.stopPropagation?.(); handleDocMore(d) }}>
                        <Ellipsis size={16} color="#bbb" />
                      </View>
                    )}
                  </View>
                ))}
              </View>
            ) : (
              <EmptyCard
                title={docFilter === 'all' ? '还没有导出过资料' : `没有 ${docFilter === 'pdf' ? 'PDF' : 'Word'} 资料`}
                hint="在「科目」里点「汇总生成」按时间段成卷，或批量选中题目「合成PDF/WORD」；成品都归档到这里"
              />
            )}
          </View>
        </ScrollView>
      )}

      {view === 'subject' && sel.selecting && (
        <BottomActionBar>
          <View style={{ flex: 1 }}>
            <ActionBtn
              icon={<FileSearch size={16} color={BRAND_FOREGROUND} />}
              label="合成PDF/WORD"
              compact
              primary
              disabled={sel.isEmpty || busy}
              onClick={handleCombine}
            />
          </View>
          <View style={{ flex: 1 }}>
            <ActionBtn
              icon={<FolderMinus size={16} color={INK} />}
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

      {/* 导出资料视图的底部操作条：只有「删除选中」（资料没有「移出复习本」的概念） */}
      {view === 'docs' && selDocs.selecting && (
        <BottomActionBar>
          <View style={{ flex: 1 }}>
            <ActionBtn
              icon={<Trash2 size={16} color="#fff" />}
              label="删除选中"
              danger
              disabled={selDocs.isEmpty || docsBusy}
              onClick={handleDocsBatchDelete}
            />
          </View>
        </BottomActionBar>
      )}

      {/* 重命名资料（迁自 /pages/summary） */}
      {renameDoc && (
        <RenameDialog
          title="重命名资料"
          initialValue={renameDoc.title}
          onCancel={() => setRenameDoc(null)}
          onConfirm={handleDocRename}
        />
      )}

      {/* 图片编辑器（思傅 2026-10-22：复习本与首页同一套规则，点图片即可编辑并原位替换） */}
      <ImageEditor
        visible={!!editorSrc}
        src={editorSrc}
        autoAction={editorAction}
        enableSaveToInbox={false}
        confirmText="另存为新图片"
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

      {/* 「更多操作」弹层（思傅 2026-10-23：复习本条目「…」——与首页同一套，
          移出复习本替代加入；zIndex 200 压过底部悬浮条与固定头） */}
      {moreItem && (
        <View style={{ position: 'fixed', left: 0, top: 0, right: 0, bottom: 0, zIndex: 200, background: 'rgba(0,0,0,0.4)' }} onClick={closeMore}>
          <View className="bg-background rounded-t-2xl p-4" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '80vh' }} onClick={(e) => e.stopPropagation?.()}>
            <Text className="block text-base font-semibold text-foreground mb-3">
              {moreItem.kind === 'image' ? '编辑这张图片' : '更多操作'}
            </Text>

            {moreItem.kind === 'image' && (
              <View className="flex flex-row flex-wrap gap-3 mb-4">
                {IMAGE_ACTIONS.map(({ action, label, icon: Icon }) => (
                  <View
                    key={action}
                    className="flex flex-col items-center justify-center rounded-xl border border-border"
                    style={{ width: '22%', paddingTop: 10, paddingBottom: 10 }}
                    onClick={() => { openEditor(moreItem, action); closeMore() }}
                  >
                    <Icon size={20} color={INK} />
                    <Text className="block text-xs text-foreground mt-1">{label}</Text>
                  </View>
                ))}
              </View>
            )}

            <View className="flex flex-row items-center gap-3 rounded-xl border border-border px-3 py-3 mb-2" onClick={handleMoreEdit}>
              <Crop size={18} color={INK} />
              <Text className="block text-sm text-foreground">
                {moreItem.kind === 'image' ? '编辑这张图片' : '编辑题面图'}
              </Text>
            </View>
            <View className="flex flex-row items-center gap-3 rounded-xl border border-border px-3 py-3 mb-2" onClick={handleMoreSubject}>
              <Tag size={18} color={INK} />
              <Text className="block text-sm text-foreground">修改分类</Text>
            </View>
            <View className="flex flex-row items-center gap-3 rounded-xl border border-border px-3 py-3 mb-2" onClick={handleMoreRemoveReview}>
              <BookmarkMinus size={18} color={INK} />
              <Text className="block text-sm text-foreground">移出复习本</Text>
            </View>
            <View className="flex flex-row items-center gap-3 rounded-xl border border-border px-3 py-3 mb-2" onClick={handleMoreDelete}>
              <Trash2 size={18} color={DANGER} />
              <Text className="block text-sm text-destructive">删除</Text>
            </View>
            <View className="mt-2">
              <Button variant="outline" className="w-full h-11 rounded-xl" onClick={closeMore}>
                <Text className="block text-sm">取消</Text>
              </Button>
            </View>
          </View>
        </View>
      )}

      {/* 学科选择弹层（「…」→ 修改分类） */}
      {pickerItem && (
        <View style={{ position: 'fixed', left: 0, top: 0, right: 0, bottom: 0, zIndex: 200, background: 'rgba(0,0,0,0.4)' }} onClick={closePicker}>
          <View className="bg-background rounded-t-2xl p-4" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '70vh' }} onClick={(e) => e.stopPropagation?.()}>
            <Text className="block text-base font-semibold text-foreground mb-3">选择分类</Text>
            <View className="overflow-y-auto">
              {subjects.map((s) => (
                <View key={s.id} className="mb-2">
                  <SubjectBadge name={s.name} color={s.color} showArrow onClick={() => applySubject(s)} />
                </View>
              ))}
              <View className="flex flex-row items-center gap-2 rounded-xl border border-dashed border-border px-3 py-3 mb-2" onClick={() => applySubject(null)}>
                <Text className="block text-sm text-muted-foreground">未分类 / 清除</Text>
              </View>
            </View>
            <View className="mt-2">
              <Button variant="outline" className="w-full h-11 rounded-xl" onClick={closePicker}>
                <Text className="block text-sm">取消</Text>
              </Button>
            </View>
          </View>
        </View>
      )}

      {savingEdit ? (
        <View style={{ position: 'fixed', left: 0, top: 0, right: 0, bottom: 0, zIndex: 300 }} />
      ) : null}
    </View>
  )
}
