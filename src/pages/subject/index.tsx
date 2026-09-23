import { View, Text, ScrollView, Image } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useState } from 'react'
import { FileText, Image as ImageIcon } from 'lucide-react-taro'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { fetchSubjects, fetchMaterials, type Subject, type Material } from '@/services/api'
import { getSubjectColor } from '@/types'

export default function SubjectPage() {
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [activeSubject, setActiveSubject] = useState('')
  const [materials, setMaterials] = useState<Material[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  const loadMaterials = async (subjectId: string) => {
    setLoading(true)
    try {
      const res = await fetchMaterials(subjectId ? { subjectId, pageSize: 100 } : { pageSize: 100 })
      setMaterials(res.list)
      setTotal(res.total)
    } catch (e) {
      console.error('加载资料失败', e)
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
    loadMaterials(preset)
  }

  useDidShow(() => {
    init()
  })

  const switchSubject = (id: string) => {
    setActiveSubject(id)
    loadMaterials(id)
  }

  const goRecognize = () => Taro.navigateTo({ url: '/pages/recognize/index' })

  const getSubjectName = (id: string | null) => {
    if (!id) return ''
    return subjects.find(s => s.id === id)?.name || ''
  }

  const getSubjectDot = (id: string | null) => {
    if (!id) return ''
    const s = subjects.find(x => x.id === id)
    return s ? getSubjectColor(s.color).dot : ''
  }

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
              <Skeleton className="h-36 w-full rounded-2xl" />
              <Skeleton className="h-36 w-full rounded-2xl" />
            </View>
          ) : materials.length ? (
            <>
              <Text className="block text-xs text-muted-foreground mb-3">共 {total} 份学习资料</Text>
              <View className="space-y-1">
                {materials.map(m => (
                  <MaterialRow key={m.id} item={m} subjectName={getSubjectName(m.subject_id)} subjectDot={getSubjectDot(m.subject_id)} onOpen={() => goRecognize()} />
                ))}
              </View>
            </>
          ) : (
            <Card className="rounded-2xl border-border p-8 flex flex-col items-center mt-8">
              <Text className="block text-sm text-muted-foreground text-center mb-4">暂无学习资料{'\n'}去拍照或导入添加</Text>
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

function MaterialRow({ item, subjectName, subjectDot, onOpen }: { item: Material; subjectName: string; subjectDot: string; onOpen: () => void }) {
  const formatted = formatTime(item.created_at)
  return (
    <View className="flex flex-row items-center gap-3 rounded-xl border border-border bg-card p-3 mb-2" onClick={onOpen}>
      {item.type === 'image' ? (
        <View className="w-20 h-24 flex-shrink-0 overflow-hidden rounded-lg bg-muted">
          <Image
            src={item.url}
            mode="aspectFill"
            style={{ width: '100%', height: '100%' }}
            onClick={e => e.stopPropagation?.()}
          />
        </View>
      ) : (
        <View className="w-20 h-24 flex-shrink-0 flex items-center justify-center rounded-lg bg-muted">
          <FileText size={26} color="#888" />
        </View>
      )}
      <View className="flex-1 min-w-0">
        <View className="flex flex-row items-center gap-2">
          {subjectDot ? <View className={`w-2 h-2 rounded-full flex-shrink-0 ${subjectDot}`} /> : null}
          <Text className="block text-sm font-medium text-foreground truncate">
            {item.name || (item.type === 'image' ? '图片资料' : '文档资料')}
          </Text>
        </View>
        <View className="flex flex-row items-center gap-2 mt-1">
          <ImageIcon size={13} color="#999" />
          <Text className="block text-xs text-muted-foreground truncate">
            {item.type === 'image' ? '图片' : '文档'}{subjectName ? ` · ${subjectName}` : ''}
          </Text>
        </View>
        <Text className="block text-xs text-muted-foreground mt-1">{formatted}</Text>
      </View>
    </View>
  )
}

function formatTime(iso: string) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}