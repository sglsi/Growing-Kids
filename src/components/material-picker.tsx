import { useState } from 'react'
import { View, Text, ScrollView } from '@tarojs/components'
import { FileText } from 'lucide-react-taro'
import { fetchLibrary, type LibraryDoc } from '@/services/api'
import { formatTime } from '@/lib/use-selection'

interface Props {
  visible: boolean
  onClose: () => void
  onSelect: (doc: LibraryDoc) => void
  title?: string
}

/**
 * 资料库选择器（v4）
 * 旧 MaterialPicker 依赖 fetchMaterials(type)，现统一走 /api/library
 */
export default function MaterialPicker({ visible, onClose, onSelect, title }: Props) {
  const [docs, setDocs] = useState<LibraryDoc[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const doLoad = async () => {
    setLoading(true)
    try {
      const res = await fetchLibrary({ pageSize: 100 })
      setDocs(res.list)
      setLoaded(true)
    } catch {
      // 忽略：由页面 toast
    } finally {
      setLoading(false)
    }
  }

  if (!visible) return null
  if (!loaded && !loading) void doLoad()

  return (
    <View
      className="fixed inset-0 z-50 flex items-end justify-center"
      style={{ backgroundColor: 'rgba(40,36,30,0.45)' }}
      onClick={onClose}
    >
      <View
        className="w-full rounded-t-2xl bg-background"
        style={{ maxHeight: '70%' }}
        onClick={(e) => e.stopPropagation()}
      >
        <View className="flex flex-row items-center justify-between px-4 py-3 border-b border-border">
          <Text className="block text-sm font-semibold text-foreground">{title || '从资料库选择'}</Text>
          <Text className="block text-sm text-muted-foreground" onClick={onClose}>关闭</Text>
        </View>

        <ScrollView scrollY style={{ maxHeight: '55vh' }}>
          {loading ? (
            <View className="py-10 flex items-center justify-center">
              <Text className="block text-sm text-muted-foreground">加载中…</Text>
            </View>
          ) : docs.length === 0 ? (
            <View className="py-10 px-6 flex items-center justify-center">
              <Text className="block text-sm text-muted-foreground text-center">
                资料库暂无内容{'\n'}先导入 PDF / Word / TXT，系统会自动归档到这里
              </Text>
            </View>
          ) : (
            <View className="p-3">
              {docs.map((d) => (
                <View
                  key={d.id}
                  className="flex flex-row items-center gap-3 rounded-xl border border-border px-3 py-3 mb-2"
                  onClick={() => { onSelect(d); onClose() }}
                >
                  <View className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
                    <FileText size={18} color="#BE3E2D" />
                  </View>
                  <View className="flex-1 min-w-0">
                    <Text className="block text-sm text-foreground truncate">{d.name}</Text>
                    <Text className="block text-xs text-muted-foreground mt-1">
                      {/pdf/i.test(d.mime_type || '') ? 'PDF' : '文档'} · {formatTime(d.created_at)}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      </View>
    </View>
  )
}
