import { View, Text, ScrollView } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Network } from '@/network'
import QuestionCard from '@/components/question-card'
import {
  exportDocument, fetchQuestions, fetchSubjects, fetchDocuments, batchDeleteDocuments,
  type Subject, type QuestionWithSubject, type DocItem,
} from '@/services/api'
import { getSubjectColor } from '@/types'
import { FileText, Check } from 'lucide-react-taro'

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

function formatTime(iso: string) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function openDocument(rawUrl: string, isPdf: boolean) {
  Taro.showLoading({ title: '打开文档…' })
  Network.downloadFile({
    url: rawUrl,
    success: (d) => {
      Taro.hideLoading()
      Taro.openDocument({
        filePath: d.tempFilePath,
        fileType: isPdf ? 'pdf' : 'docx',
        showMenu: true,
        fail: () => {
          Taro.setClipboardData({ data: rawUrl })
          Taro.showToast({ title: '无法打开，地址已复制', icon: 'none' })
        },
      })
    },
    fail: () => {
      Taro.hideLoading()
      Taro.setClipboardData({ data: rawUrl })
      Taro.showToast({ title: '加载失败，地址已复制', icon: 'none' })
    },
  })
}

export default function DocumentPage() {
  const [tab, setTab] = useState<Tab>('generate')

  // —— 生成相关 ——
  const [range, setRange] = useState<Range>('week')
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [activeSubject, setActiveSubject] = useState('')
  const [questions, setQuestions] = useState<QuestionWithSubject[]>([])
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [previewed, setPreviewed] = useState(false)
  const [includeMastered, setIncludeMastered] = useState(false)

  // —— 文档库 ——
  const [docs, setDocs] = useState<DocItem[]>([])
  const [docsLoading, setDocsLoading] = useState(true)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [docFilter, setDocFilter] = useState<'all' | 'docx' | 'pdf'>('all')

  useDidShow(() => {
    if (subjects.length === 0) {
      fetchSubjects().then(setSubjects)
    }
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
      const { start, end } = getDateRange(range)
      const res = await fetchQuestions({
        subjectId: activeSubject || undefined,
        startDate: start || undefined,
        endDate: end || undefined,
        mastered: includeMastered ? undefined : false,
      })
      setQuestions(res.list)
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
      openDocument(res.url, false)
      loadDocs()
    } catch (e) {
      console.error('导出失败', e)
      Taro.showToast({ title: '导出失败', icon: 'none' })
    } finally {
      setExporting(false)
    }
  }

  // —— 文档库操作 ——
  const filteredDocs = docs.filter(d => docFilter === 'all' || d.type === docFilter)

  const handleItemOpen = (d: DocItem) => {
    if (selecting) { toggleSelect(d.id); return }
    openDocument(d.url, d.type === 'pdf')
  }

  const toggleSelect = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  const handleLongPress = (d: DocItem) => {
    if (selecting) return
    const next = new Set<string>()
    next.add(d.id)
    setSelected(next)
    setSelecting(true)
    Taro.vibrateShort?.({ type: 'light' }).catch(() => {})
  }

  const exitSelect = () => {
    setSelecting(false)
    setSelected(new Set())
  }

  const handleDelete = async () => {
    if (!selected.size) { Taro.showToast({ title: '请先选择文档', icon: 'none' }); return }
    const ok = await new Promise<boolean>(resolve =>
      Taro.showModal({
        title: '确认删除',
        content: `将删除选中的 ${selected.size} 份文档，是否继续？`,
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      }),
    )
    if (!ok) return
    try {
      await batchDeleteDocuments(Array.from(selected))
      Taro.showToast({ title: '已删除', icon: 'success' })
      setSelected(new Set())
      setSelecting(false)
      loadDocs()
    } catch (e) {
      console.error('删除失败', e)
      Taro.showToast({ title: '删除失败', icon: 'none' })
    }
  }

  return (
    <View className="h-screen bg-background flex flex-col" style={{ height: '100vh' }}>
      {/* 顶部标签切换 */}
      <View className="flex-shrink-0 bg-background border-b border-border">
        <View className="flex flex-row bg-muted rounded-xl p-1 m-4 mb-0">
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
        </View>
      </View>

      {tab === 'generate' ? (
        <ScrollView scrollY className="flex-1">
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
              {subjects.map(s => {
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
                    {questions.map(q => <QuestionCard key={q.id} item={q} showSubject />)}
                  </View>
                </>
              ) : (
                <Card className="rounded-2xl border-border p-8 flex items-center justify-center">
                  <Text className="block text-sm text-muted-foreground">所选条件下暂无题目</Text>
                </Card>
              )
            )}
          </View>

          <View style={{
            position: 'fixed', bottom: 0, left: 0, right: 0,
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
          <View className="flex-shrink-0 bg-background border-b border-border px-4 pt-2 pb-2">
            <View className="flex flex-row items-center justify-between">
              <Text className="block text-sm text-muted-foreground">共 {filteredDocs.length} 份文档</Text>
              {!selecting ? (
                <Text className="block text-sm text-primary" onClick={() => setSelecting(true)}>批量选择</Text>
              ) : (
                <View className="flex flex-row items-center gap-3">
                  {selected.size > 0 && (
                    <>
                      <Text className="block text-sm text-foreground">已选 {selected.size}</Text>
                      <Text className="block text-sm text-muted-foreground" onClick={() => setSelected(new Set())}>清空</Text>
                    </>
                  )}
                  <Text className="block text-sm text-primary" onClick={exitSelect}>取消</Text>
                </View>
              )}
            </View>
            <View className="flex flex-row gap-2 mt-2">
              {([['all', '全部'], ['docx', 'Word'], ['pdf', 'PDF']] as ['all' | 'docx' | 'pdf', string][]).map(([v, label]) => (
                <View
                  key={v}
                  className={`rounded-full border px-3 py-2 ${docFilter === v ? 'bg-primary border-primary' : 'bg-background border-border'}`}
                  onClick={() => { setDocFilter(v); setSelected(new Set()) }}
                >
                  <Text className={`block text-xs ${docFilter === v ? 'text-primary-foreground' : ''}`}>{label}</Text>
                </View>
              ))}
            </View>
          </View>

          <ScrollView scrollY className="flex-1">
            <View className="px-4 pb-28 pt-3">
              {docsLoading ? (
                <View className="space-y-3">
                  <Skeleton className="h-16 w-full rounded-2xl" />
                  <Skeleton className="h-16 w-full rounded-2xl" />
                </View>
              ) : filteredDocs.length ? (
                <View className="space-y-2">
                  {filteredDocs.map(d => (
                    <View
                      key={d.id}
                      className={`flex flex-row items-center gap-3 rounded-xl border p-3 ${selected.has(d.id) ? 'border-primary bg-muted' : 'border-border bg-card'}`}
                      onClick={() => handleItemOpen(d)}
                      onLongPress={() => handleLongPress(d)}
                    >
                      {selecting && (
                        <View className={`w-5 h-5 flex-shrink-0 rounded-full border flex items-center justify-center ${selected.has(d.id) ? 'bg-primary border-primary' : 'border-muted-foreground'}`}>
                          {selected.has(d.id) && <Check size={14} color="#fff" />}
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
                <Card className="rounded-2xl border-border p-8 flex items-center justify-center mt-8">
                  <Text className="block text-sm text-muted-foreground text-center">暂无文档{'\n'}在「汇总生成」中导出 Word，或到复习本合成 PDF 后会自动归档到这里</Text>
                </Card>
              )}
            </View>
          </ScrollView>

          {selecting && (
            <View style={{
              position: 'fixed', bottom: 0, left: 0, right: 0,
              display: 'flex', flexDirection: 'row', gap: '12px',
              padding: '12px 16px', backgroundColor: '#fff', borderTop: '1px solid #ece8e0', zIndex: 100,
            }}
            >
              <View style={{ flex: 1 }}>
                <View
                  className={`flex flex-row items-center justify-center gap-2 h-11 rounded-xl ${!selected.size ? 'opacity-50' : ''} bg-red-600`}
                  onClick={() => { if (selected.size) handleDelete() }}
                >
                  <Text className="block text-sm text-white">删除选中</Text>
                </View>
              </View>
            </View>
          )}
        </>
      )}
    </View>
  )
}