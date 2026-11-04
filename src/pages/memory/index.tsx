import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { View, Text, ScrollView } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { Plus, Trash2, ChevronRight, NotebookPen } from 'lucide-react-taro'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import MemoryCard from '@/components/memory-card'
import SegmentedTabs from '@/components/segmented-tabs'
import SelectionBar from '@/components/selection-bar'
import { useSelection } from '@/lib/use-selection'
import {
  fetchMemories, batchDeleteMemories,
  type Memory, type MemoryCategory, MEMORY_CATEGORIES,
} from '@/services/memory'
import { fetchSubjects, type Subject } from '@/services/api'
import { cacheGet, cacheSet, cacheListKey } from '@/services/cache'
import { BRAND, BRAND_TEXT, BRAND_FOREGROUND } from '@/lib/theme'

type CatValue = MemoryCategory | 'all'

const CAT_OPTIONS = [
  { value: 'all',   label: '全部' },
  ...MEMORY_CATEGORIES.map((c) => ({ value: c.value, label: c.label })),
] as const

/**
 * 时间筛选（思傅 2026-11-04：「记忆页面的资料内容可按时间、科目等进行筛选」）。
 *
 * 用**相对区间**而不是月份选择器：服务端目前只支持 `since`（`occurred_at >= ?`），
 * 相对档位天然对上，不需要改接口；月份区间要再加 `until` 与一套月份列表 UI，
 * 反而把「随口缩小一下范围」变成两次选择。
 */
const TIME_OPTIONS = [
  { value: 'all',  label: '全部时间', days: 0 },
  { value: '7d',   label: '近 7 天',  days: 7 },
  { value: '30d',  label: '近 30 天', days: 30 },
  { value: '180d', label: '近半年',  days: 180 },
] as const

type TimeValue = (typeof TIME_OPTIONS)[number]['value']

const daysOf = (v: TimeValue) => TIME_OPTIONS.find((o) => o.value === v)?.days ?? 0

export default function MemoryHomePage() {
  const [category, setCategory] = useState<CatValue>('all')
  const [timeRange, setTimeRange] = useState<TimeValue>('all')
  const [subjectId, setSubjectId] = useState<string>('')
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [keyword, setKeyword] = useState('')
  const [activeKeyword, setActiveKeyword] = useState('')
  const [list, setList] = useState<Memory[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const sel = useSelection()

  /**
   * 加载记忆列表。
   * ⚠️ silent（思傅 2026-10-23：与首页/复习本/资料库同一规则）：
   * 删除后缓存已失效，非 silent 的 load 会 setLoading(true) → 骨架屏替换列表 →
   * ScrollView 内容塌缩 → 滚动位置被钳到顶部。silent = 旧列表留屏，后台静默替换。
   */
  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    const days = daysOf(timeRange)
    // since 用「当前时刻往前推 N 天」：occurred_at 是记录发生时间，与 created_at 无关。
    // 不传就不加这个条件（「全部时间」）。
    const since = days > 0 ? new Date(Date.now() - days * 86400000).toISOString() : undefined
    // SWR（思傅 2026-10-21）：先同步读缓存渲染首帧，再后台刷新回写
    // 🔴 缓存 key 必须带上筛选条件：否则切到「近 7 天」会先闪一屏「全部时间」的缓存内容，
    //    用户以为筛选失效（同类问题在资料库页已踩过）。
    const listKey = cacheListKey('mem', {
      category: category === 'all' ? '' : category,
      time: timeRange,
      subject: subjectId,
      keyword: activeKeyword || '',
      page: 1,
      pageSize: 50,
    })
    const cached = cacheGet<{ list: Memory[]; total: number }>(listKey)
    if (cached) {
      setList(cached.list || [])
      setTotal(cached.total || 0)
      setErrorMsg(null)
      setLoading(false)
    } else if (!opts.silent) {
      setList([])
      setTotal(0)
      setLoading(true)
      setErrorMsg(null)
    }
    try {
      const res = await fetchMemories({
        category: category === 'all' ? undefined : category,
        subjectId: subjectId || undefined,
        since,
        keyword: activeKeyword || undefined,
        page: 1,
        pageSize: 50,
      })
      // service 层已解包 + 驼峰化（fetchMemories 直接返回 MemoryListResp）
      const nextList = (res.list || []) as Memory[]
      const nextTotal = res.total || 0
      setList(nextList)
      setTotal(nextTotal)
      cacheSet(listKey, { list: nextList, total: nextTotal })
    } catch (e) {
      const msg = e instanceof Error ? e.message : '加载失败'
      setErrorMsg(msg)
    } finally {
      setLoading(false)
    }
  }, [category, timeRange, subjectId, activeKeyword])

  // 科目筛选的数据源：科目数量固定、体量极小，一次拉全量即可。
  // 失败**不阻断列表** —— 科目只是「可选地缩小范围」，拉不到就退化成「全部科目」。
  useEffect(() => {
    let alive = true
    fetchSubjects()
      .then((rows) => { if (alive) setSubjects(Array.isArray(rows) ? rows : []) })
      .catch((e) => {
        console.warn('[memory] 科目列表加载失败，科目筛选降级为「全部科目」', e)
        if (alive) setSubjects([])
      })
    return () => { alive = false }
  }, [])

  useEffect(() => { load() }, [load])

  /**
   * 从新增/编辑页返回时**必须刷新**（2026-11-02 思傅反馈）。
   *
   * 原因：列表页一直留在页面栈里，`navigateBack` 回来不会重新 mount ⇒
   * `useEffect` 不会重跑 ⇒ 新记录看不到，必须切到别的页面再切回来（重新 mount）
   * 才会重新拉。写操作已经 `invalidateDomain('mem')` 清了缓存，只差这一次调用。
   *
   * 用 `silent`：旧列表继续留屏，后台替换，不闪骨架屏、不把滚动位置钳回顶部。
   */
  const loadRef = useRef(load)
  loadRef.current = load
  const firstShowRef = useRef(true)
  useDidShow(() => {
    if (firstShowRef.current) {
      firstShowRef.current = false
      return
    }
    void loadRef.current({ silent: true })
  })

  const onSearch = useCallback(() => {
    setActiveKeyword(keyword)
  }, [keyword])

  const onCreate = useCallback(() => {
    Taro.navigateTo({ url: '/pages/memory/edit' })
  }, [])

  const onOpen = useCallback((m: Memory) => {
    if (sel.selecting) {
      sel.toggle(m.id)
      return
    }
    Taro.navigateTo({ url: `/pages/memory/detail?id=${m.id}` })
  }, [sel])

  const onLongPress = useCallback((m: Memory) => {
    if (!sel.selecting) sel.longPress(m.id)
  }, [sel])

  const onMore = useCallback((m: Memory) => {
    Taro.showActionSheet({
      itemList: ['编辑', '删除'],
      success: (r) => {
        if (r.tapIndex === 0) Taro.navigateTo({ url: `/pages/memory/edit?id=${m.id}` })
        else if (r.tapIndex === 1) {
          Taro.showModal({
            title: '确认删除',
            content: `确定删除「${m.title || m.content?.slice(0, 20) || '该记忆'}」吗？`,
            confirmText: '删除',
            confirmColor: BRAND_TEXT,
            success: async (rs) => {
              if (rs.confirm) {
                try {
                  await batchDeleteMemories([m.id])
                  Taro.showToast({ title: '已删除', icon: 'success' })
                  load({ silent: true })
                } catch (e) {
                  Taro.showToast({ title: '删除失败', icon: 'none' })
                }
              }
            },
          })
        }
      },
    })
  }, [load])

  const onBatchDelete = useCallback(async () => {
    const ids = Array.from(sel.selected)
    if (!ids.length) return
    Taro.showModal({
      title: '批量删除',
      content: `确定删除选中的 ${ids.length} 条记忆？`,
      confirmText: '删除',
      confirmColor: BRAND_TEXT,
      success: async (rs) => {
        if (rs.confirm) {
          try {
                  await batchDeleteMemories(ids)
                  Taro.showToast({ title: `已删除 ${ids.length} 条`, icon: 'success' })
                  sel.exit()
                  load({ silent: true })
          } catch (e) {
            Taro.showToast({ title: '删除失败', icon: 'none' })
          }
        }
      },
    })
  }, [sel, load])

  // 按月份分组
  const groups = useMemo(() => groupByMonth(list), [list])

  // 有没有「正在生效的筛选」：空态文案要分情况，否则筛完之后说「还没有记忆」
  // 等于告诉用户记录丢了（本来只是被筛掉了）。
  const hasFilter =
    category !== 'all' || timeRange !== 'all' || !!subjectId || !!activeKeyword

  const clearFilters = useCallback(() => {
    setCategory('all')
    setTimeRange('all')
    setSubjectId('')
    setKeyword('')
    setActiveKeyword('')
  }, [])

  return (
    <View className="flex flex-col min-h-full pb-24">
      {/* 分类筛选 */}
      <View className="px-4 pt-3">
        <SegmentedTabs<CatValue>
          value={category}
          onValueChange={setCategory}
          options={CAT_OPTIONS as any}
        />
      </View>

      {/* 时间筛选（思傅 2026-11-04） */}
      <View className="px-4 pt-2">
        <View className="flex flex-row items-center gap-2">
          {TIME_OPTIONS.map((o) => {
            const on = timeRange === o.value
            return (
              <View
                key={o.value}
                className="rounded-full px-3 h-7 flex flex-row items-center"
                style={{ backgroundColor: on ? BRAND : '#EFEAE2' }}
                onClick={() => setTimeRange(o.value)}
              >
                <Text className="text-xs" style={{ color: on ? BRAND_FOREGROUND : BRAND_TEXT }}>
                  {o.label}
                </Text>
              </View>
            )
          })}
        </View>
      </View>

      {/* 科目筛选：科目可能有八九个，横向滚动比折行更省纵向空间 */}
      {subjects.length > 0 && (
        <View className="pt-2">
          <ScrollView scrollX style={{ whiteSpace: 'nowrap' }}>
            <View className="flex flex-row items-center gap-2 px-4">
              {[{ id: '', name: '全部科目' }, ...subjects].map((s) => {
                const on = subjectId === s.id
                return (
                  <View
                    key={s.id || 'all'}
                    className="rounded-full px-3 h-7 flex flex-row items-center"
                    style={{ backgroundColor: on ? BRAND : '#EFEAE2' }}
                    onClick={() => setSubjectId(s.id)}
                  >
                    <Text className="text-xs" style={{ color: on ? BRAND_FOREGROUND : BRAND_TEXT }}>
                      {s.name}
                    </Text>
                  </View>
                )
              })}
            </View>
          </ScrollView>
        </View>
      )}

      {/* 搜索 */}
      <View className="px-4 pt-3">
        <View className="flex-1 flex flex-row items-center gap-2 rounded-xl bg-muted px-3 h-10">
          <View className="block text-xs text-muted-foreground" onClick={onSearch}>🔍</View>
          <View className="flex-1">
            <input
              className="w-full text-sm bg-transparent outline-none"
              placeholder="搜索记忆标题或内容"
              value={keyword}
              onChange={(e) => setKeyword(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onSearch() }}
              style={{ background: 'transparent', border: 'none', outline: 'none', width: '100%' }}
            />
          </View>
          {keyword ? (
            <View className="block text-xs text-muted-foreground" onClick={() => { setKeyword(''); setActiveKeyword(''); }}>
              清空
            </View>
          ) : null}
        </View>
      </View>

      {/* 主行动「记录此刻」（2026-11-02 放大）：原来是搜索框右边一个 h-9 的小按钮，
          思傅反馈看不出这是"新增"的主入口 —— 改成整条品牌色卡片，图标 + 标题 + 副标题 + 箭头。 */}
      {!sel.selecting && (
        <View className="px-4 pt-3">
          <View
            className="flex flex-row items-center gap-3 rounded-2xl px-4 py-3"
            style={{ backgroundColor: BRAND, boxShadow: '0 6px 16px rgba(16,185,129,0.28)' }}
            onClick={onCreate}
          >
            <View
              className="w-10 h-10 rounded-full flex items-center justify-center"
              style={{ backgroundColor: 'rgba(255,255,255,0.35)' }}
            >
              <NotebookPen size={20} color={BRAND_FOREGROUND} />
            </View>
            <View className="flex-1">
              <Text className="block text-base font-semibold" style={{ color: BRAND_FOREGROUND }}>
                记录此刻
              </Text>
              <Text className="block text-xs mt-1" style={{ color: BRAND_FOREGROUND, opacity: 0.78 }}>
                写点什么，或加照片、录音、视频
              </Text>
            </View>
            <ChevronRight size={18} color={BRAND_FOREGROUND} />
          </View>
        </View>
      )}

      {/* 批量操作条 */}
      {sel.selecting && (
        <View className="px-4 pt-2">
          <SelectionBar
            selection={sel}
            enterLabel="批量选择"
            onSelectAll={() => list.forEach((m) => sel.toggle(m.id))}
          />
        </View>
      )}

      {/* 顶部统计 + 进入选择 */}
      {!sel.selecting && (
        <View className="flex flex-row items-center justify-between px-4 pt-2 pb-2">
          <Text className="block text-xs text-muted-foreground">{`共 ${total} 条`}</Text>
          <View
            className="block text-xs text-muted-foreground"
            onClick={() => list.length && sel.enter()}
          >
            批量
          </View>
        </View>
      )}

      {/* 列表 */}
      {loading ? (
        <View className="flex flex-col gap-3 px-4 pt-2">
          <Skeleton className="h-32 w-full rounded-2xl" />
          <Skeleton className="h-24 w-full rounded-2xl" />
          <Skeleton className="h-32 w-full rounded-2xl" />
        </View>
      ) : errorMsg ? (
        <View className="px-4 pt-8 flex flex-col items-center">
          <Text className="block text-sm text-muted-foreground">加载失败：{errorMsg}</Text>
          <Button className="mt-4 rounded-xl" onClick={() => void load()}>
            <Text className="block text-sm">重试</Text>
          </Button>
        </View>
      ) : list.length === 0 ? (
        hasFilter ? (
          <View className="px-4 pt-12 flex flex-col items-center gap-4">
            <Text className="block text-base text-foreground">这个筛选下没有记录</Text>
            <Text className="block text-sm text-muted-foreground text-center">
              换个时间范围或科目看看{'\n'}你的记录都还在，只是没落在当前条件下
            </Text>
            <Button className="mt-2 rounded-xl" onClick={clearFilters}>
              <Text className="block text-sm">清除筛选</Text>
            </Button>
          </View>
        ) : (
          <View className="px-4 pt-12 flex flex-col items-center gap-4">
            <Text className="block text-base text-foreground">还没有记忆</Text>
            <Text className="block text-sm text-muted-foreground text-center">
              把成长路上的随想、心得、照片、声音都留下来{'\n'}让记忆成为可翻阅的「成长手记」
            </Text>
            <Button className="mt-2 rounded-xl" onClick={onCreate}>
              <Plus size={16} color={BRAND_FOREGROUND} />
              <Text className="block text-sm ml-1">记录第一段</Text>
            </Button>
          </View>
        )
      ) : (
        <View className="flex flex-col gap-3 px-4 pt-1 pb-4">
          {groups.map((g) => (
            <View key={g.month} className="flex flex-col gap-2">
              <Text className="block text-sm font-semibold text-foreground mt-2">{g.month}</Text>
              {g.items.map((m) => (
                <MemoryCard
                  key={m.id}
                  memory={m}
                  selecting={sel.selecting}
                  checked={sel.selected.has(m.id)}
                  onClick={onOpen}
                  onLongPress={onLongPress}
                  onMore={onMore}
                />
              ))}
            </View>
          ))}
        </View>
      )}

      {/* 底部批量操作条 */}
      {sel.selecting && (
        <View style={{
          position: 'fixed', bottom: 50, left: 0, right: 0,
          display: 'flex', flexDirection: 'row', gap: '12px',
          padding: '12px 16px', backgroundColor: '#fff', borderTop: '1px solid #ece8e0', zIndex: 100,
        }}
        >
          <View
            className="flex-1 h-11 rounded-xl bg-destructive flex items-center justify-center"
            onClick={onBatchDelete}
          >
            <Trash2 size={16} color="#fff" />
            <Text className="block text-sm text-destructive-foreground ml-1">删除 ({sel.count})</Text>
          </View>
          <View
            className="flex-1 h-11 rounded-xl bg-muted flex items-center justify-center"
            onClick={sel.exit}
          >
            <Text className="block text-sm text-foreground">取消</Text>
          </View>
        </View>
      )}
    </View>
  )
}

/** 按 occurredAt 的 YYYY 年 MM 月分组 */
function groupByMonth(list: Memory[]): Array<{ month: string; items: Memory[] }> {
  const out: Array<{ month: string; items: Memory[] }> = []
  for (const m of list) {
    const t = m.occurredAt || m.createdAt
    if (!t) continue
    const d = new Date(t)
    if (Number.isNaN(d.getTime())) continue
    const key = `${d.getFullYear()} 年 ${(d.getMonth() + 1).toString().padStart(2, '0')} 月`
    const found = out.find((g) => g.month === key)
    if (found) found.items.push(m)
    else out.push({ month: key, items: [m] })
  }
  return out
}

// 触发「共 n 条」文案对 selCountText 的类型守护（防止移除后编译报错）
void 0