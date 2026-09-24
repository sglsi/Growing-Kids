import { View, Text, ScrollView } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Network } from '@/network'
import QuestionCard from '@/components/question-card'
import { exportDocument, fetchQuestions, fetchSubjects, type Subject, type QuestionWithSubject } from '@/services/api'
import { getSubjectColor } from '@/types'

type Range = 'week' | 'month' | 'all'

function getDateRange(r: Range): { start: string; end: string } {
  const now = new Date()
  const end = now.toISOString()
  if (r === 'all') return { start: '', end: '' }
  const days = r === 'week' ? 7 : 30
  const start = new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString()
  return { start, end }
}

export default function DocumentPage() {
  const [range, setRange] = useState<Range>('week')
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [activeSubject, setActiveSubject] = useState('')
  const [questions, setQuestions] = useState<QuestionWithSubject[]>([])
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [previewed, setPreviewed] = useState(false)
  const [includeMastered, setIncludeMastered] = useState(false)

  useDidShow(() => {
    if (subjects.length === 0) {
      fetchSubjects().then(setSubjects)
    }
  })

  const handlePreview = async () => {
    setLoading(true)
    setPreviewed(true)
    try {
      const { start, end } = getDateRange(range)
      const res = await fetchQuestions({
        subjectId: activeSubject || undefined,
        startDate: start || undefined,
        endDate: end || undefined,
        mastered: includeMastered ? undefined : false
      })
      setQuestions(res.list)
    } catch (e) {
      console.error('预览失败', e)
    } finally {
      setLoading(false)
    }
  }

  const openDoc = (url: string) => {
    Taro.showLoading({ title: '打开文档…' })
    Network.downloadFile({
      url,
      success: (d) => {
        Taro.hideLoading()
        Taro.openDocument({
          filePath: d.tempFilePath,
          fileType: 'docx',
          showMenu: true,
          fail: () => Taro.setClipboardData({ data: url })
        })
      },
      fail: () => {
        Taro.hideLoading()
        Taro.setClipboardData({ data: url })
      }
    })
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
        include_mastered: includeMastered
      })
      openDoc(res.url)
    } catch (e) {
      console.error('导出失败', e)
    } finally {
      setExporting(false)
    }
  }

  return (
    <ScrollView scrollY className="h-full bg-background">
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
  )
}
