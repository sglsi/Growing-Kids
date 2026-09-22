import { View, Text, Image, ScrollView } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useState } from 'react'
import { fetchMaterials, type Material } from '@/services/api'

interface Props {
  visible: boolean
  // image：仅图片素材；document：仅文档素材
  type: 'image' | 'document'
  title?: string
  onClose: () => void
  // 选中后回传素材（含 url，可直接用于识别）
  onSelect: (m: Material) => void
}

export default function MaterialPicker({
  visible, type, title, onClose, onSelect,
}: Props) {
  const [materials, setMaterials] = useState<Material[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const { list } = await fetchMaterials(type)
      setMaterials(list)
      setLoaded(true)
    } catch (e) {
      Taro.showToast({ title: '素材加载失败', icon: 'none' })
    } finally {
      setLoading(false)
    }
  }

  if (!visible) return null
  if (!loaded && !loading) {
    void load()
  }

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
          <Text className="block text-sm font-semibold text-foreground">
            {title || '从素材库选择'}
          </Text>
          <Text className="block text-sm text-muted-foreground" onClick={onClose}>关闭</Text>
        </View>

        <ScrollView scrollY style={{ maxHeight: '50vh' }}>
          {loading ? (
            <View className="py-10 flex items-center justify-center">
              <Text className="block text-sm text-muted-foreground">加载中…</Text>
            </View>
          ) : materials.length === 0 ? (
            <View className="py-10 px-6 flex items-center justify-center">
              <Text className="block text-sm text-muted-foreground text-center">
                素材库暂无内容{'\n'}先拍照或导入文件，系统会自动归档到这里
              </Text>
            </View>
          ) : (
            <View className="p-3">
              {type === 'image' ? (
                <View className="grid grid-cols-3 gap-2">
                  {materials.map((m) => (
                    <View
                      key={m.id}
                      className="aspect-square rounded-lg overflow-hidden border border-border"
                      onClick={() => { onSelect(m); onClose() }}
                    >
                      <Image src={m.url} mode="aspectFill" className="w-full h-full" />
                    </View>
                  ))}
                </View>
              ) : (
                materials.map((m) => (
                  <View
                    key={m.id}
                    className="flex flex-row items-center gap-3 rounded-xl border border-border px-3 py-3 mb-2"
                    onClick={() => { onSelect(m); onClose() }}
                  >
                    <Text className="block text-sm text-foreground flex-1 break-all">{m.name}</Text>
                    {m.used ? (
                      <Text className="block text-xs text-muted-foreground shrink-0">已使用</Text>
                    ) : null}
                  </View>
                ))
              )}
            </View>
          )}
        </ScrollView>
      </View>
    </View>
  )
}
