import { View, Text, ScrollView, Image } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useState } from 'react'
import { Trash2, BookmarkPlus, CircleUser, Crop, Wand, Sparkles, Eraser, Tag } from 'lucide-react-taro'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import ReviewItemCard from '@/components/review-item-card'
import ImageEditor from '@/components/image-editor'
import { ActionBtn, BottomActionBar, EmptyCard } from '@/components/filter-header'
import { confirmDelete, useSelection } from '@/lib/use-selection'
import {
  fetchOverview, fetchTimeline, batchDeleteTimeline, addToReviewBook,
  fetchSubjects, updateTimeline, replaceTimelineImage,
  type Overview, type TimelineItem, type Subject, type ImageAction,
} from '@/services/api'
import { getAuthState, isLoggedIn, promptLogin, type AuthState } from '@/services/auth'
import { getSubjectColor } from '@/types'

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
  // 学科列表（用于「最近题目」里手动改分类）
  const [subjects, setSubjects] = useState<Subject[]>([])
  // 当前正在改分类的条目（弹层状态）
  const [pickerItem, setPickerItem] = useState<TimelineItem | null>(null)
  // 「更多操作」弹层（#3：对已加入最近题目的资料再裁剪 / 高清 / 去手写）
  const [moreItem, setMoreItem] = useState<TimelineItem | null>(null)
  // 图片编辑器状态（复用 ImageEditor）
  const [editorItem, setEditorItem] = useState<TimelineItem | null>(null)
  const [editorSrc, setEditorSrc] = useState('')
  const [editorAction, setEditorAction] = useState<ImageAction | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const sel = useSelection()

  const load = async () => {
    setLoading(true)
    setAuth(getAuthState())
    try {
      const [ov, list, subs] = await Promise.all([
        fetchOverview(),
        fetchTimeline({ scope: 'recent', pageSize: 20 }),
        fetchSubjects().catch(() => [] as Subject[]),
      ])
      setOverview(ov)
      setInbox(list.list)
      setInboxTotal(list.total)
      setSubjects(subs)
    } catch (e) {
      console.error('加载概览失败', e)
    } finally {
      setLoading(false)
    }
  }

  useDidShow(() => {
    sel.exit()
    load()
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
  const goSubject = (subjectId?: string) => {
    Taro.setStorageSync('filter_subject_id', subjectId || '')
    Taro.switchTab({ url: '/pages/subject/index' })
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

  const openEditor = (item: TimelineItem, action: ImageAction | 'crop') => {
    const src = item.url || item.thumb_url || ''
    if (!src) {
      Taro.showToast({ title: '图片地址缺失，请下拉刷新后重试', icon: 'none' })
      return
    }
    setEditorItem(item)
    setEditorSrc(src)
    setEditorAction(action === 'crop' ? null : action)
    closeMore()
  }

  /** 编辑器返回：把编辑结果保存并替换原条目 */
  const handleEditorConfirm = async (tempFilePath: string) => {
    const item = editorItem
    setEditorItem(null)
    if (!item) return
    setSavingEdit(true)
    Taro.showLoading({ title: '保存中…', mask: true })
    try {
      await replaceTimelineImage({ id: item.id, subject_id: item.subject_id }, tempFilePath)
      Taro.hideLoading()
      Taro.showToast({ title: '已更新该资料', icon: 'success' })
      load()
    } catch (e) {
      Taro.hideLoading()
      console.error('保存编辑结果失败', e)
      const msg = e instanceof Error && e.message ? e.message : '保存失败，请重试'
      Taro.showToast({ title: msg, icon: 'none' })
    } finally {
      setSavingEdit(false)
    }
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
      load()
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
      load()
    } catch (e) {
      console.error(e)
      Taro.showToast({ title: '删除失败', icon: 'none' })
    }
  }

  const handleOpen = (item: TimelineItem) => {
    if (sel.selecting) { sel.toggle(item.id); return }
    if (item.kind === 'image') {
      Taro.previewImage({ current: item.url || '', urls: [item.url || ''] })
      return
    }
    Taro.navigateTo({ url: `/pages/detail/index?id=${item.id}` })
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
      load()
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
      load()
    } catch (e) {
      console.error(e)
      Taro.showToast({ title: '操作失败', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <View className="bg-background" style={{ position: 'relative', height: '100vh' }}>
      <ScrollView scrollY style={{ height: '100vh' }}>
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
                <CircleUser size={20} color={isLoggedIn() ? '#BE3E2D' : '#9A948A'} />
              )}
              <Text className="block text-xs text-foreground">
                {isLoggedIn() ? (auth?.nickname || '我的') : '登录'}
              </Text>
            </View>
          </View>

          {/* 识别与导入主操作区 */}
          <Card className="rounded-2xl border-border p-4 mb-4">
            <View className="flex flex-row gap-3 mb-3">
              <Button className="flex-1 h-12 rounded-xl" onClick={goRecognize}>
                <Text className="block text-sm">拍照 / 相册识别</Text>
              </Button>
              <Button variant="outline" className="flex-1 h-12 rounded-xl" onClick={goSplit}>
                <Text className="block text-sm">题目答案分传</Text>
              </Button>
            </View>
            <View className="flex flex-row gap-3">
              <Button variant="outline" className="flex-1 h-11 rounded-xl" onClick={goDocImport}>
                <Text className="block text-sm">导入文档识别</Text>
              </Button>
              <Button variant="outline" className="flex-1 h-11 rounded-xl" onClick={goLibrary}>
                <Text className="block text-sm">资料库</Text>
              </Button>
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
              <View className="flex flex-row gap-3 mb-4">
                <StatCard label="本周新增" value={overview?.week_total ?? 0} highlight />
                <StatCard label="收件箱" value={overview?.total ?? 0} />
                <StatCard label="复习本" value={overview?.review_total ?? 0} onTap={goReviewBook} />
              </View>

              {/* 学科入口 */}
              <View className="mb-2 flex flex-row items-center justify-between">
                <Text className="block text-sm font-semibold text-foreground">学科分类</Text>
                <Text className="block text-xs text-muted-foreground" onClick={() => goSubject()}>全部</Text>
              </View>
              <View className="flex flex-row flex-wrap gap-2 mb-5">
                {overview?.subject_stats?.length ? (
                  overview.subject_stats.map((s) => {
                    const c = getSubjectColor(s.color)
                    return (
                      <View
                        key={s.subject_id}
                        className={`flex flex-row items-center gap-2 rounded-full border px-3 py-2 ${c.badge}`}
                        onClick={() => goSubject(s.subject_id)}
                      >
                        <View className={`w-2 h-2 rounded-full ${c.dot}`} />
                        <Text className="block text-xs">{s.name}</Text>
                        <Text className="block text-xs opacity-70">{s.count}</Text>
                      </View>
                    )
                  })
                ) : (
                  <Text className="block text-xs text-muted-foreground">暂无分类数据</Text>
                )}
              </View>

              {/* 最近题目（统一收件箱） */}
              <View className="mb-2 flex flex-row items-center justify-between">
                <Text className="block text-sm font-semibold text-foreground">
                  最近题目 <Text className="block text-xs text-muted-foreground">（共 {inboxTotal} 条 · 点学科标签改分类，点「…」可再编辑）</Text>
                </Text>
                {!sel.selecting ? (
                  <Text className="block text-xs text-primary" onClick={sel.enter}>批量选择</Text>
                ) : (
                  <View className="flex flex-row items-center gap-3">
                    {sel.count > 0 && (
                      <>
                        <Text className="block text-xs text-foreground">已选 {sel.count}</Text>
                        <Text className="block text-xs text-muted-foreground" onClick={sel.clear}>清空</Text>
                      </>
                    )}
                    <Text className="block text-xs text-primary" onClick={sel.exit}>取消</Text>
                  </View>
                )}
              </View>

              {inbox.length ? (
                <View className="space-y-3">
                  {inbox.map((item) => (
                    <ReviewItemCard
                      key={item.id}
                      item={item}
                      selecting={sel.selecting}
                      checked={sel.selected.has(item.id)}
                      onOpen={handleOpen}
                      onLongPress={(it) => sel.longPress(it.id)}
                      onChangeSubject={openSubjectPicker}
                      onMore={openMore}
                    />
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
              icon={<BookmarkPlus size={16} color="#fff" />}
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
              {subjects.map((s) => {
                const c = getSubjectColor(s.color)
                return (
                  <View key={s.id} className={`flex flex-row items-center gap-2 rounded-xl border px-3 py-3 mb-2 ${c.badge}`} onClick={() => applySubject(s)}>
                    <View className={`w-2 h-2 rounded-full ${c.dot}`} />
                    <Text className="block text-sm">{s.name}</Text>
                  </View>
                )
              })}
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
                    <Icon size={20} color="#BE3E2D" />
                    <Text className="block text-xs text-foreground mt-1">{label}</Text>
                  </View>
                ))}
              </View>
            )}

            <View className="flex flex-row items-center gap-3 rounded-xl border border-border px-3 py-3 mb-2" onClick={handleMoreSubject}>
              <Tag size={18} color="#BE3E2D" />
              <Text className="block text-sm text-foreground">修改分类</Text>
            </View>
            {!moreItem.in_review_book && (
              <View className="flex flex-row items-center gap-3 rounded-xl border border-border px-3 py-3 mb-2" onClick={handleMoreReview}>
                <BookmarkPlus size={18} color="#BE3E2D" />
                <Text className="block text-sm text-foreground">加入复习本</Text>
              </View>
            )}
            <View className="flex flex-row items-center gap-3 rounded-xl border border-border px-3 py-3 mb-2" onClick={handleMoreDelete}>
              <Trash2 size={18} color="#BE3E2D" />
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

      {/* 图片编辑器（复用；不显示「保存图片」按钮，编辑结果直接替换原条目） */}
      <ImageEditor
        visible={!!editorItem}
        src={editorSrc}
        autoAction={editorAction}
        enableSaveToInbox={false}
        onCancel={() => { setEditorItem(null); setEditorAction(null) }}
        onConfirm={handleEditorConfirm}
      />

      {savingEdit && (
        <View style={{ position: 'fixed', left: 0, top: 0, right: 0, bottom: 0, zIndex: 300 }} />
      )}
    </View>
  )
}

function StatCard({ label, value, highlight, onTap }: { label: string; value: number; highlight?: boolean; onTap?: () => void }) {
  return (
    <Card className={`flex-1 rounded-2xl border-border p-3 ${highlight ? 'bg-primary' : ''}`} onClick={onTap}>
      <Text className={`block text-2xl font-bold ${highlight ? 'text-primary-foreground' : 'text-foreground'}`}>
        {value}
      </Text>
      <Text className={`block text-xs mt-1 ${highlight ? 'text-primary-foreground opacity-70' : 'text-muted-foreground'}`}>
        {label}
      </Text>
    </Card>
  )
}
