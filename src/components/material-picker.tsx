import { useEffect, useState } from 'react'
import { View, Text, ScrollView } from '@tarojs/components'
import { FileText } from 'lucide-react-taro'
import { fetchLibrary, type LibraryDoc } from '@/services/api'
import { formatTime } from '@/lib/use-selection'
import { INK, BRAND, BRAND_FOREGROUND } from '@/lib/theme'

interface Props {
  visible: boolean
  onClose: () => void
  onSelect: (doc: LibraryDoc) => void
  title?: string
}

/**
 * 资料库选择器（v4）
 * 旧 MaterialPicker 依赖 fetchMaterials(type)，现统一走 /api/library
 *
 * ⚠️ 2026-10-22 修「弹窗空白」：旧版在**渲染期**直接 `void doLoad()`
 * （setState during render）——Web/H5 下碰巧能跑，Taro 小程序运行时
 * 渲染相位更新被丢弃，loading 状态永远不生效，内容区一片空白
 * （连「加载中…」都不显示）。改为标准 useEffect：visible 变 true 时加载。
 *
 * ⚠️ 2026-10-25 修 #113「一直显示加载中……」：原 effect deps 含
 * [visible, loaded, loading]，fetch 失败 → finally setLoading(false) →
 * effect 因 loading 变化立即重入 → 失败→重试**无限循环**；连接不通时每次
 * 等满超时，界面永远转圈。改为 deps 只跟 visible + reloadKey，失败落
 * error 态停手，由用户点「重试」再拉。
 */
export default function MaterialPicker({ visible, onClose, onSelect, title }: Props) {
  const [docs, setDocs] = useState<LibraryDoc[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 重试计数器：变一次就重跑一次加载 effect（visible 不变也能刷新） */
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const res = await fetchLibrary({ pageSize: 100 })
        if (cancelled) return
        setDocs(res.list)
      } catch (e) {
        if (cancelled) return
        console.error('资料库加载失败', e)
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [visible, reloadKey])

  if (!visible) return null

  return (
    <View
      className="fixed inset-0 flex items-end justify-center"
      // ⚠️ z-index 必须高于详情页底部「保存修改」悬浮条（inline zIndex: 100），
      // 否则弹窗被它压住，只能点到遮罩关不掉（思傅 2026-10-23 反馈）。
      // 用 inline style 而非 tailwind z-50：小程序里两种混用时以 inline 为准更稳妥。
      style={{ zIndex: 200, backgroundColor: 'rgba(40,36,30,0.45)' }}
      onClick={onClose}
    >
      <View
        className="w-full rounded-t-2xl bg-background"
        style={{ maxHeight: '70%' }}
        onClick={(e) => e.stopPropagation()}
      >
        <View className="flex flex-row items-center justify-between px-4 py-3 border-b border-border">
          <Text className="block text-sm font-semibold text-foreground">{title || '从资料库选择'}</Text>
          <View className="block text-sm text-muted-foreground" onClick={onClose}>关闭</View>
        </View>

        <ScrollView scrollY style={{ maxHeight: '55vh' }}>
          {loading ? (
            <View className="py-10 flex items-center justify-center">
              <Text className="block text-sm text-muted-foreground">加载中…</Text>
            </View>
          ) : error ? (
            <View className="py-8 px-6">
              <Text className="block text-sm text-foreground text-center">加载失败：{error}</Text>
              <Text className="block text-xs text-muted-foreground text-center mt-3 leading-5">
                {'请依次确认：\n1. 电脑已开机且后端服务在运行（3001 端口）\n2. 手机与电脑连接同一 Wi-Fi\n3. 电脑 IP 若变动，请修改 .env.local 后重新编译'}
              </Text>
              <View className="flex items-center justify-center mt-4">
                <View
                  className="rounded-lg px-4 py-2"
                  style={{ backgroundColor: BRAND, color: BRAND_FOREGROUND }}
                  onClick={() => setReloadKey((k) => k + 1)}
                >
                  <Text className="block text-sm">重试</Text>
                </View>
              </View>
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
                    <FileText size={18} color={INK} />
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
