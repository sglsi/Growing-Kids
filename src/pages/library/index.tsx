import { View, Text, ScrollView, Image } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useState } from 'react'
import { FileText, Trash2, Upload, Ellipsis } from 'lucide-react-taro'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyCard, BottomActionBar, ActionBtn } from '@/components/filter-header'
import { Input } from '@/components/ui/input'
import SelectionBar, { CheckDot } from '@/components/selection-bar'
import { confirmDelete, useSelection } from '@/lib/use-selection'
import RenameDialog from '@/components/rename-dialog'
import SubjectPickerSheet from '@/components/subject-picker-sheet'
import { openStorageFile, isPdfFile } from '@/services/net'
import {
  fetchLibrary, deleteLibraryDoc, batchDeleteLibrary, fetchSubjects, uploadFile, renameLibraryDoc, updateLibraryDoc,
  type LibraryDoc, type Subject, type Paged,
} from '@/services/api'
import { cacheGet, cacheSet, cacheListKey } from '@/services/cache'
import { getSubjectColor, formatTime } from '@/types'
import { INK, BRAND_FOREGROUND } from '@/lib/theme'
import { guardPrivacy, reportChooseFail } from '@/utils/privacy'

/** 按 mime 推断资料类型标签（思傅 2026-10-24：图片入库后需要区分） */
function getTypeLabel(mime: string | null, name: string): string {
  const m = (mime || '').toLowerCase()
  if (m.startsWith('image/')) return '图片'
  if (isPdfFile(m || name)) return 'PDF'
  if (m.includes('word') || /\.docx?$/i.test(name)) return 'Word'
  if (m.includes('text') || /\.txt$/i.test(name)) return 'TXT'
  return '文档'
}

function isImageDoc(mime: string | null): boolean {
  return (mime || '').toLowerCase().startsWith('image/')
}

/** 生成图片默认名（chooseImage 不返回原始文件名，微信只给临时路径） */
function genImageName(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `图片_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 资料库：外部 PDF / Word / TXT / 图片
 * v4 新增页面，对应后端 GET /api/library
 */
export default function LibraryPage() {
  const [docs, setDocs] = useState<LibraryDoc[]>([])
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [loading, setLoading] = useState(true)
  const [keyword, setKeyword] = useState('')
  const [busy, setBusy] = useState(false)
  const [renameTarget, setRenameTarget] = useState<LibraryDoc | null>(null)
  const [assignTarget, setAssignTarget] = useState<LibraryDoc | null>(null)
  const sel = useSelection()

  /**
   * 加载资料库。
   * ⚠️ silent（思傅 2026-10-23：与首页/复习本同一规则）：
   * 删除/上传后缓存已失效，非 silent 的 load 会 setLoading(true) → 骨架屏替换列表 →
   * ScrollView 内容塌缩 → 滚动位置被钳到顶部。silent = 旧列表留屏，后台静默替换。
   */
  const load = async (opts: { keyword?: string; subjectId?: string; silent?: boolean } = {}) => {
    // SWR（思傅 2026-10-21）：先同步读缓存渲染，再后台刷新回写
    const kw = (opts.keyword !== undefined ? opts.keyword : keyword) || undefined
    const sid = opts.subjectId || undefined
    const listKey = cacheListKey('lib', { keyword: kw || '', subjectId: sid || '', pageSize: 100 })
    const cached = cacheGet<Paged<LibraryDoc>>(listKey)
    if (cached) {
      setDocs(cached.list)
      setLoading(false)
    } else if (!opts.silent) {
      setLoading(true)
    }
    try {
      const res = await fetchLibrary({
        keyword: kw,
        subjectId: sid,
        pageSize: 100,
      })
      setDocs(res.list)
      cacheSet(listKey, res)
    } catch (e) {
      console.error('加载资料库失败', e)
      if (!cached) Taro.showToast({ title: '加载失败，请稍后重试', icon: 'none' })
    } finally {
      setLoading(false)
    }
  }

  useDidShow(() => {
    sel.exit()
    // 学科列表也走缓存（少一次请求；变化时 api.ts 已失效 subj 域）
    const cachedSubs = cacheGet<Subject[]>('subj:list')
    if (cachedSubs) setSubjects(cachedSubs)
    fetchSubjects()
      .then((s) => {
        setSubjects(s)
        if (s.length) cacheSet('subj:list', s)
      })
      // ⚠️ best-effort 的 catch 必须打全错（工程规范第 7 章第 2 条）：
      // 空 catch 会把「服务不可用」伪装成「资料未分类」，排查时无从下手。
      .catch((e) => console.error('[library] 学科列表加载失败', e))
    load()
  })

  const handleOpen = (d: LibraryDoc) => {
    if (sel.selecting) { sel.toggle(d.id); return }
    // 图片不经过 openStorageFile 的 PDF/文档逻辑，直接预览
    if (isImageDoc(d.mime_type)) {
      Taro.previewMedia({ sources: [{ url: d.url || '', type: 'image' }] })
      return
    }
    openStorageFile(d.url || '', isPdfFile(d.mime_type || d.name), d.file_key)
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
      load({ silent: true })
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
      load({ silent: true })
    } catch (e) {
      console.error(e)
      Taro.showToast({ title: '删除失败', icon: 'none' })
    }
  }

  const doUpload = async (filePath: string, fileName: string) => {
    Taro.showLoading({ title: '上传中…' })
    try {
      // 后端 /api/upload purpose=save + archive_to=library：图片也归档到资料库
      // ⚠️ 必须带 purpose=save：不带 purpose 后端只返回 URL、不落库、也不计入引用计数，
      //    表现为「提示已归档，但资料库里没有」。
      // #121：后端若发现同指纹内容已在本用户资料库里，会复用旧条目而非新建
      // （物理层早已去重，这里是业务条目层）⇒ 提示文案必须区分「新增」与「已存在」，
      // 否则用户会以为没存进去、反复上传。
      const up = await uploadFile(filePath, { purpose: 'save', archiveTo: 'library', fileName })
      Taro.hideLoading()
      if (up?.duplicated) {
        Taro.showToast({ title: up.restored ? '已存过，已为你恢复' : '这份已存过，无需重复归档', icon: 'none' })
      } else {
        Taro.showToast({ title: '已归档到资料库', icon: 'success' })
      }
      load({ silent: true })
    } catch (e) {
      Taro.hideLoading()
      console.error('上传失败', e)
      Taro.showToast({ title: '上传失败，请重试', icon: 'none' })
    }
  }

  const handleChooseDoc = async () => {
    if (!(await guardPrivacy('选择文档'))) return
    try {
      const res = await Taro.chooseMessageFile({
        count: 1,
        type: 'file',
        extension: ['pdf', 'doc', 'docx', 'txt'],
      })
      const f = res.tempFiles[0]
      await doUpload(f.path, f.name)
    } catch (e) {
      reportChooseFail(e, '选择文档', '请在小程序中从聊天/文件选择文档')
    }
  }

  const handleChooseImage = async () => {
    if (!(await guardPrivacy('选择图片'))) return
    try {
      const res = await Taro.chooseImage({ count: 1, sourceType: ['album', 'camera'] })
      const f = res.tempFiles[0]
      // chooseImage 不返回原始文件名（只给临时路径）⇒ 生成时间戳名
      await doUpload(f.path, genImageName())
    } catch (e) {
      reportChooseFail(e, '选择图片', '选择图片失败')
    }
  }

  const handleUpload = () => {
    Taro.showActionSheet({
      itemList: ['选择文档（PDF / Word / TXT）', '选择图片'],
    })
      .then((res) => {
        if (res.tapIndex === 0) handleChooseDoc()
        else if (res.tapIndex === 1) handleChooseImage()
      })
      .catch(() => { /* 取消 */ })
  }

  /** 卡片「⋯」→ 重命名 / 归属学科 / 删除 */
  const handleMore = (d: LibraryDoc) => {
    if (sel.selecting) return
    Taro.showActionSheet({ itemList: ['重命名', '归属学科', '删除'] })
      .then((res) => {
        if (res.tapIndex === 0) setRenameTarget(d)
        else if (res.tapIndex === 1) setAssignTarget(d)
        else if (res.tapIndex === 2) handleSingleDelete(d)
      })
      .catch(() => { /* 取消 */ })
  }

  /**
   * 归属学科（思傅 2026-10-24 增加，2026-10-25 修「点击无反应」）。
   * ⚠️ 旧实现在一级 action sheet 的回调里紧接着弹第二个原生 sheet，
   * 真机上二级会被微信吞掉（一级未退场）⇒ 改为页内自定义弹层
   * SubjectPickerSheet（见该组件注释）。学科未分类哨兵 subject_id=null。
   */
  const handleSubjectPicked = async (subjectId: string | null) => {
    const d = assignTarget
    setAssignTarget(null)
    if (!d) return
    try {
      await updateLibraryDoc(d.id, { subject_id: subjectId })
      Taro.showToast({
        title: subjectId ? `已归入「${subjects.find((s) => s.id === subjectId)?.name || ''}」` : '已移出学科',
        icon: 'success',
      })
      load({ silent: true })
    } catch (e) {
      console.error('设置归属学科失败', e)
      Taro.showToast({ title: '设置失败，请重试', icon: 'none' })
    }
  }

  const handleRenameConfirm = async (value: string) => {
    if (!renameTarget) return
    // ⚠️ 必须捕获：原实现无 try/catch ⇒ 失败时弹层不关、无提示，像「点了没反应」，
    // 且 rejection 逃逸成 unhandled（2026-10-29 分模块测试修复）
    try {
      await renameLibraryDoc(renameTarget.id, value)
      setRenameTarget(null)
      Taro.showToast({ title: '已重命名', icon: 'success' })
      load({ silent: true })
    } catch (e) {
      console.error('[library] 重命名失败', e)
      Taro.showToast({ title: `重命名失败：${e instanceof Error ? e.message.slice(0, 30) : '请重试'}`, icon: 'none' })
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
            <SelectionBar selection={sel} enterLabel="批量选择" />
            {!sel.selecting && (
              <View
                className="flex flex-row items-center gap-1 rounded-xl bg-brand px-3 h-8"
                onClick={handleUpload}
              >
                <Upload size={14} color={BRAND_FOREGROUND} />
                <Text className="block text-sm text-brand-foreground">导入</Text>
              </View>
            )}
          </View>
        </View>
        <View className="flex flex-row items-center gap-2 rounded-xl bg-muted px-3 h-9 mb-3">
          <View className="block text-xs text-muted-foreground" onClick={() => load({ keyword })}>🔍</View>
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
            <View className="block text-xs text-muted-foreground" onClick={() => { setKeyword(''); load({ keyword: '' }) }}>清空</View>
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
                const isImg = isImageDoc(d.mime_type)
                return (
                  <Card
                    key={d.id}
                    className={`flex flex-row items-center gap-3 rounded-2xl border p-4 ${checked ? 'border-brand-line bg-brand-soft' : 'border-border'}`}
                    onClick={() => handleOpen(d)}
                    onLongPress={() => sel.longPress(d.id)}
                  >
                    {sel.selecting && (
                      <CheckDot checked={checked} size={20} />
                    )}
                    <View className="w-11 h-11 flex-shrink-0 flex items-center justify-center rounded-lg bg-muted overflow-hidden">
                      {isImg && (d.thumb_url || d.url) ? (
                        <Image
                          src={d.thumb_url || d.url || ''}
                          mode="aspectFill"
                          className="w-11 h-11"
                        />
                      ) : (
                        <FileText size={20} color={INK} />
                      )}
                    </View>
                    <View className="flex-1 min-w-0">
                      <View className="flex flex-row items-center gap-2">
                        {getSubjectDot(d.subject_id) ? (
                          <View className={`w-2 h-2 rounded-full flex-shrink-0 ${getSubjectDot(d.subject_id)}`} />
                        ) : null}
                        <Text className="block text-sm font-medium text-foreground truncate">{d.name}</Text>
                      </View>
                      <Text className="block text-xs text-muted-foreground mt-1">
                        {getTypeLabel(d.mime_type, d.name)}
                        {getSubjectName(d.subject_id) ? ` · ${getSubjectName(d.subject_id)}` : ''} · {formatTime(d.created_at)}
                      </Text>
                    </View>
                    {!sel.selecting && (
                      <View className="p-2" onClick={(e) => { e.stopPropagation?.(); handleMore(d) }}>
                        <Ellipsis size={16} color="#bbb" />
                      </View>
                    )}
                  </Card>
                )
              })}
            </View>
          ) : (
            <EmptyCard
              title="资料库还是空的"
              hint="导入 PDF / Word / TXT / 图片，或在识别页导入文档，会自动归档到这里"
              actionLabel="导入文件"
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

      {renameTarget && (
        <RenameDialog
          title="重命名资料"
          initialValue={renameTarget.name}
          onCancel={() => setRenameTarget(null)}
          onConfirm={handleRenameConfirm}
        />
      )}

      <SubjectPickerSheet
        visible={!!assignTarget}
        subjects={subjects}
        currentId={assignTarget?.subject_id ?? null}
        onCancel={() => setAssignTarget(null)}
        onSelect={handleSubjectPicked}
      />
    </View>
  )
}
