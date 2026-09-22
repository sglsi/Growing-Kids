import { View, Text, ScrollView } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useState } from 'react'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import QuestionCard from '@/components/question-card'
import { fetchSubjects, fetchQuestions, type Subject, type QuestionWithSubject } from '@/services/api'
import { getSubjectColor } from '@/types'

export default function SubjectPage() {
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [activeSubject, setActiveSubject] = useState('')
  const [questions, setQuestions] = useState<QuestionWithSubject[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  const loadQuestions = async (subjectId: string) => {
    setLoading(true)
    try {
      const res = await fetchQuestions(subjectId ? { subjectId } : {})
      setQuestions(res.list)
      setTotal(res.total)
    } catch (e) {
      console.error('加载题目失败', e)
    } finally {
      setLoading(false)
    }
  }

  const init = async () => {
    const subs = await fetchSubjects()
    setSubjects(subs)
    const preset = Taro.getStorageSync('filter_subject_id') || ''
    if (preset) Taro.removeStorageSync('filter_subject_id')
    setActiveSubject(preset)
    loadQuestions(preset)
  }

  useDidShow(() => {
    init()
  })

  const switchSubject = (id: string) => {
    setActiveSubject(id)
    loadQuestions(id)
  }

  const goRecognize = () => Taro.navigateTo({ url: '/pages/recognize/index' })

  return (
    <View className="h-full bg-background flex flex-col">
      <ScrollView scrollX className="whitespace-nowrap py-3" enhanced showScrollbar={false}>
        <View className="flex flex-row px-4 gap-2">
          <SubjectPill active={activeSubject === ''} label="全部" onClick={() => switchSubject('')} />
          {subjects.map(s => (
            <SubjectPill
              key={s.id}
              active={activeSubject === s.id}
              label={s.name}
              color={getSubjectColor(s.color).dot}
              onClick={() => switchSubject(s.id)}
            />
          ))}
        </View>
      </ScrollView>

      <ScrollView scrollY className="flex-1">
        <View className="px-4 pb-24">
          {loading ? (
            <View className="space-y-3">
              <Skeleton className="h-28 w-full rounded-2xl" />
              <Skeleton className="h-28 w-full rounded-2xl" />
            </View>
          ) : questions.length ? (
            <>
              <Text className="block text-xs text-muted-foreground mb-3">共 {total} 道错题</Text>
              <View className="space-y-3">
                {questions.map(q => <QuestionCard key={q.id} item={q} showSubject={!activeSubject} />)}
              </View>
            </>
          ) : (
            <Card className="rounded-2xl border-border p-8 flex flex-col items-center mt-8">
              <Text className="block text-sm text-muted-foreground text-center mb-4">该学科暂无错题{'\n'}去拍照添加</Text>
              <View className="rounded-lg bg-primary px-4 py-2" onClick={goRecognize}>
                <Text className="block text-xs text-primary-foreground">去拍照识别</Text>
              </View>
            </Card>
          )}
        </View>
      </ScrollView>
    </View>
  )
}

function SubjectPill({ active, label, color, onClick }: { active: boolean; label: string; color?: string; onClick: () => void }) {
  return (
    <View
      className={`flex flex-row items-center gap-2 rounded-full px-4 py-2 border ${
        active ? 'bg-primary border-primary' : 'bg-background border-border'
      }`}
      onClick={onClick}
    >
      {color && !active && <View className={`w-2 h-2 rounded-full ${color}`} />}
      <Text className={`block text-sm whitespace-nowrap ${active ? 'text-primary-foreground' : 'text-foreground'}`}>{label}</Text>
    </View>
  )
}
