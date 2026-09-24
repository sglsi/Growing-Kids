import { View, Text, ScrollView, Image } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useState } from 'react'
import { FileText, Image as ImageIcon, Trash2, FileSearch, Check } from 'lucide-react-taro'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  fetchSubjects, fetchMaterials, batchDeleteMaterials, combineToPdf,
  type Subject, type Material,
} from '@/services/api'
import { getSubjectColor } from '@/types'
import { Network } from '@/network'

export default function SubjectPage() {
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [activeSubject, setActiveSubject] = useState('')
  const [materials, setMaterials] = useState<Material[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<Material | null>(null)
  const [busy, setBusy] = useState(false)

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
    setSelected(new Set())
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

  const toggleSelect = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  const enterSelect = () => {
    setSelected(new Set())
    setSelecting(true)
  }
  const exitSelect = () => {
    setSelecting(false)
    setSelected(new Set())
  }

  const handleItemOpen = (m: Material) => {
    if (selecting) { toggleSelect(m.id); return }
    setPreview(m)
  }

  const handleLongPress = (m: Material) => {
    if (selecting) return
    const next = new Set<string>()
    next.add(m.id)
    setSelected(next)
    setSelecting(true)
    Taro.vibrateShort?.({ type: 'light' }).catch(() => {})
  }

  const handleDelete = async () => {
    if (!selected.size) { Taro.showToast({ title: '请先选择资料', icon: 'none' }); return }
    const ok = await new Promise<boolean>(resolve =>
      Taro.showModal({
        title: '确认删除',
        content: `将删除选中的 ${selected.size} 份资料，是否继续？`,
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      }),
    )
    if (!ok) return
    setBusy(true)
    try {
      await batchDeleteMaterials(Array.from(selected))
      Taro.showToast({ title: '已删除', icon: 'success' })
      setSelected(new Set())
      setSelecting(false)
      loadMaterials(activeSubject)
    } catch (e) {
      console.error('删除失败', e)
      Taro.showToast({ title: '删除失败', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  const handleCombinePdf = async () => {
    if (!selected.size) { Taro.showToast({ title: '请先选择资料', icon: 'none' }); return }
    setBusy(true)
    try {
      const res = await combineToPdf(Array.from(selected))
      Taro.hideLoading()
      openPdf(res.url, res.pages)
    } catch (e) {
      console.error('合成 PDF 失败', e)
      Taro.hideLoading()
      Taro.showToast({ title: '合成 PDF 失败，请确认所选含图片素材', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  const openPdf = (url: string, pages?: number) => {
    Taro.showLoading({ title: '打开 PDF…' })
    Network.downloadFile({
      url,
      success: (d) => {
        Taro.hideLoading()
        Taro.openDocument({
          filePath: d.tempFilePath,
          fileType: 'pdf',
          showMenu: true,
          fail: () => {
            Taro.showToast({ title: '打开失败，地址已复制', icon: 'none' })
            Taro.setClipboardData({ data: url })
          },
        })
      },
      fail: () => {
        Taro.hideLoading()
        Taro.setClipboardData({ data: url })
        Taro.showToast({ title: pages ? `已生成 ${pages} 页 PDF，地址已复制` : 'PDF 地址已复制', icon: 'none' })
      },
    })
  }

  return (
    <View className="h-screen bg-background flex flex-col" style={{ height: '100vh' }}>
      {/* 固定顶部：科目筛选 + 批量选择 */}
      <View className="flex-shrink-0 bg-background border-b border-border">
        <ScrollView scrollX className="whitespace-nowrap pt-3" enhanced showScrollbar={false}>
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

        <View className="flex flex-row items-center justify-between px-4 pt-2 pb-3">
          <Text className="block text-sm text-muted-foreground">共 {total} 份学习资料</Text>
          {!selecting ? (
            <Text className="block text-sm text-primary" onClick={enterSelect}>批量选择</Text>
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
      </View>

      <ScrollView scrollY className="flex-1">
        <View className="px-4 pb-28 pt-3">
          {loading ? (
            <View className="space-y-3">
              <Skeleton className="h-36 w-full rounded-2xl" />
              <Skeleton className="h-36 w-full rounded-2xl" />
            </View>
          ) : materials.length ? (
            <View className="space-y-1">
              {materials.map(m => (
                <MaterialRow
                  key={m.id}
                  item={m}
                  subjectName={getSubjectName(m.subject_id)}
                  subjectDot={getSubjectDot(m.subject_id)}
                  selecting={selecting}
                  checked={selected.has(m.id)}
                  onOpen={() => handleItemOpen(m)}
                  onLongPress={() => handleLongPress(m)}
                />
              ))}
            </View>
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

      {selecting && (
        <View style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          display: 'flex', flexDirection: 'row', gap: '12px',
          padding: '12px 16px', backgroundColor: '#fff', borderTop: '1px solid #ece8e0', zIndex: 100,
        }}
        >
          <View style={{ flex: 1 }}>
            <ActionBtn icon={<FileSearch size={16} color="#fff" />} label="合成PDF" disabled={!selected.size || busy} onClick={handleCombinePdf} />
          </View>
          <View style={{ flex: 1 }}>
            <ActionBtn icon={<Trash2 size={16} color="#fff" />} label="删除" danger disabled={!selected.size || busy} onClick={handleDelete} />
          </View>
        </View>
      )}

      {preview && (
        <MaterialPreview
          material={preview}
          onClose={() => setPreview(null)}
          onDelete={async (id) => {
            await batchDeleteMaterials([id])
            Taro.showToast({ title: '已删除', icon: 'success' })
            setPreview(null)
            loadMaterials(activeSubject)
          }}
        />
      )}
    </View>
  )
}

function ActionBtn({ icon, label, danger, disabled, onClick }: { icon: React.ReactNode; label: string; danger?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <View
      className={`flex flex-row items-center justify-center gap-2 h-11 rounded-xl ${disabled ? 'opacity-50' : ''} ${danger ? 'bg-red-600' : 'bg-primary'}`}
      onClick={() => { if (!disabled) onClick() }}
    >
      {icon}
      <Text className="block text-sm text-primary-foreground">{label}</Text>
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

function MaterialRow({ item, subjectName, subjectDot, selecting, checked, onOpen, onLongPress }: {
  item: Material; subjectName: string; subjectDot: string; selecting: boolean; checked: boolean; onOpen: () => void; onLongPress: () => void
}) {
  const formatted = formatTime(item.created_at)
  return (
    <View
      className={`flex flex-row items-center gap-3 rounded-xl border p-3 mb-2 ${checked ? 'border-primary bg-muted' : 'border-border bg-card'}`}
      onClick={onOpen}
      onLongPress={onLongPress}
    >
      {selecting && (
        <View className={`w-5 h-5 flex-shrink-0 rounded-full border flex items-center justify-center ${checked ? 'bg-primary border-primary' : 'border-muted-foreground'}`}>
          {checked && <Check size={14} color="#fff" />}
        </View>
      )}
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

function MaterialPreview({ material, onClose, onDelete }: { material: Material; onClose: () => void; onDelete: (id: string) => void }) {
  const isImage = material.type === 'image'
  const [zoom, setZoom] = useState(1)
  const minZoom = 0.5
  const maxZoom = 4
  const changeZoom = (delta: number) => {
    setZoom(z => {
      const next = Math.round((z + delta) * 100) / 100
      if (next < minZoom) return minZoom
      if (next > maxZoom) return maxZoom
      return next
    })
  }
  const resetZoom = () => setZoom(1)

  return (
    <View className="fixed inset-0 z-50 flex flex-col bg-background" onClick={onClose}>
      <View className="bg-background flex flex-col h-full" onClick={(e) => e.stopPropagation()}>
        {/* 顶部栏 */}
        <View className="flex flex-row items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <Text className="block text-sm font-semibold text-foreground flex-1 pr-2 truncate">
            {material.name || (isImage ? '图片资料' : '文档资料')}
          </Text>
          <Text className="block text-sm text-muted-foreground flex-shrink-0" onClick={onClose}>关闭</Text>
        </View>

        {/* 缩放控制条 */}
        <View className="flex flex-row items-center justify-center gap-5 px-4 py-2 border-b border-border flex-shrink-0">
          <View className="w-8 h-8 rounded-full border border-border flex items-center justify-center" onClick={() => changeZoom(-0.25)}>
            <Text className="block text-lg text-foreground leading-none">−</Text>
          </View>
          <Text className="block text-sm text-foreground w-16 text-center" onClick={resetZoom}>{Math.round(zoom * 100)}%</Text>
          <View className="w-8 h-8 rounded-full border border-border flex items-center justify-center" onClick={() => changeZoom(0.25)}>
            <Text className="block text-lg text-foreground leading-none">+</Text>
          </View>
        </View>

        {/* 内容区：可滚动 + 缩放 */}
        <ScrollView scrollY scrollX className="flex-1" enhanced>
          {isImage ? (
            <View
              className="flex items-center justify-center"
              style={{
                width: `${zoom * 100}%`,
                height: `${zoom * 60}vh`,
                minWidth: zoom === 1 ? '100%' : `${zoom * 100}%`,
              }}
            >
              <Image
                src={material.url}
                mode="aspectFit"
                style={{
                  width: zoom === 1 ? '100%' : `${zoom * 100}%`,
                  height: zoom === 1 ? '60vh' : `${zoom * 60}vh`,
                }}
                onClick={() => {
                  // 调起微信原生图片预览，支持双指捏合缩放
                  Taro.previewImage({ current: material.url, urls: [material.url] })
                }}
              />
            </View>
          ) : (
            <View className="p-8 flex flex-col items-center">
              <View style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}>
                <FileText size={48} color="#999" />
              </View>
              <Text className="block text-sm text-muted-foreground mt-4 text-center">
                该素材为文档/PDF 类型{'\n'}点击下方按钮可打开原件，支持双指缩放查看
              </Text>
              <View className="rounded-lg bg-primary px-4 py-2 mt-4" onClick={() => openOriginalDocument(material.url)}>
                <Text className="block text-xs text-primary-foreground">打开文档原件</Text>
              </View>
            </View>
          )}
        </ScrollView>

        <View className="px-4 py-2 flex-shrink-0">
          <Text className="block text-xs text-muted-foreground">保存时间：{formatTime(material.created_at)}</Text>
        </View>

        <View className="p-4 flex flex-row gap-3 flex-shrink-0" style={{ display: 'flex', flexDirection: 'row', gap: '12px' }}>
          <View style={{ flex: 1 }}>
            <ActionBtn icon={<Trash2 size={16} color="#fff" />} label="删除此资料" danger onClick={() => onDelete(material.id)} />
          </View>
        </View>
      </View>
    </View>
  )
}

function openOriginalDocument(url: string) {
  Taro.showLoading({ title: '加载文档…' })
  Network.downloadFile({
    url,
    success: (d) => {
      Taro.hideLoading()
      Taro.openDocument({
        filePath: d.tempFilePath,
        showMenu: true,
        fail: () => {
          Taro.setClipboardData({ data: url })
          Taro.showToast({ title: '无法打开，地址已复制', icon: 'none' })
        },
      })
    },
    fail: () => {
      Taro.hideLoading()
      Taro.setClipboardData({ data: url })
      Taro.showToast({ title: '加载失败，地址已复制', icon: 'none' })
    },
  })
}

function formatTime(iso: string) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}