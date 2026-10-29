import { View, Text, ScrollView, Image } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useState, useRef } from 'react'
import { Trash2, BookmarkPlus, BookmarkMinus, CircleUser, Crop, Wand, Sparkles, Eraser, Tag, Camera, FileText, Images } from 'lucide-react-taro'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import ReviewItemCard from '@/components/review-item-card'
import ImageEditor from '@/components/image-editor'
import AnswerSheet from '@/components/answer-sheet'
import { ActionBtn, BottomActionBar, EmptyCard } from '@/components/filter-header'
import SubjectBadge from '@/components/subject-badge'
import SelectionBar from '@/components/selection-bar'
import { confirmDelete, useSelection } from '@/lib/use-selection'
import {
  fetchOverview, fetchTimeline, batchDeleteTimeline, addToReviewBook, removeFromReviewBook,
  fetchSubjects, updateTimeline, replaceTimelineImage, uploadImage, updateQuestion,
  type Overview, type TimelineItem, type Subject, type ImageAction, type Paged,
} from '@/services/api'
import { cacheGet, cacheSet, cacheListKey } from '@/services/cache'
import { getAuthState, isLoggedIn, promptLogin, type AuthState } from '@/services/auth'
import QrLoginModal from '@/components/qr-login-modal'
import { BUILD_META } from '@/build-meta'
import { BRAND_TEXT, BRAND_FOREGROUND, DANGER, INK } from '@/lib/theme'

/** 「更多操作」里可对图片执行的 AI 动作 */
const IMAGE_ACTIONS: { action: ImageAction | 'crop'; label: string; icon: any }[] = [
  { action: 'crop', label: '裁剪', icon: Crop },
  { action: 'auto', label: '自动调正', icon: Wand },
  { action: 'enhance', label: '智能高清', icon: Sparkles },
  { action: 'erase', label: '去手写', icon: Eraser },
]

export default function IndexPage() {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  // 最近题目（统一收件箱，图 + 题混排）
  const [inbox, setInbox] = useState<TimelineItem[]>([])
  const [inboxTotal, setInboxTotal] = useState(0)
  const [busy, setBusy] = useState(false)
  // 登录态（顶部入口展示）
  const [auth, setAuth] = useState<AuthState | null>(getAuthState())
  // H5 扫码登录弹层（电脑浏览器无 wx.login，思傅 2026-10-20 拍板方案）
  const [qrVisible, setQrVisible] = useState(false)
  // 学科列表（用于「最近题目」里手动改分类）
  const [subjects, setSubjects] = useState<Subject[]>([])
  // 当前正在改分类的条目（弹层状态）
  const [pickerItem, setPickerItem] = useState<TimelineItem | null>(null)
  // 「更多操作」弹层（#3：对已加入最近题目的资料再裁剪 / 高清 / 去手写）
  const [moreItem, setMoreItem] = useState<TimelineItem | null>(null)
  // 学科筛选（思傅 2026-10-21：点学科 = 就地筛选下方「最近题目」，不再跳复习本；
  // '' = 全部。与顶部「全部 ›」的跳转是两回事）
  const [subjectFilter, setSubjectFilter] = useState('')
  // 图片编辑器状态（复用 ImageEditor）
  const [editorItem, setEditorItem] = useState<TimelineItem | null>(null)
  const [editorSrc, setEditorSrc] = useState('')
  const [editorAction, setEditorAction] = useState<ImageAction | null>(null)
  /**
   * 编辑器编辑的是哪种图（思傅 2026-10-21）：
   *  - 'item'          kind=image 条目本身的图（保存 = 原位替换条目的 file_key）
   *  - 'questionImage' 题目条目的**题面图**（保存 = 原位替换 content.question_images[index]）
   */
  const [editorTarget, setEditorTarget] = useState<'item' | 'questionImage'>('item')
  // 答案面板的目标题目（思傅 2026-10-21）
  const [answerItem, setAnswerItem] = useState<TimelineItem | null>(null)
  const [editorIndex, setEditorIndex] = useState(0)
  // 列表滚动位置（思傅 2026-10-21 / 2026-10-22 增强）：
  // 进详情退出后回到「同一道题」——按 id 锚定（而非像素偏移，列表重排也不再跑偏）；
  // 列表内操作（加入复习本/删除/编辑保存/筛选）一律不触发回滚，停在当前位置。
  const [scrollTop, setScrollTop] = useState(0)
  const scrollRef = useRef(0) // 当前实际滚动位（onScroll 持续更新）
  const restoredRef = useRef(false) // 防止每次 show 都被强行拉回旧位置
  /** 待恢复的题目 id（仅「从详情返回」路径写入；列表内操作不写 → 不会误滚） */
  const pendingRestoreIdRef = useRef<string>('')
  /** 离开首页去详情前，记录点的是哪道题，回来时按 id 锚回原题 */
  const restoreItemIdRef = useRef<string>('')
  const [savingEdit, setSavingEdit] = useState(false)
  const sel = useSelection()

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

  /**
   * 加载列表。
   * ⚠️ silent（思傅 2026-10-23 修「加入/移出复习本后跳到第 1 题」）：
   * 列表内写操作（加入/移出复习本、删除、编辑保存）后缓存已被 api.ts 失效，
   * 非 silent 的 load 会走 setLoading(true) → 整页骨架屏 → ScrollView 内容塌缩 →
   * 滚动位置被原生钳到顶部 ⇒ 操作完 visually 跳回第 1 题（已改过两次都没治住，
   * 前两次只修了「从详情返回」的锚回，没治列表内操作这条路径）。
   * silent = 不置 loading、不显骨架，旧列表留在屏上，后台拉新数据静默替换。
   *
   * ⚠️ fresh（思傅 2026-10-29 修「新加题目回首页不刷新」）：
   * 每次页面显示都**跳过本地缓存**直接取服务端。旧实现先拿缓存铺首帧，若网络
   * 请求这一轮失败（304/慢网/后端刚醒），列表就停在缓存上，用户看到的就是
   * 「新加的题没出现」。缓存只用于「首次进页面 0 等待」，不该用于「回到页面」。
   */
  const load = async (sid = subjectFilter, opts: { silent?: boolean; fresh?: boolean } = {}) => {
    setAuth(getAuthState())
    // SWR（思傅 2026-10-21：没触发数据库操作时只读缓存）：
    // 先同步读本地缓存渲染首帧（0 网络等待），再后台刷新、静默回写。
    // 写操作已在 api.ts 收口失效缓存，这里取到即是最新。
    const listKey = cacheListKey('tl', { scope: 'recent', subjectId: sid || '', pageSize: 20 })
    const cachedOv = opts.fresh ? null : cacheGet<Overview>('tl:ov')
    const cachedList = opts.fresh ? null : cacheGet<Paged<TimelineItem>>(listKey)
    const cachedSubs = opts.fresh ? null : cacheGet<Subject[]>('subj:list')
    if (cachedOv || cachedList || cachedSubs) {
      if (cachedOv) setOverview(cachedOv)
      if (cachedList) {
        setInbox(cachedList.list)
        setInboxTotal(cachedList.total)
      }
      if (cachedSubs) setSubjects(cachedSubs)
      if (!opts.silent) setLoading(false)
    } else if (!opts.silent) {
      setLoading(true)
    }
    try {
      const [ov, list, subs] = await Promise.all([
        fetchOverview(),
        // 学科筛选走后端（subjectId），不是前端过滤——否则只能筛已加载的 20 条
        fetchTimeline({ scope: 'recent', subjectId: sid || undefined, pageSize: 20 }),
        fetchSubjects().catch(() => [] as Subject[]),
      ])
      setOverview(ov)
      setInbox(list.list)
      setInboxTotal(list.total)
      setSubjects(subs)
      cacheSet('tl:ov', ov)
      cacheSet(listKey, list)
      if (subs.length) cacheSet('subj:list', subs)
    } catch (e) {
      console.error('加载概览失败', e)
      // 有缓存则静默保留（刷新失败不打扰）；完全无缓存才提示
      if (!cachedOv && !cachedList) {
        Taro.showToast({ title: '加载失败，请稍后重试', icon: 'none' })
      }
    } finally {
      if (!opts.silent) setLoading(false)
      // 列表已渲染出来（loading 结束）→ 按 id 锚回原题（双帧 + 先偏移再归位强制 Taro 触发滚动）
      const rid = pendingRestoreIdRef.current
      if (rid) {
        pendingRestoreIdRef.current = ''
        setTimeout(() => scrollToItemById(rid, 8), 60)
      }
    }
  }

  /** 点学科胶囊：就地筛选下方最近题目（不跳页）；再点一次 / 点「全部」取消 */
  const filterSubject = (sid: string) => {
    setSubjectFilter(sid)
    void load(sid)
  }

  useDidShow(() => {
    sel.exit()
    // 从详情页返回：回到「同一道题」（按 id 锚定），不回顶部。只恢复一次。
    // 仅靠 restoreItemIdRef 判断（handleOpen 写入）；列表内操作不写它 → 不会误滚。
    if (!restoredRef.current && restoreItemIdRef.current) {
      pendingRestoreIdRef.current = restoreItemIdRef.current
      restoredRef.current = true
    }
    // fresh：回到本页一律以服务端为准（新增题目/识别入库/别处改答案都要立刻可见）
    void load(subjectFilter, { silent: true, fresh: true })
  })

  const goRecognize = () => {
    Taro.setStorageSync('recog_mode', 'paper')
    Taro.navigateTo({ url: '/pages/recognize/index' })
  }
  const goSplit = () => {
    Taro.setStorageSync('recog_mode', 'split')
    Taro.navigateTo({ url: '/pages/recognize/index' })
  }
  const goDocImport = () => {
    Taro.setStorageSync('recog_mode', 'doc')
    Taro.navigateTo({ url: '/pages/recognize/index' })
  }
  const goReviewBook = () => {
    Taro.setStorageSync('filter_subject_id', '')
    Taro.switchTab({ url: '/pages/subject/index' })
  }
  const goLibrary = () => Taro.navigateTo({ url: '/pages/library/index' })
  const goProfile = () => Taro.navigateTo({ url: '/pages/profile/index' })

  /** 顶部登录入口：未登录点一下直接微信一键登录；已登录进入「我的」 */
  const handleAuthTap = async () => {
    if (isLoggedIn()) {
      goProfile()
      return
    }
    // H5（电脑浏览器）：没有 wx.login，改走扫码登录弹层
    if (Taro.getEnv() === Taro.ENV_TYPE.WEB) {
      setQrVisible(true)
      return
    }
    const ok = await promptLogin()
    if (ok) load()
  }

  // ---------- 手动改分类 ----------
  const openSubjectPicker = (item: TimelineItem) => setPickerItem(item)
  const closePicker = () => setPickerItem(null)
  const applySubject = async (sub: Subject | null) => {
    const item = pickerItem
    if (!item) return
    const next = sub
      ? { subject_id: sub.id, subjects: { id: sub.id, name: sub.name, color: sub.color } }
      : { subject_id: null as string | null, subjects: null as null }
    // 乐观更新（失败会回滚）
    const prev = inbox
    setInbox((p) => p.map((it) => it.id === item.id ? { ...it, ...next } : it))
    closePicker()
    try {
      await updateTimeline(item.id, { subject_id: sub ? sub.id : null })
      Taro.showToast({ title: sub ? `已归为「${sub.name}」` : '已设为未分类', icon: 'none' })
    } catch (e) {
      // 失败回滚，并把服务端真实原因透出（修复「更新失败，请重试」无信息可查）
      setInbox(prev)
      const msg = e instanceof Error && e.message ? e.message : '更新失败，请重试'
      console.error('改分类失败', e)
      Taro.showToast({ title: msg, icon: 'none' })
    }
  }

  // ---------- 「更多操作」（#3） ----------
  const openMore = (item: TimelineItem) => setMoreItem(item)
  const closeMore = () => setMoreItem(null)

  // ---------- 填答案（思傅 2026-10-21）----------
  // 列表条目旁的「＋填答案」：拉起页内面板（不跳页，保住滚动位置与筛选上下文）。
  // 面板里所有写入都按 item.id 定位，答案内嵌在该题目记录里，不可能存到别的题。
  const openAnswer = (item: TimelineItem) => setAnswerItem(item)
  const closeAnswer = () => setAnswerItem(null)
  /** 答案保存后：就地替换列表中该条，避免整页刷新导致滚动跳变 */
  const handleAnswerSaved = (updated: TimelineItem) => {
    setInbox((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
  }

  /**
   * 打开图片编辑器（思傅 2026-10-21 规则：点图片 = 直接打开该图片并可编辑）。
   * @param target 'item' = 图片条目本身；'questionImage' = 题目条目的题面图
   * @param index  题面图下标（target='questionImage' 时有效）
   * @param srcOverride 由点击处直接传来的图地址（优先使用，避免再次推导错位）
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
    if (!src) {
      Taro.showToast({ title: '图片地址缺失，请下拉刷新后重试', icon: 'none' })
      return
    }
    setEditorItem(item)
    setEditorSrc(src)
    setEditorAction(action === 'crop' ? null : action)
    setEditorTarget(target)
    setEditorIndex(index)
    closeMore()
  }

  /** 编辑器返回：把编辑结果保存并替换原图 */
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
        // 题目题面图：attach 上传（不建条目）→ 原位替换 question_images[index]
        const up = await uploadImage(tempFilePath, { purpose: 'attach' })
        const keys = item.content?.question_images || []
        const nextKeys = keys.map((k, i) => (i === index ? up.key : k))
        await updateQuestion(item.id, { question_images: nextKeys })
        Taro.hideLoading()
        Taro.showToast({ title: '图片已更新', icon: 'success' })
      } else {
        await replaceTimelineImage({ id: item.id, subject_id: item.subject_id }, tempFilePath)
        Taro.hideLoading()
        Taro.showToast({ title: '已更新该资料', icon: 'success' })
      }
      load(subjectFilter, { silent: true })
    } catch (e) {
      Taro.hideLoading()
      console.error('保存编辑结果失败', e)
      const msg = e instanceof Error && e.message ? e.message : '保存失败，请重试'
      Taro.showToast({ title: msg, icon: 'none' })
    } finally {
      setSavingEdit(false)
    }
  }

  /** 「…」里的「编辑」：图片条目编辑自身图；题目条目编辑第一张题面图 */
  const handleMoreEdit = () => {
    const item = moreItem
    if (!item) return
    const hasQuestionImg = (item.question_image_urls || []).length > 0
    if (item.kind === 'image') {
      openEditor(item, 'crop', 'item', 0)
      return
    }
    if (hasQuestionImg) {
      openEditor(item, 'crop', 'questionImage', 0)
      return
    }
    closeMore()
    Taro.showToast({ title: '该条目没有图片可编辑', icon: 'none' })
  }

  const handleMoreSubject = () => {
    const item = moreItem
    closeMore()
    if (item) openSubjectPicker(item)
  }
  const handleMoreReview = async () => {
    const item = moreItem
    closeMore()
    if (!item) return
    try {
      await addToReviewBook([item.id])
      Taro.showToast({ title: '已加入复习本', icon: 'success' })
      load(subjectFilter, { silent: true })
    } catch (e) {
      console.error(e)
      Taro.showToast({ title: '操作失败', icon: 'none' })
    }
  }
  /** 思傅 2026-10-23：已加入复习本的题目，「…」里要能直接移出（原来只有加入、没有移出） */
  const handleMoreRemoveReview = async () => {
    const item = moreItem
    closeMore()
    if (!item) return
    try {
      await removeFromReviewBook([item.id])
      Taro.showToast({ title: '已移出复习本', icon: 'success' })
      load(subjectFilter, { silent: true })
    } catch (e) {
      console.error(e)
      Taro.showToast({ title: '操作失败', icon: 'none' })
    }
  }
  const handleMoreDelete = async () => {
    const item = moreItem
    closeMore()
    if (!item) return
    const ok = await confirmDelete(1, '条')
    if (!ok) return
    try {
      await batchDeleteTimeline([item.id])
      Taro.showToast({ title: '已删除', icon: 'success' })
      load(subjectFilter, { silent: true })
    } catch (e) {
      console.error(e)
      Taro.showToast({ title: '删除失败', icon: 'none' })
    }
  }

  /**
   * 点列表（功能按键以外的区域）→ 进题目详情（思傅 2026-10-21 规则）。
   * 点图**片**的走 openEditor（打开图片并可编辑），不进详情。
   */
  const handleOpen = (item: TimelineItem) => {
    if (sel.selecting) { sel.toggle(item.id); return }
    // 记录点的是哪道题，回来时按 id 锚回原题（而非像素偏移 → 列表重排也不跑偏）
    restoreItemIdRef.current = item.id
    restoredRef.current = false
    Taro.navigateTo({ url: `/pages/detail/index?id=${item.id}` })
  }

  /** 点列表里的图片 → 直接打开该图片（可编辑） */
  const handleTapImage = (item: TimelineItem, url: string, index: number, kind: 'item' | 'questionImage') => {
    if (sel.selecting) { sel.toggle(item.id); return }
    openEditor(item, 'crop', kind, index, url)
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
      load(subjectFilter, { silent: true })
    } catch (e) {
      console.error(e)
      Taro.showToast({ title: '删除失败', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  const handleAddToReview = async () => {
    if (sel.isEmpty) return
    setBusy(true)
    try {
      await addToReviewBook(Array.from(sel.selected))
      Taro.showToast({ title: '已加入复习本', icon: 'success' })
      sel.exit()
      load(subjectFilter, { silent: true })
    } catch (e) {
      console.error(e)
      Taro.showToast({ title: '操作失败', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <View className="bg-background" style={{ position: 'relative', height: '100vh' }}>
      <QrLoginModal
        visible={qrVisible}
        onClose={() => setQrVisible(false)}
        onSuccess={() => {
          setQrVisible(false)
          setAuth(getAuthState())
          load()
        }}
      />
      <ScrollView
        id="list-scroll"
        scrollY
        scrollTop={scrollTop}
        onScroll={(e) => { scrollRef.current = (e as any)?.detail?.scrollTop || 0 }}
        style={{ height: '100vh' }}
      >
        <View className="px-4 pt-4 pb-32">
          {/* 顶部标题 + 登录入口 */}
          <View className="mb-4 flex flex-row items-start justify-between">
            <View className="flex-1">
              <Text className="block text-xl font-bold text-foreground">成长学童</Text>
              <Text className="block text-xs text-muted-foreground mt-1">拍照 / 导入，把题目整理成属于你的知识地图</Text>
            </View>
            <View
              className="flex flex-row items-center gap-2 rounded-full border border-border px-3 py-2 ml-3"
              onClick={handleAuthTap}
            >
              {isLoggedIn() && auth?.avatarUrl ? (
                <Image src={auth.avatarUrl} className="rounded-full" style={{ width: '24px', height: '24px' }} mode="aspectFill" />
              ) : (
                <CircleUser size={20} color={isLoggedIn() ? BRAND_TEXT : '#9A948A'} />
              )}
              <Text className="block text-xs text-foreground">
                {isLoggedIn() ? (auth?.nickname || '我的') : '登录'}
              </Text>
            </View>
          </View>

          {/* 构建版本角标：真机一眼确认是否最新包（防「改了没生效」之争）。
              样式需在真机上醒目可辨——曾用 10px/50% 透明度被用户当作「不存在」。 */}
          <View
            className="flex flex-row items-center mb-2"
            onClick={() => Taro.showModal({ title: '当前包版本', content: `构建时间：${BUILD_META.time}\ngit：${BUILD_META.commit}\n域名：${(globalThis as any).PROJECT_DOMAIN || '(默认 127.0.0.1:3001)'}`, showCancel: false, confirmText: '知道了' })}
          >
            <View
              style={{
                backgroundColor: 'rgba(16, 185, 129,0.08)',
                borderRadius: 999,
                paddingLeft: 10,
                paddingRight: 10,
                paddingTop: 3,
                paddingBottom: 3,
                borderWidth: 1,
                borderColor: 'rgba(16, 185, 129, 0.25)',
              }}
            >
              <Text className="block text-xs" style={{ color: BRAND_TEXT }}>
                📦 包版本 {BUILD_META.label} · 点我查看后端域名
              </Text>
            </View>
          </View>

          {/* 识别与导入主操作区（主操作独立，3 个次操作合并为一行） */}
          <Card className="rounded-2xl border-border p-4 mb-4">
            <View
              className="flex flex-row items-center gap-3 rounded-xl bg-brand mb-3 px-2 py-2"
              onClick={goRecognize}
            >
              <View className="flex flex-row items-center justify-center w-9 h-9 rounded-full bg-background">
                <Camera size={18} color={INK} />
              </View>
              <View className="flex-1">
                <Text className="block text-sm font-medium text-brand-foreground">拍照 / 相册识别</Text>
                <Text className="block text-xs text-brand-foreground opacity-70">拍下一道错题，自动整理到收件箱</Text>
              </View>
              <Text className="block text-brand-foreground opacity-70 text-xl">›</Text>
            </View>
            <View className="flex flex-row gap-2">
              <View className="flex-1 flex flex-row items-center justify-center gap-1 h-10 rounded-xl border border-border bg-background" onClick={goSplit}>
                <Images size={14} color="#5C5750" />
                <Text className="block text-sm text-foreground">题答分传</Text>
              </View>
              <View className="flex-1 flex flex-row items-center justify-center gap-1 h-10 rounded-xl border border-border bg-background" onClick={goDocImport}>
                <FileText size={14} color="#5C5750" />
                <Text className="block text-sm text-foreground">导入文档</Text>
              </View>
              <View className="flex-1 flex flex-row items-center justify-center gap-1 h-10 rounded-xl border border-border bg-background" onClick={goLibrary}>
                <BookmarkPlus size={14} color="#5C5750" />
                <Text className="block text-sm text-foreground">资料库</Text>
              </View>
            </View>
          </Card>

          {loading ? (
            <View className="space-y-3">
              <Skeleton className="h-20 w-full rounded-2xl" />
              <Skeleton className="h-24 w-full rounded-2xl" />
              <Skeleton className="h-40 w-full rounded-2xl" />
            </View>
          ) : (
            <>
              {/* 数据统计 */}
              <View className="flex flex-row gap-3 mb-6">
                <StatCard label="本周新增" value={overview?.week_total ?? 0} highlight />
                <StatCard label="收件箱" value={overview?.total ?? 0} />
                <StatCard
                  label="复习本"
                  value={overview?.review_total ?? 0}
                  hint={overview?.review_due ? `今日待复习 ${overview.review_due}` : undefined}
                  onTap={goReviewBook}
                />
              </View>

              {/* 学科分类（思傅 2026-10-21：就地筛选下方最近题目，不再跳复习本） */}
              <View className="mb-2 flex flex-row items-center justify-between">
                <Text className="block text-base font-semibold text-foreground">学科分类</Text>
                <Text className="block text-xs text-muted-foreground">点学科只看该科题目</Text>
              </View>
              <View className="flex flex-row flex-wrap gap-2 mb-6">
                {/* 「全部」：清除学科筛选（思傅 2026-10-21 新增） */}
                <SubjectBadge name="全部" active={!subjectFilter} onClick={() => filterSubject('')} />
                {overview?.subject_stats?.map((s) => (
                  <SubjectBadge
                    key={s.subject_id}
                    name={s.name}
                    color={s.color}
                    active={subjectFilter === s.subject_id}
                    trailing={<Text className="block text-xs opacity-70">{s.count}</Text>}
                    onClick={() => filterSubject(s.subject_id)}
                  />
                ))}
                {!overview?.subject_stats?.length ? (
                  <Text className="block text-xs text-muted-foreground">暂无分类数据</Text>
                ) : null}
              </View>

              {/* 最近题目（统一收件箱） */}
              <View className="mb-2 flex flex-row items-center justify-between">
                <View className="flex flex-col">
                  <Text className="block text-base font-semibold text-foreground">最近题目</Text>
                  <Text className="block text-xs text-muted-foreground mt-1">共 {inboxTotal} 条 · 点学科标签可改分类，点「…」可再编辑</Text>
                </View>
                <SelectionBar selection={sel} enterLabel="批量选择" countPrefix="已选" />
              </View>
              {/* 学科筛选提示条（点「✕ 显示全部」或上面的「全部」清除） */}
              {subjectFilter ? (
                <View className="flex flex-row items-center gap-2 mb-2">
                  <Text className="block text-xs" style={{ color: BRAND_TEXT }}>
                    只看「{subjects.find((s) => s.id === subjectFilter)?.name
                      || overview?.subject_stats?.find((s) => s.subject_id === subjectFilter)?.name
                      || '该学科'}」
                  </Text>
                  <Text className="block text-xs text-muted-foreground" onClick={() => filterSubject('')}>✕ 显示全部</Text>
                </View>
              ) : null}

              {inbox.length ? (
                <View className="space-y-3">
                  {inbox.map((item) => (
                    <View id={`tl-item-${item.id}`} key={item.id}>
                      <ReviewItemCard
                        item={item}
                        selecting={sel.selecting}
                        checked={sel.selected.has(item.id)}
                        onOpen={handleOpen}
                        onTapImage={handleTapImage}
                        onLongPress={(it) => sel.longPress(it.id)}
                        onChangeSubject={openSubjectPicker}
                        onMore={openMore}
                        onAnswer={openAnswer}
                      />
                    </View>
                  ))}
                </View>
              ) : (
                <EmptyCard
                  title="收件箱还是空的"
                  hint="拍下第一张试卷，或导入文档开始整理吧"
                  actionLabel="去拍照识别"
                  onAction={goRecognize}
                />
              )}
            </>
          )}
        </View>
      </ScrollView>

      {sel.selecting && (
        <BottomActionBar>
          <View style={{ flex: 1 }}>
            <ActionBtn
              icon={<BookmarkPlus size={16} color={BRAND_FOREGROUND} />}
              label="加入复习本"
              primary
              disabled={sel.isEmpty || busy}
              onClick={handleAddToReview}
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

      {/* 改分类弹层 */}
      {pickerItem && (
        <View className="z-50" style={{ position: 'fixed', left: 0, top: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.4)' }} onClick={closePicker}>
          <View className="bg-background rounded-t-2xl p-4" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '70vh' }} onClick={(e) => e.stopPropagation?.()}>
            <Text className="block text-sm font-semibold text-foreground mb-3">选择分类</Text>
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

      {/* 「更多操作」弹层（#3） */}
      {moreItem && (
        <View className="z-50" style={{ position: 'fixed', left: 0, top: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.4)' }} onClick={closeMore}>
          <View className="bg-background rounded-t-2xl p-4" style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }} onClick={(e) => e.stopPropagation?.()}>
            <Text className="block text-sm font-semibold text-foreground mb-3">
              {moreItem.kind === 'image' ? '编辑这张图片' : '更多操作'}
            </Text>

            {moreItem.kind === 'image' && (
              <View className="flex flex-row flex-wrap gap-3 mb-4">
                {IMAGE_ACTIONS.map(({ action, label, icon: Icon }) => (
                  <View
                    key={action}
                    className="flex flex-col items-center justify-center rounded-xl border border-border"
                    style={{ width: '22%', paddingTop: 10, paddingBottom: 10 }}
                    onClick={() => openEditor(moreItem, action)}
                  >
                    <Icon size={20} color={INK} />
                    <Text className="block text-xs text-foreground mt-1">{label}</Text>
                  </View>
                ))}
              </View>
            )}

            {/* 「编辑」：打开该条目的图片（可裁剪/旋转/灰度/高清/去手写）。
                思傅 2026-10-21：此前的编辑入口在重构中丢失，需保留。 */}
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
            {moreItem.in_review_book ? (
              <View className="flex flex-row items-center gap-3 rounded-xl border border-border px-3 py-3 mb-2" onClick={handleMoreRemoveReview}>
                <BookmarkMinus size={18} color={INK} />
                <Text className="block text-sm text-foreground">移出复习本</Text>
              </View>
            ) : (
              <View className="flex flex-row items-center gap-3 rounded-xl border border-border px-3 py-3 mb-2" onClick={handleMoreReview}>
                <BookmarkPlus size={18} color={INK} />
                <Text className="block text-sm text-foreground">加入复习本</Text>
              </View>
            )}
            <View className="flex flex-row items-center gap-3 rounded-xl border border-border px-3 py-3 mb-2" onClick={handleMoreDelete}>
              <Trash2 size={18} color={DANGER} />
              <Text className="block text-sm text-foreground">删除</Text>
            </View>
            <View className="mt-2">
              <Button variant="outline" className="w-full h-11 rounded-xl" onClick={closeMore}>
                <Text className="block text-sm">取消</Text>
              </Button>
            </View>
          </View>
        </View>
      )}

      {/* 图片编辑器（复用；不显示「保存图片」按钮，点「保存并替换原图」才把结果替换原条目） */}
      <ImageEditor
        visible={!!editorItem}
        src={editorSrc}
        autoAction={editorAction}
        enableSaveToInbox={false}
        confirmText="保存并替换原图"
        onCancel={() => { setEditorItem(null); setEditorAction(null); setEditorSrc('') }}
        onConfirm={handleEditorConfirm}
      />

      {/* 填答案面板（列表条目旁「＋填答案」拉起） */}
      <AnswerSheet
        visible={!!answerItem}
        item={answerItem}
        onClose={closeAnswer}
        onSaved={handleAnswerSaved}
      />

      {savingEdit && (
        <View style={{ position: 'fixed', left: 0, top: 0, right: 0, bottom: 0, zIndex: 300 }} />
      )}
    </View>
  )
}

function StatCard({ label, value, highlight, hint, onTap }: { label: string; value: number; highlight?: boolean; hint?: string; onTap?: () => void }) {
  return (
    <Card className={`flex-1 rounded-2xl border-border p-4 ${highlight ? 'bg-brand' : ''}`} onClick={onTap}>
      {/* 字阶 D1/D5：数字 24px 拉开视觉重量，标签 12px 弱化——靠尺寸而非颜色建立层级 */}
      <Text className={`block text-2xl font-bold leading-tight ${highlight ? 'text-brand-foreground' : 'text-foreground'}`}>
        {value}
      </Text>
      <Text className={`block text-xs mt-1 ${highlight ? 'text-brand-foreground opacity-80' : 'text-muted-foreground'}`}>
        {label}
      </Text>
      {/* 复习本的「今日待复习」：分散练习唯一需要推动行动的数字，挂在总量下面而不是替换总量 */}
      {hint ? (
        <Text className="block text-xs mt-1" style={{ color: highlight ? BRAND_FOREGROUND : BRAND_TEXT }}>
          {hint}
        </Text>
      ) : null}
    </Card>
  )
}
