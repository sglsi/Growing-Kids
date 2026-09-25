import { View, Text, ScrollView } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useState } from 'react'
import { FileText, Trash2 } from 'lucide-react-taro'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { EmptyCard, BottomActionBar, ActionBtn } from '@/components/filter-header'
import { confirmDelete, useSelection } from '@/lib/use-selection'
import { openStorageFile, isPdfFile } from '@/services/net'
import {
  fetchLibrary, deleteLibraryDoc, batchDeleteLibrary, fetchSubjects, uploadFile,
  type LibraryDoc, type Subject,
} from '@/services/api'
import { getSubjectColor, formatTime } from '@/types'

/**
 * 资料库：外部 PDF / Word / TXT 等文档
 * v4 新增页面，对应后端 GET /api/library
 */
export default function LibraryPage() {
  const [docs, setDocs] = useState<LibraryDoc[]>([])
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [loading, setLoading] = useState(true)
  const [keyword, setKeyword] = useState('')
  const [busy, setBusy] = useState(false)
  const sel = useSelection()

  const load = async (opts: { keyword?: string; subjectId?: string } = {}) => {
    setLoading(true)
    try {
      const res = await fetchLibrary({
        keyword: (opts.keyword !== undefined ? opts.keyword : keyword) || undefined,
        subjectId: opts.subjectId || undefined,
        pageSize: 100,
      })
      setDocs(res.list)
    } catch (e) {
      console.error('加载资料库失败', e)
    } finally {
      setLoading(false)
    }
  }

  useDidShow(() => {
    sel.exit()
    fetchSubjects().then(setSubjects).catch(() => {})
    load()
  })

  const handleOpen = (d: LibraryDoc) => {
    if (sel.selecting) { sel.toggle(d.id); return }
    openStorageFile(d.url || '', isPdfFile(d.mime_type || d.name))
  }

  const handleDelete = async () => {
    if (sel.isEmpty) return
    const ok = await confirmDelete(sel.count, '份资料')
    if (!ok) return
    setBusy(true)
    try {
      await batchDeleteLibrary(Array.from(sel.selected))
      Taro.showToast({ title: '已删除', icon: 'success' })
      sel.exit()
      load()
    } catch (e) {
      console.error(e)
      Taro.showToast({ title: '删除失败', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  const handleSingleDelete = async (d: LibraryDoc) => {
    const ok = await confirmDelete(1, '份资料')
    if (!ok) return
    try {
      await deleteLibraryDoc(d.id)
      Taro.showToast({ title: '已删除', icon: 'success' })
      load()
    } catch (e) {
      console.error(e)
      Taro.showToast({ title: '删除失败', icon: 'none' })
    }
  }

  const handleUpload = async () => {
    try {
      const res = await Taro.chooseMessageFile({
        count: 1,
        type: 'file',
        extension: ['pdf', 'doc', 'docx', 'txt'],
      })
      const f = res.tempFiles[0]
      Taro.showLoading({ title: '上传中…' })
      // 后端 /api/upload 检测为非图片时自动归档到 library，并回传 library_id
      await uploadFile(f.path)
      Taro.hideLoading()
      Taro.showToast({ title: '已归档到资料库', icon: 'success' })
      load()
    } catch (e) {
      Taro.hideLoading()
      Taro.showToast({ title: '请在小程序中从聊天/文件选择文档', icon: 'none' })
    }
  }

  const getSubjectDot = (id: string | null) => {
    if (!id) return ''
    const s = subjects.find((x) => x.id === id)
    return s ? getSubjectColor(s.color).dot : ''
  }
  const getSubjectName = (id: string | null) => (id ? subjects.find((s) => s.id === id)?.name || '' : '')

  return (
    <View className="bg-background" style={{ position: 'relative', height: '100vh' }}>
      {/* 固定顶部 */}
      <View style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 50, backgroundColor: '#fff', borderBottom: '1px solid #ecefe3', padding: '12px 16px 0' }}>
        <View className="flex flex-row items-center justify-between mb-2">
          <Text className="block text-base font-semibold text-foreground">资料库</Text>
          <View className="flex flex-row items-center gap-3">
            {!sel.selecting ? (
              <Text className="block text-sm text-primary" onClick={sel.enter}>批量选择</Text>
            ) : (
              <>
                {sel.count > 0 && <Text className="block text-sm text-foreground">已选 {sel.count}</Text>}
                <Text className="block text-sm text-primary" onClick={sel.exit}>取消</Text>
              </>
            )}
            <Text className="block text-sm text-primary" onClick={handleUpload}>导入</Text>
          </View>
        </View>
        <View className="flex flex-row items-center gap-2 rounded-xl bg-muted px-3 h-9 mb-3">
          <Text className="block text-xs text-muted-foreground" onClick={() => load({ keyword })}>🔍</Text>
          <Input
            className="flex-1 text-sm bg-transparent"
            value={keyword}
            placeholder="搜索资料名称"
            placeholderClass="text-muted-foreground"
            confirmType="search"
            onInput={(e) => setKeyword(e.detail.value)}
            onConfirm={() => load({ keyword })}
          />
          {keyword ? (
            <Text className="block text-xs text-muted-foreground" onClick={() => { setKeyword(''); load({ keyword: '' }) }}>清空</Text>
          ) : null}
        </View>
      </View>

      <ScrollView scrollY style={{ height: '100vh', paddingTop: 110 }}>
        <View className="px-4 pb-28 pt-3">
          <Text className="block text-xs text-muted-foreground mb-3">共 {docs.length} 份资料</Text>
          {loading ? (
            <View className="space-y-3">
              <Skeleton className="h-16 w-full rounded-2xl" />
              <Skeleton className="h-16 w-full rounded-2xl" />
            </View>
          ) : docs.length ? (
            <View className="space-y-2">
              {docs.map((d) => {
                const checked = sel.selected.has(d.id)
                return (
                  <Card
                    key={d.id}
                    className={`flex flex-row items-center gap-3 rounded-xl border p-3 ${checked ? 'border-primary bg-muted' : 'border-border'}`}
                    onClick={() => handleOpen(d)}
                    onLongPress={() => sel.longPress(d.id)}
                  >
                    {sel.selecting && (
                      <View className={`w-5 h-5 flex-shrink-0 rounded-full border flex items-center justify-center ${checked ? 'bg-primary border-primary' : 'border-muted-foreground'}`}>
                        {checked && <Text className="block text-xs text-primary-foreground">✓</Text>}
                      </View>
                    )}
                    <View className="w-11 h-11 flex-shrink-0 flex items-center justify-center rounded-lg bg-muted">
                      <FileText size={20} color="#BE3E2D" />
                    </View>
                    <View className="flex-1 min-w-0">
                      <View className="flex flex-row items-center gap-2">
                        {getSubjectDot(d.subject_id) ? (
                          <View className={`w-2 h-2 rounded-full flex-shrink-0 ${getSubjectDot(d.subject_id)}`} />
                        ) : null}
                        <Text className="block text-sm font-medium text-foreground truncate">{d.name}</Text>
                      </View>
                      <Text className="block text-xs text-muted-foreground mt-1">
                        {isPdfFile(d.mime_type || d.name) ? 'PDF' : '文档'}
                        {getSubjectName(d.subject_id) ? ` · ${getSubjectName(d.subject_id)}` : ''} · {formatTime(d.created_at)}
                      </Text>
                    </View>
                    {!sel.selecting && (
                      <View className="p-2" onClick={(e) => { e.stopPropagation?.(); handleSingleDelete(d) }}>
                        <Trash2 size={16} color="#bbb" />
                      </View>
                    )}
                  </Card>
                )
              })}
            </View>
          ) : (
            <EmptyCard
              title="资料库还是空的"
              hint="导入 PDF / Word / TXT，或在识别页导入文档，会自动归档到这里"
              actionLabel="导入文档"
              onAction={handleUpload}
            />
          )}
        </View>
      </ScrollView>

      {sel.selecting && (
        <BottomActionBar>
          <View style={{ flex: 1 }}>
            <ActionBtn
              icon={<Trash2 size={16} color="#fff" />}
              label="删除选中"
              danger
              disabled={sel.isEmpty || busy}
              onClick={handleDelete}
            />
          </View>
        </BottomActionBar>
      )}
    </View>
  )
}
