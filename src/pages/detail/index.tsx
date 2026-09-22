import { View, Text, ScrollView, Picker } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Network } from '@/network'
import {
  fetchQuestionDetail, fetchSubjects, updateQuestion, searchSolution, exportDocument,
  type Subject, type QuestionWithSubject
} from '@/services/api'
import { getSubjectColor } from '@/types'

export default function DetailPage() {
  const router = useRouter()
  const id = router.params.id || ''
  const [question, setQuestion] = useState<QuestionWithSubject | null>(null)
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [subjectId, setSubjectId] = useState('')
  const [qContent, setQContent] = useState('')
  const [aContent, setAContent] = useState('')
  const [solution, setSolution] = useState('')
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [searchHint, setSearchHint] = useState('')
  const [mastered, setMastered] = useState(false)

  const load = async () => {
    const [q, subs] = await Promise.all([fetchQuestionDetail(id), fetchSubjects()])
    setQuestion(q)
    setSubjects(subs)
    setSubjectId(q.subject_id)
    setQContent(q.question_content)
    setAContent(q.answer_content)
    setSolution(q.solution)
    setMastered(q.mastered)
  }

  useEffect(() => {
    load()
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      const updated = await updateQuestion(id, {
        subject_id: subjectId,
        question_content: qContent,
        answer_content: aContent,
        solution,
        status: aContent ? 'answered' : 'pending',
        mastered
      })
      setQuestion(prev => (prev ? { ...prev, ...updated } : prev))
      Taro.showToast({ title: '已保存', icon: 'success' })
    } catch (e) {
      console.error('保存失败', e)
    } finally {
      setSaving(false)
    }
  }

  const handleSearch = async () => {
    if (!qContent) {
      Taro.showToast({ title: '题目为空，无法搜题', icon: 'none' })
      return
    }
    setSearching(true)
    setSearchHint('正在联网检索解题过程…')
    try {
      const res = await searchSolution(qContent)
      setAContent(res.answer)
      setSolution(res.solution)
      setSearchHint('已找到参考解答，请核对后保存')
    } catch (e) {
      console.error('搜题失败', e)
      setSearchHint('未检索到可靠答案，可手动填写')
    } finally {
      setSearching(false)
    }
  }

  const handlePrint = async () => {
    try {
      const res = await exportDocument({ start_date: '', end_date: '' })
      openDoc(res.url)
    } catch (e) {
      console.error('导出失败', e)
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

  const color = getSubjectColor(question?.subjects?.color || 'gray-500')

  return (
    <ScrollView scrollY className="h-full bg-background">
      <View className="px-4 pt-4 pb-32">
        {question && (
          <View className="flex flex-row items-center gap-2 mb-4">
            <View className={`flex flex-row items-center gap-2 rounded-full border px-3 py-1 ${color.badge}`}>
              <View className={`w-2 h-2 rounded-full ${color.dot}`} />
              <Text className="block text-xs">{question.subjects?.name}</Text>
            </View>
            <Picker
              mode="selector"
              range={subjects}
              rangeKey="name"
              value={Math.max(0, subjects.findIndex(s => s.id === subjectId))}
              onChange={(e) => setSubjectId(subjects[Number(e.detail.value)]?.id || subjectId)}
            >
              <Text className="block text-xs text-muted-foreground">切换学科</Text>
            </Picker>
          </View>
        )}

        <View className="flex flex-row items-center justify-between bg-muted rounded-xl px-4 py-3 mb-4">
          <View className="flex-1">
            <Text className="block text-sm font-medium text-foreground">已掌握</Text>
            <Text className="block text-xs text-muted-foreground">标记后默认不进入汇总，可在文档页开启开关重新纳入</Text>
          </View>
          <Switch checked={mastered} onCheckedChange={(v) => setMastered(v)} />
        </View>

        <Text className="block text-sm font-semibold text-foreground mb-2">题目</Text>
        <Card className="rounded-2xl border-border p-4 mb-4">
          <Textarea
            className="min-h-32 border-0 ring-0 focus-within:ring-0 rounded-xl"
            value={qContent}
            placeholder="题目内容"
            maxlength={3000}
            onInput={(e) => setQContent(e.detail.value)}
          />
        </Card>

        <View className="flex flex-row items-center justify-between mb-2">
          <Text className="block text-sm font-semibold" style={{ color: '#BE3E2D' }}>正确答案 / 解题过程</Text>
          <Text className="block text-xs text-primary" onClick={handleSearch}>
            {searching ? '检索中…' : '联网搜题'}
          </Text>
        </View>
        <Card className="rounded-2xl p-4 mb-2" style={{ borderColor: 'rgba(190,62,45,0.25)', backgroundColor: 'rgba(190,62,45,0.04)' }}>
          <Textarea
            className="min-h-24 border-0 ring-0 focus-within:ring-0 rounded-xl"
            value={aContent}
            placeholder="无答案时可点右上角联网搜题，或手动填写"
            maxlength={3000}
            onInput={(e) => setAContent(e.detail.value)}
          />
        </Card>

        <Text className="block text-xs text-muted-foreground mb-2 mt-4">详细解题过程</Text>
        <Card className="rounded-2xl border-border p-4 mb-2">
          <Textarea
            className="min-h-28 border-0 ring-0 focus-within:ring-0 rounded-xl"
            value={solution}
            placeholder="可粘贴或联网获取详细解析"
            maxlength={3000}
            onInput={(e) => setSolution(e.detail.value)}
          />
        </Card>
        {searchHint && <Text className="block text-xs text-muted-foreground mb-4">{searchHint}</Text>}
      </View>

      <View style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        display: 'flex', flexDirection: 'row', gap: '12px',
        padding: '12px 16px', backgroundColor: '#fff', borderTop: '1px solid #ece8e0', zIndex: 100,
      }}
      >
        <Button variant="outline" className="flex-1 h-11 rounded-xl" onClick={handlePrint}>
          <Text className="block text-sm">导出打印</Text>
        </Button>
        <Button className="flex-1 h-11 rounded-xl" disabled={saving} onClick={handleSave}>
          <Text className="block text-sm">{saving ? '保存中…' : '保存修改'}</Text>
        </Button>
      </View>
    </ScrollView>
  )
}
