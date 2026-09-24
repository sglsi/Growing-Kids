import { View, Text, ScrollView } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import QuestionCard from '@/components/question-card'
import { fetchOverview, type Overview } from '@/services/api'
import { getSubjectColor } from '@/types'

export default function IndexPage() {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)

  const load = async () => {
    try {
      const data = await fetchOverview()
      setOverview(data)
    } catch (e) {
      console.error('加载概览失败', e)
    } finally {
      setLoading(false)
    }
  }

  useDidShow(() => {
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
    Taro.switchTab({ url: '/pages/subject/index' }).then(() => {
      if (subjectId) {
        Taro.setStorageSync('filter_subject_id', subjectId)
      }
    })
  }

  return (
    <ScrollView scrollY className="h-full bg-background">
      <View className="px-4 pt-4 pb-24">
        {/* 顶部标题 */}
        <View className="mb-4">
          <Text className="block text-xl font-bold text-foreground">成长学童</Text>
          <Text className="block text-xs text-muted-foreground mt-1">拍照 / 导入，把题目整理成属于你的知识地图</Text>
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
          <Button variant="outline" className="w-full h-11 rounded-xl" onClick={goDocImport}>
            <Text className="block text-sm">导入文档（PDF / Word / TXT）</Text>
          </Button>
        </Card>

        {loading ? (
          <View className="space-y-3">
            <Skeleton className="h-24 w-full rounded-2xl" />
            <Skeleton className="h-40 w-full rounded-2xl" />
            <Skeleton className="h-40 w-full rounded-2xl" />
          </View>
        ) : (
          <>
            {/* 数据统计 */}
            <View className="flex flex-row gap-3 mb-4">
              <StatCard label="本周新增" value={overview?.week_total ?? 0} highlight />
              <StatCard label="累计题目" value={overview?.total ?? 0} />
              <StatCard label="待找答案" value={overview?.pending ?? 0} />
            </View>

            {/* 学科入口 */}
            <View className="mb-2 flex flex-row items-center justify-between">
              <Text className="block text-sm font-semibold text-foreground">学科分类</Text>
              <Text className="block text-xs text-muted-foreground" onClick={() => goSubject()}>全部</Text>
            </View>
            <View className="flex flex-row flex-wrap gap-2 mb-5">
              {overview?.subject_stats?.map(s => {
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
              })}
            </View>

            {/* 最近题目 */}
            <View className="mb-2">
              <Text className="block text-sm font-semibold text-foreground">最近题目</Text>
            </View>
            {overview?.recent?.length ? (
              <View className="space-y-3">
                {overview.recent.map(q => <QuestionCard key={q.id} item={q} />)}
              </View>
            ) : (
              <EmptyState onAction={goRecognize} />
            )}
          </>
        )}
      </View>
    </ScrollView>
  )
}

function StatCard({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <Card className={`flex-1 rounded-2xl border-border p-3 ${highlight ? 'bg-primary' : ''}`}>
      <Text className={`block text-2xl font-bold ${highlight ? 'text-primary-foreground' : 'text-foreground'}`}>
        {value}
      </Text>
      <Text className={`block text-xs mt-1 ${highlight ? 'text-primary-foreground opacity-70' : 'text-muted-foreground'}`}>
        {label}
      </Text>
    </Card>
  )
}

function EmptyState({ onAction }: { onAction: () => void }) {
  return (
    <Card className="rounded-2xl border-border p-8 flex flex-col items-center">
      <Text className="block text-sm text-muted-foreground mb-4 text-center">还没有题目记录{'\n'}拍下第一张试卷开始整理吧</Text>
      <Button size="sm" className="rounded-lg" onClick={onAction}>
        <Text className="block text-xs">去拍照识别</Text>
      </Button>
    </Card>
  )
}
