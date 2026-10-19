import { useEffect, useState, useCallback, useMemo } from 'react'
import { View, Text } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { Plus } from 'lucide-react-taro'
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

type CatValue = MemoryCategory | 'all'

const CAT_OPTIONS = [
  { value: 'all',   label: '全部' },
  ...MEMORY_CATEGORIES.map((c) => ({ value: c.value, label: c.label })),
] as const

export default function MemoryHomePage() {
  const [category, setCategory] = useState<CatValue>('all')
  const [keyword, setKeyword] = useState('')
  const [activeKeyword, setActiveKeyword] = useState('')
  const [list, setList] = useState<Memory[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const sel = useSelection()

  const load = useCallback(async () => {
    setLoading(true)
    setErrorMsg(null)
    try {
      const res = await fetchMemories({
        category: category === 'all' ? undefined : category,
        keyword: activeKeyword || undefined,
        page: 1,
        pageSize: 50,
      })
      // 列表响应需要解包：res.data.data.list
      const data = (res as any).data?.data || (res as any).data || res
      setList((data.list || []) as Memory[])
      setTotal(data.total || 0)
    } catch (e) {
      const msg = e instanceof Error ? e.message : '加载失败'
      setErrorMsg(msg)
    } finally {
      setLoading(false)
    }
  }, [category, activeKeyword])

  useEffect(() => { load() }, [load])

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
            confirmColor: '#BE3E2D',
            success: async (rs) => {
              if (rs.confirm) {
                try {
                  await batchDeleteMemories([m.id])
                  Taro.showToast({ title: '已删除', icon: 'success' })
                  load()
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
      confirmColor: '#BE3E2D',
      success: async (rs) => {
        if (rs.confirm) {
          try {
            await batchDeleteMemories(ids)
            Taro.showToast({ title: `已删除 ${ids.length} 条`, icon: 'success' })
            sel.exit()
            load()
          } catch (e) {
            Taro.showToast({ title: '删除失败', icon: 'none' })
          }
        }
      },
    })
  }, [sel, load])

  // 按月份分组
  const groups = useMemo(() => groupByMonth(list), [list])

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

      {/* 搜索 + 新增 */}
      <View className="flex flex-row items-center gap-2 px-4 pt-3">
        <View className="flex-1 flex flex-row items-center gap-2 rounded-xl bg-muted px-3 h-9">
          <Text className="block text-xs text-muted-foreground" onClick={onSearch}>🔍</Text>
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
            <Text className="block text-xs text-muted-foreground" onClick={() => { setKeyword(''); setActiveKeyword(''); }}>
              清空
            </Text>
          ) : null}
        </View>
        {!sel.selecting && (
          <Button
            className="h-9 px-3 rounded-xl bg-primary"
            onClick={onCreate}
          >
            <Plus size={16} color="#fff" />
            <Text className="block text-sm text-primary-foreground ml-1">新增</Text>
          </Button>
        )}
      </View>

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
          <Text
            className="block text-xs text-muted-foreground"
            onClick={() => list.length && sel.enter()}
          >
            批量
          </Text>
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
          <Button className="mt-4 rounded-xl bg-primary" onClick={load}>
            <Text className="block text-sm text-primary-foreground">重试</Text>
          </Button>
        </View>
      ) : list.length === 0 ? (
        <View className="px-4 pt-12 flex flex-col items-center gap-4">
          <Text className="block text-base text-foreground">还没有记忆</Text>
          <Text className="block text-sm text-muted-foreground text-center">
            把成长路上的随想、心得、照片、声音都留下来{'\n'}让记忆成为可翻阅的「成长手记」
          </Text>
          <Button className="mt-2 rounded-xl bg-primary" onClick={onCreate}>
            <Plus size={16} color="#fff" />
            <Text className="block text-sm text-primary-foreground ml-1">记录第一段</Text>
          </Button>
        </View>
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
            className="flex-1 h-11 rounded-xl bg-red-600 flex items-center justify-center"
            onClick={onBatchDelete}
          >
            <Text className="block text-sm text-white">删除 ({sel.count})</Text>
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