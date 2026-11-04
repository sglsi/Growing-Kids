import { View, Text, ScrollView } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import ReviewItemCard from '@/components/review-item-card'
import { EmptyCard } from '@/components/filter-header'
import SubjectBadge from '@/components/subject-badge'
import RangePicker, { getSinceFromRange, RANGE_OPTIONS, type RangeValue } from '@/components/range-picker'
import {
  fetchTimeline, fetchSubjects, exportDocument,
  type Subject, type TimelineItem, type Paged,
} from '@/services/api'
import { cacheGet, cacheSet, cacheListKey } from '@/services/cache'
import { openStorageFile } from '@/services/net'

/**
 * 汇总生成（本页现在只做一件事）
 *
 * 沿革：
 *   · 2026-11-02 从「文档」tab 搬进复习本（按时间段成卷 + 导出资料归档）；
 *   · **2026-11-04「导出资料」搬到复习本顶部，与本页的「科目」并列成两个可切换视图**
 *     ⇒ 本页只剩「汇总生成」一件事，所以去掉原来的两个 tab。
 *
 * 与复习本「批量选择 → 合成PDF/WORD」的分工（这是最容易被问混的一点）：
 *   · 本页 = **按条件自动收题**：给定时间段 + 学科，把符合条件的题一次成卷，
 *     不需要手指点；适合「把这一周的题打一份练习卷」。
 *   · 批量选择 = **手动挑题**：在列表里勾哪几道就出哪几道，可跨学科任意组合；
 *     适合「就是这 5 道错题，单独打印」。
 *   两者产物都会归档进「导出资料」，区别只在「谁来挑题」。
 */

function getDateRange(r: RangeValue, latestTimestamp?: string | null): { start: string; end: string } {
  const end = new Date().toISOString()
  const since = getSinceFromRange(r, latestTimestamp)
  if (!since) return { start: '', end: r === 'all' ? '' : end }
  return { start: since, end }
}

const RANGE_LABEL: Record<RangeValue, string> = RANGE_OPTIONS.reduce(
  (acc, o) => { acc[o.value] = o.label; return acc },
  {} as Record<RangeValue, string>,
)

export default function SummaryPage() {
  // —— 生成相关 ——
  const [range, setRange] = useState<RangeValue>('week')
  const [latestTimestamp, setLatestTimestamp] = useState<string | undefined>(undefined)
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [activeSubject, setActiveSubject] = useState('')
  const [questions, setQuestions] = useState<TimelineItem[]>([])
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [includeMastered, setIncludeMastered] = useState(false)

  /**
   * 按当前筛选条件拉取题目。
   *
   * ⚠️ 2026-11-04 修「打开汇总生成，一道题都没有」：
   * 原实现只在用户手动点「生成汇总预览」后才拉数据，且未预览时列表区**连空态都不渲染**
   * ⇒ 进页面看到的是「时间段 + 学科 + 开关 + 一个按钮 + 大片空白」，很容易被当成坏了。
   * 现在改为**进页面自动生成一次**、改筛选条件也自动重生成，页面永远有内容或明确的空态。
   */
  const preview = async () => {
    setLoading(true)
    try {
      // 数据源为 timeline（kind=question），已掌握过滤与学科筛选在后端，时间窗在前端
      const { start, end } = getDateRange(range, latestTimestamp)
      // SWR：重复预览同一筛选时先读缓存（写操作已失效 tl 域，拿到即最新）
      const listKey = cacheListKey('tl', { scope: 'recent', subjectId: activeSubject || '', pageSize: 100 })
      let res = cacheGet<Paged<TimelineItem>>(listKey)
      if (!res) {
        res = await fetchTimeline({
          scope: 'recent',
          subjectId: activeSubject || undefined,
          pageSize: 100,
        })
        cacheSet(listKey, res)
      }
      let list = res.list.filter((it) => it.kind === 'question')
      // 自动模式：首次预览时把最新一条记录为锚点
      if (!latestTimestamp && range === 'auto' && list[0]) {
        setLatestTimestamp(list[0].created_at)
      }
      if (!includeMastered) list = list.filter((it) => !it.mastered)
      if (start) list = list.filter((it) => it.created_at >= start)
      if (end) list = list.filter((it) => it.created_at <= end)
      setQuestions(list)
    } catch (e) {
      console.error('[summary] 预览失败', e)
      Taro.showToast({ title: '汇总预览失败，请重试', icon: 'none' })
    } finally {
      setLoading(false)
    }
  }

  useDidShow(() => {
    const cachedSubs = cacheGet<Subject[]>('subj:list')
    if (cachedSubs && subjects.length === 0) setSubjects(cachedSubs)
    fetchSubjects()
      .then((s) => {
        setSubjects(s)
        if (s.length) cacheSet('subj:list', s)
      })
      // ⚠️ best-effort 的 catch 必须打全错（工程规范第 7 章第 2 条）
      .catch((e) => console.error('[summary] 学科列表加载失败', e))

  })

  /**
   * 筛选条件一变就重新生成——保证「看到的列表」永远等于「当前筛选」。
   * 不做这一步的话，把时间段从「近一周」改成「全部」后列表还是旧的，
   * 用户会以为筛选没生效（这正是老版本被误判成「没有一道题」的第二个原因）。
   */
  useEffect(() => {
    void preview()
    // preview 每次渲染都是新函数，放进依赖会无限循环；它读的 range/subject/includeMastered 已在下面列出
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, activeSubject, includeMastered])

  /**
   * 导出 Word/PDF（2026-10-28 起两种用途分开，默认练习卷）。
   *
   * 背景：此前不传 `include_answers` 而后端默认含答案 ⇒ 家长想打一份空白练习卷，
   * 拿到的却是答案纸（而复习本合成 PDF 的默认恰好相反，同一产品两套默认）。
   * 现在按钮把用途写明：**打印练习卷 = 不含答案**，另一颗按钮才是答疑解惑。
   */
  const handleExport = async (withAnswers: boolean) => {
    if (!questions.length) {
      Taro.showToast({ title: '当前条件没有题目，先放宽筛选', icon: 'none' })
      return
    }
    if (exporting) return
    setExporting(true)
    try {
      const { start, end } = getDateRange(range, latestTimestamp)
      const res = await exportDocument({
        subject_id: activeSubject || undefined,
        start_date: start,
        end_date: end,
        include_mastered: includeMastered,
        include_answers: withAnswers,
      })
      openStorageFile(res.url, false, res.file_key)
      Taro.showToast({ title: withAnswers ? '已生成答疑解惑版' : '已生成练习卷', icon: 'none' })
    } catch (e) {
      console.error('[summary] 导出失败', e)
      Taro.showToast({ title: '导出失败', icon: 'none' })
    } finally {
      setExporting(false)
    }
  }

  const subjectName = subjects.find((s) => s.id === activeSubject)?.name || ''
  /** 空态提示要具体到「当前筛选是什么」，否则家长不知道该改哪一项 */
  const emptyHint = `当前筛选：${RANGE_LABEL[range]}${subjectName ? ` · ${subjectName}` : ' · 全部学科'}${includeMastered ? '' : ' · 不含已掌握'}。把时间段放宽到「全部」，或打开「包含已掌握题目」再试。`

  return (
    <View className="bg-background" style={{ position: 'relative', height: '100vh' }}>
      <ScrollView scrollY style={{ height: '100vh' }}>
        <View className="px-4 pt-4 pb-32">
          <Text className="block text-base font-semibold text-foreground mb-2">汇总时间段</Text>
          <View className="mb-4">
            <RangePicker value={range} onChange={setRange} />
          </View>

          <View className="mb-2">
            <Text className="block text-base font-semibold text-foreground">选择学科（不选为全部学科）</Text>
          </View>
          <View className="flex flex-row flex-wrap gap-2 mb-5">
            <SubjectBadge name="全部" active={activeSubject === ''} onClick={() => setActiveSubject('')} />
            {subjects.map((s) => (
              <SubjectBadge
                key={s.id}
                name={s.name}
                color={s.color}
                active={activeSubject === s.id}
                onClick={() => setActiveSubject(s.id)}
              />
            ))}
          </View>

          <View className="flex flex-row items-center justify-between bg-muted rounded-xl px-4 py-3 mb-5">
            <View className="flex-1">
              <Text className="block text-sm font-medium text-foreground">包含已掌握题目</Text>
              <Text className="block text-xs text-muted-foreground">默认仅汇总未掌握题目，开启后已掌握题一并纳入</Text>
            </View>
            <Switch checked={includeMastered} onCheckedChange={(v) => setIncludeMastered(v)} />
          </View>

          <View className="bg-muted rounded-xl px-4 py-3 mb-5">
            <Text className="block text-sm font-medium text-foreground">两种导出用途</Text>
            <Text className="block text-xs text-muted-foreground mt-1">
              「打印练习卷」＝不含答案与解析，打给孩子做；「答疑解惑」＝含答案/解析/错因，用于对答案与讲解。两份可分别导出。
            </Text>
          </View>

          <Button variant="outline" className="w-full h-11 rounded-xl mb-5" disabled={loading} onClick={() => void preview()}>
            <Text className="block text-sm">{loading ? '生成中…' : '重新生成预览'}</Text>
          </Button>

          {loading ? (
            <View className="space-y-3">
              <Skeleton className="h-28 w-full rounded-2xl" />
            </View>
          ) : (
            questions.length ? (
              <>
                <Text className="block text-xs text-muted-foreground mb-3">共 {questions.length} 题，按录入时间排列</Text>
                <View className="space-y-3 mb-5">
                  {questions.map((q) => <ReviewItemCard key={q.id} item={q} showSubject />)}
                </View>
              </>
            ) : (
              <EmptyCard title="这个条件下没有题目" hint={emptyHint} />
            )
          )}
        </View>

        <View style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          display: 'flex', flexDirection: 'row', gap: '12px',
          padding: '12px 16px', backgroundColor: '#fff', borderTop: '1px solid #ece8e0', zIndex: 100,
        }}
        >
          <Button className="flex-1 h-11 rounded-xl" disabled={exporting} onClick={() => handleExport(false)}>
            <Text className="block text-sm">{exporting ? '导出中…' : '打印练习卷'}</Text>
          </Button>
          <Button variant="outline" className="flex-1 h-11 rounded-xl" disabled={exporting} onClick={() => handleExport(true)}>
            <Text className="block text-sm">答疑解惑（含答案）</Text>
          </Button>
        </View>
      </ScrollView>
    </View>
  )
}
