import { View, Text, ScrollView } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import ReviewItemCard from '@/components/review-item-card'
import { EmptyCard, BottomActionBar, ActionBtn } from '@/components/filter-header'
import { confirmDelete, useSelection } from '@/lib/use-selection'
import {
  fetchTimeline, fetchSubjects, fetchDocuments, batchDeleteDocuments, exportDocument,
  type Subject, type TimelineItem, type DocItem,
} from '@/services/api'
import { getSubjectColor, formatTime } from '@/types'
import { openStorageFile, isPdfFile } from '@/services/net'
import { FileText, Check, FolderOpen } from 'lucide-react-taro'

type Range = 'week' | 'month' | 'all'
type Tab = 'generate' | 'library'

function getDateRange(r: Range): { start: string; end: string } {
  const now = new Date()
  const end = now.toISOString()
  if (r === 'all') return { start: '', end: '' }
  const days = r === 'week' ? 7 : 30
  const start = new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString()
  return { start, end }
}

export default function DocumentPage() {
  const [tab, setTab] = useState<Tab>('library')

  // —— 生成相关 ——
  const [range, setRange] = useState<Range>('week')
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [activeSubject, setActiveSubject] = useState('')
  const [questions, setQuestions] = useState<TimelineItem[]>([])
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [previewed, setPreviewed] = useState(false)
  const [includeMastered, setIncludeMastered] = useState(false)

  // —— 文档库 ——
  const [docs, setDocs] = useState<DocItem[]>([])
  const [docsLoading, setDocsLoading] = useState(true)
  const [docFilter, setDocFilter] = useState<'all' | 'docx' | 'pdf'>('all')
  const [busy, setBusy] = useState(false)
  const sel = useSelection()

  useDidShow(() => {
    if (subjects.length === 0) {
      fetchSubjects().then(setSubjects).catch(() => {})
    }
    sel.exit()
    loadDocs()
  })

  const loadDocs = async () => {
    setDocsLoading(true)
    try {
      const res = await fetchDocuments({ pageSize: 100 })
      setDocs(res.list)
    } catch (e) {
      console.error('加载文档失败', e)
    } finally {
      setDocsLoading(false)
    }
  }

  const handlePreview = async () => {
    setLoading(true)
    setPreviewed(true)
    try {
      // v4：汇总数据源为 timeline（kind=question），已掌握过滤与时间/学科筛选均在后端
      const { start, end } = getDateRange(range)
      const res = await fetchTimeline({
        scope: 'recent',
        subjectId: activeSubject || undefined,
        pageSize: 100,
      })
      let list = res.list.filter((it) => it.kind === 'question')
      if (!includeMastered) list = list.filter((it) => !it.mastered)
      if (start) list = list.filter((it) => it.created_at >= start)
      if (end) list = list.filter((it) => it.created_at <= end)
      setQuestions(list)
    } catch (e) {
      console.error('预览失败', e)
    } finally {
      setLoading(false)
    }
  }

  const handleExport = async () => {
    if (!questions.length) {
      Taro.showToast({ title: '请先生成汇总', icon: 'none' })
      return
    }
    setExporting(true)
    try {
      const { start, end } = getDateRange(range)
      const res = await exportDocument({
        subject_id: activeSubject || undefined,
        start_date: start,
        end_date: end,
        include_mastered: includeMastered,
      })
      openStorageFile(res.url, false)
      loadDocs()
    } catch (e) {
      console.error('导出失败', e)
      Taro.showToast({ title: '导出失败', icon: 'none' })
    } finally {
      setExporting(false)
    }
  }

  const filteredDocs = docs.filter((d) => docFilter === 'all' || d.type === docFilter)

  const handleItemOpen = (d: DocItem) => {
    if (sel.selecting) { sel.toggle(d.id); return }
    openStorageFile(d.url || '', isPdfFile(d.mime_type || d.type))
  }

  const handleDelete = async () => {
    if (sel.isEmpty) { Taro.showToast({ title: '请先选择文档', icon: 'none' }); return }
    const ok = await confirmDelete(sel.count, '份文档')
    if (!ok) return
    setBusy(true)
    try {
      await batchDeleteDocuments(Array.from(sel.selected))
      Taro.showToast({ title: '已删除', icon: 'success' })
      sel.exit()
      loadDocs()
    } catch (e) {
      console.error('删除失败', e)
      Taro.showToast({ title: '删除失败', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  const goLibrary = () => Taro.navigateTo({ url: '/pages/library/index' })

  return (
    <View className="bg-background" style={{ position: 'relative', height: '100vh' }}>
      {/* 固定顶部标签 */}
      <View style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 50, backgroundColor: '#fff', padding: '12px 16px 0', borderBottom: '1px solid #ecefe3' }}>
        <View className="flex flex-row bg-muted rounded-xl p-1 mb-2">
          <View
            className={`flex-1 flex items-center justify-center h-9 rounded-lg ${tab === 'generate' ? 'bg-background shadow-sm' : ''}`}
            onClick={() => setTab('generate')}
          >
            <Text className={`block text-sm ${tab === 'generate' ? 'text-primary font-medium' : 'text-muted-foreground'}`}>汇总生成</Text>
          </View>
          <View
            className={`flex-1 flex items-center justify-center h-9 rounded-lg ${tab === 'library' ? 'bg-background shadow-sm' : ''}`}
            onClick={() => setTab('library')}
          >
            <Text className={`block text-sm ${tab === 'library' ? 'text-primary font-medium' : 'text-muted-foreground'}`}>我的文档</Text>
          </View>
          <View
            className="flex-1 flex items-center justify-center h-9 rounded-lg"
            onClick={goLibrary}
          >
            <Text className="block text-sm text-muted-foreground">资料库</Text>
          </View>
        </View>
      </View>

      {tab === 'generate' ? (
        <ScrollView scrollY style={{ height: '100vh', paddingTop: 60 }}>
          <View className="px-4 pt-4 pb-32">
            <Text className="block text-sm font-semibold text-foreground mb-2">汇总时间段</Text>
            <View className="flex flex-row bg-muted rounded-xl p-1 mb-4">
              {([['week', '近一周'], ['month', '近一月'], ['all', '全部']] as [Range, string][]).map(([v, label]) => (
                <View
                  key={v}
                  className={`flex-1 flex items-center justify-center h-9 rounded-lg ${range === v ? 'bg-background shadow-sm' : ''}`}
                  onClick={() => setRange(v)}
                >
                  <Text className={`block text-sm ${range === v ? 'text-primary font-medium' : 'text-muted-foreground'}`}>{label}</Text>
                </View>
              ))}
            </View>

            <View className="mb-2">
              <Text className="block text-sm font-semibold text-foreground">选择学科（不选为全部学科）</Text>
            </View>
            <View className="flex flex-row flex-wrap gap-2 mb-5">
              <View
                className={`rounded-full border px-3 py-2 ${activeSubject === '' ? 'bg-primary border-primary' : 'bg-background border-border'}`}
                onClick={() => setActiveSubject('')}
              >
                <Text className={`block text-xs ${activeSubject === '' ? 'text-primary-foreground' : ''}`}>全部</Text>
              </View>
              {subjects.map((s) => {
                const active = activeSubject === s.id
                const c = getSubjectColor(s.color)
                return (
                  <View
                    key={s.id}
                    className={`flex flex-row items-center gap-2 rounded-full border px-3 py-2 ${active ? 'bg-primary border-primary' : c.badge}`}
                    onClick={() => setActiveSubject(s.id)}
                  >
                    {!active && <View className={`w-2 h-2 rounded-full ${c.dot}`} />}
                    <Text className={`block text-xs ${active ? 'text-primary-foreground' : ''}`}>{s.name}</Text>
                  </View>
                )
              })}
            </View>

            <View className="flex flex-row items-center justify-between bg-muted rounded-xl px-4 py-3 mb-5">
              <View className="flex-1">
                <Text className="block text-sm font-medium text-foreground">包含已掌握题目</Text>
                <Text className="block text-xs text-muted-foreground">默认仅汇总未掌握题目，开启后已掌握题一并纳入</Text>
              </View>
              <Switch checked={includeMastered} onCheckedChange={(v) => setIncludeMastered(v)} />
            </View>

            <Button variant="outline" className="w-full h-11 rounded-xl mb-5" disabled={loading} onClick={handlePreview}>
              <Text className="block text-sm">{loading ? '生成中…' : '生成汇总预览'}</Text>
            </Button>

            {loading ? (
              <View className="space-y-3">
                <Skeleton className="h-28 w-full rounded-2xl" />
              </View>
            ) : previewed && (
              questions.length ? (
                <>
                  <Text className="block text-xs text-muted-foreground mb-3">共 {questions.length} 题，按录入时间排列</Text>
                  <View className="space-y-3 mb-5">
                    {questions.map((q) => <ReviewItemCard key={q.id} item={q} showSubject />)}
                  </View>
                </>
              ) : (
                <EmptyCard title="所选条件下暂无题目" />
              )
            )}
          </View>

          <View style={{
            position: 'fixed', bottom: 50, left: 0, right: 0,
            display: 'flex', flexDirection: 'row', gap: '12px',
            padding: '12px 16px', backgroundColor: '#fff', borderTop: '1px solid #ece8e0', zIndex: 100,
          }}
          >
            <Button className="flex-1 h-11 rounded-xl" disabled={exporting} onClick={handleExport}>
              <Text className="block text-sm">{exporting ? '导出中…' : '导出 Word 并打印'}</Text>
            </Button>
          </View>
        </ScrollView>
      ) : (
        <>
          <View style={{ position: 'fixed', top: 60, left: 0, right: 0, zIndex: 49, backgroundColor: '#fff', padding: '8px 16px', borderBottom: '1px solid #ecefe3' }}>
            <View className="flex flex-row items-center justify-between">
              <Text className="block text-sm text-muted-foreground">共 {filteredDocs.length} 份文档</Text>
              {!sel.selecting ? (
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
              )}
            </View>
            <View className="flex flex-row gap-2 mt-2">
              {([['all', '全部'], ['docx', 'Word'], ['pdf', 'PDF']] as ['all' | 'docx' | 'pdf', string][]).map(([v, label]) => (
                <View
                  key={v}
                  className={`rounded-full border px-3 py-2 ${docFilter === v ? 'bg-primary border-primary' : 'bg-background border-border'}`}
                  onClick={() => { setDocFilter(v); sel.clear() }}
                >
                  <Text className={`block text-xs ${docFilter === v ? 'text-primary-foreground' : ''}`}>{label}</Text>
                </View>
              ))}
            </View>
          </View>

          <ScrollView scrollY style={{ height: '100vh', paddingTop: 136 }}>
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
                      className={`flex flex-row items-center gap-3 rounded-xl border p-3 ${sel.selected.has(d.id) ? 'border-primary bg-muted' : 'border-border bg-card'}`}
                      onClick={() => handleItemOpen(d)}
                      onLongPress={() => sel.longPress(d.id)}
                    >
                      {sel.selecting && (
                        <View className={`w-5 h-5 flex-shrink-0 rounded-full border flex items-center justify-center ${sel.selected.has(d.id) ? 'bg-primary border-primary' : 'border-muted-foreground'}`}>
                          {sel.selected.has(d.id) && <Check size={14} color="#fff" />}
                        </View>
                      )}
                      <View className="w-11 h-11 flex-shrink-0 flex items-center justify-center rounded-lg bg-muted">
                        <FileText size={20} color="#BE3E2D" />
                      </View>
                      <View className="flex-1 min-w-0">
                        <View className="flex flex-row items-center gap-2">
                          <View className="rounded px-2 py-1 flex-shrink-0 bg-muted">
                            <Text className={`block text-xs font-medium ${d.type === 'pdf' ? 'text-red-600' : 'text-blue-600'}`}>
                              {d.type === 'pdf' ? 'PDF' : 'Word'}
                            </Text>
                          </View>
                          <Text className="block text-sm font-medium text-foreground truncate">{d.title}</Text>
                        </View>
                        <Text className="block text-xs text-muted-foreground mt-1">{formatTime(d.created_at)}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              ) : (
                <EmptyCard
                  title="暂无文档"
                  hint="在「汇总生成」导出 Word，或在复习本合成 PDF，会自动归档到这里"
                  actionLabel="去资料库"
                  onAction={goLibrary}
                />
              )}
            </View>
          </ScrollView>

          {sel.selecting && (
            <BottomActionBar>
              <View style={{ flex: 1 }}>
                <ActionBtn
                  icon={<FolderOpen size={16} color="#fff" />}
                  label="删除选中"
                  danger
                  disabled={sel.isEmpty || busy}
                  onClick={handleDelete}
                />
              </View>
            </BottomActionBar>
          )}
        </>
      )}
    </View>
  )
}
